import * as core from "@actions/core";
import { getConfig } from "./config";
import { getZeusApiErrorMessage, ZeusApi, ZeusApiError } from "./api";
import { GitHubClient } from "./github";
import { formatPrComment, formatLegacyPrComment } from "./format";
import type { AuditFindings, Finding, Severity } from "./types";
import { MAX_CONSECUTIVE_POLL_FAILURES } from "./constants";

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
  severities: Severity[]
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

// Track active audit for cancellation on SIGTERM/SIGINT
let activeAudit: { api: ZeusApi; jobId: string } | null = null;

function registerShutdownHandlers() {
  const handler = async (signal: string) => {
    if (activeAudit) {
      core.info(
        `Received ${signal} — cancelling Auto Prover audit ${activeAudit.jobId}...`
      );
      try {
        await activeAudit.api.cancelAudit(activeAudit.jobId);
        core.info("Auto Prover audit cancelled.");
      } catch {
        core.warning("Failed to cancel Auto Prover audit on shutdown.");
      }
    }
    process.exit(1);
  };

  process.on("SIGTERM", () => void handler("SIGTERM"));
  process.on("SIGINT", () => void handler("SIGINT"));
}

async function run(): Promise<void> {
  registerShutdownHandlers();
  // ── Phase 1: Validate Inputs ──
  core.info("Phase 1: Validating inputs...");
  const config = getConfig();
  core.info(`Target: ${config.target}`);
  core.info(`Audit type: ${config.auditType}`);
  core.info(`Base SHA: ${config.branchStarting}`);
  core.info(`Head SHA: ${config.branchEnding}`);
  core.info(`Context patterns: ${config.context.join(", ")}`);

  const api = new ZeusApi(config.apiBaseUrl, config.apiKey);

  // ── Phase 2: Create Audit ──
  core.info(`Phase 2: Creating ${config.auditType} audit...`);

  let createResponse;
  if (config.auditType === "full") {
    createResponse = await api.createFullAudit({
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
    createResponse.remaining_credits
  );
  core.info(
    remainingBalance === null
      ? `Audit created: ${jobId}`
      : `Audit created: ${jobId} (${formatUsd(remainingBalance)} balance remaining)`
  );

  // ── Phase 3: Poll for Completion ──
  core.info("Phase 3: Polling for completion...");
  const startTime = Date.now();
  const timeoutMs = config.timeout * 60 * 1000;
  let consecutiveFailures = 0;
  let finalStatus = "pending";

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      core.warning(
        `Timeout exceeded (${config.timeout} minutes). Cancelling audit...`
      );
      try {
        await api.cancelAudit(jobId);
        core.info("Audit cancelled.");
      } catch {
        core.warning("Failed to cancel audit after timeout.");
      }
      core.setOutput("status", "cancelled");
      core.setFailed(
        `Audit timed out after ${config.timeout} minutes. The audit was cancelled.`
      );
      return;
    }

    try {
      const progress = await api.getProgress(jobId);
      consecutiveFailures = 0;
      finalStatus = progress.status;
      const currentCost = firstFiniteNumber(
        progress.billed_amount_usd,
        progress.actual_cost_usd
      );

      core.info(
        `[${Math.round(elapsed / 60000)}m] Status: ${progress.status} | ` +
          `Phase: ${progress.current_phase} | ` +
          `Progress: ${progress.progress_percent.toFixed(1)}% | ` +
          `Cost: ${formatUsd(currentCost)}`
      );

      if (
        progress.status === "succeeded" ||
        progress.status === "failed" ||
        progress.status === "cancelled"
      ) {
        break;
      }
    } catch (error) {
      consecutiveFailures++;
      core.warning(
        `Poll failed (${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${error instanceof Error ? error.message : String(error)}`
      );

      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        core.setOutput("status", "failed");
        core.setFailed(
          `Lost connection to Auto Prover API after ${MAX_CONSECUTIVE_POLL_FAILURES} consecutive failures.`
        );
        return;
      }
    }

    await sleep(config.pollInterval * 1000);
  }

  activeAudit = null;
  core.setOutput("status", finalStatus);

  if (finalStatus === "failed") {
    const status = await api.getStatus(jobId);
    core.setFailed(`Audit failed: ${status.error ?? "Unknown error"}`);
    return;
  }

  if (finalStatus === "cancelled") {
    core.setFailed("Audit was cancelled.");
    return;
  }

  // ── Phase 4: Fetch Results & Create Issues ──
  core.info("Phase 4: Fetching results...");
  const result = await api.getResult(jobId);

  // Handle legacy markdown result
  if (typeof result.result === "string") {
    core.warning(
      "Audit returned a legacy markdown report. Structured findings are not available."
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
        config.prNumber
      );
      await ghClient.upsertPrComment(config.prNumber, comment);
    }
    return;
  }

  const findings = result.result.findings;
  core.setOutput("highs-count", String(findings.highs.length));
  core.setOutput("mediums-count", String(findings.mediums.length));
  core.setOutput("lows-count", String(findings.lows.length));
  core.setOutput("infos-count", String(findings.infos.length));

  const totalFindings = getAllFindings(findings).length;
  core.info(
    `Found ${totalFindings} findings: ${findings.highs.length} HIGH, ${findings.mediums.length} MEDIUM, ${findings.lows.length} LOW, ${findings.infos.length} INFO`
  );

  const ghClient = new GitHubClient(config.githubToken);
  const issueLinks: { finding: Finding; url: string }[] = [];

  if (config.createIssues) {
    const findingsToTrack = getFindingsBySeverities(
      findings,
      config.issueSeverities
    );

    if (findingsToTrack.length > 0) {
      core.info(
        `Creating issues for ${findingsToTrack.length} findings (${config.issueSeverities.join(", ")})...`
      );

      await ghClient.ensureLabelsExist(config.labels, config.issueSeverities);

      for (const finding of findingsToTrack) {
        const issueUrl = await ghClient.createOrUpdateIssue(
          finding,
          jobId,
          config.prNumber,
          config.labels
        );
        if (issueUrl) {
          issueLinks.push({ finding, url: issueUrl });
        }
      }
    }
  }

  core.setOutput(
    "issues-created",
    issueLinks.map((l) => l.url).join(",")
  );

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
      config.prNumber
    );
    await ghClient.upsertPrComment(config.prNumber, comment);
  }

  // Check fail-on condition
  if (config.failOn.length > 0) {
    const failFindings = getFindingsBySeverities(findings, config.failOn);
    if (failFindings.length > 0) {
      core.setFailed(
        `Found ${failFindings.length} findings matching fail-on severities: ${config.failOn.join(", ")}`
      );
    }
  }

  core.info("Auto Prover CI completed successfully.");
}

run().catch((error) => {
  if (error instanceof ZeusApiError) {
    core.setFailed(getZeusApiErrorMessage(error));
  } else {
    core.setFailed(
      `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});
