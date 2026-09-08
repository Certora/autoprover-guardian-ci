import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  apiMethods,
  createIdempotencyKeyMock,
  getConfigMock,
  getGeneratedFollowupMock,
  infoMock,
  setFailedMock,
  setOutputMock,
  upsertPrCommentMock,
} = vi.hoisted(() => ({
  apiMethods: {
    estimateRun: vi.fn(),
    createRun: vi.fn(),
    getRun: vi.fn(),
    getResult: vi.fn(),
    cancelRun: vi.fn(),
    commitGeneratedFiles: vi.fn(),
  },
  createIdempotencyKeyMock: vi.fn(() => "certora-guardian-stable"),
  getConfigMock: vi.fn(),
  getGeneratedFollowupMock: vi.fn(),
  infoMock: vi.fn(),
  setFailedMock: vi.fn(),
  setOutputMock: vi.fn(),
  upsertPrCommentMock: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  info: infoMock,
  warning: vi.fn(),
  setOutput: setOutputMock,
  setFailed: setFailedMock,
}));
vi.mock("../src/config", () => ({ getConfig: getConfigMock }));
vi.mock("../src/api", () => ({
  createIdempotencyKey: createIdempotencyKeyMock,
  AutoProverApi: vi.fn(function AutoProverApi() {
    return apiMethods;
  }),
}));
vi.mock("../src/github", () => ({
  GitHubClient: vi.fn(function GitHubClient() {
    return {
      getGeneratedFollowup: getGeneratedFollowupMock,
      upsertPrComment: upsertPrCommentMock,
      ensureLabelsExist: vi.fn(),
      createOrUpdateIssue: vi.fn(),
    };
  }),
}));

import { buildRunRequest, run } from "../src/run";
import type {
  AiAuditorActionConfig,
  FindingValidationActionConfig,
  ModelMode,
  Run,
  StandaloneActionConfig,
  Workflow,
} from "../src/types";
import { workflowRunType } from "../src/types";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const RETRY_RUN_ID = "22222222-2222-4222-8222-222222222222";
const ESTIMATE_QUOTE_ID = "33333333-3333-4333-8333-333333333333";
const HEAD_SHA = "b".repeat(40);

function aiConfig(
  workflow: "ai-auditor-full" | "ai-auditor-diff" = "ai-auditor-diff",
): AiAuditorActionConfig {
  return {
    workflow,
    apiKey: "certora_test",
    apiBaseUrl: "https://app.certora.com",
    githubToken: "ghs_local_only",
    pollInterval: 1,
    timeout: 1,
    commentOnPr: false,
    repositoryUrl: "https://github.com/Certora/contracts",
    repositoryPrivate: false,
    baseCommitSha: "a".repeat(40),
    headCommitSha: HEAD_SHA,
    prNumber: 42,
    githubRunAttempt: 1,
    idempotencySeed: "github-run-123",
    context: ["contracts/**/*.sol"],
    scope: workflow === "ai-auditor-full" ? ["contracts/src/**"] : undefined,
    instructions: "Focus on authorization.",
    useMemory: true,
    maxIterations: 6,
    skipSubmodules: false,
    createIssues: false,
    issueSeverities: ["HIGH", "MEDIUM"],
    failOn: [],
    labels: ["ai-auditor", "security"],
  };
}

function standaloneConfig(
  workflow: "auto-prover" | "auto-fuzzer" = "auto-prover",
): StandaloneActionConfig {
  return {
    workflow,
    apiKey: "certora_test",
    apiBaseUrl: "https://app.certora.com",
    githubToken: "ghs_local_only",
    pollInterval: 1,
    timeout: 1,
    commentOnPr: true,
    repositoryUrl: "https://github.com/Certora/contracts",
    repositoryPrivate: true,
    baseCommitSha: "a".repeat(40),
    headCommitSha: HEAD_SHA,
    prNumber: 42,
    githubRunAttempt: 1,
    idempotencySeed: "github-run-123",
    contractPath: "src/Vault.sol",
    contractName: "Vault",
    designDocPath: "docs/design.md",
    threatModelPath:
      workflow === "auto-prover" ? "docs/threat-model.md" : undefined,
  };
}

function findingValidationConfig(): FindingValidationActionConfig {
  return {
    workflow: "ai-auditor-finding-validation",
    apiKey: "certora_test",
    apiBaseUrl: "https://app.certora.com",
    githubToken: "ghs_local_only",
    pollInterval: 1,
    timeout: 1,
    commentOnPr: true,
    repositoryUrl: "https://github.com/Certora/contracts",
    repositoryPrivate: false,
    baseCommitSha: "a".repeat(40),
    headCommitSha: HEAD_SHA,
    prNumber: 42,
    githubRunAttempt: 1,
    idempotencySeed: "github-run-123",
    context: ["contracts/**/*.sol"],
    finding: "Vault.withdraw() may be reentrant.",
    skipSubmodules: false,
  };
}

function runResource(
  workflow: Workflow,
  status: Run["status"] = "succeeded",
): Run {
  return {
    id: RUN_ID,
    run_type: workflowRunType(workflow),
    status,
    source:
      workflow === "ai-auditor-diff"
        ? {
            repository_url: "https://github.com/Certora/contracts",
            base_commit_sha: "a".repeat(40),
            head_commit_sha: HEAD_SHA,
          }
        : {
            repository_url: "https://github.com/Certora/contracts",
            commit_sha: HEAD_SHA,
          },
    client_reference: ["certora-guardian", "pr-42", HEAD_SHA, workflow].join(
      ":",
    ),
    progress:
      status === "succeeded"
        ? {
            phase: "complete",
            percent: 100,
            completed_steps: 4,
            total_steps: 4,
          }
        : {
            phase: "queued",
            percent: 0,
            completed_steps: 0,
            total_steps: 4,
          },
    result: { available: status === "succeeded" },
    billing: {
      status:
        status === "queued"
          ? "reserved"
          : status === "cancelling"
            ? "releasing"
            : status === "running" || status === "finalizing"
              ? "metering"
              : "settled",
      reserved_usd: "10.0000",
      charged_usd: status === "succeeded" ? "12.5000" : null,
    },
    failure:
      status === "failed"
        ? {
            code: "provider_failed",
            detail: "Provider failed",
            retryable: false,
          }
        : null,
    delivery:
      workflow === "auto-prover" || workflow === "auto-fuzzer"
        ? {
            type: "github_pull_request",
            pull_request_number: 42,
            status: "pending",
            outcome: null,
            commit_sha: null,
            files: [],
            renamed_files: [],
            error: null,
          }
        : null,
    cancellable: status === "queued" || status === "running",
    created_at: "2026-08-07T00:00:00.000Z",
    started_at: "2026-08-07T00:00:01.000Z",
    completed_at:
      status === "succeeded" || status === "failed"
        ? "2026-08-07T00:05:00.000Z"
        : null,
    dashboard_url: `https://app.certora.com/runs/${RUN_ID}`,
  };
}

function estimate(canLaunch = true, estimateQuoteId?: string) {
  return {
    request_id: "req-estimate",
    estimate: {
      estimated_cost_usd: "12.5000",
      minimum_balance_required_usd: "10.0000",
      balance_usd: canLaunch ? "100.0000" : "1.0000",
      can_launch: canLaunch,
      ...(estimateQuoteId ? { estimate_quote_id: estimateQuoteId } : undefined),
    },
  };
}

function aiResult(workflow: "ai-auditor-full" | "ai-auditor-diff") {
  return {
    request_id: "req-result",
    result: {
      schema_version: "1" as const,
      run_id: RUN_ID,
      run_type: workflowRunType(workflow),
      data: {
        report: {
          format: "json" as const,
          content: {
            findings: { highs: [], mediums: [], lows: [], infos: [] },
          },
        },
        intermediate: null,
      },
    },
  };
}

function standaloneResult(workflow: "auto-prover" | "auto-fuzzer") {
  return {
    request_id: "req-result",
    result: {
      schema_version: "1" as const,
      run_id: RUN_ID,
      run_type: workflowRunType(workflow),
      data: {
        contract: { path: "src/Vault.sol", name: "Vault" },
        report: {
          schema_version: "1",
          backend: workflow === "auto-prover" ? "prover" : "foundry",
          contract_name: "Vault",
          outcome: "verified_with_gaps",
          rule_counts: [{ status: "VERIFIED", count: 2 }],
          skipped: [],
          gave_up_components: [],
          coverage: {
            total_properties: 2,
            total_rules: 2,
            total_groups: 1,
            property_coverage_complete: true,
            properties_in_no_group: [],
            rules_spanning_multiple_groups: [],
            skipped_count: 0,
            gave_up_component_count: 0,
            dropped_orphan_rules: 0,
            warnings: [],
          },
        },
      },
    },
  };
}

function findingValidationResult() {
  return {
    request_id: "req-result",
    result: {
      schema_version: "1" as const,
      run_id: RUN_ID,
      run_type: "ai_auditor_finding_validation" as const,
      data: {
        report: {
          format: "json" as const,
          content: {
            final_verdict: "VALID",
            final_severity: "HIGH",
            severity_reasoning: "Loss of funds is possible.",
            impact: "High",
            likelihood: "Medium",
            false_positive_reasoning: null,
            consensus_method: "unanimous_valid",
            analysis_status: "completed",
            claude_verdict: {
              verdict: "VALID",
              severity: "HIGH",
              reasoning: "The call precedes the update.",
            },
            gpt_verdict: {
              verdict: "VALID",
              severity: "HIGH",
              reasoning: "The callback can re-enter.",
            },
            tiebreaker_verdict: null,
          },
        },
      },
    },
  };
}

const commit = {
  request_id: "req-commit",
  delivery: {
    status: "committed" as const,
    commit_sha: "c".repeat(40),
    files: [{ path: "certora/Vault.spec" }],
    renamed_files: [],
  },
};

describe("run v2 orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createIdempotencyKeyMock.mockReturnValue("certora-guardian-stable");
    getGeneratedFollowupMock.mockResolvedValue(null);
    apiMethods.estimateRun.mockResolvedValue(estimate());
    apiMethods.cancelRun.mockResolvedValue({
      request_id: "req-cancel",
      run: runResource("ai-auditor-diff", "cancelling"),
    });
    apiMethods.commitGeneratedFiles.mockResolvedValue(commit);
  });

  it.each(["ai-auditor-full", "ai-auditor-diff"] as const)(
    "preserves the legacy %s request when model-mode is omitted",
    (workflow) => {
      const config = aiConfig(workflow);
      const body = buildRunRequest(config);
      expect(body).not.toHaveProperty("model_mode");
      expect(body).toHaveProperty("max_iterations", 6);
      expect(buildRunRequest({ ...config, modelMode: undefined })).toEqual(body);
    },
  );

  describe.each(["normal", "frontier"] as const)("model-mode %s", (modelMode) => {
    it.each(["ai-auditor-full", "ai-auditor-diff"] as const)(
      "estimates and launches %s with the identical mode and explicit iterations",
      async (workflow) => {
        const config = { ...aiConfig(workflow), modelMode, maxIterations: 8, commentOnPr: true };
        getConfigMock.mockReturnValue(config);
        apiMethods.createRun.mockResolvedValue({
          request_id: "req-mode", run: { ...runResource(workflow), model_mode: modelMode },
        });
        apiMethods.getResult.mockResolvedValue(aiResult(workflow));

        await run();

        const body = buildRunRequest(config);
        expect(body).toHaveProperty("model_mode", modelMode);
        expect(body).toHaveProperty("max_iterations", 8);
        expect(apiMethods.estimateRun).toHaveBeenCalledWith(workflow, body);
        expect(apiMethods.createRun).toHaveBeenCalledWith(workflow, body, "certora-guardian-stable", undefined);
        expect(setOutputMock).toHaveBeenCalledWith("model-mode", modelMode);
        const label = modelMode === "frontier" ? "Frontier" : "Normal";
        expect(infoMock).toHaveBeenCalledWith(`Model mode: ${label}`);
        expect(upsertPrCommentMock).toHaveBeenCalledWith(
          42, expect.stringContaining(`**Model mode:** ${label}`),
          `<!-- certora-guardian-ci:${workflow}${modelMode === "frontier" ? ":frontier" : ""} -->`,
        );
      },
    );

    it("forwards mode for finding validation without adding iterations", async () => {
      const config = { ...findingValidationConfig(), modelMode };
      getConfigMock.mockReturnValue(config);
      apiMethods.createRun.mockResolvedValue({
        request_id: "req-mode", run: { ...runResource(config.workflow), model_mode: modelMode },
      });
      apiMethods.getResult.mockResolvedValue(findingValidationResult());

      await run();

      const body = buildRunRequest(config);
      expect(body).toHaveProperty("model_mode", modelMode);
      expect(body).not.toHaveProperty("max_iterations");
      expect(apiMethods.estimateRun).toHaveBeenCalledWith(config.workflow, body);
      expect(apiMethods.createRun).toHaveBeenCalledWith(config.workflow, body, "certora-guardian-stable", undefined);
      expect(upsertPrCommentMock).toHaveBeenCalledWith(
        42, expect.stringContaining(`**Model mode:** ${modelMode === "frontier" ? "Frontier" : "Normal"}`),
        `<!-- certora-guardian-ci:ai-auditor-finding-validation${modelMode === "frontier" ? ":frontier" : ""} -->`,
      );
    });
  });

  it("does not relabel an unrecorded historical run as Normal", async () => {
    const config = { ...aiConfig(), commentOnPr: true };
    getConfigMock.mockReturnValue(config);
    apiMethods.createRun.mockResolvedValue({
      request_id: "req-legacy", run: { ...runResource(config.workflow), model_mode: null },
    });
    apiMethods.getResult.mockResolvedValue(aiResult(config.workflow));

    await run();

    expect(infoMock).toHaveBeenCalledWith("Model mode: Normal (server default)");
    expect(setOutputMock).not.toHaveBeenCalledWith("model-mode", "normal");
    expect(upsertPrCommentMock).toHaveBeenCalledWith(
      42, expect.stringContaining("**Model mode:** Not recorded (legacy run)"),
      "<!-- certora-guardian-ci:ai-auditor-diff -->",
    );
  });

  it("rejects a conflicting recorded model mode without another launch", async () => {
    const config = { ...aiConfig(), modelMode: "frontier" as ModelMode };
    getConfigMock.mockReturnValue(config);
    apiMethods.createRun.mockResolvedValue({
      request_id: "req-conflict", run: { ...runResource(config.workflow), model_mode: "normal" },
    });

    await expect(run()).rejects.toThrow("different model mode");
    expect(apiMethods.createRun).toHaveBeenCalledTimes(1);
    expect(apiMethods.getResult).not.toHaveBeenCalled();
  });

  it("never retries a rejected Frontier estimate without its mode", async () => {
    const config = { ...aiConfig(), modelMode: "frontier" as ModelMode };
    getConfigMock.mockReturnValue(config);
    apiMethods.estimateRun.mockRejectedValue(new Error("model_mode is not supported"));

    await expect(run()).rejects.toThrow("model_mode is not supported");
    expect(apiMethods.estimateRun).toHaveBeenCalledTimes(1);
    expect(apiMethods.estimateRun).toHaveBeenCalledWith(config.workflow, expect.objectContaining({ model_mode: "frontier" }));
    expect(apiMethods.createRun).not.toHaveBeenCalled();
  });

  it.each(["auto-prover", "auto-fuzzer"] as const)("does not add audit mode to %s requests", (workflow) => {
    expect(buildRunRequest(standaloneConfig(workflow))).not.toHaveProperty("model_mode");
  });

  it("estimates and launches an AI diff run with the identical body", async () => {
    const config = aiConfig("ai-auditor-diff");
    const succeeded = runResource(config.workflow);
    getConfigMock.mockReturnValue(config);
    apiMethods.createRun.mockResolvedValue({
      request_id: "req",
      run: succeeded,
    });
    apiMethods.getResult.mockResolvedValue(aiResult(config.workflow));

    await run();

    const expectedBody = buildRunRequest(config);
    expect(apiMethods.estimateRun).toHaveBeenCalledWith(
      config.workflow,
      expectedBody,
    );
    expect(createIdempotencyKeyMock).toHaveBeenCalledWith(
      config.workflow,
      expectedBody,
      config.idempotencySeed,
    );
    expect(apiMethods.createRun).toHaveBeenCalledWith(
      config.workflow,
      expectedBody,
      "certora-guardian-stable",
      undefined,
    );
    expect(setOutputMock).toHaveBeenCalledWith("run-id", RUN_ID);
    expect(setOutputMock).toHaveBeenCalledWith("status", "succeeded");
    expect(apiMethods.getResult).toHaveBeenCalledWith(RUN_ID);
    expect(setFailedMock).not.toHaveBeenCalled();
  });

  it("replays a successful run on a GitHub rerun without launching again", async () => {
    const config = { ...aiConfig(), githubRunAttempt: 2 };
    getConfigMock.mockReturnValue(config);
    apiMethods.createRun.mockResolvedValue({
      request_id: "req-replay",
      run: runResource(config.workflow),
    });
    apiMethods.getResult.mockResolvedValue(aiResult(config.workflow));

    await run();

    expect(apiMethods.createRun).toHaveBeenCalledTimes(1);
    expect(createIdempotencyKeyMock).toHaveBeenCalledTimes(1);
    expect(createIdempotencyKeyMock).toHaveBeenCalledWith(
      config.workflow,
      buildRunRequest(config),
      config.idempotencySeed,
    );
  });

  it("waits for a recovered running run instead of duplicating it on a GitHub rerun", async () => {
    vi.useFakeTimers();
    try {
      const config = { ...aiConfig(), githubRunAttempt: 2 };
      getConfigMock.mockReturnValue(config);
      apiMethods.createRun.mockResolvedValue({
        request_id: "req-replay",
        run: runResource(config.workflow, "running"),
      });
      apiMethods.getRun.mockResolvedValue({
        request_id: "req-poll",
        run: runResource(config.workflow),
      });
      apiMethods.getResult.mockResolvedValue(aiResult(config.workflow));

      const promise = run();
      await vi.advanceTimersByTimeAsync(1_000);
      await promise;

      expect(apiMethods.createRun).toHaveBeenCalledTimes(1);
      expect(createIdempotencyKeyMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not relaunch when a recovered queued run fails during the GitHub rerun", async () => {
    vi.useFakeTimers();
    try {
      const config = { ...aiConfig(), githubRunAttempt: 2 };
      getConfigMock.mockReturnValue(config);
      apiMethods.createRun.mockResolvedValue({
        request_id: "req-replay",
        run: runResource(config.workflow, "queued"),
      });
      apiMethods.getRun.mockResolvedValue({
        request_id: "req-poll",
        run: runResource(config.workflow, "failed"),
      });

      const promise = run();
      await vi.advanceTimersByTimeAsync(1_000);
      await promise;

      expect(apiMethods.createRun).toHaveBeenCalledTimes(1);
      expect(createIdempotencyKeyMock).toHaveBeenCalledTimes(1);
      expect(setFailedMock).toHaveBeenCalledWith(
        "Certora run failed: Provider failed",
      );
      expect(apiMethods.getResult).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["failed", "cancelled"] as const)(
    "launches one attempt-scoped retry when a GitHub rerun recovers a terminal %s run",
    async (terminalStatus) => {
      const config = { ...aiConfig(), githubRunAttempt: 2 };
      const retryRun = runResource(config.workflow);
      retryRun.id = RETRY_RUN_ID;
      const retryResult = aiResult(config.workflow);
      retryResult.result.run_id = RETRY_RUN_ID;
      getConfigMock.mockReturnValue(config);
      createIdempotencyKeyMock.mockImplementation(
        (_workflow, _body, seed: string) =>
          seed.endsWith(":github-rerun-attempt:2")
            ? "certora-guardian-attempt-2"
            : "certora-guardian-stable",
      );
      apiMethods.createRun
        .mockResolvedValueOnce({
          request_id: "req-replay",
          run: runResource(config.workflow, terminalStatus),
        })
        .mockResolvedValueOnce({
          request_id: "req-retry",
          run: retryRun,
        });
      apiMethods.getResult.mockResolvedValue(retryResult);

      await run();

      expect(createIdempotencyKeyMock).toHaveBeenNthCalledWith(
        1,
        config.workflow,
        buildRunRequest(config),
        config.idempotencySeed,
      );
      expect(createIdempotencyKeyMock).toHaveBeenNthCalledWith(
        2,
        config.workflow,
        buildRunRequest(config),
        `${config.idempotencySeed}:github-rerun-attempt:2`,
      );
      expect(apiMethods.createRun).toHaveBeenNthCalledWith(
        1,
        config.workflow,
        buildRunRequest(config),
        "certora-guardian-stable",
        undefined,
      );
      expect(apiMethods.createRun).toHaveBeenNthCalledWith(
        2,
        config.workflow,
        buildRunRequest(config),
        "certora-guardian-attempt-2",
        undefined,
      );
      expect(apiMethods.createRun).toHaveBeenCalledTimes(2);
      expect(apiMethods.getResult).toHaveBeenCalledWith(RETRY_RUN_ID);
      expect(setFailedMock).not.toHaveBeenCalled();
    },
  );

  it("never launches more than one attempt-scoped retry", async () => {
    const config = { ...aiConfig(), githubRunAttempt: 2 };
    getConfigMock.mockReturnValue(config);
    apiMethods.createRun
      .mockResolvedValueOnce({
        request_id: "req-replay",
        run: runResource(config.workflow, "failed"),
      })
      .mockResolvedValueOnce({
        request_id: "req-retry",
        run: runResource(config.workflow, "failed"),
      });

    await run();

    expect(apiMethods.createRun).toHaveBeenCalledTimes(2);
    expect(createIdempotencyKeyMock).toHaveBeenCalledTimes(2);
    expect(setFailedMock).toHaveBeenCalledWith(
      "Certora run failed: Provider failed",
    );
    expect(apiMethods.getResult).not.toHaveBeenCalled();
  });

  it("never includes the local GitHub token in a private launch", () => {
    const body = buildRunRequest(standaloneConfig());
    expect(body.source.authentication).toEqual({
      type: "organization_github_app",
    });
    expect(JSON.stringify(body)).not.toContain("ghs_local_only");
  });

  it("uses the exact finding-validation request and processes its verdict", async () => {
    const config = findingValidationConfig();
    getConfigMock.mockReturnValue(config);
    apiMethods.createRun.mockResolvedValue({
      request_id: "req",
      run: runResource(config.workflow),
    });
    apiMethods.getResult.mockResolvedValue(findingValidationResult());

    await run();

    const expectedBody = buildRunRequest(config);
    expect(expectedBody).toMatchObject({
      source: { commit_sha: HEAD_SHA, authentication: { type: "public" } },
      context: ["contracts/**/*.sol"],
      finding: "Vault.withdraw() may be reentrant.",
    });
    expect(apiMethods.estimateRun).toHaveBeenCalledWith(
      "ai-auditor-finding-validation",
      expectedBody,
    );
    expect(setOutputMock).toHaveBeenCalledWith("validation-verdict", "VALID");
    expect(setOutputMock).toHaveBeenCalledWith("validation-severity", "HIGH");
    expect(upsertPrCommentMock).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Valid finding"),
      "<!-- certora-guardian-ci:ai-auditor-finding-validation -->",
    );
  });

  it("stops before launch when the estimate cannot launch", async () => {
    getConfigMock.mockReturnValue(aiConfig());
    apiMethods.estimateRun.mockResolvedValue(estimate(false));

    await expect(run()).rejects.toThrow("minimum required $10.00");
    expect(apiMethods.createRun).not.toHaveBeenCalled();
  });

  it("polls only the canonical run resource until success", async () => {
    vi.useFakeTimers();
    try {
      const config = aiConfig();
      getConfigMock.mockReturnValue(config);
      apiMethods.createRun.mockResolvedValue({
        request_id: "req",
        run: runResource(config.workflow, "queued"),
      });
      apiMethods.getRun.mockResolvedValue({
        request_id: "req-poll",
        run: runResource(config.workflow, "succeeded"),
      });
      apiMethods.getResult.mockResolvedValue(aiResult(config.workflow));

      const promise = run();
      await vi.advanceTimersByTimeAsync(1_000);
      await promise;

      expect(apiMethods.getRun).toHaveBeenCalledWith(
        RUN_ID,
        expect.any(Number),
      );
      expect(setOutputMock).toHaveBeenCalledWith("status", "succeeded");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never follows a run ID returned by a poll response", async () => {
    vi.useFakeTimers();
    try {
      const config = aiConfig();
      const otherRun = runResource(config.workflow, "running");
      otherRun.id = "22222222-2222-4222-8222-222222222222";
      getConfigMock.mockReturnValue(config);
      apiMethods.createRun.mockResolvedValue({
        request_id: "req",
        run: runResource(config.workflow, "queued"),
      });
      apiMethods.getRun
        .mockResolvedValueOnce({ request_id: "req-wrong", run: otherRun })
        .mockResolvedValueOnce({
          request_id: "req-correct",
          run: runResource(config.workflow, "succeeded"),
        });
      apiMethods.getResult.mockResolvedValue(aiResult(config.workflow));

      const promise = run();
      await vi.advanceTimersByTimeAsync(2_000);
      await promise;

      expect(apiMethods.getRun).toHaveBeenCalledTimes(2);
      for (const call of apiMethods.getRun.mock.calls) {
        expect(call[0]).toBe(RUN_ID);
      }
      expect(apiMethods.getResult).toHaveBeenCalledWith(RUN_ID);
      expect(apiMethods.getRun).not.toHaveBeenCalledWith(
        otherRun.id,
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests cancellation when the action timeout expires", async () => {
    vi.useFakeTimers();
    try {
      const config = { ...aiConfig(), pollInterval: 60, timeout: 1 };
      getConfigMock.mockReturnValue(config);
      apiMethods.createRun.mockResolvedValue({
        request_id: "req",
        run: runResource(config.workflow, "running"),
      });

      const promise = run();
      await vi.advanceTimersByTimeAsync(60_000);
      await promise;

      expect(apiMethods.cancelRun).toHaveBeenCalledWith(
        RUN_ID,
        expect.any(Number),
      );
      expect(setFailedMock).toHaveBeenCalledWith(
        expect.stringContaining("timed out after 1 minute"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("processes a run that wins the timeout cancellation race", async () => {
    vi.useFakeTimers();
    try {
      const config = { ...aiConfig(), pollInterval: 60, timeout: 1 };
      getConfigMock.mockReturnValue(config);
      apiMethods.createRun.mockResolvedValue({
        request_id: "req",
        run: runResource(config.workflow, "running"),
      });
      apiMethods.cancelRun.mockResolvedValue({
        request_id: "req-cancel",
        run: runResource(config.workflow, "succeeded"),
      });
      apiMethods.getResult.mockResolvedValue(aiResult(config.workflow));

      const promise = run();
      await vi.advanceTimersByTimeAsync(60_000);
      await promise;

      expect(apiMethods.cancelRun).toHaveBeenCalledWith(
        RUN_ID,
        expect.any(Number),
      );
      expect(apiMethods.getResult).toHaveBeenCalledWith(RUN_ID);
      expect(setFailedMock).not.toHaveBeenCalledWith(
        expect.stringContaining("timed out"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds AutoProver delivery at launch and commits with an empty API call", async () => {
    const config = standaloneConfig("auto-prover");
    getConfigMock.mockReturnValue(config);
    apiMethods.estimateRun.mockResolvedValue(estimate(true, ESTIMATE_QUOTE_ID));
    apiMethods.createRun.mockResolvedValue({
      request_id: "req",
      run: runResource(config.workflow),
    });
    apiMethods.getResult.mockResolvedValue(standaloneResult(config.workflow));

    await run();

    expect(buildRunRequest(config)).toMatchObject({
      contract: { path: "src/Vault.sol", name: "Vault" },
      delivery: { type: "github_pull_request", pull_request_number: 42 },
    });
    expect(apiMethods.commitGeneratedFiles).toHaveBeenCalledWith(RUN_ID);
    expect(apiMethods.createRun).toHaveBeenCalledWith(
      config.workflow,
      buildRunRequest(config),
      "certora-guardian-stable",
      ESTIMATE_QUOTE_ID,
    );
    expect(apiMethods.getResult).toHaveBeenCalledWith(RUN_ID);
    expect(apiMethods.commitGeneratedFiles.mock.calls[0]).toHaveLength(1);
    expect(setOutputMock).toHaveBeenCalledWith(
      "generated-files",
      "certora/Vault.spec",
    );
  });

  it("validates a generated follow-up without estimating or launching again", async () => {
    const config = standaloneConfig("auto-prover");
    getConfigMock.mockReturnValue(config);
    getGeneratedFollowupMock.mockResolvedValue({
      runId: RUN_ID,
      sourceCommitSha: "a".repeat(40),
    });
    const followedUpRun = runResource(config.workflow);
    followedUpRun.source.commit_sha = "a".repeat(40);
    followedUpRun.client_reference = [
      "certora-guardian",
      "pr-42",
      "a".repeat(40),
      config.workflow,
    ].join(":");
    followedUpRun.delivery = {
      type: "github_pull_request",
      pull_request_number: 42,
      status: "succeeded",
      outcome: "committed",
      commit_sha: HEAD_SHA,
      files: [{ path: "certora/Vault.spec" }],
      renamed_files: [],
      error: null,
    };
    apiMethods.getRun.mockResolvedValue({
      request_id: "req-run",
      run: followedUpRun,
    });
    apiMethods.getResult.mockResolvedValue(standaloneResult(config.workflow));
    apiMethods.commitGeneratedFiles.mockResolvedValue({
      ...commit,
      delivery: { ...commit.delivery, commit_sha: HEAD_SHA },
    });

    await run();

    expect(apiMethods.estimateRun).not.toHaveBeenCalled();
    expect(apiMethods.createRun).not.toHaveBeenCalled();
    expect(apiMethods.getRun).toHaveBeenCalledWith(RUN_ID);
    expect(apiMethods.commitGeneratedFiles).toHaveBeenCalledWith(RUN_ID);
  });

  it("fails closed when a result belongs to another run", async () => {
    const config = aiConfig();
    getConfigMock.mockReturnValue(config);
    apiMethods.createRun.mockResolvedValue({
      request_id: "req",
      run: runResource(config.workflow),
    });
    const result = aiResult(config.workflow);
    result.result.run_id = "22222222-2222-4222-8222-222222222222";
    apiMethods.getResult.mockResolvedValue(result);

    await expect(run()).rejects.toThrow("result for a different run");
  });

  it("rejects a diff run replayed for a different base commit", async () => {
    const config = aiConfig("ai-auditor-diff");
    getConfigMock.mockReturnValue(config);
    const mismatched = runResource(config.workflow);
    mismatched.source.base_commit_sha = "c".repeat(40);
    apiMethods.createRun.mockResolvedValue({
      request_id: "req",
      run: mismatched,
    });

    await expect(run()).rejects.toThrow("different source");
    expect(apiMethods.getResult).not.toHaveBeenCalled();
  });

  it("rejects a run replayed for a different client reference", async () => {
    const config = aiConfig();
    getConfigMock.mockReturnValue(config);
    const mismatched = runResource(config.workflow);
    mismatched.client_reference = "another-client";
    apiMethods.createRun.mockResolvedValue({
      request_id: "req",
      run: mismatched,
    });

    await expect(run()).rejects.toThrow("different source");
  });

  it("rejects findings placed in the wrong severity bucket", async () => {
    const config = aiConfig();
    getConfigMock.mockReturnValue(config);
    apiMethods.createRun.mockResolvedValue({
      request_id: "req",
      run: runResource(config.workflow),
    });
    const result = aiResult(config.workflow);
    result.result.data.report.content.findings.highs.push({
      id: "AA-1",
      title: "Medium finding in the high bucket",
      severity: "MEDIUM",
      locations: ["src/Vault.sol:1"],
      description: "Description",
      recommendation: "Recommendation",
    } as never);
    apiMethods.getResult.mockResolvedValue(result);

    await expect(run()).rejects.toThrow("invalid highs");
  });

  it("publishes a successful Markdown AI report without fabricating counts", async () => {
    const config = aiConfig();
    getConfigMock.mockReturnValue(config);
    apiMethods.createRun.mockResolvedValue({
      request_id: "req",
      run: runResource(config.workflow),
    });
    const result = aiResult(config.workflow);
    result.result.data.report = {
      format: "markdown",
      content: "# Audit report",
    } as never;
    apiMethods.getResult.mockResolvedValue(result);

    await run();

    expect(setOutputMock).toHaveBeenCalledWith("highs-count", "");
    expect(setOutputMock).toHaveBeenCalledWith("mediums-count", "");
    expect(setFailedMock).not.toHaveBeenCalled();
  });

  it("reports a canonical failed run without requesting its result", async () => {
    const config = aiConfig();
    getConfigMock.mockReturnValue(config);
    apiMethods.createRun.mockResolvedValue({
      request_id: "req",
      run: runResource(config.workflow, "failed"),
    });

    await run();

    expect(setFailedMock).toHaveBeenCalledWith(
      "Certora run failed: Provider failed",
    );
    expect(apiMethods.createRun).toHaveBeenCalledTimes(1);
    expect(createIdempotencyKeyMock).toHaveBeenCalledTimes(1);
    expect(apiMethods.getResult).not.toHaveBeenCalled();
  });
});
