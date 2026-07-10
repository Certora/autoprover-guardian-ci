import * as core from "@actions/core";
import type {
  AuditResultResponse,
  CreateAuditResponse,
  DiffAuditRequest,
  FullAuditRequest,
  ApiErrorResponse,
  ProgressResponse,
  StatusResponse,
  AuditStatus,
} from "./types";
import { MAX_RETRY_ATTEMPTS } from "./constants";

export class ZeusApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = "ZeusApiError";
  }
}

export function getZeusApiErrorMessage(error: ZeusApiError): string {
  switch (error.code) {
    case "invalid_api_key":
      return "Invalid Auto Prover API key. Please check your AI_AUDITOR_API_KEY secret.";
    case "insufficient_balance":
    case "insufficient_credits":
      return "Insufficient Auto Prover balance. Please top up at https://zeus.certora.com.";
    default:
      return `Auto Prover API error (${error.code}): ${error.message}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type NormalizedAuditStatus = Exclude<AuditStatus, "canceled">;

/** The public API accepts both spellings; action outputs use `cancelled`. */
export function normalizeAuditStatus(
  status: AuditStatus
): NormalizedAuditStatus {
  return status === "canceled" ? "cancelled" : status;
}

async function request<T>(
  url: string,
  apiKey: string,
  options: RequestInit = {},
  retries = MAX_RETRY_ATTEMPTS,
  retryableErrorCodes: readonly string[] = []
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
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
        errorBody?.error?.message ?? `HTTP ${response.status}: ${response.statusText}`;

      const shouldRetry =
        response.status === 429 ||
        response.status >= 500 ||
        retryableErrorCodes.includes(code);

      if (!shouldRetry) {
        throw new ZeusApiError(code, message, response.status);
      }

      lastError = new ZeusApiError(code, message, response.status);
    } catch (error) {
      if (error instanceof ZeusApiError && error.statusCode < 500 && error.statusCode !== 429) {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < retries) {
      const delay = Math.min(1000 * 2 ** attempt, 30000);
      core.info(`Request failed, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${retries})...`);
      await sleep(delay);
    }
  }

  throw lastError ?? new Error("Request failed after all retries");
}

export class ZeusApi {
  constructor(
    private baseUrl: string,
    private apiKey: string
  ) {}

  async createFullAudit(body: FullAuditRequest): Promise<CreateAuditResponse> {
    return request<CreateAuditResponse>(
      `${this.baseUrl}/api/v1/audits`,
      this.apiKey,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      0
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
      0
    );
  }

  async getStatus(jobId: string): Promise<StatusResponse> {
    const response = await request<StatusResponse>(
      `${this.baseUrl}/api/v1/audits/${jobId}`,
      this.apiKey
    );
    return { ...response, status: normalizeAuditStatus(response.status) };
  }

  async getProgress(jobId: string): Promise<ProgressResponse> {
    const response = await request<ProgressResponse>(
      `${this.baseUrl}/api/v1/audits/${jobId}/progress`,
      this.apiKey
    );
    return { ...response, status: normalizeAuditStatus(response.status) };
  }

  async getResult(jobId: string): Promise<AuditResultResponse> {
    return request<AuditResultResponse>(
      `${this.baseUrl}/api/v1/audits/${jobId}/result`,
      this.apiKey,
      {},
      MAX_RETRY_ATTEMPTS,
      ["result_not_ready"]
    );
  }

  async cancelAudit(jobId: string): Promise<void> {
    await request(
      `${this.baseUrl}/api/v1/audits/${jobId}`,
      this.apiKey,
      { method: "DELETE" },
      0 // No retries for cancel
    );
  }
}
