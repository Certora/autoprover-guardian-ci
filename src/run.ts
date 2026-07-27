import * as core from "@actions/core";
import { getConfig } from "./config";
import { ZeusApi, ZeusApiDeadlineError, ZeusApiError } from "./api";
import { GitHubClient } from "./github";
import {
  formatPrComment,
  formatLegacyPrComment,
  formatStandalonePrComment,
  getStandaloneWarnings,
  isFailingStandaloneOutcome,
} from "./format";
import type {
  AissResult,
  AissRunOutcome,
  AiAuditorResult,
  AuditResultResponse,
  AuditFindings,
  CancelAuditResponse,
  Finding,
  Severity,
  StandaloneActionConfig,
} from "./types";
import {
  API_REQUEST_TIMEOUT_MS,
  MAX_CONSECUTIVE_POLL_FAILURES,
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
  const set = new Set(severities);
  const result: Finding[] = [];
  if (set.has("HIGH")) result.push(...findings.highs);
  if (set.has("MEDIUM")) result.push(...findings.mediums);
  if (set.has("LOW")) result.push(...findings.lows);
  if (set.has("INFO")) result.push(...findings.infos);
  return result;
}

function firstFiniteNumber(...values: (number | undefined)[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function formatUsd(value: number | null): string {
  return value === null ? "unavailable" : `$${value.toFixed(2)}`;
}

function isAissResult(value: unknown): value is AissResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<AissResult>;
  return (
    typeof result.report_state === "string" &&
    Array.isArray(result.artifacts) &&
    (result.report === null || typeof result.report === "object")
  );
}

function isAiAuditorResult(value: unknown): value is AiAuditorResult {
  if (!value || typeof value !== "object") return false;
  const findings = (value as Partial<AiAuditorResult>).findings;
  return Boolean(
    findings &&
    Array.isArray(findings.highs) &&
    Array.isArray(findings.mediums) &&
    Array.isArray(findings.lows) &&
    Array.isArray(findings.infos),
  );
}

function isExpectedStandaloneResult(
  result: AuditResultResponse,
  jobId: string,
  config: StandaloneActionConfig,
  requireContractIdentity = false,
): result is AuditResultResponse & { result: AissResult } {
  const hasContractIdentity =
    result.contract_path !== undefined || result.contract_name !== undefined;
  const matchesContractIdentity =
    result.contract_path === config.contractPath &&
    result.contract_name === config.contractName;

  return (
    result.job_id === jobId &&
    result.engine === config.engine &&
    result.status === "succeeded" &&
    isAissResult(result.result) &&
    (matchesContractIdentity ||
      (!requireContractIdentity && !hasContractIdentity))
  );
}

const VALID_AISS_OUTCOMES = new Set<AissRunOutcome>([
  "verified",
  "verified_with_gaps",
  "partial",
  "issues_found",
  "unknown",
]);

function readAissOutcome(result: AissResult): AissRunOutcome {
  if (!result.report) return "unknown";
  const outcome = result.report.outcome;
  if (!VALID_AISS_OUTCOMES.has(outcome)) {
    throw new Error(`Unexpected standalone audit outcome: ${String(outcome)}`);
  }
  return outcome;
}

function standaloneFailureMessage(
  engine: StandaloneActionConfig["engine"],
): string {
  return engine === "auto-foundry"
    ? "auto-foundry found one or more failing generated tests."
    : "auto-prover found one or more violated properties or rules.";
}

function initializeOutputs(): void {
  core.setOutput("engine", "");
  core.setOutput("run-outcome", "");
  core.setOutput("generated-files", "");
  core.setOutput("generated-commit-sha", "");
  core.setOutput("issues-created", "");
  core.setOutput("highs-count", "0");
  core.setOutput("mediums-count", "0");
  core.setOutput("lows-count", "0");
  core.setOutput("infos-count", "0");
}

async function waitForPersistedResult(
  api: ZeusApi,
  jobId: string,
  deadlineMs: number,
  timeoutLabel: string,
  pollIntervalMs: number,
  finalStatus: string,
): Promise<AuditResultResponse | null> {
  let waitingForResult = false;

  while (true) {
    if (waitingForResult && Date.now() >= deadlineMs) {
      core.warning(
        `Timeout exceeded (${timeoutLabel}) while waiting for the persisted audit result. The terminal provider workflow will not be cancelled.`,
      );
      core.setFailed(
        `Audit reached provider status ${finalStatus}, but its persisted result did not become available within ${timeoutLabel}.`,
      );
      return null;
    }

    try {
      return await api.getResult(jobId, deadlineMs);
    } catch (error) {
      const retryableResultError =
        error instanceof ZeusApiDeadlineError ||
        (error instanceof ZeusApiError &&
          (error.code === "result_not_ready" ||
            error.statusCode === 429 ||
            error.statusCode >= 500));
      if (!retryableResultError) {
        throw error;
      }

      waitingForResult = true;
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        continue;
      }

      const detail =
        error instanceof ZeusApiError && error.code !== "result_not_ready"
          ? ` (${error.code})`
          : "";
      core.info(
        `Provider work is complete; waiting for the persisted audit result${detail}...`,
      );
      await sleep(Math.min(pollIntervalMs, remainingMs));
    }
  }
}

async function statusAfterCancellationAttempt(
  api: ZeusApi,
  jobId: string,
): Promise<Awaited<ReturnType<ZeusApi["getStatus"]>> | null> {
  try {
    return await api.getStatus(jobId, Date.now() + API_REQUEST_TIMEOUT_MS);
  } catch (error) {
    core.warning(
      `Could not verify status after cancellation: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function runGeneratedFollowup(
  config: StandaloneActionConfig,
  api: ZeusApi,
  ghClient: GitHubClient,
  jobId: string,
): Promise<void> {
  core.info(`Verifying generated-commit follow-up for Zeus job ${jobId}...`);
  const result = await api.getResult(jobId);
  if (!isExpectedStandaloneResult(result, jobId, config, true)) {
    throw new Error(
      "Generated follow-up received an unexpected persisted audit result.",
    );
  }

  const generatedCommit = await api.commitGeneratedFiles(jobId, {
    pull_request_number: config.prNumber,
    token: config.githubToken,
  });
  if (!generatedCommit.commit_created) {
    throw new Error(
      "Generated follow-up did not resolve to a generated commit.",
    );
  }
  if (
    generatedCommit.commit_sha.toLowerCase() !==
    config.branchEnding.toLowerCase()
  ) {
    throw new Error(
      `Generated follow-up commit mismatch: expected ${config.branchEnding}, received ${generatedCommit.commit_sha}.`,
    );
  }

  const outcome = readAissOutcome(result.result);
  const generatedPaths = generatedCommit.files.map((file) => file.path);
  core.setOutput("engine", result.engine);
  core.setOutput("job-id", jobId);
  core.setOutput("status", result.status);
  core.setOutput("run-outcome", outcome);
  core.setOutput("generated-files", generatedPaths.join(","));
  core.setOutput("generated-commit-sha", generatedCommit.commit_sha);

  for (const warning of getStandaloneWarnings(
    result.result.report_state,
    result.result.report,
    config.engine,
  )) {
    core.warning(warning);
  }

  if (config.commentOnPr) {
    const billedCostUsd =
      firstFiniteNumber(result.billed_amount_usd, result.actual_cost_usd) ?? 0;
    const comment = formatStandalonePrComment({
      engine: config.engine,
      jobId,
      cost: billedCostUsd,
      reportState: result.result.report_state,
      report: result.result.report,
      commit: generatedCommit,
    });
    await ghClient.upsertPrComment(config.prNumber, comment);
  }

  if (isFailingStandaloneOutcome(outcome)) {
    core.setFailed(standaloneFailureMessage(config.engine));
    return;
  }

  core.info(
    `Confirmed ${result.engine} outcome ${outcome} for generated commit ${generatedCommit.commit_sha}.`,
  );
}

// Track active audit for cancellation on SIGTERM/SIGINT
let activeAudit: { api: ZeusApi; jobId: string } | null = null;
let shutdownHandlersRegistered = false;

function cancellationSummary(response: CancelAuditResponse): string {
  if (response.status === "cancelled") {
    return `Cancellation confirmed: ${response.message}`;
  }
  if (response.status === "cancellation_pending") {
    return `Cancellation requested and still pending: ${response.message}`;
  }
  return `Audit reached a failed state: ${response.message}`;
}

async function requestCancellation(
  api: ZeusApi,
  jobId: string,
): Promise<CancelAuditResponse | null> {
  try {
    const response = await api.cancelAudit(jobId);
    core.info(cancellationSummary(response));
    return response;
  } catch (error) {
    core.warning(
      `Failed to request cancellation: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function registerShutdownHandlers() {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;

  const handler = async (signal: string) => {
    if (activeAudit) {
      core.info(
        `Received ${signal} — requesting cancellation for Zeus audit ${activeAudit.jobId}...`,
      );
      await requestCancellation(activeAudit.api, activeAudit.jobId);
    }
    process.exit(1);
  };

  process.on("SIGTERM", () => void handler("SIGTERM"));
  process.on("SIGINT", () => void handler("SIGINT"));
}

export async function run(): Promise<void> {
  registerShutdownHandlers();
  activeAudit = null;
  // ── Phase 1: Validate Inputs ──
  core.info("Phase 1: Validating inputs...");
  const config = getConfig();
  initializeOutputs();
  core.setOutput("engine", config.engine);
  core.info(`Target: ${config.target}`);
  core.info(`Engine: ${config.engine}`);
  core.info(`Base SHA: ${config.branchStarting}`);
  core.info(`Head SHA: ${config.branchEnding}`);
  if (config.engine === "ai-auditor") {
    core.info(`Audit type: ${config.auditType}`);
    core.info(`Context patterns: ${config.context.join(", ")}`);
  } else {
    core.info(`Contract: ${config.contractPath} (${config.contractName})`);
  }

  const api = new ZeusApi(config.apiBaseUrl, config.apiKey);
  if (config.engine !== "ai-auditor") {
    const ghClient = new GitHubClient(config.githubToken);
    const generatedJobId = await ghClient.getGeneratedFollowupJobId(
      config.branchEnding,
    );
    if (generatedJobId) {
      await runGeneratedFollowup(config, api, ghClient, generatedJobId);
      return;
    }
  }

  // ── Phase 2: Create Audit ──
  core.info(`Phase 2: Creating ${config.engine} audit...`);

  let createResponse;
  if (config.engine !== "ai-auditor") {
    createResponse = await api.createStandaloneAudit({
      engine: config.engine,
      target: config.target,
      branch: config.branchEnding,
      pull_request_number: config.prNumber,
      contract_path: config.contractPath,
      contract_name: config.contractName,
      design_doc_path: config.designDocPath,
      threat_model_path: config.threatModelPath,
      token: config.githubToken,
    });
  } else if (config.auditType === "full") {
    createResponse = await api.createFullAudit({
      engine: "ai-auditor",
      target: config.target,
      branch: config.branchEnding,
      context: config.context,
      scope: config.scope,
      preprompt: config.preprompt,
      use_memory: config.useMemory,
      token: config.githubToken,
      skip_submodules: config.skipSubmodules,
      max_iterations: config.maxIterations,
    });
  } else {
    createResponse = await api.createDiffAudit({
      target: config.target,
      branch_starting: config.branchStarting,
      branch_ending: config.branchEnding,
      context: config.context,
      preprompt: config.preprompt,
      token: config.githubToken,
      skip_submodules: config.skipSubmodules,
      max_iterations: config.maxIterations,
    });
  }

  const jobId = createResponse.job_id;
  activeAudit = { api, jobId };
  core.setOutput("job-id", jobId);
  const remainingBalance = firstFiniteNumber(
    createResponse.current_balance_usd,
    createResponse.remaining_credits,
  );
  core.info(
    remainingBalance === null
      ? `Audit created: ${jobId}`
      : `Audit created: ${jobId} (${formatUsd(remainingBalance)} balance remaining)`,
  );

  // ── Phase 3: Poll for Completion ──
  core.info("Phase 3: Polling for completion...");
  const startTime = Date.now();
  const timeoutMs = config.timeout * 60 * 1000;
  const deadlineMs = startTime + timeoutMs;
  let resultDeadlineMs = deadlineMs;
  const timeoutLabel = `${config.timeout} ${config.timeout === 1 ? "minute" : "minutes"}`;
  let consecutiveFailures = 0;
  let finalStatus = "pending";
  let finalError: string | null | undefined;
  let providerTerminal = false;

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= timeoutMs) {
      if (providerTerminal) {
        activeAudit = null;
        core.warning(
          `Timeout exceeded (${timeoutLabel}) while waiting for final billing settlement. The terminal provider workflow will not be cancelled.`,
        );
        core.setOutput("status", finalStatus);
        core.setFailed(
          `Audit reached provider status ${finalStatus}, but final billing settlement did not finish within ${timeoutLabel}.`,
        );
      } else {
        core.warning(
          `Timeout exceeded (${timeoutLabel}). Requesting cancellation...`,
        );
        const cancellation = await requestCancellation(api, jobId);
        const authoritativeStatus = await statusAfterCancellationAttempt(
          api,
          jobId,
        );
        if (authoritativeStatus?.status === "succeeded") {
          finalStatus = "succeeded";
          providerTerminal = true;
          activeAudit = null;
          if (
            config.engine === "ai-auditor" ||
            authoritativeStatus.completed_at
          ) {
            resultDeadlineMs = Date.now() + API_REQUEST_TIMEOUT_MS;
            core.info(
              "The audit completed while cancellation was being requested; continuing with its successful result.",
            );
            break;
          }
          core.setOutput("status", finalStatus);
          core.setFailed(
            `Audit reached provider status succeeded, but final billing settlement did not finish within ${timeoutLabel}.`,
          );
          return;
        }
        activeAudit = null;
        core.setOutput("status", cancellation?.status ?? "failed");
        const cancellationResult =
          cancellation?.status === "cancelled"
            ? "Cancellation was confirmed."
            : cancellation?.status === "cancellation_pending"
              ? "Cancellation was requested and is still being reconciled."
              : cancellation?.status === "failed"
                ? "The audit reached a failed state."
                : "Cancellation could not be confirmed.";
        core.setFailed(
          `Audit timed out after ${timeoutLabel}. ${cancellationResult}`,
        );
      }
      return;
    }

    try {
      const progress = await api.getProgress(jobId, deadlineMs);
      finalStatus = progress.status;
      const currentCost = firstFiniteNumber(
        progress.billed_amount_usd,
        progress.actual_cost_usd,
      );

      core.info(
        `[${Math.round(elapsed / 60000)}m] Status: ${progress.status} | ` +
          `Phase: ${progress.current_phase} | ` +
          `Progress: ${progress.progress_percent.toFixed(1)}% | ` +
          `Cost: ${formatUsd(currentCost)}`,
      );

      if (
        config.engine !== "ai-auditor" &&
        (progress.status === "succeeded" ||
          progress.status === "failed" ||
          progress.status === "cancelled")
      ) {
        providerTerminal = true;
        activeAudit = null;
        const status = await api.getStatus(jobId, deadlineMs);
        finalStatus = status.status;
        finalError = status.error;
        if (status.completed_at) break;
        core.info(
          "Provider work is complete; waiting for final billing settlement...",
        );
      } else if (progress.status === "succeeded") {
        break;
      } else if (
        progress.status === "failed" ||
        progress.status === "cancelled"
      ) {
        break;
      }
      // Reset only after the entire poll iteration succeeds. In particular, a
      // successful progress request must not erase a failure from the
      // settlement-status request that follows it.
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures++;
      core.warning(
        `Poll failed (${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${error instanceof Error ? error.message : String(error)}`,
      );

      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        let cancellation: CancelAuditResponse | null = null;
        if (!providerTerminal) {
          core.warning(
            "The audit is still non-terminal; requesting cancellation before the action exits.",
          );
          cancellation = await requestCancellation(api, jobId);
        }
        const authoritativeStatus = await statusAfterCancellationAttempt(
          api,
          jobId,
        );
        if (authoritativeStatus?.status === "succeeded") {
          finalStatus = "succeeded";
          providerTerminal = true;
          activeAudit = null;
          if (
            config.engine === "ai-auditor" ||
            authoritativeStatus.completed_at
          ) {
            resultDeadlineMs = Date.now() + API_REQUEST_TIMEOUT_MS;
            core.info(
              "The audit completed while cancellation was being requested; continuing with its successful result.",
            );
            break;
          }
          core.setOutput("status", finalStatus);
          core.setFailed(
            "Audit reached provider status succeeded, but final billing settlement could not be confirmed after polling failed.",
          );
          return;
        }
        activeAudit = null;
        core.setOutput(
          "status",
          providerTerminal ? finalStatus : (cancellation?.status ?? "failed"),
        );
        const cancellationResult = providerTerminal
          ? "The provider workflow was already terminal and was not cancelled."
          : cancellation?.status === "cancelled"
            ? "Cancellation was confirmed."
            : cancellation?.status === "cancellation_pending"
              ? "Cancellation was requested and is still being reconciled."
              : cancellation?.status === "failed"
                ? "The audit reached a failed state."
                : "Cancellation could not be confirmed.";
        core.setFailed(
          `Lost connection to the Zeus API after ${MAX_CONSECUTIVE_POLL_FAILURES} consecutive failures. ${cancellationResult}`,
        );
        return;
      }
    }

    const remainingBeforeNextPoll = deadlineMs - Date.now();
    if (remainingBeforeNextPoll > 0) {
      await sleep(
        Math.min(config.pollInterval * 1000, remainingBeforeNextPoll),
      );
    }
  }

  activeAudit = null;
  core.setOutput("status", finalStatus);

  if (finalStatus === "failed") {
    if (finalError === undefined) {
      try {
        const status = await api.getStatus(
          jobId,
          Date.now() + API_REQUEST_TIMEOUT_MS,
        );
        finalError = status.error;
      } catch (error) {
        core.warning(
          `Could not retrieve final audit failure details: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    core.setFailed(`Audit failed: ${finalError ?? "Unknown error"}`);
    return;
  }

  if (finalStatus === "cancelled") {
    core.setFailed("Audit was cancelled.");
    return;
  }

  // ── Phase 4: Fetch Results & Create Issues ──
  core.info("Phase 4: Fetching results...");
  const result = await waitForPersistedResult(
    api,
    jobId,
    resultDeadlineMs,
    timeoutLabel,
    config.pollInterval * 1000,
    finalStatus,
  );
  if (!result) return;

  if (config.engine !== "ai-auditor") {
    if (!isExpectedStandaloneResult(result, jobId, config)) {
      throw new Error(
        `${config.engine} returned an unexpected persisted audit result.`,
      );
    }

    core.info("Committing generated files to the pull request branch...");
    const generatedCommit = await api.commitGeneratedFiles(jobId, {
      pull_request_number: config.prNumber,
      token: config.githubToken,
    });
    const generatedPaths = generatedCommit.files.map((file) => file.path);
    // Older API deployments did not return this discriminator; preserve their
    // successful-commit behavior while honoring the explicit new no-op state.
    const commitCreated = generatedCommit.commit_created !== false;
    const outcome = readAissOutcome(result.result);
    const failingOutcome = isFailingStandaloneOutcome(outcome);

    core.setOutput("highs-count", "0");
    core.setOutput("mediums-count", "0");
    core.setOutput("lows-count", "0");
    core.setOutput("infos-count", "0");
    core.setOutput("issues-created", "");
    core.setOutput("run-outcome", outcome);
    core.setOutput("generated-files", generatedPaths.join(","));
    core.setOutput(
      "generated-commit-sha",
      commitCreated ? generatedCommit.commit_sha : "",
    );

    if (!commitCreated) {
      core.warning(
        "No generated files needed to be committed. The pull request head is unchanged, so the current check remains authoritative.",
      );
    }

    for (const warning of getStandaloneWarnings(
      result.result.report_state,
      result.result.report,
      config.engine,
    )) {
      core.warning(warning);
    }

    const ghClient = new GitHubClient(config.githubToken);
    if (config.commentOnPr) {
      const billedCostUsd =
        firstFiniteNumber(result.billed_amount_usd, result.actual_cost_usd) ??
        0;
      const comment = formatStandalonePrComment({
        engine: config.engine,
        jobId,
        cost: billedCostUsd,
        reportState: result.result.report_state,
        report: result.result.report,
        commit: generatedCommit,
      });
      await ghClient.upsertPrComment(config.prNumber, comment);
    }

    if (failingOutcome) {
      core.setFailed(standaloneFailureMessage(config.engine));
      return;
    }

    core.info(
      `${config.engine} CI completed with outcome ${outcome} and committed ${generatedPaths.length} generated files.`,
    );
    return;
  }

  // Handle legacy markdown result
  if (typeof result.result === "string") {
    core.warning(
      "Audit returned a legacy markdown report. Structured findings are not available.",
    );
    core.setOutput("highs-count", "0");
    core.setOutput("mediums-count", "0");
    core.setOutput("lows-count", "0");
    core.setOutput("infos-count", "0");
    core.setOutput("issues-created", "");

    if (config.commentOnPr) {
      const ghClient = new GitHubClient(config.githubToken);
      const comment = formatLegacyPrComment(
        result.result,
        jobId,
        config.prNumber,
      );
      await ghClient.upsertPrComment(config.prNumber, comment);
    }
    return;
  }

  if (!isAiAuditorResult(result.result)) {
    throw new Error("AI Auditor returned an unexpected result payload.");
  }

  const findings = result.result.findings;
  core.setOutput("highs-count", String(findings.highs.length));
  core.setOutput("mediums-count", String(findings.mediums.length));
  core.setOutput("lows-count", String(findings.lows.length));
  core.setOutput("infos-count", String(findings.infos.length));

  const totalFindings = getAllFindings(findings).length;
  core.info(
    `Found ${totalFindings} findings: ${findings.highs.length} HIGH, ${findings.mediums.length} MEDIUM, ${findings.lows.length} LOW, ${findings.infos.length} INFO`,
  );

  const ghClient = new GitHubClient(config.githubToken);
  const issueLinks: { finding: Finding; url: string }[] = [];

  if (config.createIssues) {
    const findingsToTrack = getFindingsBySeverities(
      findings,
      config.issueSeverities,
    );

    if (findingsToTrack.length > 0) {
      core.info(
        `Creating issues for ${findingsToTrack.length} findings (${config.issueSeverities.join(", ")})...`,
      );

      await ghClient.ensureLabelsExist(config.labels, config.issueSeverities);

      for (const finding of findingsToTrack) {
        const issueUrl = await ghClient.createOrUpdateIssue(
          finding,
          jobId,
          config.prNumber,
          config.labels,
        );
        if (issueUrl) {
          issueLinks.push({ finding, url: issueUrl });
        }
      }
    }
  }

  core.setOutput("issues-created", issueLinks.map((l) => l.url).join(","));

  // ── Phase 5: PR Comment & Fail Check ──
  core.info("Phase 5: Posting PR comment...");

  if (config.commentOnPr) {
    const billedCostUsd =
      firstFiniteNumber(result.billed_amount_usd, result.actual_cost_usd) ?? 0;
    const comment = formatPrComment(
      findings,
      jobId,
      billedCostUsd,
      issueLinks,
      config.prNumber,
    );
    await ghClient.upsertPrComment(config.prNumber, comment);
  }

  // Check fail-on condition
  if (config.failOn.length > 0) {
    const failFindings = getFindingsBySeverities(findings, config.failOn);
    if (failFindings.length > 0) {
      core.setFailed(
        `Found ${failFindings.length} findings matching fail-on severities: ${config.failOn.join(", ")}`,
      );
    }
  }

  core.info("Zeus Guardian CI completed successfully.");
}
