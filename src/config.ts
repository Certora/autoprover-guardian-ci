import * as core from "@actions/core";
import * as github from "@actions/github";
import type { ActionConfig, AuditType, Severity } from "./types";
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

function parseCommaSeparated(input: string): string[] {
  if (!input.trim()) return [];
  return input
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
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
  const context = parseCommaSeparated(contextInput);

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

  const auditTypeInput = core.getInput("audit-type") || "diff";
  const targetBranchRef: string = pr.base?.ref ?? "";
  let auditType: AuditType;

  if (auditTypeInput.includes(":")) {
    // Branch mapping format: "main:full,dev:diff"
    const mappings = auditTypeInput.split(",").map((m) => m.trim());
    let resolved: AuditType = "diff"; // default fallback
    for (const mapping of mappings) {
      const [branch, type] = mapping.split(":").map((s) => s.trim());
      if (branch === targetBranchRef && (type === "full" || type === "diff")) {
        resolved = type;
        break;
      }
    }
    auditType = resolved;
    core.info(`Branch "${targetBranchRef}" resolved to audit type: ${auditType}`);
  } else if (auditTypeInput === "full" || auditTypeInput === "diff") {
    auditType = auditTypeInput;
  } else {
    throw new Error(
      'audit-type must be "full", "diff", or a branch mapping like "main:full,dev:diff".'
    );
  }

  const scopeInput = core.getInput("scope") || "";
  const scope = parseCommaSeparated(scopeInput);

  return {
    apiKey: core.getInput("api-key", { required: true }),
    apiBaseUrl: (
      core.getInput("api-base-url") || "https://zeus.certora.com"
    ).replace(/\/$/, ""),
    auditType,
    context,
    scope: scope.length > 0 ? scope : undefined,
    githubToken: core.getInput("github-token", { required: true }),
    preprompt: core.getInput("preprompt") || undefined,
    useMemory: core.getInput("use-memory") !== "false",
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
    labels: (core.getInput("labels") || "auto-prover,security")
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean),
    target,
    branchStarting: baseSha,
    branchEnding: headSha,
    prNumber: pr.number,
  };
}
