import type { Finding, Severity } from "./types";
export declare class GitHubClient {
    private octokit;
    private owner;
    private repo;
    constructor(token: string);
    /** Pin live branch tips, never the synthetic pull-request merge commit. */
    resolveDiffSource(args: {
        prNumber: number;
        repositoryUrl: string;
        baseBranchName?: string;
        headBranchName?: string;
        headCommitSha: string;
        deadlineMs?: number;
    }): Promise<{
        baseCommitSha: string;
        headCommitSha: string;
    }>;
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
