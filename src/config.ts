import * as core from "@actions/core";
import * as github from "@actions/github";
import type { ActionConfig, Severity, Workflow } from "./types";
import {
  CONTRACT_NAME_MAX,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_TIMEOUT,
  REPOSITORY_PATH_MAX,
  SHA_REGEX,
} from "./constants";

const VALID_SEVERITIES = new Set<string>(["HIGH", "MEDIUM", "LOW", "INFO"]);
const VALID_WORKFLOWS = new Set<string>([
  "ai-auditor-full",
  "ai-auditor-diff",
  "ai-auditor-finding-validation",
  "auto-prover",
  "auto-foundry",
]);
const SOLIDITY_IDENTIFIER_REGEX = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const DOCUMENT_EXTENSIONS = new Set(["md", "markdown", "pdf"]);

function parseSeverities(input: string, name: string): Severity[] {
  if (!input.trim()) return [];
  return input
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .map((s) => {
      if (!VALID_SEVERITIES.has(s)) {
        throw new Error(
          `${name} contains unsupported severity "${s}". Use HIGH, MEDIUM, LOW, or INFO.`,
        );
      }
      return s;
    }) as Severity[];
}

function parseCommaSeparated(input: string): string[] {
  if (!input.trim()) return [];
  return input
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function parsePositiveInteger(input: string, name: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function parseBoolean(
  input: string,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = input.trim().toLowerCase();
  if (!value) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be either true or false.`);
}

function validateApiBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("api-base-url must be a valid absolute URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "api-base-url must not contain credentials, a query, or a fragment.",
    );
  }
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error(
      "api-base-url must use HTTPS (HTTP is allowed only for local loopback development).",
    );
  }
  return url.href.replace(/\/+$/, "");
}

function parseWorkflow(input: string): Workflow {
  const workflow = input || "ai-auditor-diff";
  if (!VALID_WORKFLOWS.has(workflow)) {
    throw new Error(
      'workflow must be "ai-auditor-full", "ai-auditor-diff", "ai-auditor-finding-validation", "auto-prover", or "auto-foundry".',
    );
  }
  return workflow as Workflow;
}

function validateRepositoryPath(
  input: string,
  name: string,
  required: boolean,
): string | undefined {
  const path = input.trim();
  if (!path) {
    if (required) {
      throw new Error(`${name} is required for this workflow.`);
    }
    return undefined;
  }
  if (path.length > REPOSITORY_PATH_MAX) {
    throw new Error(
      `${name} must be at most ${REPOSITORY_PATH_MAX} characters.`,
    );
  }

  const segments = path.split("/");
  if (
    Array.from(path).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment === "...",
    )
  ) {
    throw new Error(
      `${name} must be a repository-relative path without traversal.`,
    );
  }
  return path;
}

function validateDocumentPath(input: string, name: string): string | undefined {
  const path = validateRepositoryPath(input, name, false);
  if (!path) return undefined;

  const extension = path.split(".").pop()?.toLowerCase();
  if (!extension || !DOCUMENT_EXTENSIONS.has(extension)) {
    throw new Error(`${name} must point to a .md, .markdown, or .pdf file.`);
  }
  return path;
}

export function getConfig(): ActionConfig {
  const apiKey = core.getInput("api-key", { required: true });
  const githubToken = core.getInput("github-token", { required: true });
  core.setSecret(apiKey);
  core.setSecret(githubToken);
  const apiConfig = {
    apiKey,
    apiBaseUrl: validateApiBaseUrl(
      core.getInput("api-base-url") || "https://app.certora.com",
    ),
    githubToken,
  };
  const pr = github.context.payload.pull_request;
  if (!pr) {
    throw new Error(
      "This action must be triggered by a pull_request event. No pull_request payload found.",
    );
  }

  const baseSha: string = pr.base?.sha;
  const headSha: string = pr.head?.sha;

  if (!baseSha || !SHA_REGEX.test(baseSha)) {
    throw new Error(
      `Invalid base SHA: "${baseSha}". Expected a 40-character hex string.`,
    );
  }
  if (!headSha || !SHA_REGEX.test(headSha)) {
    throw new Error(
      `Invalid head SHA: "${headSha}". Expected a 40-character hex string.`,
    );
  }

  const { owner, repo } = github.context.repo;
  const repositoryUrl = `https://github.com/${owner}/${repo}`;
  const repositoryPrivateValue = github.context.payload.repository?.private;
  if (typeof repositoryPrivateValue !== "boolean") {
    throw new Error(
      "The pull request payload is missing repository visibility.",
    );
  }
  const repositoryPrivate = repositoryPrivateValue;
  const workflow = parseWorkflow(core.getInput("workflow"));
  if (workflow === "auto-prover" || workflow === "auto-foundry") {
    const baseRepository = pr.base?.repo?.full_name;
    const headRepository = pr.head?.repo?.full_name;
    if (
      !baseRepository ||
      !headRepository ||
      baseRepository.toLowerCase() !== headRepository.toLowerCase()
    ) {
      throw new Error(
        "AutoProver and AutoFoundry require a same-repository pull request; fork pull requests cannot receive generated files.",
      );
    }
  }
  const common = {
    ...apiConfig,
    pollInterval: parsePositiveInteger(
      core.getInput("poll-interval") || String(DEFAULT_POLL_INTERVAL),
      "poll-interval",
    ),
    timeout: parsePositiveInteger(
      core.getInput("timeout") || String(DEFAULT_TIMEOUT),
      "timeout",
    ),
    commentOnPr: parseBoolean(
      core.getInput("comment-on-pr"),
      "comment-on-pr",
      true,
    ),
    workflow,
    repositoryUrl,
    repositoryPrivate,
    baseCommitSha: baseSha,
    headCommitSha: headSha,
    prNumber: parsePositiveInteger(String(pr.number), "pull request number"),
    githubRunAttempt: parsePositiveInteger(
      String(github.context.runAttempt),
      "GitHub run attempt",
    ),
    idempotencySeed: [
      github.context.runId,
      github.context.job,
      workflow,
      pr.number,
      headSha,
    ].join(":"),
  };

  if (workflow === "auto-prover" || workflow === "auto-foundry") {
    const contractPath = validateRepositoryPath(
      core.getInput("contract-path"),
      "contract-path",
      true,
    ) as string;
    if (!contractPath.endsWith(".sol")) {
      throw new Error("contract-path must point to a .sol file.");
    }

    const contractName = core.getInput("contract-name").trim();
    if (!contractName) {
      throw new Error("contract-name is required for this workflow.");
    }
    if (contractName.length > CONTRACT_NAME_MAX) {
      throw new Error(
        `contract-name must be at most ${CONTRACT_NAME_MAX} characters.`,
      );
    }
    if (!SOLIDITY_IDENTIFIER_REGEX.test(contractName)) {
      throw new Error("contract-name must be a valid Solidity identifier.");
    }

    const designDocPath = validateDocumentPath(
      core.getInput("design-doc-path"),
      "design-doc-path",
    );
    const threatModelPath = validateDocumentPath(
      core.getInput("threat-model-path"),
      "threat-model-path",
    );
    if (workflow === "auto-foundry" && threatModelPath) {
      throw new Error("threat-model-path is only supported by auto-prover.");
    }

    return {
      ...common,
      workflow,
      contractPath,
      contractName,
      designDocPath,
      threatModelPath,
    };
  }

  const contextInput = core.getInput("context");
  const context = parseCommaSeparated(contextInput);

  if (context.length === 0) {
    throw new Error("At least one context pattern is required.");
  }

  if (workflow === "ai-auditor-finding-validation") {
    const finding = core.getInput("finding").trim();
    if (!finding) {
      throw new Error("finding is required for this workflow.");
    }
    if (finding.length > 8_000) {
      throw new Error("finding must be at most 8000 characters.");
    }
    if (finding.includes("\u0000")) {
      throw new Error("finding must not contain null bytes.");
    }
    return {
      ...common,
      workflow,
      context,
      finding,
      skipSubmodules: parseBoolean(
        core.getInput("skip-submodules"),
        "skip-submodules",
        false,
      ),
    };
  }

  const maxIterations = Number(
    core.getInput("max-iterations") || String(DEFAULT_MAX_ITERATIONS),
  );
  if (
    !Number.isSafeInteger(maxIterations) ||
    maxIterations < 4 ||
    maxIterations > 10
  ) {
    throw new Error("max-iterations must be between 4 and 10.");
  }

  const scopeInput = core.getInput("scope") || "";
  const scope = parseCommaSeparated(scopeInput);

  return {
    ...common,
    workflow,
    context,
    scope: scope.length > 0 ? scope : undefined,
    instructions: core.getInput("instructions") || undefined,
    useMemory: parseBoolean(core.getInput("use-memory"), "use-memory", true),
    maxIterations,
    skipSubmodules: parseBoolean(
      core.getInput("skip-submodules"),
      "skip-submodules",
      false,
    ),
    createIssues: parseBoolean(
      core.getInput("create-issues"),
      "create-issues",
      true,
    ),
    issueSeverities: parseSeverities(
      core.getInput("issue-severities") || "HIGH,MEDIUM",
      "issue-severities",
    ),
    failOn: parseSeverities(core.getInput("fail-on") || "", "fail-on"),
    labels: (core.getInput("labels") || "ai-auditor,security")
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean),
  };
}
