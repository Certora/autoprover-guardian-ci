import type { CommitGeneratedFilesResponse, EstimateResponse, RunRequest, RunResponse, RunResultResponse, Workflow } from "./types";
export declare class AutoProverApiError extends Error {
    code: string;
    statusCode: number;
    retryable: boolean;
    requestId?: string | undefined;
    fieldErrors?: Record<string, string[]> | undefined;
    constructor(code: string, message: string, statusCode: number, retryable: boolean, requestId?: string | undefined, fieldErrors?: Record<string, string[]> | undefined);
}
export declare class AutoProverApiDeadlineError extends Error {
    constructor();
}
export declare function getAutoProverApiErrorMessage(error: AutoProverApiError): string;
/** Stable across action retries and process restarts for an identical launch. */
export declare function createIdempotencyKey(workflow: Workflow, body: RunRequest, executionSeed: string): string;
export declare class AutoProverApi {
    private baseUrl;
    private apiKey;
    constructor(baseUrl: string, apiKey: string);
    estimateRun(workflow: Workflow, body: RunRequest): Promise<EstimateResponse>;
    createRun(workflow: Workflow, body: RunRequest, idempotencyKey: string, estimateQuoteId?: string): Promise<RunResponse>;
    getRun(runId: string, deadlineMs?: number): Promise<RunResponse>;
    getResult(runId: string, deadlineMs?: number): Promise<RunResultResponse>;
    cancelRun(runId: string, deadlineMs?: number): Promise<RunResponse>;
    commitGeneratedFiles(runId: string): Promise<CommitGeneratedFilesResponse>;
}
