import * as core from "@actions/core";
import type {
  AuditResultResponse,
  CancelAuditResponse,
  CommitGeneratedFilesRequest,
  CommitGeneratedFilesResponse,
  CreateAuditResponse,
  DiffAuditRequest,
  FullAuditRequest,
  ApiErrorResponse,
  ProgressResponse,
  StandaloneAuditRequest,
  StatusResponse,
  AuditStatus,
} from "./types";
import { API_REQUEST_TIMEOUT_MS, MAX_RETRY_ATTEMPTS } from "./constants";

export class ZeusApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "ZeusApiError";
  }
}

export class ZeusApiDeadlineError extends Error {
  constructor() {
    super("The configured audit timeout expired during a Zeus API request.");
    this.name = "ZeusApiDeadlineError";
  }
}

export function getZeusApiErrorMessage(error: ZeusApiError): string {
  switch (error.code) {
    case "invalid_api_key":
      return "Invalid Zeus API key. Check the API key supplied to this action.";
    case "insufficient_balance":
    case "insufficient_credits":
      return "Insufficient Zeus balance. Please top up at https://zeus.certora.com.";
    default:
      return `Zeus API error (${error.code}): ${error.message}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const AMBIGUOUS_LAUNCH_GUIDANCE =
  "The launch outcome may be unknown; inspect the audit list before rerunning.";

function ambiguousLaunchError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`${detail} ${AMBIGUOUS_LAUNCH_GUIDANCE}`);
  wrapped.name = "ZeusApiAmbiguousLaunchError";
  return wrapped;
}

type NormalizedAuditStatus = Exclude<AuditStatus, "canceled">;

/** The public API accepts both spellings; action outputs use `cancelled`. */
export function normalizeAuditStatus(
  status: AuditStatus,
): NormalizedAuditStatus {
  return status === "canceled" ? "cancelled" : status;
}

async function request<T>(
  url: string,
  apiKey: string,
  options: RequestInit = {},
  retries = MAX_RETRY_ATTEMPTS,
  retryableErrorCodes: readonly string[] = [],
  deadlineMs?: number,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const remainingMs =
      deadlineMs === undefined
        ? API_REQUEST_TIMEOUT_MS
        : deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new ZeusApiDeadlineError();
    }
    const requestTimeoutMs = Math.min(API_REQUEST_TIMEOUT_MS, remainingMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      // Parse error response
      let errorBody: ApiErrorResponse | null = null;
      try {
        errorBody = (await response.json()) as ApiErrorResponse;
      } catch {
        // Ignore JSON parse failure
      }

      const code = errorBody?.error?.code ?? "unknown_error";
      const message =
        errorBody?.error?.message ??
        `HTTP ${response.status}: ${response.statusText}`;

      const shouldRetry =
        response.status === 429 ||
        response.status >= 500 ||
        retryableErrorCodes.includes(code);

      if (!shouldRetry) {
        throw new ZeusApiError(code, message, response.status);
      }

      lastError =
        options.method === "POST" && retries === 0 && response.status >= 500
          ? new ZeusApiError(
              code,
              `${message} ${AMBIGUOUS_LAUNCH_GUIDANCE}`,
              response.status,
            )
          : new ZeusApiError(code, message, response.status);
    } catch (error) {
      if (
        error instanceof ZeusApiError &&
        error.statusCode < 500 &&
        error.statusCode !== 429
      ) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        if (deadlineMs !== undefined && deadlineMs - Date.now() <= 0) {
          throw new ZeusApiDeadlineError();
        }
        const timeoutSeconds = Math.ceil(requestTimeoutMs / 1000);
        const ambiguousLaunch =
          options.method === "POST" && retries === 0
            ? ` ${AMBIGUOUS_LAUNCH_GUIDANCE}`
            : "";
        lastError = new Error(
          `Zeus API request timed out after ${timeoutSeconds} seconds.${ambiguousLaunch}`,
        );
        lastError.name = "ZeusApiTimeoutError";
      } else {
        lastError =
          options.method === "POST" &&
          retries === 0 &&
          !(error instanceof ZeusApiError)
            ? ambiguousLaunchError(error)
            : error instanceof Error
              ? error
              : new Error(String(error));
      }
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < retries) {
      const remainingBeforeRetry =
        deadlineMs === undefined
          ? Number.POSITIVE_INFINITY
          : deadlineMs - Date.now();
      if (remainingBeforeRetry <= 0) {
        throw new ZeusApiDeadlineError();
      }
      const delay = Math.min(1000 * 2 ** attempt, 30000, remainingBeforeRetry);
      core.info(
        `Request failed, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${retries})...`,
      );
      await sleep(delay);
    }
  }

  throw lastError ?? new Error("Request failed after all retries");
}

export class ZeusApi {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async createFullAudit(body: FullAuditRequest): Promise<CreateAuditResponse> {
    return request<CreateAuditResponse>(
      `${this.baseUrl}/api/v1/audits`,
      this.apiKey,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      0,
    );
  }

  async createDiffAudit(body: DiffAuditRequest): Promise<CreateAuditResponse> {
    return request<CreateAuditResponse>(
      `${this.baseUrl}/api/v1/diff-audits`,
      this.apiKey,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      0,
    );
  }

  async createStandaloneAudit(
    body: StandaloneAuditRequest,
  ): Promise<CreateAuditResponse> {
    return request<CreateAuditResponse>(
      `${this.baseUrl}/api/v1/audits`,
      this.apiKey,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      0,
    );
  }

  async getStatus(jobId: string, deadlineMs?: number): Promise<StatusResponse> {
    const response = await request<StatusResponse>(
      `${this.baseUrl}/api/v1/audits/${jobId}`,
      this.apiKey,
      {},
      MAX_RETRY_ATTEMPTS,
      [],
      deadlineMs,
    );
    return { ...response, status: normalizeAuditStatus(response.status) };
  }

  async getProgress(
    jobId: string,
    deadlineMs?: number,
  ): Promise<ProgressResponse> {
    const response = await request<ProgressResponse>(
      `${this.baseUrl}/api/v1/audits/${jobId}/progress`,
      this.apiKey,
      {},
      MAX_RETRY_ATTEMPTS,
      [],
      deadlineMs,
    );
    return { ...response, status: normalizeAuditStatus(response.status) };
  }

  async getResult(
    jobId: string,
    deadlineMs?: number,
  ): Promise<AuditResultResponse> {
    return request<AuditResultResponse>(
      `${this.baseUrl}/api/v1/audits/${jobId}/result`,
      this.apiKey,
      {},
      MAX_RETRY_ATTEMPTS,
      ["result_not_ready"],
      deadlineMs,
    );
  }

  async cancelAudit(jobId: string): Promise<CancelAuditResponse> {
    return request<CancelAuditResponse>(
      `${this.baseUrl}/api/v1/audits/${jobId}`,
      this.apiKey,
      { method: "DELETE" },
      0, // No retries for cancel: the accepted response may be lost.
    );
  }

  async commitGeneratedFiles(
    jobId: string,
    body: CommitGeneratedFilesRequest,
  ): Promise<CommitGeneratedFilesResponse> {
    return request<CommitGeneratedFilesResponse>(
      `${this.baseUrl}/api/v1/audits/${jobId}/generated-files/commit`,
      this.apiKey,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      MAX_RETRY_ATTEMPTS,
      ["generated_files_not_ready"],
    );
  }
}
