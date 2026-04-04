import * as core from "@actions/core";
import * as github from "@actions/github";
import type { ActionConfig, Severity } from "./types";
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_TIMEOUT,
  SHA_REGEX,
} from "./constants";

const VALID_SEVERITIES = new Set<string>(["HIGH", "MEDIUM", "LOW", "INFO"]);

function parseSeverities(input: string): Severity[] {
  if (!input.trim()) return [];
  return input
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => {
      if (!VALID_SEVERITIES.has(s)) {
        core.warning(`Ignoring unknown severity: ${s}`);
        return false;
      }
      return true;
    }) as Severity[];
}

export function getConfig(): ActionConfig {
  const pr = github.context.payload.pull_request;
  if (!pr) {
    throw new Error(
      "This action must be triggered by a pull_request event. No pull_request payload found."
    );
  }

  const baseSha: string = pr.base?.sha;
  const headSha: string = pr.head?.sha;

  if (!baseSha || !SHA_REGEX.test(baseSha)) {
    throw new Error(
      `Invalid base SHA: "${baseSha}". Expected a 40-character hex string.`
    );
  }
  if (!headSha || !SHA_REGEX.test(headSha)) {
    throw new Error(
      `Invalid head SHA: "${headSha}". Expected a 40-character hex string.`
    );
  }

  const { owner, repo } = github.context.repo;
  const target = `https://github.com/${owner}/${repo}`;

  const contextInput = core.getInput("context", { required: true });
  const context = contextInput
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  if (context.length === 0) {
    throw new Error("At least one context pattern is required.");
  }

  const maxIterations = parseInt(
    core.getInput("max-iterations") || String(DEFAULT_MAX_ITERATIONS),
    10
  );
  if (isNaN(maxIterations) || maxIterations < 4 || maxIterations > 10) {
    throw new Error("max-iterations must be between 4 and 10.");
  }

  return {
    apiKey: core.getInput("api-key", { required: true }),
    apiBaseUrl: (
      core.getInput("api-base-url") || "https://zeus-audit.com"
    ).replace(/\/$/, ""),
    context,
    githubToken: core.getInput("github-token", { required: true }),
    preprompt: core.getInput("preprompt") || undefined,
    maxIterations,
    skipSubmodules: core.getInput("skip-submodules") === "true",
    pollInterval: parseInt(
      core.getInput("poll-interval") || String(DEFAULT_POLL_INTERVAL),
      10
    ),
    timeout: parseInt(
      core.getInput("timeout") || String(DEFAULT_TIMEOUT),
      10
    ),
    createIssues: core.getInput("create-issues") !== "false",
    issueSeverities: parseSeverities(
      core.getInput("issue-severities") || "HIGH,MEDIUM"
    ),
    commentOnPr: core.getInput("comment-on-pr") !== "false",
    failOn: parseSeverities(core.getInput("fail-on") || ""),
    labels: (core.getInput("labels") || "zeus-audit,security")
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean),
    target,
    branchStarting: baseSha,
    branchEnding: headSha,
    prNumber: pr.number,
  };
}
