import * as core from "@actions/core";
import { createHash } from "node:crypto";
import { formatProgressPhase, formatRunFailure } from "./automatic-context";
import {
  AutoProverApi,
  AutoProverApiDeadlineError,
  createIdempotencyKey,
} from "./api";
import { getConfig } from "./config";
import { isServerManagedGithubDelivery } from "./delivery";
import {
  formatAiAuditorMarkdownPrComment,
  formatFindingValidationPrComment,
  formatPrComment,
  formatStandalonePrComment,
  getStandaloneWarnings,
  isFailingStandaloneOutcome,
} from "./format";
import { GitHubClient } from "./github";
import type {
  ActionConfig,
  AiAuditorActionConfig,
  AiAuditorGithubDeliveryRequest,
  AissRunReport,
  AuditFindings,
  CommitGeneratedFilesResponse,
  Finding,
  FindingValidationActionConfig,
  FindingValidationModelVerdict,
  FindingValidationReport,
  ModelMode,
  PublicReport,
  Run,
  RunRequest,
  RunResult,
  ServerManagedGithubDelivery,
  Severity,
  StandaloneActionConfig,
} from "./types";
import { workflowEngine, workflowRunType } from "./types";
import {
  AI_AUDITOR_CHECK_NAME,
  CANCELLATION_REQUEST_TIMEOUT_MS,
  MAX_CONSECUTIVE_POLL_FAILURES,
  modelModeLabel,
  prCommentMarker,
  SHA_REGEX,
  SHUTDOWN_CANCEL_TIMEOUT_MS,
} from "./constants";

function sleep(ms: number): Promise<void> {
  const until = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      const remaining = until - Date.now();
      if (remaining <= 0) resolve();
      else setTimeout(tick, Math.min(remaining, 30_000));
    };
    tick();
  });
}

function getAllFindings(findings: AuditFindings): Finding[] {
  return [
    ...findings.highs,
    ...findings.mediums,
    ...findings.lows,
    ...findings.infos,
  ];
}

function getFindingsBySeverities(
  findings: AuditFindings,
  severities: Severity[],
): Finding[] {
  const selected = new Set(severities);
  return getAllFindings(findings).filter((finding) =>
    selected.has(finding.severity),
  );
}

function parseUsd(value: string | null | undefined): number | null {
  const parsed = Number(value);
  return value !== null && value !== undefined && Number.isFinite(parsed)
    ? parsed
    : null;
}

function initializeOutputs(): void {
  core.setOutput("run-id", "");
  core.setOutput("workflow", "");
  core.setOutput("model-mode", "");
  core.setOutput("status", "");
  core.setOutput("run-outcome", "");
  core.setOutput("validation-verdict", "");
  core.setOutput("validation-severity", "");
  core.setOutput("generated-files", "");
  core.setOutput("generated-commit-sha", "");
  core.setOutput("issues-created", "");
  core.setOutput("check-run-id", "");
  core.setOutput("check-run-url", "");
  core.setOutput("highs-count", "0");
  core.setOutput("mediums-count", "0");
  core.setOutput("lows-count", "0");
  core.setOutput("infos-count", "0");
}

function sourceAuthentication(config: ActionConfig) {
  return config.repositoryPrivate
    ? ({ type: "organization_github_app" } as const)
    : ({ type: "public" } as const);
}

function isStandaloneConfig(
  config: ActionConfig,
): config is StandaloneActionConfig {
  return config.workflow === "auto-prover" || config.workflow === "auto-fuzzer";
}

function isFindingValidationConfig(
  config: ActionConfig,
): config is FindingValidationActionConfig {
  return config.workflow === "ai-auditor-finding-validation";
}

function isAsyncAuditConfig(
  config: ActionConfig,
): config is AiAuditorActionConfig {
  return (
    (config.workflow === "ai-auditor-full" ||
      config.workflow === "ai-auditor-diff") &&
    !config.waitForCompletion
  );
}

function aiAuditorDelivery(
  config: AiAuditorActionConfig,
): AiAuditorGithubDeliveryRequest {
  return {
    type: "github_pull_request",
    pull_request_number: config.prNumber,
    head_commit_sha: config.headCommitSha,
    comment_on_pr: config.commentOnPr,
    create_issues: config.createIssues,
    issue_severities: config.issueSeverities,
    fail_on: config.failOn,
    labels: config.labels,
  };
}

function configurationReferenceId(config: ActionConfig): string | undefined {
  return config.configurationId === undefined
    ? undefined
    : createHash("sha256").update(config.configurationId).digest("hex");
}

function clientReference(
  config: ActionConfig,
  sourceCommitSha = config.headCommitSha,
): string {
  return [
    "certora-guardian",
    `pr-${config.prNumber}`,
    sourceCommitSha,
    config.workflow,
    ...(config.configurationId
      ? ["configuration", configurationReferenceId(config)]
      : []),
  ].join(":");
}

export function buildRunRequest(config: ActionConfig): RunRequest {
  const authentication = sourceAuthentication(config);
  const reference = clientReference(config);

  if (config.workflow === "ai-auditor-diff") {
    return {
      source: {
        repository_url: config.repositoryUrl,
        base_commit_sha: config.baseCommitSha,
        head_commit_sha: config.headCommitSha,
        authentication,
      },
      context: config.context,
      ...(config.modelMode !== undefined
        ? { model_mode: config.modelMode }
        : {}),
      instructions: config.instructions,
      skip_submodules: config.skipSubmodules,
      max_iterations: config.maxIterations,
      ...(config.waitForCompletion
        ? {}
        : { delivery: aiAuditorDelivery(config) }),
      client_reference: reference,
    };
  }

  if (config.workflow === "ai-auditor-full") {
    return {
      source: {
        repository_url: config.repositoryUrl,
        commit_sha: config.headCommitSha,
        authentication,
      },
      context: config.context,
      ...(config.modelMode !== undefined
        ? { model_mode: config.modelMode }
        : {}),
      scope: config.scope,
      instructions: config.instructions,
      use_memory: config.useMemory,
      skip_submodules: config.skipSubmodules,
      max_iterations: config.maxIterations,
      ...(config.waitForCompletion
        ? {}
        : { delivery: aiAuditorDelivery(config) }),
      client_reference: reference,
    };
  }

  if (config.workflow === "ai-auditor-finding-validation") {
    return {
      source: {
        repository_url: config.repositoryUrl,
        commit_sha: config.headCommitSha,
        authentication,
      },
      context: config.context,
      ...(config.modelMode !== undefined
        ? { model_mode: config.modelMode }
        : {}),
      finding: config.finding,
      skip_submodules: config.skipSubmodules,
      client_reference: reference,
    };
  }

  const standaloneConfig = config as StandaloneActionConfig;
  return {
    source: {
      repository_url: config.repositoryUrl,
      commit_sha: config.headCommitSha,
      authentication,
    },
    contract: {
      path: standaloneConfig.contractPath,
      name: standaloneConfig.contractName,
    },
    documents:
      standaloneConfig.designDocPath || standaloneConfig.threatModelPath
        ? {
            design: standaloneConfig.designDocPath,
            threat_model: standaloneConfig.threatModelPath,
          }
        : undefined,
    delivery: {
      type: "github_pull_request",
      pull_request_number: config.prNumber,
    },
    client_reference: reference,
  };
}

function isFinding(value: unknown): value is Finding {
  if (!value || typeof value !== "object") return false;
  const finding = value as Partial<Finding>;
  return (
    typeof finding.id === "string" &&
    typeof finding.title === "string" &&
    ["HIGH", "MEDIUM", "LOW", "INFO"].includes(finding.severity ?? "") &&
    Array.isArray(finding.locations) &&
    finding.locations.every((location) => typeof location === "string") &&
    typeof finding.description === "string" &&
    typeof finding.recommendation === "string"
  );
}

function readAiAuditorFindings(report: unknown): AuditFindings {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("AI Auditor returned an invalid v2 report envelope.");
  }
  const publicReport = report as { format?: unknown; content?: unknown };
  if (publicReport.format === "markdown") {
    if (typeof publicReport.content !== "string") {
      throw new Error("AI Auditor returned an invalid Markdown report.");
    }
    throw new Error(
      "AI Auditor returned a Markdown report; structured JSON findings are required by this action.",
    );
  }
  if (publicReport.format !== "json" || !("content" in publicReport)) {
    throw new Error("AI Auditor returned an invalid v2 report envelope.");
  }
  const content = publicReport.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("AI Auditor returned an invalid JSON report.");
  }
  const findings = (content as { findings?: unknown }).findings;
  if (!findings || typeof findings !== "object") {
    throw new Error("AI Auditor v2 report is missing structured findings.");
  }
  const candidate = findings as Partial<AuditFindings>;
  const buckets = {
    highs: "HIGH",
    mediums: "MEDIUM",
    lows: "LOW",
    infos: "INFO",
  } as const;
  for (const [key, expectedSeverity] of Object.entries(buckets) as [
    keyof typeof buckets,
    Severity,
  ][]) {
    if (
      !Array.isArray(candidate[key]) ||
      !candidate[key].every(
        (finding) =>
          isFinding(finding) && finding.severity === expectedSeverity,
      )
    ) {
      throw new Error(`AI Auditor v2 report has invalid ${key}.`);
    }
  }
  return candidate as AuditFindings;
}

function isStatusCounts(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as { status?: unknown }).status === "string" &&
        Number.isSafeInteger((entry as { count?: unknown }).count) &&
        (entry as { count: number }).count >= 0,
    )
  );
}

function readStandaloneReport(report: unknown): AissRunReport {
  if (!report || typeof report !== "object") {
    throw new Error("Standalone workflow returned an invalid v2 report.");
  }
  const candidate = report as Partial<AissRunReport>;
  if (
    typeof candidate.schema_version !== "string" ||
    (candidate.backend !== "prover" &&
      candidate.backend !== "foundry" &&
      candidate.backend !== null) ||
    typeof candidate.contract_name !== "string" ||
    ![
      "verified",
      "verified_with_gaps",
      "partial",
      "issues_found",
      "unknown",
    ].includes(candidate.outcome ?? "") ||
    !isStatusCounts(candidate.rule_counts) ||
    !Array.isArray(candidate.skipped) ||
    !Array.isArray(candidate.gave_up_components) ||
    !candidate.coverage ||
    typeof candidate.coverage !== "object" ||
    !Number.isSafeInteger(candidate.coverage.total_properties) ||
    candidate.coverage.total_properties < 0 ||
    !Number.isSafeInteger(candidate.coverage.total_rules) ||
    candidate.coverage.total_rules < 0 ||
    !Number.isSafeInteger(candidate.coverage.total_groups) ||
    candidate.coverage.total_groups < 0 ||
    typeof candidate.coverage.property_coverage_complete !== "boolean" ||
    !Array.isArray(candidate.coverage.properties_in_no_group) ||
    !Array.isArray(candidate.coverage.rules_spanning_multiple_groups) ||
    !Number.isSafeInteger(candidate.coverage.skipped_count) ||
    candidate.coverage.skipped_count < 0 ||
    !Number.isSafeInteger(candidate.coverage.gave_up_component_count) ||
    candidate.coverage.gave_up_component_count < 0 ||
    !Number.isSafeInteger(candidate.coverage.dropped_orphan_rules) ||
    candidate.coverage.dropped_orphan_rules < 0 ||
    !Array.isArray(candidate.coverage.warnings) ||
    !candidate.coverage.warnings.every((warning) => typeof warning === "string")
  ) {
    throw new Error("Standalone workflow returned a malformed v2 report.");
  }
  return candidate as AissRunReport;
}

function readModelVerdict(
  value: unknown,
): FindingValidationModelVerdict | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.verdict !== "VALID" && candidate.verdict !== "INVALID") ||
    (candidate.severity !== undefined &&
      candidate.severity !== null &&
      typeof candidate.severity !== "string") ||
    (candidate.reasoning !== undefined &&
      typeof candidate.reasoning !== "string")
  ) {
    return undefined;
  }
  return {
    verdict: candidate.verdict,
    severity:
      typeof candidate.severity === "string" ? candidate.severity : null,
    reasoning:
      typeof candidate.reasoning === "string" ? candidate.reasoning : "",
  };
}

function readFindingValidationReport(
  report: PublicReport,
): FindingValidationReport | null {
  if (
    report.format !== "json" ||
    !report.content ||
    typeof report.content !== "object" ||
    Array.isArray(report.content)
  ) {
    return null;
  }
  const candidate = report.content as Record<string, unknown>;
  const consensusMethods = new Set([
    "unanimous_valid",
    "unanimous_invalid",
    "tiebreaker_valid",
    "tiebreaker_invalid",
  ]);
  const claudeVerdict = readModelVerdict(candidate.claude_verdict);
  const gptVerdict = readModelVerdict(candidate.gpt_verdict);
  const tiebreakerVerdict = readModelVerdict(
    candidate.tiebreaker_verdict ?? null,
  );
  if (
    (candidate.final_verdict !== "VALID" &&
      candidate.final_verdict !== "INVALID") ||
    (candidate.final_severity !== null &&
      typeof candidate.final_severity !== "string") ||
    typeof candidate.consensus_method !== "string" ||
    !consensusMethods.has(candidate.consensus_method) ||
    typeof candidate.analysis_status !== "string" ||
    claudeVerdict === undefined ||
    gptVerdict === undefined ||
    tiebreakerVerdict === undefined
  ) {
    return null;
  }
  const optionalString = (key: string): string =>
    typeof candidate[key] === "string" ? candidate[key] : "";
  return {
    final_verdict: candidate.final_verdict,
    final_severity: candidate.final_severity,
    severity_reasoning: optionalString("severity_reasoning"),
    impact: optionalString("impact"),
    likelihood: optionalString("likelihood"),
    false_positive_reasoning:
      typeof candidate.false_positive_reasoning === "string"
        ? candidate.false_positive_reasoning
        : null,
    consensus_method:
      candidate.consensus_method as FindingValidationReport["consensus_method"],
    analysis_status: candidate.analysis_status,
    claude_verdict: claudeVerdict,
    gpt_verdict: gptVerdict,
    tiebreaker_verdict: tiebreakerVerdict,
  };
}

function validateResultIdentity(
  result: RunResult,
  runId: string,
  config: ActionConfig,
): void {
  if (
    result.schema_version !== "1" ||
    result.run_id !== runId ||
    result.run_type !== workflowRunType(config.workflow)
  ) {
    throw new Error("Certora returned a result for a different run.");
  }
  if (isStandaloneConfig(config)) {
    if (
      result.run_type !== "auto_prover" &&
      result.run_type !== "auto_fuzzer"
    ) {
      throw new Error("Certora returned a result for a different workflow.");
    }
    if (
      result.data.contract.path !== config.contractPath ||
      result.data.contract.name !== config.contractName
    ) {
      throw new Error("Certora returned a result for a different contract.");
    }
  } else if (
    isFindingValidationConfig(config) &&
    result.run_type !== "ai_auditor_finding_validation"
  ) {
    throw new Error("Certora returned a result for a different workflow.");
  }
}

function validateRunIdentity(
  run: Run,
  config: ActionConfig,
  expectedRunId: string,
  expectedSourceCommitSha = config.headCommitSha,
  expectedReference = clientReference(config, expectedSourceCommitSha),
): void {
  const expectedCommit = expectedSourceCommitSha.toLowerCase();
  const actualCommit =
    config.workflow === "ai-auditor-diff"
      ? run.source.head_commit_sha
      : run.source.commit_sha;
  const baseCommitMatches =
    config.workflow !== "ai-auditor-diff" ||
    run.source.base_commit_sha?.toLowerCase() ===
      config.baseCommitSha.toLowerCase();
  if (
    run.id !== expectedRunId ||
    run.run_type !== workflowRunType(config.workflow) ||
    run.source.repository_url.toLowerCase() !==
      config.repositoryUrl.toLowerCase() ||
    actualCommit?.toLowerCase() !== expectedCommit ||
    !baseCommitMatches ||
    run.client_reference !== expectedReference
  ) {
    throw new Error("Certora returned a run for a different source.");
  }
  if (
    !isStandaloneConfig(config) &&
    config.modelMode !== undefined &&
    run.model_mode != null &&
    run.model_mode !== config.modelMode
  ) {
    throw new Error("Certora returned a run for a different model mode.");
  }
  if (
    isStandaloneConfig(config) &&
    (run.delivery?.type !== "github_pull_request" ||
      run.delivery.pull_request_number !== config.prNumber)
  ) {
    throw new Error(
      "Certora returned a run bound to a different pull request.",
    );
  }
}

function validateAsyncDelivery(
  run: Run,
  config: AiAuditorActionConfig,
): ServerManagedGithubDelivery {
  const delivery = run.delivery;
  if (
    !isServerManagedGithubDelivery(delivery) ||
    delivery.pull_request_number !== config.prNumber ||
    delivery.check.head_sha !== config.headCommitSha ||
    !new URL(delivery.check.html_url).pathname
      .toLowerCase()
      .startsWith(`${new URL(config.repositoryUrl).pathname.toLowerCase()}/`)
  ) {
    throw new Error(
      `Certora accepted run ${run.id}, but did not confirm a server-owned ${AI_AUDITOR_CHECK_NAME} check for this pull request and head commit. The run has not been cancelled. Rerun with the same inputs and API key to recover it; do not change inputs to work around a missing handoff.`,
    );
  }
  return delivery;
}

function publishAsyncHandoff(run: Run, config: AiAuditorActionConfig): void {
  const delivery = validateAsyncDelivery(run, config);
  core.setOutput("check-run-id", String(delivery.check.id));
  core.setOutput("check-run-url", delivery.check.html_url);
  core.info(
    `Server-owned ${AI_AUDITOR_CHECK_NAME}: ${delivery.check.html_url}`,
  );
  core.info(`Audit dashboard: ${run.dashboard_url}`);
  core.info(
    `Audit handoff confirmed. This workflow confirms launch, not a clean audit; the separate ${AI_AUDITOR_CHECK_NAME} check owns the final result and fail-on policy. No runner-side cancellation or result publishing will follow.`,
  );
}

let activeRun: {
  api: AutoProverApi;
  runId: string;
  config: ActionConfig;
} | null = null;
let shutdownHandlersRegistered = false;
let shuttingDown = false;

async function requestCancellation(
  api: AutoProverApi,
  runId: string,
  config: ActionConfig,
  deadlineMs?: number,
): Promise<Run> {
  const response =
    deadlineMs === undefined
      ? await api.cancelRun(runId)
      : await api.cancelRun(runId, deadlineMs);
  validateRunIdentity(response.run, config, runId);
  core.info(
    `Cancellation request accepted; run status is ${response.run.status}.`,
  );
  return response.run;
}

function registerShutdownHandlers(): void {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;
  const handler = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (activeRun) {
      core.info(
        `Received ${signal}; requesting cancellation for Certora run ${activeRun.runId}...`,
      );
      try {
        await requestCancellation(
          activeRun.api,
          activeRun.runId,
          activeRun.config,
          Date.now() + SHUTDOWN_CANCEL_TIMEOUT_MS,
        );
      } catch (error) {
        core.warning(
          `Failed to request cancellation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    process.exit(1);
  };
  process.on("SIGTERM", () => void handler("SIGTERM"));
  process.on("SIGINT", () => void handler("SIGINT"));
}

function standaloneReport(
  result: RunResult,
  runId: string,
  config: StandaloneActionConfig,
): AissRunReport {
  validateResultIdentity(result, runId, config);
  if (result.run_type !== "auto_prover" && result.run_type !== "auto_fuzzer") {
    throw new Error("Standalone workflow returned an AI Auditor result.");
  }
  const report = readStandaloneReport(result.data.report);
  if (report.contract_name !== config.contractName) {
    throw new Error(
      "Standalone workflow returned a report for a different contract.",
    );
  }
  const expectedBackend =
    config.workflow === "auto-prover" ? "prover" : "foundry";
  if (report.backend !== null && report.backend !== expectedBackend) {
    throw new Error(
      "Standalone workflow returned a report from a different backend.",
    );
  }
  return report;
}

async function publishStandaloneResult(args: {
  api: AutoProverApi;
  config: StandaloneActionConfig;
  ghClient: GitHubClient;
  run: Run;
  runId: string;
  requireCommitSha?: string;
  summaryHeadSha?: string;
  prepared?: { result: RunResult; commit: CommitGeneratedFilesResponse };
}): Promise<void> {
  const {
    api,
    config,
    ghClient,
    run,
    runId,
    requireCommitSha,
    summaryHeadSha,
  } = args;
  const result = args.prepared?.result ?? (await api.getResult(runId)).result;
  const report = standaloneReport(result, runId, config);
  const commit =
    args.prepared?.commit ?? (await api.commitGeneratedFiles(runId));
  if (
    !requireCommitSha &&
    commit.delivery.status === "committed" &&
    commit.delivery.commit_sha?.toLowerCase() ===
      config.headCommitSha.toLowerCase()
  ) {
    throw new Error(
      "Generated-file delivery claimed a commit but left the pull request head unchanged.",
    );
  }

  if (requireCommitSha) {
    if (
      commit.delivery.commit_sha?.toLowerCase() !==
      requireCommitSha.toLowerCase()
    ) {
      throw new Error(
        `Generated follow-up commit mismatch: expected ${requireCommitSha}, received ${commit.delivery.commit_sha ?? "none"}.`,
      );
    }
  }

  core.setOutput("run-id", runId);
  core.setOutput("workflow", config.workflow);
  core.setOutput("status", run.status);
  core.setOutput("run-outcome", report.outcome);
  core.setOutput(
    "generated-files",
    commit.delivery.files.map((file) => file.path).join(","),
  );
  core.setOutput(
    "generated-commit-sha",
    commit.delivery.status === "committed"
      ? (commit.delivery.commit_sha ?? "")
      : "",
  );

  for (const warning of getStandaloneWarnings(report, config.workflow)) {
    core.warning(warning);
  }

  if (config.commentOnPr) {
    await ghClient.upsertPrComment(
      config.prNumber,
      formatStandalonePrComment({
        workflow: config.workflow,
        runId,
        cost: parseUsd(run.billing.charged_usd),
        report,
        commit,
      }),
      prCommentMarker(config.workflow),
      summaryHeadSha ?? commit.delivery.commit_sha ?? config.headCommitSha,
      runId,
    );
  }

  if (isFailingStandaloneOutcome(report.outcome)) {
    core.setFailed(
      config.workflow === "auto-fuzzer"
        ? "auto-fuzzer found one or more failing generated tests."
        : "auto-prover found one or more violated properties or rules.",
    );
  }
}

async function tryGeneratedFollowup(
  config: StandaloneActionConfig,
  api: AutoProverApi,
  ghClient: GitHubClient,
  deadlineMs: number,
): Promise<boolean> {
  let followup = await ghClient.getGeneratedFollowup(
    config.headCommitSha,
    deadlineMs,
  );
  if (!followup) return false;
  let commitSha = config.headCommitSha;
  let sourceSha: string | undefined;
  let matched:
    | {
        run: Run;
        commitSha: string;
        result: RunResult;
        commit: CommitGeneratedFilesResponse;
      }
    | undefined;
  const seenRuns = new Set<string>();
  const recoveryApi = completionApi(config, deadlineMs);
  // A generated push triggers every installed configuration. Attest the whole
  // generated-only chain, then recover this configuration's own result (which
  // may be below another configuration's commit), never the top trailer alone.
  for (let depth = 0; ; depth++) {
    if (depth >= 16 || seenRuns.has(followup.runId)) {
      throw new Error(
        "Generated follow-up ancestry is cyclic or exceeds 16 commits.",
      );
    }
    if (Date.now() >= deadlineMs) throw new AutoProverApiDeadlineError();
    seenRuns.add(followup.runId);
    const response = await api.getRun(followup.runId);
    const candidate = response.run;
    const workflow =
      candidate.run_type === "auto_prover"
        ? "auto-prover"
        : candidate.run_type === "auto_fuzzer"
          ? "auto-fuzzer"
          : undefined;
    const candidateSource = candidate.source.commit_sha;
    if (!workflow || !candidateSource || !SHA_REGEX.test(candidateSource)) {
      throw new Error(
        "Generated follow-up references an incompatible Certora run.",
      );
    }
    sourceSha ??= candidateSource.toLowerCase();
    if (candidateSource.toLowerCase() !== sourceSha) {
      throw new Error(
        "Generated follow-up contains runs from different source commits.",
      );
    }
    const legacyReference = clientReference(
      { ...config, workflow, configurationId: undefined },
      sourceSha,
    );
    const reference = candidate.client_reference;
    let configurationId: string | undefined;
    if (reference !== legacyReference) {
      const prefix = `${legacyReference}:configuration:`;
      configurationId = reference?.startsWith(prefix)
        ? reference.slice(prefix.length)
        : undefined;
      if (!configurationId || !/^[0-9a-f]{64}$/.test(configurationId)) {
        throw new Error(
          "Certora returned a run for a different source or configuration.",
        );
      }
    }
    validateRunIdentity(
      candidate,
      { ...config, workflow },
      followup.runId,
      sourceSha,
      reference ?? undefined,
    );
    const delivery = candidate.delivery;
    if (delivery && "managed_by" in delivery) {
      throw new Error(
        "Certora returned an audit check instead of generated-file delivery.",
      );
    }
    const completedForHead =
      delivery?.status === "succeeded" &&
      delivery.outcome === "committed" &&
      delivery.commit_sha?.toLowerCase() === commitSha.toLowerCase();
    const needsDeliveryRecovery =
      (delivery?.status === "pending" || delivery?.status === "failed") &&
      delivery.outcome === null &&
      delivery.commit_sha === null;
    if (
      candidate.status !== "succeeded" ||
      (!completedForHead && !needsDeliveryRecovery)
    ) {
      throw new Error(
        "Generated follow-up references an incompatible Certora run.",
      );
    }
    const isOwnConfiguration =
      workflow === config.workflow &&
      configurationId === configurationReferenceId(config);
    let ownResult: RunResult | undefined;
    if (isOwnConfiguration) {
      // A configured identity may not silently change contracts. Legacy
      // workflows retain their existing strict engine+contract validation.
      ownResult = (await recoveryApi.getResult(candidate.id)).result;
      standaloneReport(ownResult, candidate.id, config);
    }
    if (needsDeliveryRecovery) {
      core.info(
        `Recovering generated-file delivery for Certora run ${followup.runId}.`,
      );
    }
    const committed = await recoveryApi.commitGeneratedFiles(candidate.id);
    if (
      committed.delivery.status !== "committed" ||
      committed.delivery.commit_sha?.toLowerCase() !== commitSha.toLowerCase()
    ) {
      throw new Error(
        `Generated follow-up commit mismatch: expected ${commitSha}, received ${committed.delivery.commit_sha ?? "none"}.`,
      );
    }
    if (ownResult && !matched)
      matched = {
        run: candidate,
        commitSha,
        result: ownResult,
        commit: committed,
      };
    const parent = followup.sourceCommitSha.toLowerCase();
    if (parent === sourceSha) break;
    commitSha = parent;
    followup = await ghClient.getGeneratedFollowup(parent, deadlineMs);
    if (!followup) {
      throw new Error(
        "Generated follow-up ancestry contains an unverified contributor commit.",
      );
    }
  }
  if (matched) {
    await publishStandaloneResult({
      api: recoveryApi,
      config,
      ghClient,
      run: matched.run,
      runId: matched.run.id,
      requireCommitSha: matched.commitSha,
      summaryHeadSha: config.headCommitSha,
      prepared: { result: matched.result, commit: matched.commit },
    });
  } else {
    // A sibling-only chain is not a passing result for this configuration.
    // Its own run may have produced no files (including a failing report), so
    // recover only one exact no-files result by read-only lookup/polling. Never
    // invent an original workflow-run idempotency key or start a replacement.
    const candidates = await api.findRunsByReference({
      workflow: config.workflow,
      repositoryUrl: config.repositoryUrl,
      commitSha: sourceSha,
      clientReference: clientReference(config, sourceSha),
    });
    if (candidates.runs.length !== 1 || candidates.next_cursor !== null) {
      throw new Error(
        "No unique result exists for this configuration at the original source. No new run was launched; inspect the original run and retry this workflow after it completes.",
      );
    }
    let own = candidates.runs[0];
    const ownRunId = own.id;
    validateRunIdentity(own, config, ownRunId, sourceSha);
    // Do not reuse pollRun: its timeout/failure branches may cancel a run.
    // This run belongs to the original source workflow, not this follow-up.
    // activeRun remains null throughout, including during SIGTERM handling.
    while (
      ["queued", "running", "finalizing", "cancelling"].includes(own.status) ||
      (own.status === "succeeded" && own.delivery?.status === "pending")
    ) {
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0)
        throw new Error(
          "Timed out waiting for this configuration's original run and delivery. It was not cancelled and no new run was launched. Retry this follow-up workflow after the original run completes.",
        );
      core.info(
        `Waiting for original configuration run ${ownRunId}; no new launch or cancellation will be sent.`,
      );
      await sleep(Math.min(config.pollInterval * 1000, remaining));
      if (Date.now() >= deadlineMs)
        throw new Error(
          "Timed out waiting for this configuration's original run and delivery. It was not cancelled and no new run was launched. Retry this follow-up workflow after the original run completes.",
        );
      own = (await api.getRun(ownRunId)).run;
      validateRunIdentity(own, config, ownRunId, sourceSha);
    }
    const delivery = own.delivery;
    if (
      own.status !== "succeeded" ||
      !delivery ||
      "managed_by" in delivery ||
      delivery.status !== "succeeded" ||
      delivery.outcome !== "no_changes" ||
      delivery.commit_sha !== null ||
      delivery.files.length !== 0 ||
      delivery.renamed_files.length !== 0
    ) {
      throw new Error(
        "This configuration has no verified completed no-files result. Its original run may still be running or require delivery. No new run was launched; inspect the original run and retry this workflow after it completes.",
      );
    }
    const result = (await recoveryApi.getResult(own.id)).result;
    standaloneReport(result, own.id, config);
    await publishStandaloneResult({
      api: recoveryApi,
      config,
      ghClient,
      run: own,
      runId: own.id,
      summaryHeadSha: config.headCommitSha,
      prepared: {
        result,
        commit: {
          request_id: candidates.request_id,
          delivery: {
            status: "no_changes",
            commit_sha: null,
            files: [],
            renamed_files: [],
          },
        },
      },
    });
  }
  return true;
}

async function pollRun(
  api: AutoProverApi,
  initialRun: Run,
  runId: string,
  config: ActionConfig,
  pollIntervalSeconds: number,
  timeoutMinutes: number,
  deadlineMs: number,
): Promise<Run | null> {
  let run = initialRun;
  let consecutiveFailures = 0;

  while (
    run.status !== "succeeded" &&
    run.status !== "failed" &&
    run.status !== "cancelled"
  ) {
    if (Date.now() >= deadlineMs) {
      if (run.cancellable) {
        try {
          run = await requestCancellation(
            api,
            runId,
            config,
            Date.now() + CANCELLATION_REQUEST_TIMEOUT_MS,
          );
        } catch (error) {
          core.warning(
            `Failed to request cancellation after timeout: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (
        run.status === "succeeded" ||
        run.status === "failed" ||
        run.status === "cancelled"
      ) {
        return run;
      }
      core.setOutput("status", run.status);
      core.setFailed(
        `Certora run timed out after ${timeoutMinutes} ${timeoutMinutes === 1 ? "minute" : "minutes"}; last status: ${run.status}.`,
      );
      return null;
    }

    const delay = Math.min(
      pollIntervalSeconds * 1000,
      Math.max(0, deadlineMs - Date.now()),
    );
    if (delay > 0) await sleep(delay);
    if (Date.now() >= deadlineMs) continue;

    try {
      const polledRun = (await api.getRun(runId, deadlineMs)).run;
      validateRunIdentity(polledRun, config, runId);
      run = polledRun;
      consecutiveFailures = 0;
      const progress = run.progress;
      core.info(
        progress
          ? `Status: ${run.status} | Phase: ${formatProgressPhase(progress.phase)}${progress.percent === null ? "" : ` | Progress: ${progress.percent.toFixed(1)}%`}`
          : `Status: ${run.status}`,
      );
    } catch (error) {
      if (error instanceof AutoProverApiDeadlineError) {
        // Expired in-flight requests use the normal bounded cancellation path.
        if (Date.now() >= deadlineMs) continue;
        // A quota reset beyond our budget is not permission to poll or cancel
        // early. Keep the known run ID and explain when recovery can resume.
        core.setFailed(error.message);
        return null;
      }
      consecutiveFailures += 1;
      core.warning(
        `Run poll failed (${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${error instanceof Error ? error.message : String(error)}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        if (run.cancellable) {
          try {
            run = await requestCancellation(
              api,
              runId,
              config,
              Date.now() + CANCELLATION_REQUEST_TIMEOUT_MS,
            );
          } catch (cancelError) {
            core.warning(
              `Failed to request cancellation after polling failed: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
            );
          }
        }
        if (
          run.status === "succeeded" ||
          run.status === "failed" ||
          run.status === "cancelled"
        ) {
          return run;
        }
        core.setOutput("status", run.status);
        core.setFailed(
          `Lost connection to the Certora API after ${MAX_CONSECUTIVE_POLL_FAILURES} consecutive failures; last status: ${run.status}.`,
        );
        return null;
      }
    }
  }
  return run;
}

async function publishFindingValidationResult(
  api: AutoProverApi,
  config: FindingValidationActionConfig,
  run: Run,
  runId: string,
): Promise<void> {
  const response = await api.getResult(runId);
  validateResultIdentity(response.result, runId, config);
  if (response.result.run_type !== "ai_auditor_finding_validation") {
    throw new Error("AI Auditor returned a result for a different workflow.");
  }
  const report = response.result.data.report;
  const modelMode = reportedModelMode(config, run);
  const parsed = readFindingValidationReport(report);
  if (parsed) {
    core.setOutput("validation-verdict", parsed.final_verdict);
    core.setOutput("validation-severity", parsed.final_severity ?? "");
  } else {
    core.warning(
      "Finding validation completed, but its public report did not contain the recognized structured verdict shape.",
    );
  }

  if (config.commentOnPr) {
    await new GitHubClient(config.githubToken).upsertPrComment(
      config.prNumber,
      formatFindingValidationPrComment({
        runId,
        cost: parseUsd(run.billing.charged_usd),
        report,
        parsed,
        modelMode,
      }),
      prCommentMarker(config.workflow, modelMode),
      config.headCommitSha,
      runId,
    );
  }
}

async function publishAiAuditorResult(
  api: AutoProverApi,
  config: AiAuditorActionConfig,
  run: Run,
  runId: string,
): Promise<void> {
  const response = await api.getResult(runId);
  validateResultIdentity(response.result, runId, config);
  if (
    response.result.run_type !== "ai_auditor_full" &&
    response.result.run_type !== "ai_auditor_diff"
  ) {
    throw new Error("AI Auditor returned a standalone workflow result.");
  }
  const report = response.result.data.report;
  const modelMode = reportedModelMode(config, run);
  if (report.format === "markdown") {
    core.setOutput("highs-count", "");
    core.setOutput("mediums-count", "");
    core.setOutput("lows-count", "");
    core.setOutput("infos-count", "");
    if (config.createIssues) {
      core.warning(
        "AI Auditor returned a Markdown report, so structured finding issues could not be created.",
      );
    }
    if (config.commentOnPr) {
      await new GitHubClient(config.githubToken).upsertPrComment(
        config.prNumber,
        formatAiAuditorMarkdownPrComment({
          workflow: config.workflow,
          runId,
          cost: parseUsd(run.billing.charged_usd),
          content: report.content,
          modelMode,
        }),
        prCommentMarker(config.workflow, modelMode),
        config.headCommitSha,
        runId,
      );
    }
    if (config.failOn.length > 0) {
      core.setFailed(
        `AI Auditor returned only a Markdown report, so the fail-on policy (${config.failOn.join(", ")}) could not be evaluated.`,
      );
    }
    return;
  }
  const findings = readAiAuditorFindings(report);

  core.setOutput("highs-count", String(findings.highs.length));
  core.setOutput("mediums-count", String(findings.mediums.length));
  core.setOutput("lows-count", String(findings.lows.length));
  core.setOutput("infos-count", String(findings.infos.length));

  const ghClient = new GitHubClient(config.githubToken);
  const issueLinks: { finding: Finding; url: string }[] = [];
  if (config.createIssues) {
    const selected = getFindingsBySeverities(findings, config.issueSeverities);
    if (selected.length > 0) {
      await ghClient.ensureLabelsExist(config.labels, config.issueSeverities);
      for (const finding of selected) {
        const reference = await ghClient.createOrUpdateIssue(
          finding,
          runId,
          config.prNumber,
          config.labels,
        );
        if (reference) issueLinks.push({ finding, url: reference });
      }
    }
  }
  core.setOutput(
    "issues-created",
    issueLinks.map((entry) => entry.url).join(","),
  );

  if (config.commentOnPr) {
    await ghClient.upsertPrComment(
      config.prNumber,
      formatPrComment(
        findings,
        runId,
        parseUsd(run.billing.charged_usd),
        issueLinks,
        config.prNumber,
        config.workflow,
        modelMode,
      ),
      prCommentMarker(config.workflow, modelMode),
      config.headCommitSha,
      runId,
    );
  }

  const failing = getFindingsBySeverities(findings, config.failOn);
  if (failing.length > 0) {
    core.setFailed(
      `AI Auditor found ${failing.length} finding${failing.length === 1 ? "" : "s"} matching fail-on (${config.failOn.join(", ")}).`,
    );
  }
}

function reportedModelMode(
  config: AiAuditorActionConfig | FindingValidationActionConfig,
  run: Run,
): ModelMode | null {
  return run.model_mode ?? config.modelMode ?? null;
}

function completionApi(
  config: ActionConfig,
  deadlineMs: number,
): AutoProverApi {
  // A successful timeout/cancel race must still be able to read its result.
  // This client never launches audits; result and delivery share one grace
  // budget rather than receiving a new timeout on every request.
  return new AutoProverApi(
    config.apiBaseUrl,
    config.apiKey,
    Math.max(deadlineMs, Date.now() + CANCELLATION_REQUEST_TIMEOUT_MS),
  );
}

export async function run(): Promise<void> {
  registerShutdownHandlers();
  activeRun = null;
  initializeOutputs();

  core.info("Phase 1: Validating inputs...");
  const eventConfig = getConfig();
  const deadlineMs = Date.now() + eventConfig.timeout * 60_000;
  if (!Number.isSafeInteger(deadlineMs)) {
    throw new Error("The configured timeout is too large.");
  }
  // Keep the key bound to the immutable event. Refreshing the submitted base
  // must never mint a second paid launch on rerun; the server rejects a changed
  // body for this same key before reserving balance.
  const idempotencyBody = buildRunRequest(eventConfig);
  const config: ActionConfig =
    eventConfig.workflow === "ai-auditor-diff"
      ? {
          ...eventConfig,
          ...(await new GitHubClient(eventConfig.githubToken).resolveDiffSource(
            {
              ...eventConfig,
              deadlineMs,
            },
          )),
        }
      : eventConfig;
  const asyncAudit = isAsyncAuditConfig(config);
  if (asyncAudit) {
    for (const output of [
      "highs-count",
      "mediums-count",
      "lows-count",
      "infos-count",
    ]) {
      core.setOutput(output, "");
    }
  }
  core.setOutput("workflow", config.workflow);
  core.info(`Repository: ${config.repositoryUrl}`);
  core.info(`Workflow: ${config.workflow}`);
  if (!isStandaloneConfig(config)) {
    core.info(
      `Model mode: ${modelModeLabel(config.modelMode)}${config.modelMode === undefined ? " (server default)" : ""}`,
    );
  }
  core.info(`Base commit: ${config.baseCommitSha}`);
  core.info(`Head commit: ${config.headCommitSha}`);

  const api = new AutoProverApi(config.apiBaseUrl, config.apiKey, deadlineMs);
  if (isStandaloneConfig(config)) {
    const ghClient = new GitHubClient(config.githubToken);
    if (await tryGeneratedFollowup(config, api, ghClient, deadlineMs)) return;
  }

  const body = buildRunRequest(config);
  core.info(
    "Phase 2: Launch preflight is handled by the server. Existing runs are recovered before source and balance checks; new runs are validated and reserve balance during launch.",
  );

  core.info("Phase 3: Launching run...");
  const idempotencyKey = createIdempotencyKey(
    config.workflow,
    idempotencyBody,
    config.idempotencySeed,
  );
  let currentRun = (await api.createRun(config.workflow, body, idempotencyKey))
    .run;
  let currentRunId = currentRun.id;
  validateRunIdentity(currentRun, config, currentRunId);
  // Preserve the accepted run reference even if refreshing its status fails.
  core.setOutput("run-id", currentRunId);
  activeRun =
    !asyncAudit && currentRun.cancellable
      ? { api, runId: currentRunId, config }
      : null;
  if (config.githubRunAttempt > 1) {
    // A completed idempotency record replays the original launch response,
    // usually queued. Only a fresh resource can decide whether this GitHub
    // rerun recovered an already-terminal failure eligible for one retry.
    currentRun = (await api.getRun(currentRunId)).run;
    validateRunIdentity(currentRun, config, currentRunId);
  }
  const canonicalRunWasTerminalAtRecovery =
    currentRun.status === "failed" || currentRun.status === "cancelled";
  let usedAttemptScopedRetry = false;

  while (true) {
    validateRunIdentity(currentRun, config, currentRunId);
    // An accepted async launch belongs to the server even if its handshake or
    // a later refresh is malformed/unavailable. Never cancel it from a runner.
    activeRun = asyncAudit ? null : { api, runId: currentRunId, config };
    core.setOutput("run-id", currentRunId);
    core.setOutput("status", currentRun.status);
    if (!isStandaloneConfig(config)) {
      core.setOutput("model-mode", reportedModelMode(config, currentRun) ?? "");
    }
    core.info(`Run created or recovered: ${currentRunId}`);
    core.info(`Reserved balance: $${currentRun.billing.reserved_usd}.`);

    if (isAsyncAuditConfig(config)) validateAsyncDelivery(currentRun, config);
    core.info(
      asyncAudit
        ? "Phase 4: Confirming server check handoff..."
        : "Phase 4: Polling run...",
    );
    const terminal = asyncAudit
      ? currentRun
      : await pollRun(
          api,
          currentRun,
          currentRunId,
          config,
          config.pollInterval,
          config.timeout,
          deadlineMs,
        );
    activeRun = null;
    if (!terminal) return;
    currentRun = terminal;
    validateRunIdentity(currentRun, config, currentRunId);
    core.setOutput("status", currentRun.status);
    if (!isStandaloneConfig(config)) {
      core.setOutput("model-mode", reportedModelMode(config, currentRun) ?? "");
    }

    if (
      config.githubRunAttempt > 1 &&
      canonicalRunWasTerminalAtRecovery &&
      !usedAttemptScopedRetry &&
      (currentRun.status === "failed" || currentRun.status === "cancelled")
    ) {
      if (Date.now() >= deadlineMs) throw new AutoProverApiDeadlineError();
      usedAttemptScopedRetry = true;
      const retryIdempotencyKey = createIdempotencyKey(
        config.workflow,
        idempotencyBody,
        `${config.idempotencySeed}:github-rerun-attempt:${config.githubRunAttempt}`,
      );
      core.info(
        `GitHub rerun attempt ${config.githubRunAttempt} recovered terminal ${currentRun.status} run ${currentRunId}; launching one attempt-scoped retry.`,
      );
      currentRun = (
        await api.createRun(config.workflow, body, retryIdempotencyKey)
      ).run;
      currentRunId = currentRun.id;
      continue;
    }

    if (isAsyncAuditConfig(config)) {
      publishAsyncHandoff(currentRun, config);
      return;
    }
    break;
  }

  if (currentRun.status === "failed") {
    core.setFailed(
      `Certora run failed: ${formatRunFailure(currentRun.failure)}`,
    );
    return;
  }
  if (currentRun.status === "cancelled") {
    core.setFailed("Certora run was cancelled.");
    return;
  }

  core.info("Phase 5: Processing result...");
  const resultApi = completionApi(config, deadlineMs);
  if (isStandaloneConfig(config)) {
    await publishStandaloneResult({
      api: resultApi,
      config,
      ghClient: new GitHubClient(config.githubToken),
      run: currentRun,
      runId: currentRunId,
    });
  } else if (isFindingValidationConfig(config)) {
    await publishFindingValidationResult(
      resultApi,
      config,
      currentRun,
      currentRunId,
    );
  } else {
    await publishAiAuditorResult(resultApi, config, currentRun, currentRunId);
  }

  core.info(
    `${workflowEngine(config.workflow)} run ${currentRunId} completed with status ${currentRun.status}.`,
  );
}
