import * as core from "@actions/core";
import * as github from "@actions/github";
import type { ActionConfig, AuditType, Engine, Severity } from "./types";
import {
  CONTRACT_NAME_MAX,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_TIMEOUT,
  REPOSITORY_PATH_MAX,
  SHA_REGEX,
} from "./constants";

const VALID_SEVERITIES = new Set<string>(["HIGH", "MEDIUM", "LOW", "INFO"]);
const VALID_ENGINES = new Set<string>([
  "ai-auditor",
  "auto-prover",
  "auto-foundry",
]);
const SOLIDITY_IDENTIFIER_REGEX = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const DOCUMENT_EXTENSIONS = new Set(["md", "markdown", "pdf"]);

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

function parsePositiveInteger(input: string, name: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function parseEngine(input: string): Engine {
  const engine = input || "ai-auditor";
  if (!VALID_ENGINES.has(engine)) {
    throw new Error(
      'engine must be "ai-auditor", "auto-prover", or "auto-foundry".',
    );
  }
  return engine as Engine;
}

function validateRepositoryPath(
  input: string,
  name: string,
  required: boolean,
): string | undefined {
  const path = input.trim();
  if (!path) {
    if (required) {
      throw new Error(`${name} is required for this engine.`);
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
  const apiConfig = {
    apiKey: core.getInput("api-key", { required: true }),
    apiBaseUrl: (
      core.getInput("api-base-url") || "https://zeus.certora.com"
    ).replace(/\/+$/, ""),
    githubToken: core.getInput("github-token", { required: true }),
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
  const target = `https://github.com/${owner}/${repo}`;
  const engine = parseEngine(core.getInput("engine"));
  if (engine === "auto-prover" || engine === "auto-foundry") {
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
    commentOnPr: core.getInput("comment-on-pr") !== "false",
    target,
    branchStarting: baseSha,
    branchEnding: headSha,
    prNumber: pr.number,
  };

  if (engine === "auto-prover" || engine === "auto-foundry") {
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
      throw new Error("contract-name is required for this engine.");
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
    if (engine === "auto-foundry" && threatModelPath) {
      throw new Error("threat-model-path is only supported by auto-prover.");
    }

    return {
      ...common,
      engine,
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
    core.info(
      `Branch "${targetBranchRef}" resolved to audit type: ${auditType}`,
    );
  } else if (auditTypeInput === "full" || auditTypeInput === "diff") {
    auditType = auditTypeInput;
  } else {
    throw new Error(
      'audit-type must be "full", "diff", or a branch mapping like "main:full,dev:diff".',
    );
  }

  const scopeInput = core.getInput("scope") || "";
  const scope = parseCommaSeparated(scopeInput);

  return {
    ...common,
    engine,
    auditType,
    context,
    scope: scope.length > 0 ? scope : undefined,
    preprompt: core.getInput("preprompt") || undefined,
    useMemory: core.getInput("use-memory") !== "false",
    maxIterations,
    skipSubmodules: core.getInput("skip-submodules") === "true",
    createIssues: core.getInput("create-issues") !== "false",
    issueSeverities: parseSeverities(
      core.getInput("issue-severities") || "HIGH,MEDIUM",
    ),
    commentOnPr: core.getInput("comment-on-pr") !== "false",
    failOn: parseSeverities(core.getInput("fail-on") || ""),
    labels: (core.getInput("labels") || "ai-auditor,security")
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean),
  };
}
