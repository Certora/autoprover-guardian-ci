import * as core from "@actions/core";
import * as github from "@actions/github";
import type { ActionConfig, ModelMode, Severity, Workflow } from "./types";
import {
  CONTRACT_NAME_MAX,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_TIMEOUT,
  FINDING_MAX,
  INSTRUCTIONS_MAX,
  PATTERN_ARRAY_MAX,
  PATTERN_MAX,
  REPOSITORY_PATH_MAX,
  SHA_REGEX,
} from "./constants";

const VALID_SEVERITIES = new Set<string>(["HIGH", "MEDIUM", "LOW", "INFO"]);
const VALID_WORKFLOWS = new Set<string>([
  "ai-auditor-full",
  "ai-auditor-diff",
  "ai-auditor-finding-validation",
  "auto-prover",
  "auto-fuzzer",
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

function parsePatternInput(input: string, name: string): string[] {
  const value = input.trim();
  if (!value) return [];

  if (value.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      // A leading character class or literal bracket filename is still a
      // legacy glob. A leading JSON string (or unfinished array) is not:
      // never silently reinterpret a malformed explicit context as a glob.
      if (/^\[\s*(?:"|$)/.test(value)) {
        throw new Error(`${name} must be a valid JSON array of pattern strings.`);
      }
    }
    if (Array.isArray(parsed)) {
      if (parsed.some((pattern) => typeof pattern !== "string" || !pattern.trim())) {
        throw new Error(`${name} must be a JSON array of non-empty pattern strings.`);
      }
      return (parsed as string[]).map((pattern) => pattern.trim());
    }
  }

  // Preserve commas inside brace globs, character classes, and extglobs.
  // JSON arrays are the unambiguous format for literal comma filenames.
  const patterns: string[] = [];
  const closing: string[] = [];
  let start = 0;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "{" || character === "[" || character === "(") {
      closing.push(character === "{" ? "}" : character === "[" ? "]" : ")");
    } else if (character === closing.at(-1)) {
      closing.pop();
    } else if (character === "," && closing.length === 0) {
      patterns.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  // Keep historical CSV behavior for unbalanced literal path punctuation.
  if (closing.length > 0) return parseCommaSeparated(value);
  patterns.push(value.slice(start).trim());
  return patterns.filter(Boolean);
}

function parseApiPatternList(input: string, name: string): string[] {
  const patterns = parsePatternInput(input, name);
  if (patterns.length > PATTERN_ARRAY_MAX) {
    throw new Error(
      `${name} must contain at most ${PATTERN_ARRAY_MAX} patterns.`,
    );
  }
  for (const pattern of patterns) {
    if (pattern.length > PATTERN_MAX) {
      throw new Error(
        `${name} patterns must be at most ${PATTERN_MAX} characters.`,
      );
    }
    if (pattern.includes("\u0000")) {
      throw new Error(`${name} patterns must not contain null bytes.`);
    }
  }
  return patterns;
}

function parseOptionalApiText(
  input: string,
  name: string,
  max: number,
): string | undefined {
  if (!input) return undefined;
  if (input.length > max) {
    throw new Error(`${name} must be at most ${max} characters.`);
  }
  if (input.includes("\u0000")) {
    throw new Error(`${name} must not contain null bytes.`);
  }
  return input;
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
      'workflow must be "ai-auditor-full", "ai-auditor-diff", "ai-auditor-finding-validation", "auto-prover", or "auto-fuzzer".',
    );
  }
  return workflow as Workflow;
}

function parseModelMode(input: string): ModelMode | undefined {
  const mode = input.trim();
  if (!mode) return undefined;
  if (mode !== "normal" && mode !== "frontier") {
    throw new Error('model-mode must be "normal" or "frontier".');
  }
  return mode;
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
  const modelModeInput = core.getInput("model-mode");
  if (workflow === "auto-prover" || workflow === "auto-fuzzer") {
    if (modelModeInput.trim()) {
      throw new Error("model-mode is only supported by AI Auditor workflows.");
    }
    const baseRepository = pr.base?.repo?.full_name;
    const headRepository = pr.head?.repo?.full_name;
    if (
      !baseRepository ||
      !headRepository ||
      baseRepository.toLowerCase() !== headRepository.toLowerCase()
    ) {
      throw new Error(
        "AutoProver and AutoFuzzer require a same-repository pull request; fork pull requests cannot receive generated files.",
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

  if (workflow === "auto-prover" || workflow === "auto-fuzzer") {
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
    if (workflow === "auto-fuzzer" && threatModelPath) {
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
  const context = parseApiPatternList(contextInput, "context");

  const modelMode = parseModelMode(modelModeInput);

  if (workflow === "ai-auditor-finding-validation") {
    const finding = core.getInput("finding").trim();
    if (!finding) {
      throw new Error("finding is required for this workflow.");
    }
    if (finding.length > FINDING_MAX) {
      throw new Error(`finding must be at most ${FINDING_MAX} characters.`);
    }
    if (finding.includes("\u0000")) {
      throw new Error("finding must not contain null bytes.");
    }
    return {
      ...common,
      workflow,
      context,
      modelMode,
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
  const scope = parseApiPatternList(scopeInput, "scope");
  if (workflow === "ai-auditor-full" && context.length === 0 && scope.length === 0) {
    throw new Error("scope is required for full audits when context is selected automatically.");
  }

  return {
    ...common,
    workflow,
    context,
    modelMode,
    scope: scope.length > 0 ? scope : undefined,
    instructions: parseOptionalApiText(
      core.getInput("instructions"),
      "instructions",
      INSTRUCTIONS_MAX,
    ),
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
