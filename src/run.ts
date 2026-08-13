import * as core from "@actions/core";
import { AutoProverApi, createIdempotencyKey } from "./api";
import { getConfig } from "./config";
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
  AissRunReport,
  AuditFindings,
  Finding,
  FindingValidationActionConfig,
  FindingValidationModelVerdict,
  FindingValidationReport,
  PublicReport,
  Run,
  RunRequest,
  RunResult,
  Severity,
  StandaloneActionConfig,
} from "./types";
import { workflowEngine, workflowRunType } from "./types";
import {
  CANCELLATION_REQUEST_TIMEOUT_MS,
  MAX_CONSECUTIVE_POLL_FAILURES,
  prCommentMarker,
  SHUTDOWN_CANCEL_TIMEOUT_MS,
} from "./constants";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  core.setOutput("status", "");
  core.setOutput("run-outcome", "");
  core.setOutput("validation-verdict", "");
  core.setOutput("validation-severity", "");
  core.setOutput("generated-files", "");
  core.setOutput("generated-commit-sha", "");
  core.setOutput("issues-created", "");
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
  return (
    config.workflow === "auto-prover" || config.workflow === "auto-fuzzer"
  );
}

function isFindingValidationConfig(
  config: ActionConfig,
): config is FindingValidationActionConfig {
  return config.workflow === "ai-auditor-finding-validation";
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
      instructions: config.instructions,
      skip_submodules: config.skipSubmodules,
      max_iterations: config.maxIterations,
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
      scope: config.scope,
      instructions: config.instructions,
      use_memory: config.useMemory,
      skip_submodules: config.skipSubmodules,
      max_iterations: config.maxIterations,
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
    run.client_reference !== clientReference(config, expectedSourceCommitSha)
  ) {
    throw new Error("Certora returned a run for a different source.");
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

let activeRun: { api: AutoProverApi; runId: string; config: ActionConfig } | null =
  null;
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

async function publishStandaloneResult(args: {
  api: AutoProverApi;
  config: StandaloneActionConfig;
  ghClient: GitHubClient;
  run: Run;
  runId: string;
  requireCommitSha?: string;
}): Promise<void> {
  const { api, config, ghClient, run, runId, requireCommitSha } = args;
  const resultResponse = await api.getResult(runId);
  validateResultIdentity(resultResponse.result, runId, config);
  if (
    resultResponse.result.run_type !== "auto_prover" &&
    resultResponse.result.run_type !== "auto_fuzzer"
  ) {
    throw new Error("Standalone workflow returned an AI Auditor result.");
  }
  const report = readStandaloneReport(resultResponse.result.data.report);
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
  const commit = await api.commitGeneratedFiles(runId);
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
): Promise<boolean> {
  const followup = await ghClient.getGeneratedFollowup(config.headCommitSha);
  if (!followup) return false;

  const response = await api.getRun(followup.runId);
  validateRunIdentity(
    response.run,
    config,
    followup.runId,
    followup.sourceCommitSha,
  );
  if (
    response.run.status !== "succeeded" ||
    response.run.delivery?.status !== "succeeded" ||
    response.run.delivery.outcome !== "committed" ||
    response.run.delivery.commit_sha?.toLowerCase() !==
      config.headCommitSha.toLowerCase()
  ) {
    throw new Error(
      "Generated follow-up references an incompatible Certora run.",
    );
  }
  await publishStandaloneResult({
    api,
    config,
    ghClient,
    run: response.run,
    runId: followup.runId,
    requireCommitSha: config.headCommitSha,
  });
  return true;
}

async function pollRun(
  api: AutoProverApi,
  initialRun: Run,
  runId: string,
  config: ActionConfig,
  pollIntervalSeconds: number,
  timeoutMinutes: number,
): Promise<Run | null> {
  const deadlineMs = Date.now() + timeoutMinutes * 60_000;
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
          ? `Status: ${run.status} | Phase: ${progress.phase}${progress.percent === null ? "" : ` | Progress: ${progress.percent.toFixed(1)}%`}`
          : `Status: ${run.status}`,
      );
    } catch (error) {
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
      }),
      prCommentMarker(config.workflow),
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
        }),
        prCommentMarker(config.workflow),
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
      ),
      prCommentMarker(config.workflow),
    );
  }

  const failing = getFindingsBySeverities(findings, config.failOn);
  if (failing.length > 0) {
    core.setFailed(
      `AI Auditor found ${failing.length} finding${failing.length === 1 ? "" : "s"} matching fail-on (${config.failOn.join(", ")}).`,
    );
  }
}

export async function run(): Promise<void> {
  registerShutdownHandlers();
  activeRun = null;
  initializeOutputs();

  core.info("Phase 1: Validating inputs...");
  const config = getConfig();
  core.setOutput("workflow", config.workflow);
  core.info(`Repository: ${config.repositoryUrl}`);
  core.info(`Workflow: ${config.workflow}`);
  core.info(`Base commit: ${config.baseCommitSha}`);
  core.info(`Head commit: ${config.headCommitSha}`);

  const api = new AutoProverApi(config.apiBaseUrl, config.apiKey);
  if (isStandaloneConfig(config)) {
    const ghClient = new GitHubClient(config.githubToken);
    if (await tryGeneratedFollowup(config, api, ghClient)) return;
  }

  const body = buildRunRequest(config);
  core.info("Phase 2: Estimating run...");
  const estimate = (await api.estimateRun(config.workflow, body)).estimate;
  core.info(
    `Estimated cost: $${estimate.estimated_cost_usd}; minimum required balance: $${estimate.minimum_balance_required_usd}; current balance: $${estimate.balance_usd}.`,
  );
  if (!estimate.can_launch) {
    throw new Error(
      `The run cannot launch: balance $${estimate.balance_usd}, minimum required $${estimate.minimum_balance_required_usd}.`,
    );
  }

  core.info("Phase 3: Launching run...");
  const idempotencyKey = createIdempotencyKey(
    config.workflow,
    body,
    config.idempotencySeed,
  );
  let currentRun = (
    await api.createRun(
      config.workflow,
      body,
      idempotencyKey,
      estimate.estimate_quote_id,
    )
  ).run;
  let currentRunId = currentRun.id;
  const canonicalRunWasTerminalAtRecovery =
    currentRun.status === "failed" || currentRun.status === "cancelled";
  let usedAttemptScopedRetry = false;

  while (true) {
    validateRunIdentity(currentRun, config, currentRunId);
    activeRun = { api, runId: currentRunId, config };
    core.setOutput("run-id", currentRunId);
    core.setOutput("status", currentRun.status);
    core.info(`Run created or recovered: ${currentRunId}`);

    core.info("Phase 4: Polling run...");
    const terminal = await pollRun(
      api,
      currentRun,
      currentRunId,
      config,
      config.pollInterval,
      config.timeout,
    );
    activeRun = null;
    if (!terminal) return;
    currentRun = terminal;
    validateRunIdentity(currentRun, config, currentRunId);
    core.setOutput("status", currentRun.status);

    if (
      config.githubRunAttempt > 1 &&
      canonicalRunWasTerminalAtRecovery &&
      !usedAttemptScopedRetry &&
      (currentRun.status === "failed" || currentRun.status === "cancelled")
    ) {
      usedAttemptScopedRetry = true;
      const retryIdempotencyKey = createIdempotencyKey(
        config.workflow,
        body,
        `${config.idempotencySeed}:github-rerun-attempt:${config.githubRunAttempt}`,
      );
      core.info(
        `GitHub rerun attempt ${config.githubRunAttempt} recovered terminal ${currentRun.status} run ${currentRunId}; launching one attempt-scoped retry.`,
      );
      currentRun = (
        await api.createRun(
          config.workflow,
          body,
          retryIdempotencyKey,
          estimate.estimate_quote_id,
        )
      ).run;
      currentRunId = currentRun.id;
      continue;
    }

    break;
  }

  if (currentRun.status === "failed") {
    core.setFailed(
      `Certora run failed: ${currentRun.failure?.detail ?? "Unknown error"}`,
    );
    return;
  }
  if (currentRun.status === "cancelled") {
    core.setFailed("Certora run was cancelled.");
    return;
  }

  core.info("Phase 5: Processing result...");
  if (isStandaloneConfig(config)) {
    await publishStandaloneResult({
      api,
      config,
      ghClient: new GitHubClient(config.githubToken),
      run: currentRun,
      runId: currentRunId,
    });
  } else if (isFindingValidationConfig(config)) {
    await publishFindingValidationResult(api, config, currentRun, currentRunId);
  } else {
    await publishAiAuditorResult(api, config, currentRun, currentRunId);
  }

  core.info(
    `${workflowEngine(config.workflow)} run ${currentRunId} completed with status ${currentRun.status}.`,
  );
}
