import type {
  AissRunReport,
  AissRunOutcome,
  AuditFindings,
  CommitGeneratedFilesResponse,
  Finding,
  FindingValidationReport,
  PublicReport,
} from "./types";
export declare function formatIssueTitle(finding: Finding): string;
export declare function formatIssueBody(
  finding: Finding,
  runId: string,
  prNumber: number,
): string;
export declare function formatPrComment(
  findings: AuditFindings,
  runId: string,
  cost: number | null,
  issueLinks: {
    finding: Finding;
    url: string;
  }[],
  prNumber: number,
  workflow: "ai-auditor-full" | "ai-auditor-diff",
): string;
export declare function formatAiAuditorMarkdownPrComment(args: {
  workflow: "ai-auditor-full" | "ai-auditor-diff";
  runId: string;
  cost: number | null;
  content: string;
}): string;
export declare function formatFindingValidationPrComment(args: {
  runId: string;
  cost: number | null;
  report: PublicReport;
  parsed: FindingValidationReport | null;
}): string;
export declare function isFailingStandaloneOutcome(
  outcome: AissRunOutcome,
): boolean;
export declare function getStandaloneWarnings(
  report: AissRunReport,
  engine?: "auto-prover" | "auto-foundry",
): string[];
export declare function formatStandalonePrComment(args: {
  workflow: "auto-prover" | "auto-foundry";
  runId: string;
  cost: number | null;
  report: AissRunReport;
  commit: CommitGeneratedFilesResponse;
}): string;
