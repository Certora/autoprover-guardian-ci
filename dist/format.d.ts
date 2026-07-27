import type { AissRunReport, AissRunOutcome, AuditFindings, CommitGeneratedFilesResponse, Engine, Finding } from "./types";
export declare function formatIssueTitle(finding: Finding): string;
export declare function formatIssueBody(finding: Finding, jobId: string, prNumber: number): string;
export declare function formatPrComment(findings: AuditFindings, jobId: string, cost: number, issueLinks: {
    finding: Finding;
    url: string;
}[], prNumber: number): string;
export declare function formatLegacyPrComment(markdownResult: string, jobId: string, prNumber: number): string;
export declare function isFailingStandaloneOutcome(outcome: AissRunOutcome): boolean;
export declare function getStandaloneWarnings(reportState: string, report: AissRunReport | null, engine?: Exclude<Engine, "ai-auditor">): string[];
export declare function formatStandalonePrComment(args: {
    engine: Exclude<Engine, "ai-auditor">;
    jobId: string;
    cost: number;
    reportState: string;
    report: AissRunReport | null;
    commit: CommitGeneratedFilesResponse;
}): string;
