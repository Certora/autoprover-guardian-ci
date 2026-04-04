import type { AuditResultResponse, CreateAuditResponse, DiffAuditRequest, ProgressResponse, StatusResponse } from "./types";
export declare class ZeusApiError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode: number);
}
export declare class ZeusApi {
    private baseUrl;
    private apiKey;
    constructor(baseUrl: string, apiKey: string);
    createDiffAudit(body: DiffAuditRequest): Promise<CreateAuditResponse>;
    getStatus(jobId: string): Promise<StatusResponse>;
    getProgress(jobId: string): Promise<ProgressResponse>;
    getResult(jobId: string): Promise<AuditResultResponse>;
    cancelAudit(jobId: string): Promise<void>;
}
