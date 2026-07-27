import type { AuditResultResponse, CancelAuditResponse, CommitGeneratedFilesRequest, CommitGeneratedFilesResponse, CreateAuditResponse, DiffAuditRequest, FullAuditRequest, ProgressResponse, StandaloneAuditRequest, StatusResponse, AuditStatus } from "./types";
export declare class ZeusApiError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode: number);
}
export declare class ZeusApiDeadlineError extends Error {
    constructor();
}
export declare function getZeusApiErrorMessage(error: ZeusApiError): string;
type NormalizedAuditStatus = Exclude<AuditStatus, "canceled">;
/** The public API accepts both spellings; action outputs use `cancelled`. */
export declare function normalizeAuditStatus(status: AuditStatus): NormalizedAuditStatus;
export declare class ZeusApi {
    private baseUrl;
    private apiKey;
    constructor(baseUrl: string, apiKey: string);
    createFullAudit(body: FullAuditRequest): Promise<CreateAuditResponse>;
    createDiffAudit(body: DiffAuditRequest): Promise<CreateAuditResponse>;
    createStandaloneAudit(body: StandaloneAuditRequest): Promise<CreateAuditResponse>;
    getStatus(jobId: string, deadlineMs?: number): Promise<StatusResponse>;
    getProgress(jobId: string, deadlineMs?: number): Promise<ProgressResponse>;
    getResult(jobId: string, deadlineMs?: number): Promise<AuditResultResponse>;
    cancelAudit(jobId: string): Promise<CancelAuditResponse>;
    commitGeneratedFiles(jobId: string, body: CommitGeneratedFilesRequest): Promise<CommitGeneratedFilesResponse>;
}
export {};
