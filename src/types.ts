export type Severity = "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type AuditStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type DiffAuditRequest = {
  target: string;
  branch_starting: string;
  branch_ending: string;
  context: string[];
  preprompt?: string;
  token?: string;
  skip_submodules?: boolean;
  max_iterations?: number;
};

export type CreateAuditResponse = {
  job_id: string;
  status: AuditStatus;
  audit_type: string;
  remaining_credits: number;
};

export type StatusResponse = {
  job_id: string;
  status: AuditStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
};

export type ProgressResponse = {
  job_id: string;
  status: AuditStatus;
  current_phase: string;
  completed_phases: number;
  total_phases: number;
  progress: number;
  progress_percent: number;
  actual_cost_usd: number;
};

export type Finding = {
  id: string;
  title: string;
  severity: Severity;
  locations: string[];
  description: string;
  recommendation: string;
};

export type AuditFindings = {
  highs: Finding[];
  mediums: Finding[];
  lows: Finding[];
  infos: Finding[];
};

export type AuditResultResponse = {
  job_id: string;
  status: string;
  actual_cost_usd: number;
  result:
    | {
        config: Record<string, unknown>;
        findings: AuditFindings;
      }
    | string;
  intermediate_result: unknown;
};

export type ApiErrorResponse = {
  error: {
    code: string;
    message: string;
  };
};

export type ActionConfig = {
  apiKey: string;
  apiBaseUrl: string;
  context: string[];
  githubToken: string;
  preprompt?: string;
  maxIterations: number;
  skipSubmodules: boolean;
  pollInterval: number;
  timeout: number;
  createIssues: boolean;
  issueSeverities: Severity[];
  commentOnPr: boolean;
  failOn: Severity[];
  labels: string[];
  target: string;
  branchStarting: string;
  branchEnding: string;
  prNumber: number;
};
