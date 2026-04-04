import * as core from "@actions/core";
import type {
  AuditResultResponse,
  CreateAuditResponse,
  DiffAuditRequest,
  ApiErrorResponse,
  ProgressResponse,
  StatusResponse,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request<T>(
  url: string,
  apiKey: string,
  options: RequestInit = {},
  retries = MAX_RETRY_ATTEMPTS
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

      // Don't retry client errors (except 429)
      if (response.status !== 429 && response.status < 500) {
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

  async createDiffAudit(body: DiffAuditRequest): Promise<CreateAuditResponse> {
    return request<CreateAuditResponse>(
      `${this.baseUrl}/api/v1/diff-audits`,
      this.apiKey,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
  }

  async getStatus(jobId: string): Promise<StatusResponse> {
    return request<StatusResponse>(
      `${this.baseUrl}/api/v1/audits/${jobId}`,
      this.apiKey
    );
  }

  async getProgress(jobId: string): Promise<ProgressResponse> {
    return request<ProgressResponse>(
      `${this.baseUrl}/api/v1/audits/${jobId}/progress`,
      this.apiKey
    );
  }

  async getResult(jobId: string): Promise<AuditResultResponse> {
    return request<AuditResultResponse>(
      `${this.baseUrl}/api/v1/audits/${jobId}/result`,
      this.apiKey
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
