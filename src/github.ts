import * as core from "@actions/core";
import * as github from "@actions/github";
import type { Finding, Severity } from "./types";
import {
  PR_COMMENT_MARKER,
  SEVERITY_LABEL_PREFIX,
  ZEUS_AUDIT_LABEL,
} from "./constants";
import { formatIssueTitle, formatIssueBody } from "./format";

type Octokit = ReturnType<typeof github.getOctokit>;

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(token: string) {
    this.octokit = github.getOctokit(token);
    this.owner = github.context.repo.owner;
    this.repo = github.context.repo.repo;
  }

  async ensureLabelsExist(labels: string[], severities: Severity[]): Promise<void> {
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
            label === ZEUS_AUDIT_LABEL
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
    try {
      const { data } = await this.octokit.rest.search.issuesAndPullRequests({
        q: `repo:${this.owner}/${this.repo} is:issue is:open label:${ZEUS_AUDIT_LABEL} "${finding.id}" in:title`,
        per_page: 5,
      });

      for (const issue of data.items) {
        if (issue.title === title) {
          return issue.number;
        }
      }
    } catch (error) {
      core.warning(
        `Failed to search for existing issues: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return null;
  }

  async createOrUpdateIssue(
    finding: Finding,
    jobId: string,
    prNumber: number,
    labels: string[]
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
          body: `This finding was detected again in PR #${prNumber} (Zeus Job: \`${jobId}\`).`,
        });
        core.info(
          `Finding ${finding.id} already tracked in #${existingIssueNumber}, added recurrence comment.`
        );
        return `#${existingIssueNumber}`;
      }

      // Create new issue
      const { data: issue } = await this.octokit.rest.issues.create({
        owner: this.owner,
        repo: this.repo,
        title,
        body: formatIssueBody(finding, jobId, prNumber),
        labels: allLabels,
      });

      core.info(`Created issue #${issue.number} for finding ${finding.id}`);
      return `#${issue.number}`;
    } catch (error) {
      core.warning(
        `Failed to create/update issue for ${finding.id}: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  async upsertPrComment(prNumber: number, body: string): Promise<void> {
    try {
      // Search for existing comment with our marker
      const { data: comments } = await this.octokit.rest.issues.listComments({
        owner: this.owner,
        repo: this.repo,
        issue_number: prNumber,
        per_page: 100,
      });

      const existing = comments.find(
        (c) => c.body?.includes(PR_COMMENT_MARKER)
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
        `Failed to upsert PR comment: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
