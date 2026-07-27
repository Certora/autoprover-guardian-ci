export type Severity = "HIGH" | "MEDIUM" | "LOW" | "INFO";
export type AuditType = "full" | "diff";
export type Engine = "ai-auditor" | "auto-prover" | "auto-foundry";
export type AuditStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "canceled";
export type FullAuditRequest = {
    engine: "ai-auditor";
    target: string;
    branch: string;
    context: string[];
    scope?: string[];
    preprompt?: string;
    use_memory?: boolean;
    token?: string;
    skip_submodules?: boolean;
    max_iterations?: number;
};
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
export type StandaloneAuditRequest = {
    engine: "auto-prover" | "auto-foundry";
    target: string;
    branch: string;
    pull_request_number: number;
    contract_path: string;
    contract_name: string;
    design_doc_path?: string;
    threat_model_path?: string;
    token?: string;
};
export type CreateAuditResponse = {
    job_id: string;
    status: AuditStatus;
    engine?: Engine;
    audit_type?: string;
    required_balance_usd?: number;
    current_balance_usd?: number;
    /** Legacy SaaS response field, kept for older deployments. */
    remaining_credits?: number;
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
    billed_amount_usd?: number;
    /** Legacy backend/private API field, not exposed by current public v1 API. */
    actual_cost_usd?: number;
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
export type AissRunOutcome = "verified" | "verified_with_gaps" | "partial" | "issues_found" | "unknown";
export type AissStatusCount = {
    status: string;
    count: number;
};
export type AissCoverage = {
    totalProperties: number;
    totalRules: number;
    totalGroups: number;
    propertyCoverageComplete: boolean;
    propertiesInNoGroup: {
        component: string;
        title: string;
    }[];
    rulesSpanningMultipleGroups: string[];
    skippedCount: number;
    gaveUpComponentCount: number;
    droppedOrphanRules: number;
    warnings: string[];
};
export type AissRunReport = {
    contractName: string;
    outcome: AissRunOutcome;
    ruleCounts: AissStatusCount[];
    groupCounts?: AissStatusCount[];
    skipped: unknown[];
    gaveUpComponents: unknown[];
    coverage: AissCoverage;
};
export type AissArtifact = {
    key?: string;
    name?: string;
    path?: string;
    [key: string]: unknown;
};
export type AissResult = {
    report_state: "ready" | "not_published" | "invalid" | "unavailable";
    report: AissRunReport | null;
    artifacts: AissArtifact[];
};
export type AiAuditorResult = {
    config: Record<string, unknown>;
    findings: AuditFindings;
};
export type AuditResultResponse = {
    job_id: string;
    engine?: Engine;
    status: string;
    billed_amount_usd?: number;
    /** Immutable standalone launch identity; absent on older API deployments. */
    contract_path?: string;
    /** Immutable standalone launch identity; absent on older API deployments. */
    contract_name?: string;
    /** Legacy backend/private API field, not exposed by current public v1 API. */
    actual_cost_usd?: number;
    result: AiAuditorResult | AissResult | string;
    intermediate_result?: unknown;
};
export type CommitGeneratedFilesRequest = {
    pull_request_number: number;
    token: string;
};
export type CommitGeneratedFilesResponse = {
    commit_sha: string;
    /** Absent on older API deployments, where a successful response created a commit. */
    commit_created?: boolean;
    files: {
        path: string;
    }[];
    renamed_files: {
        from: string;
        to: string;
    }[];
};
export type CancelAuditResponse = {
    job_id: string;
    status: "cancelled" | "cancellation_pending" | "failed";
    message: string;
    cancelled_at?: string;
    requested_at?: string;
    refunded_usd?: number;
    charged_usd?: number;
};
export type ApiErrorResponse = {
    error: {
        code: string;
        message: string;
    };
};
type CommonActionConfig = {
    apiKey: string;
    apiBaseUrl: string;
    githubToken: string;
    pollInterval: number;
    timeout: number;
    commentOnPr: boolean;
    target: string;
    branchStarting: string;
    branchEnding: string;
    prNumber: number;
};
export type AiAuditorActionConfig = CommonActionConfig & {
    engine: "ai-auditor";
    auditType: AuditType;
    context: string[];
    scope?: string[];
    preprompt?: string;
    useMemory: boolean;
    maxIterations: number;
    skipSubmodules: boolean;
    createIssues: boolean;
    issueSeverities: Severity[];
    failOn: Severity[];
    labels: string[];
};
export type StandaloneActionConfig = CommonActionConfig & {
    engine: "auto-prover" | "auto-foundry";
    contractPath: string;
    contractName: string;
    designDocPath?: string;
    threatModelPath?: string;
};
export type ActionConfig = AiAuditorActionConfig | StandaloneActionConfig;
export {};
