export type Severity = "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type ModelMode = "normal" | "frontier";

export type Workflow =
  | "ai-auditor-full"
  | "ai-auditor-diff"
  | "ai-auditor-finding-validation"
  | "auto-prover"
  | "auto-fuzzer";

export type RunType =
  | "ai_auditor_full"
  | "ai_auditor_diff"
  | "ai_auditor_finding_validation"
  | "auto_prover"
  | "auto_fuzzer";

export type Engine = "ai-auditor" | "auto-prover" | "auto-fuzzer";

export type RunStatus =
  | "queued"
  | "running"
  | "finalizing"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled";

export type BillingStatus = "reserved" | "metering" | "releasing" | "settled";

export type RepositoryAuthentication =
  | { type: "public" }
  | { type: "organization_github_app" }
  | { type: "ephemeral_token"; token: string };

export type SingleCommitSource = {
  repository_url: string;
  commit_sha: string;
  authentication?: RepositoryAuthentication;
};

export type DiffSource = {
  repository_url: string;
  base_commit_sha: string;
  head_commit_sha: string;
  authentication?: RepositoryAuthentication;
};

export type AiAuditorFullRunRequest = {
  source: SingleCommitSource;
  model_mode?: ModelMode;
  context: string[];
  scope?: string[];
  instructions?: string;
  use_memory?: boolean;
  skip_submodules?: boolean;
  max_iterations?: number;
  client_reference?: string;
};

export type AiAuditorDiffRunRequest = {
  source: DiffSource;
  model_mode?: ModelMode;
  context: string[];
  instructions?: string;
  skip_submodules?: boolean;
  max_iterations?: number;
  client_reference?: string;
};

export type AiAuditorFindingValidationRunRequest = {
  source: SingleCommitSource;
  model_mode?: ModelMode;
  context: string[];
  finding: string;
  skip_submodules?: boolean;
  client_reference?: string;
};

export type StandaloneRunRequest = {
  source: SingleCommitSource;
  contract: {
    path: string;
    name: string;
  };
  documents?: {
    design?: string;
    threat_model?: string;
  };
  delivery: {
    type: "github_pull_request";
    pull_request_number: number;
  };
  client_reference?: string;
};

export type RunRequest =
  | AiAuditorFullRunRequest
  | AiAuditorDiffRunRequest
  | AiAuditorFindingValidationRunRequest
  | StandaloneRunRequest;

export type RunEstimate = {
  estimated_cost_usd: string;
  minimum_balance_required_usd: string;
  balance_usd: string;
  can_launch: boolean;
  estimate_quote_id?: string;
};

export type EstimateResponse = {
  request_id: string;
  estimate: RunEstimate;
};

export type RunProgress = {
  phase: string;
  percent: number | null;
  completed_steps: number | null;
  total_steps: number | null;
};

export type RunError = {
  code: string;
  detail: string;
};

export type Run = {
  id: string;
  run_type: RunType;
  model_mode?: ModelMode | null;
  status: RunStatus;
  source: {
    repository_url: string;
    commit_sha?: string;
    base_commit_sha?: string;
    head_commit_sha?: string;
  };
  client_reference: string | null;
  progress: RunProgress | null;
  result: { available: boolean };
  billing: {
    status: BillingStatus;
    reserved_usd: string;
    charged_usd: string | null;
  };
  failure: (RunError & { retryable: boolean }) | null;
  delivery: {
    type: "github_pull_request";
    pull_request_number: number;
    status: "pending" | "succeeded" | "failed" | "skipped";
    outcome: "committed" | "no_changes" | null;
    commit_sha: string | null;
    files: { path: string }[];
    renamed_files: { from: string; to: string }[];
    error: string | null;
  } | null;
  cancellable: boolean;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  dashboard_url: string;
};

export type RunResponse = {
  request_id: string;
  run: Run;
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

export type AissRunOutcome =
  | "verified"
  | "verified_with_gaps"
  | "partial"
  | "issues_found"
  | "unknown";

export type AissStatusCount = {
  status: string;
  count: number;
};

export type AissCoverage = {
  total_properties: number;
  total_rules: number;
  total_groups: number;
  property_coverage_complete: boolean;
  properties_in_no_group: { component: string; title: string }[];
  rules_spanning_multiple_groups: string[];
  skipped_count: number;
  gave_up_component_count: number;
  dropped_orphan_rules: number;
  warnings: string[];
};

export type AissRunReport = {
  schema_version: string;
  backend: "prover" | "foundry" | null;
  contract_name: string;
  outcome: AissRunOutcome;
  rule_counts: AissStatusCount[];
  group_counts?: AissStatusCount[];
  skipped: unknown[];
  gave_up_components: unknown[];
  coverage: AissCoverage;
};

export type PublicReport =
  | { format: "markdown"; content: string }
  | { format: "json"; content: unknown };

export type AiAuditorResultData = {
  report: PublicReport;
  intermediate?: PublicReport | null;
};

export type FindingValidationResultData = {
  report: PublicReport;
};

export type FindingValidationModelVerdict = {
  verdict: "VALID" | "INVALID";
  severity: string | null;
  reasoning: string;
};

export type FindingValidationReport = {
  final_verdict: "VALID" | "INVALID";
  final_severity: string | null;
  severity_reasoning: string;
  impact: string;
  likelihood: string;
  false_positive_reasoning: string | null;
  consensus_method:
    | "unanimous_valid"
    | "unanimous_invalid"
    | "tiebreaker_valid"
    | "tiebreaker_invalid";
  analysis_status: string;
  claude_verdict: FindingValidationModelVerdict | null;
  gpt_verdict: FindingValidationModelVerdict | null;
  tiebreaker_verdict: FindingValidationModelVerdict | null;
};

export type StandaloneResultData = {
  contract: {
    path: string;
    name: string;
  };
  report: unknown;
};

export type RunResult =
  | {
      schema_version: "1";
      run_id: string;
      run_type: "ai_auditor_full" | "ai_auditor_diff";
      data: AiAuditorResultData;
    }
  | {
      schema_version: "1";
      run_id: string;
      run_type: "ai_auditor_finding_validation";
      data: FindingValidationResultData;
    }
  | {
      schema_version: "1";
      run_id: string;
      run_type: "auto_prover" | "auto_fuzzer";
      data: StandaloneResultData;
    };

export type RunResultResponse = {
  request_id: string;
  result: RunResult;
};

export type CommitGeneratedFilesResponse = {
  request_id: string;
  delivery: {
    status: "committed" | "no_changes";
    commit_sha: string | null;
    files: { path: string }[];
    renamed_files: { from: string; to: string }[];
  };
};

export type ProblemDetails = {
  type?: string;
  title?: string;
  status: number;
  detail: string;
  code: string;
  request_id?: string;
  retryable?: boolean;
  field_errors?: Record<string, string[]>;
};

type CommonActionConfig = {
  workflow: Workflow;
  apiKey: string;
  apiBaseUrl: string;
  githubToken: string;
  pollInterval: number;
  timeout: number;
  commentOnPr: boolean;
  repositoryUrl: string;
  repositoryPrivate: boolean;
  baseCommitSha: string;
  headCommitSha: string;
  prNumber: number;
  githubRunAttempt: number;
  idempotencySeed: string;
};

export type AiAuditorActionConfig = CommonActionConfig & {
  workflow: "ai-auditor-full" | "ai-auditor-diff";
  modelMode?: ModelMode;
  context: string[];
  scope?: string[];
  instructions?: string;
  useMemory: boolean;
  maxIterations: number;
  skipSubmodules: boolean;
  createIssues: boolean;
  issueSeverities: Severity[];
  failOn: Severity[];
  labels: string[];
};

export type FindingValidationActionConfig = CommonActionConfig & {
  workflow: "ai-auditor-finding-validation";
  modelMode?: ModelMode;
  context: string[];
  finding: string;
  skipSubmodules: boolean;
};

export type StandaloneActionConfig = CommonActionConfig & {
  workflow: "auto-prover" | "auto-fuzzer";
  contractPath: string;
  contractName: string;
  designDocPath?: string;
  threatModelPath?: string;
};

export type ActionConfig =
  | AiAuditorActionConfig
  | FindingValidationActionConfig
  | StandaloneActionConfig;

export function workflowEngine(workflow: Workflow): Engine {
  if (workflow === "auto-prover" || workflow === "auto-fuzzer") {
    return workflow;
  }
  return "ai-auditor";
}

export function workflowRunType(workflow: Workflow): RunType {
  if (workflow === "ai-auditor-full") return "ai_auditor_full";
  if (workflow === "ai-auditor-diff") return "ai_auditor_diff";
  if (workflow === "ai-auditor-finding-validation") {
    return "ai_auditor_finding_validation";
  }
  if (workflow === "auto-prover") return "auto_prover";
  return "auto_fuzzer";
}
