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
type PrIssueComment = {
  id: number;
  node_id: string;
  body?: string | null;
};
type CommentOwnershipResponse = {
  nodes: ({
    id: string;
    body: string;
    viewerDidAuthor: boolean;
  } | null)[];
};

// Generated commits are immutable external state. Removing this protocol alias
// can launch a duplicate paid run when an older generated commit is revisited.
const LEGACY_GENERATED_RUN_TRAILER = "Zeus-Guardian-Job";

function hasLeadingCommentMarker(
  body: string | null | undefined,
  marker: string,
): boolean {
  // Report Markdown can itself quote a different workflow's marker. Only the
  // first line is protocol metadata; never treat report contents as identity.
  return body?.split(/\r?\n/, 1)[0] === marker;
}

function githubFailureSummary(error: unknown): string {
  // Octokit errors may include response bodies or request details. Keep useful
  // status information without copying credentials or repository content to CI.
  const status =
    error && typeof error === "object" && "status" in error
      ? error.status
      : undefined;
  return typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 599
    ? ` (GitHub HTTP ${status})`
    : "";
}

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
    // Finding IDs originate in model output, not trusted query syntax. Unusual
    // IDs remain publishable, but must not introduce GitHub search qualifiers.
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(finding.id)) return null;
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
        if (
          issue.repository_url.toLowerCase() ===
            `https://api.github.com/repos/${this.owner}/${this.repo}`.toLowerCase() &&
          !issue.pull_request &&
          (issue.title === title || issue.title === legacyTitle)
        ) {
          return issue.number;
        }
      }
    } catch (error) {
      core.warning(
        `Failed to search for existing issues${githubFailureSummary(error)}.`,
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
        `Failed to create/update finding issue${githubFailureSummary(error)}.`,
      );
      return null;
    }
  }

  async upsertPrComment(
    prNumber: number,
    body: string,
    marker = PR_COMMENT_MARKER,
    expectedHeadSha: string,
    runId: string,
  ): Promise<void> {
    try {
      if (
        !SHA_REGEX.test(expectedHeadSha) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          runId,
        ) ||
        !marker.endsWith(" -->") ||
        !hasLeadingCommentMarker(body, marker)
      ) {
        throw new Error("Invalid immutable PR comment identity.");
      }

      // GitHub has no atomic head-conditional comment update. Scope identity to
      // both the immutable head and canonical paid audit so an older run cannot
      // overwrite another result even if the head changes after our final GET.
      // Legacy unscoped summaries are deliberately left untouched.
      const scopedMarker = marker.replace(
        / -->$/,
        `:head:${expectedHeadSha}:run:${runId.toLowerCase()} -->`,
      );
      const scopedBody = scopedMarker + body.slice(marker.length);
      if (!(await this.isCurrentPrHead(prNumber, expectedHeadSha))) return;

      const comments: PrIssueComment[] = await this.octokit.paginate(
        this.octokit.rest.issues.listComments,
        {
          owner: this.owner,
          repo: this.repo,
          issue_number: prNumber,
          per_page: 100,
        },
      );

      const candidates = comments.filter((comment) =>
        hasLeadingCommentMarker(comment.body, scopedMarker),
      );
      let existing: (typeof candidates)[number] | undefined;
      for (let offset = 0; offset < candidates.length; offset += 100) {
        const batch = candidates.slice(offset, offset + 100);
        // Ask GitHub about the authenticated viewer, rather than trusting a
        // public marker, author login, bot type, or repository role. This works
        // for GITHUB_TOKEN, installation tokens, and personal access tokens.
        const response: CommentOwnershipResponse =
          await this.octokit.graphql<CommentOwnershipResponse>(
            `query GuardianCommentOwnership($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on IssueComment { id body viewerDidAuthor }
            }
          }`,
            { ids: batch.map((comment) => comment.node_id) },
          );
        const owned = response.nodes.find(
          (comment) =>
            comment?.viewerDidAuthor === true &&
            hasLeadingCommentMarker(comment.body, scopedMarker) &&
            batch.some((candidate) => candidate.node_id === comment.id),
        );
        if (owned) {
          existing = batch.find((comment) => comment.node_id === owned.id);
          break;
        }
      }

      // Pagination and identity verification can take time. Recheck just before
      // mutation; a late old-head result should normally publish nothing.
      if (!(await this.isCurrentPrHead(prNumber, expectedHeadSha))) return;

      if (existing) {
        await this.octokit.rest.issues.updateComment({
          owner: this.owner,
          repo: this.repo,
          comment_id: existing.id,
          body: scopedBody,
        });
        core.info(`Updated existing PR comment #${existing.id}`);
      } else {
        await this.octokit.rest.issues.createComment({
          owner: this.owner,
          repo: this.repo,
          issue_number: prNumber,
          body: scopedBody,
        });
        core.info(`Created new PR comment on #${prNumber}`);
      }
    } catch (error) {
      core.warning(
        `Failed to upsert PR comment${githubFailureSummary(error)}.`,
      );
    }
  }

  private async isCurrentPrHead(
    prNumber: number,
    expectedHeadSha: string,
  ): Promise<boolean> {
    const { data } = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });
    if (data.head.sha !== expectedHeadSha) {
      core.info(
        "Skipped PR summary because the pull request head has changed.",
      );
      return false;
    }
    return true;
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
