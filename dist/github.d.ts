import type { Finding, Severity } from "./types";
export declare class GitHubClient {
    private octokit;
    private owner;
    private repo;
    constructor(token: string);
    ensureLabelsExist(labels: string[], severities: Severity[]): Promise<void>;
    findExistingIssue(finding: Finding): Promise<number | null>;
    createOrUpdateIssue(finding: Finding, jobId: string, prNumber: number, labels: string[]): Promise<string | null>;
    upsertPrComment(prNumber: number, body: string): Promise<void>;
    getGeneratedFollowupJobId(headSha: string): Promise<string | null>;
}
