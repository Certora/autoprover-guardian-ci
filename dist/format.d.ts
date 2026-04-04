import type { AuditFindings, Finding } from "./types";
export declare function formatIssueTitle(finding: Finding): string;
export declare function formatIssueBody(finding: Finding, jobId: string, prNumber: number): string;
export declare function formatPrComment(findings: AuditFindings, jobId: string, cost: number, issueLinks: {
    finding: Finding;
    url: string;
}[], prNumber: number): string;
export declare function formatLegacyPrComment(markdownResult: string, jobId: string, prNumber: number): string;
