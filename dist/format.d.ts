import type { AissRunReport, AissRunOutcome, AuditFindings, CommitGeneratedFilesResponse, Finding, FindingValidationReport, ModelMode, PublicReport } from "./types";
export declare function formatIssueTitle(finding: Finding): string;
export declare function formatIssueBody(finding: Finding, runId: string, prNumber: number): string;
export declare function formatPrComment(findings: AuditFindings, runId: string, cost: number | null, issueLinks: {
    finding: Finding;
    url: string;
}[], prNumber: number, workflow: "ai-auditor-full" | "ai-auditor-diff", modelMode?: ModelMode | null): string;
export declare function formatAiAuditorMarkdownPrComment(args: {
    workflow: "ai-auditor-full" | "ai-auditor-diff";
    runId: string;
    cost: number | null;
    content: string;
    modelMode?: ModelMode | null;
}): string;
export declare function formatFindingValidationPrComment(args: {
    runId: string;
    cost: number | null;
    report: PublicReport;
    parsed: FindingValidationReport | null;
    modelMode?: ModelMode | null;
}): string;
export declare function isFailingStandaloneOutcome(outcome: AissRunOutcome): boolean;
export declare function getStandaloneWarnings(report: AissRunReport, engine?: "auto-prover" | "auto-fuzzer"): string[];
export declare function formatStandalonePrComment(args: {
    workflow: "auto-prover" | "auto-fuzzer";
    runId: string;
    cost: number | null;
    report: AissRunReport;
    commit: CommitGeneratedFilesResponse;
}): string;
