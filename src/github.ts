import * as core from "@actions/core";
import * as github from "@actions/github";
import type { Finding, Severity } from "./types";
import {
  AI_AUDITOR_LABEL,
  AUTO_PROVER_LABEL,
  PR_COMMENT_MARKER,
  SHA_REGEX,
  SEVERITY_LABEL_PREFIX,
} from "./constants";
import { formatIssueTitle, formatIssueBody } from "./format";

type Octokit = ReturnType<typeof github.getOctokit>;

// These protocol aliases must remain readable because generated commits and
// pull-request comments are immutable external state. Removing either alias
// can launch a duplicate paid run or create a duplicate summary comment.
const LEGACY_GENERATED_RUN_TRAILER = "Zeus-Guardian-Job";
const LEGACY_PR_COMMENT_MARKER = "<!-- zeus-guardian-ci -->";

function generatedRunIdFromCommitMessage(message: string): string | null {
  const lines = message.split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  const trailer = lines.at(-1);
  const match = trailer?.match(
    /^([^:]+): ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
  );
  if (
    match?.[1] !== "Certora-Guardian-Run" &&
    match?.[1] !== LEGACY_GENERATED_RUN_TRAILER
  ) {
    return null;
  }
  return match[2] ?? null;
}

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(token: string) {
    this.octokit = github.getOctokit(token);
    this.owner = github.context.repo.owner;
    this.repo = github.context.repo.repo;
  }

  async ensureLabelsExist(
    labels: string[],
    severities: Severity[],
  ): Promise<void> {
    const allLabels = [
      ...labels,
      ...severities.map((s) => `${SEVERITY_LABEL_PREFIX}${s.toLowerCase()}`),
    ];

    for (const label of allLabels) {
      try {
        await this.octokit.rest.issues.getLabel({
          owner: this.owner,
          repo: this.repo,
          name: label,
        });
      } catch {
        try {
          const color =
            label === AI_AUDITOR_LABEL || label === AUTO_PROVER_LABEL
              ? "7B3FE4"
              : label.startsWith(SEVERITY_LABEL_PREFIX)
                ? label.includes("high")
                  ? "D73A49"
                  : label.includes("medium")
                    ? "E36209"
                    : label.includes("low")
                      ? "FBCA04"
                      : "0075CA"
                : "EDEDED";

          await this.octokit.rest.issues.createLabel({
            owner: this.owner,
            repo: this.repo,
            name: label,
            color,
          });
          core.info(`Created label: ${label}`);
        } catch {
          core.warning(`Could not create label: ${label}`);
        }
      }
    }
  }

  async findExistingIssue(finding: Finding): Promise<number | null> {
    const title = formatIssueTitle(finding);
    const legacyTitle = `[Auto Prover] ${finding.severity}: ${finding.title} (${finding.id})`;
    try {
      const { data } = await this.octokit.rest.search.issuesAndPullRequests({
        // Search by finding id, then require an exact current OR legacy title
        // below. Omitting a label qualifier is deliberate: releases before
        // the AI Auditor rename used `auto-prover`, while current issues use
        // `ai-auditor`, and callers may configure their own labels.
        q: `repo:${this.owner}/${this.repo} is:issue is:open "${finding.id}" in:title`,
        per_page: 20,
      });

      for (const issue of data.items) {
        if (issue.title === title || issue.title === legacyTitle) {
          return issue.number;
        }
      }
    } catch (error) {
      core.warning(
        `Failed to search for existing issues: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }

  async createOrUpdateIssue(
    finding: Finding,
    runId: string,
    prNumber: number,
    labels: string[],
  ): Promise<string | null> {
    const title = formatIssueTitle(finding);
    const severityLabel = `${SEVERITY_LABEL_PREFIX}${finding.severity.toLowerCase()}`;
    const allLabels = [...labels, severityLabel];

    try {
      const existingIssueNumber = await this.findExistingIssue(finding);

      if (existingIssueNumber) {
        // Add a comment noting recurrence
        await this.octokit.rest.issues.createComment({
          owner: this.owner,
          repo: this.repo,
          issue_number: existingIssueNumber,
          body: `This finding was detected again in PR #${prNumber} (Certora run: \`${runId}\`).`,
        });
        core.info(
          `Finding ${finding.id} already tracked in #${existingIssueNumber}, added recurrence comment.`,
        );
        return `#${existingIssueNumber}`;
      }

      // Create new issue
      const { data: issue } = await this.octokit.rest.issues.create({
        owner: this.owner,
        repo: this.repo,
        title,
        body: formatIssueBody(finding, runId, prNumber),
        labels: allLabels,
      });

      core.info(`Created issue #${issue.number} for finding ${finding.id}`);
      return `#${issue.number}`;
    } catch (error) {
      core.warning(
        `Failed to create/update issue for ${finding.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async upsertPrComment(
    prNumber: number,
    body: string,
    marker = PR_COMMENT_MARKER,
  ): Promise<void> {
    try {
      // Search for existing comment with our marker
      const comments = await this.octokit.paginate(
        this.octokit.rest.issues.listComments,
        {
          owner: this.owner,
          repo: this.repo,
          issue_number: prNumber,
          per_page: 100,
        },
      );

      const fallbackMarkers =
        marker === PR_COMMENT_MARKER
          ? [LEGACY_PR_COMMENT_MARKER]
          : [PR_COMMENT_MARKER, LEGACY_PR_COMMENT_MARKER];
      const existing =
        comments.find((comment) => comment.body?.includes(marker)) ??
        comments.find((comment) =>
          fallbackMarkers.some((fallback) =>
            comment.body?.includes(fallback),
          ),
        );

      if (existing) {
        await this.octokit.rest.issues.updateComment({
          owner: this.owner,
          repo: this.repo,
          comment_id: existing.id,
          body,
        });
        core.info(`Updated existing PR comment #${existing.id}`);
      } else {
        await this.octokit.rest.issues.createComment({
          owner: this.owner,
          repo: this.repo,
          issue_number: prNumber,
          body,
        });
        core.info(`Created new PR comment on #${prNumber}`);
      }
    } catch (error) {
      core.warning(
        `Failed to upsert PR comment: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getGeneratedFollowup(
    headSha: string,
  ): Promise<{ runId: string; sourceCommitSha: string } | null> {
    try {
      const { data: commit } = await this.octokit.rest.repos.getCommit({
        owner: this.owner,
        repo: this.repo,
        ref: headSha,
      });
      if (commit.sha.toLowerCase() !== headSha.toLowerCase()) {
        throw new Error("GitHub returned a different head commit.");
      }
      const runId = generatedRunIdFromCommitMessage(commit.commit.message);
      if (runId) {
        const sourceCommitSha = commit.parents[0]?.sha;
        if (
          commit.parents.length !== 1 ||
          !sourceCommitSha ||
          !SHA_REGEX.test(sourceCommitSha)
        ) {
          throw new Error("Generated commit does not have one valid parent.");
        }
        core.info(
          `Detected generated-commit follow-up marker for Certora run ${runId}.`,
        );
        return { runId, sourceCommitSha };
      }
      return null;
    } catch {
      throw new Error(
        "Failed to inspect the pull request head commit. Refusing to launch a run that could duplicate a generated-commit follow-up.",
      );
    }
  }
}
