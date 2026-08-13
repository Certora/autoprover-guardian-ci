import { createHash } from "node:crypto";
import * as core from "@actions/core";
import type {
  CommitGeneratedFilesResponse,
  EstimateResponse,
  ProblemDetails,
  RunRequest,
  RunResponse,
  RunResultResponse,
  Workflow,
} from "./types";
import {
  API_REQUEST_TIMEOUT_MS,
  MAX_RETRY_ATTEMPTS,
  SHA_REGEX,
} from "./constants";

export class AutoProverApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number,
    public retryable: boolean,
    public requestId?: string,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "AutoProverApiError";
  }
}

export class AutoProverApiDeadlineError extends Error {
  constructor() {
    super("The configured run timeout expired during an AutoProver API request.");
    this.name = "AutoProverApiDeadlineError";
  }
}

export function getAutoProverApiErrorMessage(
  error: AutoProverApiError,
): string {
  switch (error.code) {
    case "invalid_api_key":
    case "invalid_bearer_token":
      return "Invalid Certora API key. Check the api-key supplied to this action.";
    case "insufficient_balance":
      return "Insufficient Certora balance. Please top up at https://app.certora.com.";
    case "missing_scope":
    case "insufficient_scope":
      return "The Certora API key does not have the scope required by this workflow.";
    case "source_revision_not_found":
      return "Certora could not resolve the pull request commit. Confirm the commit still exists on the remote and that the Certora GitHub App can read this repository. No balance reservation was created.";
    case "contract_not_found":
      return "The configured contract-path does not exist or cannot be read at the pull request commit. Check the contract-path input and its casing. No balance reservation was created.";
    default:
      return `Certora API error (${error.code}): ${error.message}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

/** Stable across action retries and process restarts for an identical launch. */
export function createIdempotencyKey(
  workflow: Workflow,
  body: RunRequest,
  executionSeed: string,
): string {
  const digest = createHash("sha256")
    .update(executionSeed)
    .update("\0")
    .update(workflow)
    .update("\0")
    .update(canonicalJson(body))
    .digest("hex");
  return `certora-guardian-${digest}`;
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("Retry-After");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - Date.now());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidResponse(detail: string): never {
  const error = new Error(`Invalid Certora API response: ${detail}`);
  error.name = "AutoProverApiResponseError";
  throw error;
}

function requestEnvelope(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.request_id !== "string") {
    invalidResponse("missing request_id");
  }
  return value;
}

function decodeEstimate(value: unknown): EstimateResponse {
  const envelope = requestEnvelope(value);
  const estimate = envelope.estimate;
  if (
    !isRecord(estimate) ||
    typeof estimate.estimated_cost_usd !== "string" ||
    !USD_REGEX.test(estimate.estimated_cost_usd) ||
    typeof estimate.minimum_balance_required_usd !== "string" ||
    !USD_REGEX.test(estimate.minimum_balance_required_usd) ||
    typeof estimate.balance_usd !== "string" ||
    !SIGNED_USD_REGEX.test(estimate.balance_usd) ||
    typeof estimate.can_launch !== "boolean" ||
    (estimate.estimate_quote_id !== undefined &&
      (typeof estimate.estimate_quote_id !== "string" ||
        !UUID_REGEX.test(estimate.estimate_quote_id)))
  ) {
    invalidResponse("malformed estimate");
  }
  return value as EstimateResponse;
}

const RUN_TYPES = new Set([
  "ai_auditor_full",
  "ai_auditor_diff",
  "ai_auditor_finding_validation",
  "auto_prover",
  "auto_fuzzer",
]);
const RUN_STATUSES = new Set([
  "queued",
  "running",
  "finalizing",
  "succeeded",
  "failed",
  "cancelling",
  "cancelled",
]);
const BILLING_STATUSES = new Set([
  "reserved",
  "metering",
  "releasing",
  "settled",
]);
const DELIVERY_STATUSES = new Set([
  "pending",
  "succeeded",
  "failed",
  "skipped",
]);
const DELIVERY_OUTCOMES = new Set(["committed", "no_changes"]);
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USD_REGEX = /^\d+\.\d{4}$/;
const SIGNED_USD_REGEX = /^-?\d+\.\d{4}$/;

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isDeliveryFile(value: unknown): boolean {
  return isRecord(value) && typeof value.path === "string" && value.path !== "";
}

function isRenamedFile(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.from === "string" &&
    value.from !== "" &&
    typeof value.to === "string" &&
    value.to !== ""
  );
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function decodeRun(value: unknown): RunResponse {
  const envelope = requestEnvelope(value);
  const run = envelope.run;
  if (
    !isRecord(run) ||
    typeof run.id !== "string" ||
    !UUID_REGEX.test(run.id) ||
    typeof run.run_type !== "string" ||
    !RUN_TYPES.has(run.run_type) ||
    typeof run.status !== "string" ||
    !RUN_STATUSES.has(run.status) ||
    !isRecord(run.source) ||
    typeof run.source.repository_url !== "string" ||
    (run.client_reference !== null &&
      typeof run.client_reference !== "string") ||
    !isRecord(run.result) ||
    typeof run.result.available !== "boolean" ||
    !isRecord(run.billing) ||
    typeof run.billing.status !== "string" ||
    !BILLING_STATUSES.has(run.billing.status) ||
    typeof run.billing.reserved_usd !== "string" ||
    !USD_REGEX.test(run.billing.reserved_usd) ||
    (run.billing.charged_usd !== null &&
      (typeof run.billing.charged_usd !== "string" ||
        !USD_REGEX.test(run.billing.charged_usd))) ||
    (run.failure !== null &&
      (!isRecord(run.failure) ||
        typeof run.failure.code !== "string" ||
        typeof run.failure.detail !== "string" ||
        typeof run.failure.retryable !== "boolean")) ||
    (run.delivery !== null &&
      (!isRecord(run.delivery) ||
        run.delivery.type !== "github_pull_request" ||
        !Number.isSafeInteger(run.delivery.pull_request_number) ||
        (run.delivery.pull_request_number as number) <= 0 ||
        typeof run.delivery.status !== "string" ||
        !DELIVERY_STATUSES.has(run.delivery.status) ||
        (run.delivery.outcome !== null &&
          (typeof run.delivery.outcome !== "string" ||
            !DELIVERY_OUTCOMES.has(run.delivery.outcome))) ||
        (run.delivery.commit_sha !== null &&
          (typeof run.delivery.commit_sha !== "string" ||
            !SHA_REGEX.test(run.delivery.commit_sha))) ||
        !Array.isArray(run.delivery.files) ||
        !run.delivery.files.every(isDeliveryFile) ||
        !Array.isArray(run.delivery.renamed_files) ||
        !run.delivery.renamed_files.every(isRenamedFile) ||
        !isNullableString(run.delivery.error))) ||
    typeof run.cancellable !== "boolean" ||
    typeof run.created_at !== "string" ||
    !isNullableString(run.started_at) ||
    !isNullableString(run.completed_at) ||
    !isHttpUrl(run.dashboard_url)
  ) {
    invalidResponse("malformed run");
  }
  if (
    run.progress !== null &&
    (!isRecord(run.progress) ||
      typeof run.progress.phase !== "string" ||
      (run.progress.percent !== null &&
        (typeof run.progress.percent !== "number" ||
          !Number.isFinite(run.progress.percent) ||
          run.progress.percent < 0 ||
          run.progress.percent > 100)) ||
      (run.progress.completed_steps !== null &&
        !isNonNegativeInteger(run.progress.completed_steps)) ||
      (run.progress.total_steps !== null &&
        !isNonNegativeInteger(run.progress.total_steps)))
  ) {
    invalidResponse("malformed run progress");
  }
  if (run.status === "succeeded" && run.result.available !== true) {
    invalidResponse("succeeded run without an available result");
  }
  if (
    (run.status === "succeeded" ||
      run.status === "failed" ||
      run.status === "cancelled") &&
    run.billing.status !== "settled"
  ) {
    invalidResponse("terminal run with unsettled billing");
  }
  if (isRecord(run.delivery)) {
    if (
      (run.delivery.status === "succeeded" &&
        (typeof run.delivery.outcome !== "string" ||
          !DELIVERY_OUTCOMES.has(run.delivery.outcome))) ||
      (run.delivery.outcome === "committed" &&
        (typeof run.delivery.commit_sha !== "string" ||
          !SHA_REGEX.test(run.delivery.commit_sha))) ||
      (run.delivery.outcome === "no_changes" &&
        run.delivery.commit_sha !== null)
    ) {
      invalidResponse("inconsistent run delivery");
    }
  }
  return value as RunResponse;
}

function decodeResult(value: unknown): RunResultResponse {
  const envelope = requestEnvelope(value);
  const result = envelope.result;
  if (
    !isRecord(result) ||
    result.schema_version !== "1" ||
    typeof result.run_id !== "string" ||
    typeof result.run_type !== "string" ||
    !RUN_TYPES.has(result.run_type) ||
    !isRecord(result.data)
  ) {
    invalidResponse("malformed run result");
  }
  if (
    (result.run_type === "ai_auditor_full" ||
      result.run_type === "ai_auditor_diff") &&
    (!isPublicReport(result.data.report) ||
      (result.data.intermediate !== undefined &&
        result.data.intermediate !== null &&
        !isPublicReport(result.data.intermediate)))
  ) {
    invalidResponse("malformed AI Auditor report");
  }
  if (
    result.run_type === "ai_auditor_finding_validation" &&
    !isPublicReport(result.data.report)
  ) {
    invalidResponse("malformed finding-validation report");
  }
  if (
    (result.run_type === "auto_prover" || result.run_type === "auto_fuzzer") &&
    (!isRecord(result.data.contract) ||
      typeof result.data.contract.path !== "string" ||
      typeof result.data.contract.name !== "string" ||
      !isRecord(result.data.report))
  ) {
    invalidResponse("malformed standalone report");
  }
  return value as RunResultResponse;
}

function isPublicReport(value: unknown): boolean {
  if (!isRecord(value) || !("content" in value)) return false;
  return (
    value.format === "json" ||
    (value.format === "markdown" && typeof value.content === "string")
  );
}

function decodeCommit(value: unknown): CommitGeneratedFilesResponse {
  const envelope = requestEnvelope(value);
  const delivery = envelope.delivery;
  if (
    !isRecord(delivery) ||
    (delivery.status !== "committed" && delivery.status !== "no_changes") ||
    (delivery.commit_sha !== null && typeof delivery.commit_sha !== "string") ||
    !Array.isArray(delivery.files) ||
    !delivery.files.every(isDeliveryFile) ||
    !Array.isArray(delivery.renamed_files) ||
    !delivery.renamed_files.every(isRenamedFile)
  ) {
    invalidResponse("malformed generated-file delivery");
  }
  if (
    (delivery.status === "committed" &&
      (typeof delivery.commit_sha !== "string" ||
        !SHA_REGEX.test(delivery.commit_sha))) ||
    (delivery.status === "no_changes" && delivery.commit_sha !== null)
  ) {
    invalidResponse("inconsistent generated-file delivery");
  }
  return value as CommitGeneratedFilesResponse;
}

const WORKFLOW_COLLECTIONS: Record<Workflow, string> = {
  "ai-auditor-full": "/v2/ai-auditor-full-runs",
  "ai-auditor-diff": "/v2/ai-auditor-diff-runs",
  "ai-auditor-finding-validation": "/v2/ai-auditor-finding-validations-runs",
  "auto-prover": "/v2/auto-prover-runs",
  "auto-fuzzer": "/v2/auto-fuzzer-runs",
};

function workflowCollection(workflow: Workflow): string {
  return WORKFLOW_COLLECTIONS[workflow];
}

async function request<T>(
  url: string,
  apiKey: string,
  options: RequestInit = {},
  retries = MAX_RETRY_ATTEMPTS,
  deadlineMs?: number,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const remainingMs =
      deadlineMs === undefined
        ? API_REQUEST_TIMEOUT_MS
        : deadlineMs - Date.now();
    if (remainingMs <= 0) throw new AutoProverApiDeadlineError();

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(API_REQUEST_TIMEOUT_MS, remainingMs),
    );
    let serverRetryAfterMs: number | null = null;

    try {
      const hasBody = options.body !== undefined;
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
      });

      if (response.ok) return (await response.json()) as T;

      let problem: ProblemDetails | null = null;
      try {
        const candidate: unknown = await response.json();
        if (
          isRecord(candidate) &&
          typeof candidate.code === "string" &&
          typeof candidate.detail === "string" &&
          typeof candidate.status === "number" &&
          (candidate.retryable === undefined ||
            typeof candidate.retryable === "boolean") &&
          (candidate.request_id === undefined ||
            typeof candidate.request_id === "string") &&
          (candidate.field_errors === undefined ||
            (isRecord(candidate.field_errors) &&
              Object.values(candidate.field_errors).every(
                (messages) =>
                  Array.isArray(messages) &&
                  messages.every((message) => typeof message === "string"),
              )))
        ) {
          problem = candidate as ProblemDetails;
        }
      } catch {
        // Preserve the HTTP status if the upstream response is malformed.
      }

      const error = new AutoProverApiError(
        problem?.code ?? "unknown_error",
        problem?.detail ?? `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        problem?.retryable ??
          (response.status === 429 || response.status >= 500),
        problem?.request_id,
        problem?.field_errors,
      );
      if (!error.retryable) throw error;
      lastError = error;
      serverRetryAfterMs = retryAfterMs(response);
    } catch (error) {
      if (error instanceof AutoProverApiError && !error.retryable) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        if (deadlineMs !== undefined && deadlineMs <= Date.now()) {
          throw new AutoProverApiDeadlineError();
        }
        lastError = new Error("Certora API request timed out.");
        lastError.name = "AutoProverApiTimeoutError";
      } else {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < retries) {
      const remainingBeforeRetry =
        deadlineMs === undefined
          ? Number.POSITIVE_INFINITY
          : deadlineMs - Date.now();
      if (remainingBeforeRetry <= 0)
        throw new AutoProverApiDeadlineError();
      const delay = Math.min(
        serverRetryAfterMs ?? 1000 * 2 ** attempt,
        30_000,
        remainingBeforeRetry,
      );
      core.info(
        `Request failed, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${retries})...`,
      );
      await sleep(delay);
    }
  }

  throw lastError ?? new Error("Request failed after all retries");
}

export class AutoProverApi {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async estimateRun(
    workflow: Workflow,
    body: RunRequest,
  ): Promise<EstimateResponse> {
    return decodeEstimate(
      await request<unknown>(
        `${this.baseUrl}${workflowCollection(workflow)}/estimate`,
        this.apiKey,
        { method: "POST", body: JSON.stringify(body) },
      ),
    );
  }

  async createRun(
    workflow: Workflow,
    body: RunRequest,
    idempotencyKey: string,
    estimateQuoteId?: string,
  ): Promise<RunResponse> {
    return decodeRun(
      await request<unknown>(
        `${this.baseUrl}${workflowCollection(workflow)}`,
        this.apiKey,
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: {
            "Idempotency-Key": idempotencyKey,
            ...(estimateQuoteId
              ? { "Estimate-Quote-Id": estimateQuoteId }
              : {}),
          },
        },
      ),
    );
  }

  async getRun(runId: string, deadlineMs?: number): Promise<RunResponse> {
    return decodeRun(
      await request<unknown>(
        `${this.baseUrl}/v2/runs/${runId}`,
        this.apiKey,
        {},
        MAX_RETRY_ATTEMPTS,
        deadlineMs,
      ),
    );
  }

  async getResult(
    runId: string,
    deadlineMs?: number,
  ): Promise<RunResultResponse> {
    return decodeResult(
      await request<unknown>(
        `${this.baseUrl}/v2/runs/${runId}/result`,
        this.apiKey,
        {},
        MAX_RETRY_ATTEMPTS,
        deadlineMs,
      ),
    );
  }

  async cancelRun(runId: string, deadlineMs?: number): Promise<RunResponse> {
    return decodeRun(
      await request<unknown>(
        `${this.baseUrl}/v2/runs/${runId}/cancel`,
        this.apiKey,
        { method: "POST" },
        MAX_RETRY_ATTEMPTS,
        deadlineMs,
      ),
    );
  }

  async commitGeneratedFiles(
    runId: string,
  ): Promise<CommitGeneratedFilesResponse> {
    return decodeCommit(
      await request<unknown>(
        `${this.baseUrl}/v2/runs/${runId}/generated-files/commit`,
        this.apiKey,
        { method: "POST" },
        MAX_RETRY_ATTEMPTS,
      ),
    );
  }
}
