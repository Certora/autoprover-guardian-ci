import type { Finding, Severity } from "./types";
export declare class GitHubClient {
    private octokit;
    private owner;
    private repo;
    constructor(token: string);
    ensureLabelsExist(labels: string[], severities: Severity[]): Promise<void>;
    findExistingIssue(finding: Finding): Promise<number | null>;
    createOrUpdateIssue(finding: Finding, runId: string, prNumber: number, labels: string[]): Promise<string | null>;
    upsertPrComment(prNumber: number, body: string, marker: string | undefined, expectedHeadSha: string, runId: string): Promise<void>;
    private isCurrentPrHead;
    getGeneratedFollowup(headSha: string): Promise<{
        runId: string;
        sourceCommitSha: string;
    } | null>;
}
