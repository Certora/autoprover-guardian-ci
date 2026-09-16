import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  apiMethods,
  createIdempotencyKeyMock,
  getConfigMock,
  getGeneratedFollowupMock,
  resolveDiffSourceMock,
  infoMock,
  setFailedMock,
  setOutputMock,
  upsertPrCommentMock,
} = vi.hoisted(() => ({
  apiMethods: {
    estimateRun: vi.fn(),
    createRun: vi.fn(),
    getRun: vi.fn(),
    findRunsByReference: vi.fn(),
    getResult: vi.fn(),
    cancelRun: vi.fn(),
    commitGeneratedFiles: vi.fn(),
  },
  createIdempotencyKeyMock: vi.fn(() => "certora-guardian-stable"),
  getConfigMock: vi.fn(),
  getGeneratedFollowupMock: vi.fn(),
  resolveDiffSourceMock: vi.fn(),
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
  AutoProverApiDeadlineError: class extends Error {
    constructor() {
      super("The configured run timeout expired during a Certora API request.");
      this.name = "AutoProverApiDeadlineError";
    }
  },
  AutoProverApi: vi.fn(function AutoProverApi() {
    return apiMethods;
  }),
}));
vi.mock("../src/github", () => ({
  GitHubClient: vi.fn(function GitHubClient() {
    return {
      getGeneratedFollowup: getGeneratedFollowupMock,
      resolveDiffSource: resolveDiffSourceMock,
      upsertPrComment: upsertPrCommentMock,
      ensureLabelsExist: vi.fn(),
      createOrUpdateIssue: vi.fn(),
    };
  }),
}));

import { buildRunRequest, run } from "../src/run";
import { AutoProverApi } from "../src/api";
import type {
  AiAuditorActionConfig,
  FindingValidationActionConfig,
  ModelMode,
  Run,
  ServerManagedGithubDelivery,
  StandaloneActionConfig,
  Workflow,
} from "../src/types";
import { workflowRunType } from "../src/types";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const RETRY_RUN_ID = "22222222-2222-4222-8222-222222222222";
const HEAD_SHA = "b".repeat(40);

function aiConfig(
  workflow: "ai-auditor-full" | "ai-auditor-diff" = "ai-auditor-diff",
): AiAuditorActionConfig {
  return {
    workflow,
    waitForCompletion: true,
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
    baseBranchName: "main",
    headBranchName: "feature/review",
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

function managedAuditRun(
  workflow: "ai-auditor-full" | "ai-auditor-diff" = "ai-auditor-diff",
  status: Run["status"] = "queued",
  checkName: ServerManagedGithubDelivery["check"]["name"] = "Security Review",
): Run {
  const terminal = ["succeeded", "failed", "cancelled"].includes(status);
  return {
    ...runResource(workflow, status),
    delivery: {
      type: "github_pull_request",
      pull_request_number: 42,
      managed_by: "server",
      status: terminal ? "completed" : "pending",
      check: {
        id: 12345,
        name: checkName,
        head_sha: HEAD_SHA,
        html_url: "https://github.com/Certora/contracts/runs/12345",
        status: terminal ? "completed" : "in_progress",
      },
      error: null,
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
    for (const method of Object.values(apiMethods)) method.mockReset();
    createIdempotencyKeyMock.mockReturnValue("certora-guardian-stable");
    getGeneratedFollowupMock.mockResolvedValue(null);
    resolveDiffSourceMock.mockReset();
    resolveDiffSourceMock.mockResolvedValue({
      baseCommitSha: "a".repeat(40),
      headCommitSha: HEAD_SHA,
    });
    apiMethods.estimateRun.mockResolvedValue(estimate());
    apiMethods.cancelRun.mockResolvedValue({
      request_id: "req-cancel",
      run: runResource("ai-auditor-diff", "cancelling"),
    });
    apiMethods.commitGeneratedFiles.mockResolvedValue(commit);
    apiMethods.findRunsByReference.mockResolvedValue({
      request_id: "list",
      runs: [],
      next_cursor: null,
    });
  });

  describe("asynchronous full/diff audit handoff", () => {
    it("submits live base tips once while keeping the event-derived launch key", async () => {
      const config = { ...aiConfig(), waitForCompletion: false };
      const freshBase = "c".repeat(40);
      getConfigMock.mockReturnValue(config);
      resolveDiffSourceMock.mockResolvedValue({
        baseCommitSha: freshBase,
        headCommitSha: HEAD_SHA,
      });
      const accepted = managedAuditRun();
      accepted.source.base_commit_sha = freshBase;
      apiMethods.createRun.mockResolvedValue({
        request_id: "launch",
        run: accepted,
      });

      await run();

      expect(resolveDiffSourceMock).toHaveBeenCalledExactlyOnceWith({
        ...config,
        deadlineMs: expect.any(Number),
      });
      expect(apiMethods.createRun).toHaveBeenCalledWith(
        "ai-auditor-diff",
        expect.objectContaining({
          source: expect.objectContaining({
            base_commit_sha: freshBase,
            head_commit_sha: HEAD_SHA,
          }),
        }),
        "certora-guardian-stable",
      );
      expect(createIdempotencyKeyMock).toHaveBeenCalledWith(
        "ai-auditor-diff",
        buildRunRequest(config),
        config.idempotencySeed,
      );
      expect(config.baseCommitSha).toBe("a".repeat(40));
    });

    it.each([
      "stale head",
      "closed PR",
      "fork PR",
      "retargeted PR",
      "GitHub unavailable",
    ])(
      "does no paid work when diff-source verification fails: %s",
      async (reason) => {
        getConfigMock.mockReturnValue({
          ...aiConfig(),
          waitForCompletion: false,
        });
        resolveDiffSourceMock.mockRejectedValue(new Error(reason));
        await expect(run()).rejects.toThrow(reason);
        expect(apiMethods.createRun).not.toHaveBeenCalled();
        expect(apiMethods.estimateRun).not.toHaveBeenCalled();
        expect(apiMethods.cancelRun).not.toHaveBeenCalled();
      },
    );

    it.each(
      (["ai-auditor-full", "ai-auditor-diff"] as const).flatMap((workflow) =>
        (["Security Review", "AI Auditor", "Zeus AI Audit"] as const).map(
          (checkName) => ({ workflow, checkName }),
        ),
      ),
    )(
      "hands off $workflow with a persisted $checkName check and current branding",
      async ({ workflow, checkName }) => {
        const config = {
          ...aiConfig(workflow),
          waitForCompletion: false,
          createIssues: true,
          commentOnPr: true,
          failOn: ["HIGH"] as const,
        };
        getConfigMock.mockReturnValue(config);
        apiMethods.createRun.mockResolvedValue({
          request_id: "launch",
          run: managedAuditRun(workflow, "queued", checkName),
        });

        await run();

        expect(apiMethods.createRun).toHaveBeenCalledWith(
          workflow,
          expect.objectContaining({
            delivery: {
              type: "github_pull_request",
              pull_request_number: 42,
              head_commit_sha: HEAD_SHA,
              create_issues: true,
              comment_on_pr: true,
              issue_severities: ["HIGH", "MEDIUM"],
              fail_on: ["HIGH"],
              labels: ["ai-auditor", "security"],
            },
          }),
          "certora-guardian-stable",
        );
        expect(JSON.stringify(apiMethods.createRun.mock.calls)).not.toContain(
          "ghs_local_only",
        );
        expect(apiMethods.getRun).not.toHaveBeenCalled();
        expect(apiMethods.getResult).not.toHaveBeenCalled();
        expect(apiMethods.cancelRun).not.toHaveBeenCalled();
        expect(upsertPrCommentMock).not.toHaveBeenCalled();
        expect(setFailedMock).not.toHaveBeenCalled();
        expect(setOutputMock).toHaveBeenCalledWith("run-id", RUN_ID);
        expect(setOutputMock).toHaveBeenCalledWith("status", "queued");
        expect(setOutputMock).toHaveBeenCalledWith("check-run-id", "12345");
        expect(setOutputMock).toHaveBeenCalledWith(
          "check-run-url",
          "https://github.com/Certora/contracts/runs/12345",
        );
        expect(infoMock).toHaveBeenCalledWith(
          "Server-owned Security Review: https://github.com/Certora/contracts/runs/12345",
        );
        expect(infoMock).toHaveBeenCalledWith(
          expect.stringContaining(
            "the separate Security Review check owns the final result",
          ),
        );
        expect(JSON.stringify(infoMock.mock.calls)).not.toMatch(/zeus/i);
        if (workflow === "ai-auditor-full") {
          expect(resolveDiffSourceMock).not.toHaveBeenCalled();
        }
        for (const name of [
          "highs-count",
          "mediums-count",
          "lows-count",
          "infos-count",
        ]) {
          expect(
            setOutputMock.mock.calls
              .filter(([output]) => output === name)
              .at(-1),
          ).toEqual([name, ""]);
        }
      },
    );

    it.each([
      ["absent delivery", () => null],
      ["absent check", (delivery: any) => ({ ...delivery, check: undefined })],
      [
        "unowned check",
        (delivery: any) => ({ ...delivery, managed_by: "client" }),
      ],
      [
        "wrong PR",
        (delivery: any) => ({ ...delivery, pull_request_number: 43 }),
      ],
      [
        "wrong head",
        (delivery: any) => ({
          ...delivery,
          check: { ...delivery.check, head_sha: "c".repeat(40) },
        }),
      ],
      [
        "invalid check ID",
        (delivery: any) => ({
          ...delivery,
          check: { ...delivery.check, id: 0 },
        }),
      ],
      [
        "wrong check name",
        (delivery: any) => ({
          ...delivery,
          check: { ...delivery.check, name: "Unrelated check" },
        }),
      ],
      [
        "wrong repository",
        (delivery: any) => ({
          ...delivery,
          check: {
            ...delivery.check,
            html_url: "https://github.com/Other/repo/runs/12345",
          },
        }),
      ],
    ])(
      "fails closed for %s without cancelling the accepted audit",
      async (_label, mutate) => {
        getConfigMock.mockReturnValue({
          ...aiConfig(),
          waitForCompletion: false,
        });
        const accepted = managedAuditRun();
        accepted.delivery = mutate(accepted.delivery);
        apiMethods.createRun.mockResolvedValue({
          request_id: "launch",
          run: accepted,
        });

        await expect(run()).rejects.toThrow(
          "did not confirm a server-owned Security Review check",
        );

        expect(setOutputMock).toHaveBeenCalledWith("run-id", RUN_ID);
        expect(apiMethods.getRun).not.toHaveBeenCalled();
        expect(apiMethods.cancelRun).not.toHaveBeenCalled();
        expect(apiMethods.getResult).not.toHaveBeenCalled();
        expect(setOutputMock).not.toHaveBeenCalledWith("check-run-id", "12345");
      },
    );

    it("keeps an accepted audit when rerun status refresh fails", async () => {
      getConfigMock.mockReturnValue({
        ...aiConfig(),
        waitForCompletion: false,
        githubRunAttempt: 2,
      });
      apiMethods.createRun.mockResolvedValue({
        request_id: "launch",
        run: managedAuditRun(),
      });
      apiMethods.getRun.mockRejectedValue(
        new Error("Temporary projection failure"),
      );

      await expect(run()).rejects.toThrow("Temporary projection failure");

      expect(setOutputMock).toHaveBeenCalledWith("run-id", RUN_ID);
      expect(apiMethods.createRun).toHaveBeenCalledTimes(1);
      expect(apiMethods.cancelRun).not.toHaveBeenCalled();
    });

    it.each(["succeeded", "failed", "cancelled"] as const)(
      "reuses the server's completed check for a recovered %s audit",
      async (status) => {
        getConfigMock.mockReturnValue({
          ...aiConfig(),
          waitForCompletion: false,
        });
        apiMethods.createRun.mockResolvedValue({
          request_id: "launch",
          run: managedAuditRun("ai-auditor-diff", status),
        });
        await run();
        expect(setFailedMock).not.toHaveBeenCalled();
        expect(apiMethods.getResult).not.toHaveBeenCalled();
        expect(apiMethods.createRun).toHaveBeenCalledTimes(1);
        expect(setOutputMock).toHaveBeenCalledWith("status", status);
        expect(setOutputMock).toHaveBeenCalledWith("check-run-id", "12345");
      },
    );

    it("retries a previously failed canonical audit once on an explicit GitHub rerun", async () => {
      const config = {
        ...aiConfig(),
        waitForCompletion: false,
        githubRunAttempt: 2,
      };
      getConfigMock.mockReturnValue(config);
      apiMethods.createRun
        .mockResolvedValueOnce({
          request_id: "canonical",
          run: managedAuditRun(),
        })
        .mockResolvedValueOnce({
          request_id: "retry",
          run: { ...managedAuditRun(), id: RETRY_RUN_ID },
        });
      apiMethods.getRun.mockResolvedValue({
        request_id: "refresh",
        run: managedAuditRun("ai-auditor-diff", "failed"),
      });

      await run();

      expect(apiMethods.createRun).toHaveBeenCalledTimes(2);
      expect(apiMethods.getRun).toHaveBeenCalledTimes(1);
      expect(createIdempotencyKeyMock).toHaveBeenLastCalledWith(
        config.workflow,
        expect.objectContaining({
          delivery: expect.objectContaining({ type: "github_pull_request" }),
        }),
        `${config.idempotencySeed}:github-rerun-attempt:2`,
      );
      expect(setOutputMock).toHaveBeenCalledWith("run-id", RETRY_RUN_ID);
      expect(apiMethods.cancelRun).not.toHaveBeenCalled();
    });

    it("does not cancel a handed-off audit when the runner later receives SIGTERM", async () => {
      getConfigMock.mockReturnValue({
        ...aiConfig(),
        waitForCompletion: false,
      });
      apiMethods.createRun.mockResolvedValue({
        request_id: "launch",
        run: managedAuditRun(),
      });
      await run();

      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      try {
        process.emit("SIGTERM");
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
        expect(apiMethods.cancelRun).not.toHaveBeenCalled();
      } finally {
        exit.mockRestore();
      }
    });
  });

  describe.each(["normal", "frontier"] as const)(
    "automatic context in %s mode",
    (modelMode) => {
      it.each([
        "ai-auditor-full",
        "ai-auditor-diff",
        "ai-auditor-finding-validation",
      ] as const)(
        "launches %s directly without locally selecting files or requiring a preview",
        async (workflow) => {
          const base =
            workflow === "ai-auditor-finding-validation"
              ? findingValidationConfig()
              : aiConfig(workflow);
          const config = {
            ...base,
            context: [],
            modelMode,
            repositoryPrivate: true,
            skipSubmodules: true,
          };
          getConfigMock.mockReturnValue(config);
          apiMethods.createRun.mockResolvedValue({
            request_id: "req-auto",
            run: { ...runResource(workflow), model_mode: modelMode },
          });
          apiMethods.getResult.mockResolvedValue(
            workflow === "ai-auditor-finding-validation"
              ? findingValidationResult()
              : aiResult(workflow),
          );

          await run();

          const body = buildRunRequest(config);
          expect(body).toMatchObject({
            context: [],
            model_mode: modelMode,
            skip_submodules: true,
            source: { authentication: { type: "organization_github_app" } },
          });
          expect(JSON.stringify(body)).not.toContain(config.githubToken);
          expect(apiMethods.estimateRun).not.toHaveBeenCalled();
          expect(apiMethods.createRun).toHaveBeenCalledExactlyOnceWith(
            workflow,
            body,
            "certora-guardian-stable",
          );
          expect(createIdempotencyKeyMock).toHaveBeenCalledWith(
            workflow,
            body,
            config.idempotencySeed,
          );
          expect(infoMock).toHaveBeenCalledWith("Reserved balance: $10.0000.");
          if (workflow === "ai-auditor-full") {
            expect(body).toHaveProperty("scope", ["contracts/src/**"]);
          } else if (workflow === "ai-auditor-diff") {
            expect(body).not.toHaveProperty("scope");
            expect(body).toMatchObject({
              source: {
                base_commit_sha: "a".repeat(40),
                head_commit_sha: HEAD_SHA,
              },
            });
          } else {
            expect(body).toHaveProperty(
              "finding",
              "Vault.withdraw() may be reentrant.",
            );
            expect(body).not.toHaveProperty("max_iterations");
          }
        },
      );
    },
  );

  it("preserves the server's insufficient-balance failure for automatic context", async () => {
    getConfigMock.mockReturnValue({ ...aiConfig(), context: [] });
    apiMethods.createRun.mockRejectedValueOnce(
      new Error("insufficient_balance"),
    );

    await expect(run()).rejects.toThrow("insufficient_balance");

    expect(apiMethods.estimateRun).not.toHaveBeenCalled();
    expect(apiMethods.createRun).toHaveBeenCalledTimes(1);
    expect(apiMethods.getRun).not.toHaveBeenCalled();
    expect(apiMethods.getResult).not.toHaveBeenCalled();
  });

  it.each(["ai-auditor-full", "ai-auditor-diff"] as const)(
    "preserves the legacy %s request when model-mode is omitted",
    (workflow) => {
      const config = aiConfig(workflow);
      const body = buildRunRequest(config);
      expect(body).not.toHaveProperty("model_mode");
      expect(body).toHaveProperty("max_iterations", 6);
      expect(buildRunRequest({ ...config, modelMode: undefined })).toEqual(
        body,
      );
    },
  );

  describe.each(["normal", "frontier"] as const)(
    "model-mode %s",
    (modelMode) => {
      it.each(["ai-auditor-full", "ai-auditor-diff"] as const)(
        "launches %s with the requested mode and explicit iterations",
        async (workflow) => {
          const config = {
            ...aiConfig(workflow),
            modelMode,
            maxIterations: 8,
            commentOnPr: true,
          };
          getConfigMock.mockReturnValue(config);
          apiMethods.createRun.mockResolvedValue({
            request_id: "req-mode",
            run: { ...runResource(workflow), model_mode: modelMode },
          });
          apiMethods.getResult.mockResolvedValue(aiResult(workflow));

          await run();

          const body = buildRunRequest(config);
          expect(body).toHaveProperty("model_mode", modelMode);
          expect(body).toHaveProperty("max_iterations", 8);
          expect(apiMethods.estimateRun).not.toHaveBeenCalled();
          expect(apiMethods.createRun).toHaveBeenCalledWith(
            workflow,
            body,
            "certora-guardian-stable",
          );
          expect(setOutputMock).toHaveBeenCalledWith("model-mode", modelMode);
          const label = modelMode === "frontier" ? "Frontier" : "Normal";
          expect(infoMock).toHaveBeenCalledWith(`Model mode: ${label}`);
          expect(upsertPrCommentMock).toHaveBeenCalledWith(
            42,
            expect.stringContaining(`**Model mode:** ${label}`),
            `<!-- certora-guardian-ci:${workflow}${modelMode === "frontier" ? ":frontier" : ""} -->`,
            HEAD_SHA,
            RUN_ID,
          );
        },
      );

      it("forwards mode for finding validation without adding iterations", async () => {
        const config = { ...findingValidationConfig(), modelMode };
        getConfigMock.mockReturnValue(config);
        apiMethods.createRun.mockResolvedValue({
          request_id: "req-mode",
          run: { ...runResource(config.workflow), model_mode: modelMode },
        });
        apiMethods.getResult.mockResolvedValue(findingValidationResult());

        await run();

        const body = buildRunRequest(config);
        expect(body).toHaveProperty("model_mode", modelMode);
        expect(body).not.toHaveProperty("max_iterations");
        expect(apiMethods.estimateRun).not.toHaveBeenCalled();
        expect(apiMethods.createRun).toHaveBeenCalledWith(
          config.workflow,
          body,
          "certora-guardian-stable",
        );
        expect(upsertPrCommentMock).toHaveBeenCalledWith(
          42,
          expect.stringContaining(
            `**Model mode:** ${modelMode === "frontier" ? "Frontier" : "Normal"}`,
          ),
          `<!-- certora-guardian-ci:ai-auditor-finding-validation${modelMode === "frontier" ? ":frontier" : ""} -->`,
          HEAD_SHA,
          RUN_ID,
        );
      });
    },
  );

  it("does not relabel an unrecorded historical run as Normal", async () => {
    const config = { ...aiConfig(), commentOnPr: true };
    getConfigMock.mockReturnValue(config);
    apiMethods.createRun.mockResolvedValue({
      request_id: "req-legacy",
      run: { ...runResource(config.workflow), model_mode: null },
    });
    apiMethods.getResult.mockResolvedValue(aiResult(config.workflow));

    await run();

    expect(infoMock).toHaveBeenCalledWith(
      "Model mode: Normal (server default)",
    );
    expect(setOutputMock).not.toHaveBeenCalledWith("model-mode", "normal");
    expect(upsertPrCommentMock).toHaveBeenCalledWith(
      42,
      expect.stringContaining("**Model mode:** Not recorded (legacy run)"),
      "<!-- certora-guardian-ci:ai-auditor-diff -->",
      HEAD_SHA,
      RUN_ID,
    );
  });

  it("rejects a conflicting recorded model mode without another launch", async () => {
    const config = { ...aiConfig(), modelMode: "frontier" as ModelMode };
    getConfigMock.mockReturnValue(config);
    apiMethods.createRun.mockResolvedValue({
      request_id: "req-conflict",
      run: { ...runResource(config.workflow), model_mode: "normal" },
    });

    await expect(run()).rejects.toThrow("different model mode");
    expect(apiMethods.createRun).toHaveBeenCalledTimes(1);
    expect(apiMethods.getResult).not.toHaveBeenCalled();
  });

  it("never retries a rejected Frontier launch without its mode", async () => {
    const config = { ...aiConfig(), modelMode: "frontier" as ModelMode };
    getConfigMock.mockReturnValue(config);
    apiMethods.createRun.mockRejectedValue(
      new Error("model_mode is not supported"),
    );

    await expect(run()).rejects.toThrow("model_mode is not supported");
    expect(apiMethods.estimateRun).not.toHaveBeenCalled();
    expect(apiMethods.createRun).toHaveBeenCalledExactlyOnceWith(
      config.workflow,
      expect.objectContaining({ model_mode: "frontier" }),
      "certora-guardian-stable",
    );
  });

  it.each(["auto-prover", "auto-fuzzer"] as const)(
    "does not add audit mode to %s requests",
    (workflow) => {
      expect(buildRunRequest(standaloneConfig(workflow))).not.toHaveProperty(
        "model_mode",
      );
    },
  );

  it("launches an AI diff run with the exact validated body and stable key", async () => {
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
    expect(apiMethods.estimateRun).not.toHaveBeenCalled();
    expect(createIdempotencyKeyMock).toHaveBeenCalledWith(
      config.workflow,
      expectedBody,
      config.idempotencySeed,
    );
    expect(apiMethods.createRun).toHaveBeenCalledWith(
      config.workflow,
      expectedBody,
      "certora-guardian-stable",
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
      run: runResource(config.workflow, "queued"),
    });
    apiMethods.getRun.mockResolvedValue({
      request_id: "req-current",
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
      apiMethods.getRun
        .mockResolvedValue({
          request_id: "req-poll",
          run: runResource(config.workflow),
        })
        .mockResolvedValueOnce({
          request_id: "req-current",
          run: runResource(config.workflow, "running"),
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
      apiMethods.getRun
        .mockResolvedValue({
          request_id: "req-poll",
          run: runResource(config.workflow, "failed"),
        })
        .mockResolvedValueOnce({
          request_id: "req-current",
          run: runResource(config.workflow, "queued"),
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
          run: runResource(config.workflow, "queued"),
        })
        .mockResolvedValueOnce({
          request_id: "req-retry",
          run: retryRun,
        });
      apiMethods.getRun.mockResolvedValue({
        request_id: "req-current",
        run: runResource(config.workflow, terminalStatus),
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
      );
      expect(apiMethods.createRun).toHaveBeenNthCalledWith(
        2,
        config.workflow,
        buildRunRequest(config),
        "certora-guardian-attempt-2",
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
    apiMethods.getRun.mockResolvedValue({
      request_id: "req-current",
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

  it.each([
    aiConfig("ai-auditor-full"),
    aiConfig("ai-auditor-diff"),
    findingValidationConfig(),
    standaloneConfig("auto-prover"),
    standaloneConfig("auto-fuzzer"),
  ])(
    "refreshes a cached launch response before deciding whether to retry $workflow",
    async (base) => {
      const config = { ...base, githubRunAttempt: 2 };
      getConfigMock.mockReturnValue(config);
      apiMethods.createRun
        .mockResolvedValueOnce({
          request_id: "req-original-cached-202",
          run: runResource(config.workflow, "queued"),
        })
        .mockResolvedValueOnce({
          request_id: "req-retry",
          run: { ...runResource(config.workflow, "failed"), id: RETRY_RUN_ID },
        });
      apiMethods.getRun.mockResolvedValue({
        request_id: "req-current",
        run: runResource(config.workflow, "failed"),
      });

      await run();

      expect(apiMethods.getRun).toHaveBeenCalledExactlyOnceWith(RUN_ID);
      expect(apiMethods.createRun).toHaveBeenCalledTimes(2);
      expect(createIdempotencyKeyMock).toHaveBeenLastCalledWith(
        config.workflow,
        buildRunRequest(config),
        `${config.idempotencySeed}:github-rerun-attempt:2`,
      );
      expect(apiMethods.getResult).not.toHaveBeenCalled();
    },
  );

  it("rejects a refreshed run with a different identity before a paid retry", async () => {
    const config = { ...aiConfig(), githubRunAttempt: 2 };
    getConfigMock.mockReturnValue(config);
    apiMethods.createRun.mockResolvedValue({
      request_id: "req-cached",
      run: runResource(config.workflow, "queued"),
    });
    apiMethods.getRun.mockResolvedValue({
      request_id: "req-current",
      run: { ...runResource(config.workflow, "failed"), id: RETRY_RUN_ID },
    });

    await expect(run()).rejects.toThrow("different source");

    expect(apiMethods.createRun).toHaveBeenCalledTimes(1);
    expect(apiMethods.getResult).not.toHaveBeenCalled();
    expect(apiMethods.cancelRun).not.toHaveBeenCalled();
  });

  it("does not launch another run when the recovery refresh fails", async () => {
    const config = { ...aiConfig(), githubRunAttempt: 2 };
    getConfigMock.mockReturnValue(config);
    apiMethods.createRun.mockResolvedValue({
      request_id: "req-cached",
      run: runResource(config.workflow, "queued"),
    });
    apiMethods.getRun.mockRejectedValue(new Error("Recovery unavailable"));

    await expect(run()).rejects.toThrow("Recovery unavailable");

    expect(apiMethods.createRun).toHaveBeenCalledTimes(1);
    expect(apiMethods.getResult).not.toHaveBeenCalled();
    expect(setOutputMock).toHaveBeenLastCalledWith("run-id", RUN_ID);
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
    expect(apiMethods.createRun).toHaveBeenCalledWith(
      "ai-auditor-finding-validation",
      expectedBody,
      "certora-guardian-stable",
    );
    expect(setOutputMock).toHaveBeenCalledWith("validation-verdict", "VALID");
    expect(setOutputMock).toHaveBeenCalledWith("validation-severity", "HIGH");
    expect(upsertPrCommentMock).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Valid finding"),
      "<!-- certora-guardian-ci:ai-auditor-finding-validation -->",
      HEAD_SHA,
      RUN_ID,
    );
  });

  it("preserves a new manual-context launch rejection without polling or reporting a run", async () => {
    getConfigMock.mockReturnValue(aiConfig());
    apiMethods.createRun.mockRejectedValue(new Error("insufficient_balance"));

    await expect(run()).rejects.toThrow("insufficient_balance");
    expect(apiMethods.estimateRun).not.toHaveBeenCalled();
    expect(apiMethods.createRun).toHaveBeenCalledOnce();
    expect(apiMethods.getRun).not.toHaveBeenCalled();
    expect(apiMethods.getResult).not.toHaveBeenCalled();
    expect(
      setOutputMock.mock.calls.filter(([key]) => key === "run-id"),
    ).toEqual([["run-id", ""]]);
  });

  describe.each([1, 2])("recovery on GitHub attempt %i", (githubRunAttempt) => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    describe.each(["insufficient available balance", "estimator unavailable"])(
      "with %s",
      (estimateFailure) => {
        it.each(
          [
            aiConfig("ai-auditor-full"),
            aiConfig("ai-auditor-diff"),
            findingValidationConfig(),
            standaloneConfig("auto-prover"),
            standaloneConfig("auto-fuzzer"),
          ].flatMap((config) =>
            (["queued", "succeeded"] as const).map((status) => ({
              config,
              status,
            })),
          ),
        )(
          "recovers $config.workflow in $status state without a separate estimate or duplicate launch",
          async ({ config: base, status }) => {
            const config = { ...base, githubRunAttempt };
            getConfigMock.mockReturnValue(config);
            if (estimateFailure === "estimator unavailable") {
              apiMethods.estimateRun.mockRejectedValue(
                new Error("Estimator unavailable"),
              );
            } else {
              apiMethods.estimateRun.mockResolvedValue(estimate(false));
            }
            apiMethods.createRun.mockResolvedValue({
              request_id: "req-recovered",
              run: runResource(config.workflow, status),
            });
            apiMethods.getRun.mockResolvedValue({
              request_id: "req-current",
              run: runResource(config.workflow),
            });
            apiMethods.getResult.mockResolvedValue(
              config.workflow === "auto-prover" ||
                config.workflow === "auto-fuzzer"
                ? standaloneResult(config.workflow)
                : config.workflow === "ai-auditor-finding-validation"
                  ? findingValidationResult()
                  : aiResult(config.workflow),
            );

            const pending = run();
            await vi.advanceTimersByTimeAsync(1_000);
            await pending;

            expect(apiMethods.estimateRun).not.toHaveBeenCalled();
            expect(apiMethods.createRun).toHaveBeenCalledExactlyOnceWith(
              config.workflow,
              buildRunRequest(config),
              "certora-guardian-stable",
            );
            expect(createIdempotencyKeyMock).toHaveBeenCalledExactlyOnceWith(
              config.workflow,
              buildRunRequest(config),
              config.idempotencySeed,
            );
            expect(apiMethods.getResult).toHaveBeenCalledExactlyOnceWith(
              RUN_ID,
            );
            expect(setOutputMock).toHaveBeenCalledWith("status", "succeeded");
            expect(setFailedMock).not.toHaveBeenCalled();
          },
        );
      },
    );
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

  it("shares one deadline between a slow launch and polling, without a fresh polling budget", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const config = { ...aiConfig(), pollInterval: 60, timeout: 1 };
      getConfigMock.mockReturnValue(config);
      apiMethods.createRun.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  request_id: "req-slow-launch",
                  run: runResource(config.workflow, "running"),
                }),
              45_000,
            );
          }),
      );

      const pending = run();
      await vi.advanceTimersByTimeAsync(45_000);
      expect(AutoProverApi).toHaveBeenCalledWith(
        config.apiBaseUrl,
        config.apiKey,
        startedAt + 60_000,
      );
      expect(apiMethods.cancelRun).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(apiMethods.cancelRun).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(Date.now()).toBe(startedAt + 60_000);
      expect(apiMethods.cancelRun).toHaveBeenCalledExactlyOnceWith(
        RUN_ID,
        startedAt + 75_000,
      );
      expect(apiMethods.getRun).not.toHaveBeenCalled();
      expect(apiMethods.estimateRun).not.toHaveBeenCalled();
      expect(setFailedMock).toHaveBeenCalledWith(
        expect.stringContaining("timed out after 1 minute"),
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not reset the overall deadline for an attempt-scoped paid retry", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const config = {
        ...aiConfig(),
        githubRunAttempt: 2,
        pollInterval: 60,
        timeout: 1,
      };
      getConfigMock.mockReturnValue(config);
      apiMethods.createRun
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              setTimeout(
                () =>
                  resolve({
                    request_id: "req-slow-recovery",
                    run: runResource(config.workflow, "queued"),
                  }),
                45_000,
              );
            }),
        )
        .mockResolvedValueOnce({
          request_id: "req-retry",
          run: { ...runResource(config.workflow, "running"), id: RETRY_RUN_ID },
        });
      apiMethods.getRun.mockResolvedValue({
        request_id: "req-failed",
        run: runResource(config.workflow, "failed"),
      });
      apiMethods.cancelRun.mockResolvedValue({
        request_id: "req-cancel",
        run: {
          ...runResource(config.workflow, "cancelling"),
          id: RETRY_RUN_ID,
        },
      });

      const pending = run();
      await vi.advanceTimersByTimeAsync(60_000);
      await pending;

      expect(apiMethods.createRun).toHaveBeenCalledTimes(2);
      expect(apiMethods.cancelRun).toHaveBeenCalledExactlyOnceWith(
        RETRY_RUN_ID,
        startedAt + 75_000,
      );
      expect(Date.now()).toBe(startedAt + 60_000);
      expect(apiMethods.getResult).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(["failed", "cancelled"] as const)(
    "does not issue a new paid retry when recovering %s consumes the entire deadline",
    async (status) => {
      vi.useFakeTimers();
      try {
        const config = { ...aiConfig(), githubRunAttempt: 2, timeout: 1 };
        getConfigMock.mockReturnValue(config);
        apiMethods.createRun.mockResolvedValue({
          request_id: "req-cached",
          run: runResource(config.workflow, "queued"),
        });
        apiMethods.getRun.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              setTimeout(
                () =>
                  resolve({
                    request_id: "req-recovered",
                    run: runResource(config.workflow, status),
                  }),
                60_000,
              );
            }),
        );

        const pending = expect(run()).rejects.toMatchObject({
          name: "AutoProverApiDeadlineError",
        });
        await vi.advanceTimersByTimeAsync(60_000);
        await pending;

        expect(apiMethods.createRun).toHaveBeenCalledOnce();
        expect(createIdempotencyKeyMock).toHaveBeenCalledOnce();
        expect(apiMethods.getResult).not.toHaveBeenCalled();
        expect(apiMethods.cancelRun).not.toHaveBeenCalled();
        expect(setOutputMock).toHaveBeenCalledWith("run-id", RUN_ID);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

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
    apiMethods.createRun.mockResolvedValue({
      request_id: "req",
      run: runResource(config.workflow),
    });
    apiMethods.getResult.mockResolvedValue(standaloneResult(config.workflow));

    await run();

    expect(resolveDiffSourceMock).not.toHaveBeenCalled();
    expect(buildRunRequest(config)).toMatchObject({
      contract: { path: "src/Vault.sol", name: "Vault" },
      delivery: { type: "github_pull_request", pull_request_number: 42 },
    });
    expect(apiMethods.commitGeneratedFiles).toHaveBeenCalledWith(RUN_ID);
    expect(apiMethods.createRun).toHaveBeenCalledWith(
      config.workflow,
      buildRunRequest(config),
      "certora-guardian-stable",
    );
    expect(apiMethods.getResult).toHaveBeenCalledWith(RUN_ID);
    expect(apiMethods.commitGeneratedFiles.mock.calls[0]).toHaveLength(1);
    expect(setOutputMock).toHaveBeenCalledWith(
      "generated-files",
      "certora/Vault.spec",
    );
    expect(upsertPrCommentMock).toHaveBeenCalledWith(
      42,
      expect.any(String),
      "<!-- certora-guardian-ci:auto-prover -->",
      commit.delivery.commit_sha,
      RUN_ID,
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
    expect(upsertPrCommentMock).toHaveBeenCalledWith(
      42,
      expect.any(String),
      "<!-- certora-guardian-ci:auto-prover -->",
      HEAD_SHA,
      RUN_ID,
    );
  });

  describe("independent named configurations", () => {
    afterEach(() => vi.useRealTimers());
    const SOURCE_SHA = "a".repeat(40);
    const SECOND_SHA = "c".repeat(40);
    const THIRD_SHA = "d".repeat(40);
    const THIRD_ID = "33333333-3333-4333-8333-333333333333";
    type Entry = { id: string; sha: string; config: StandaloneActionConfig };
    function generatedChain(entries: Entry[]) {
      let parent = SOURCE_SHA;
      const ancestors = new Map<
        string,
        { runId: string; sourceCommitSha: string }
      >();
      const runs = new Map<string, Run>();
      const results = new Map<string, ReturnType<typeof standaloneResult>>();
      for (const entry of entries) {
        ancestors.set(entry.sha, { runId: entry.id, sourceCommitSha: parent });
        const resource = runResource(entry.config.workflow);
        resource.id = entry.id;
        resource.source.commit_sha = SOURCE_SHA;
        resource.client_reference =
          buildRunRequest({ ...entry.config, headCommitSha: SOURCE_SHA })
            .client_reference ?? null;
        resource.delivery = {
          type: "github_pull_request",
          pull_request_number: 42,
          status: "succeeded",
          outcome: "committed",
          commit_sha: entry.sha,
          files: [{ path: `certora/${entry.config.contractName}.spec` }],
          renamed_files: [],
          error: null,
        };
        runs.set(entry.id, resource);
        const result = standaloneResult(entry.config.workflow);
        result.result.run_id = entry.id;
        result.result.data.contract = {
          path: entry.config.contractPath,
          name: entry.config.contractName,
        };
        result.result.data.report.contract_name = entry.config.contractName;
        results.set(entry.id, result);
        parent = entry.sha;
      }
      getGeneratedFollowupMock.mockImplementation(
        async (sha: string) => ancestors.get(sha) ?? null,
      );
      apiMethods.getRun.mockImplementation(async (id: string) => ({
        request_id: "get",
        run: runs.get(id),
      }));
      apiMethods.getResult.mockImplementation(async (id: string) =>
        results.get(id),
      );
      apiMethods.commitGeneratedFiles.mockImplementation(
        async (id: string) => ({
          ...commit,
          delivery: {
            ...commit.delivery,
            commit_sha: entries.find((entry) => entry.id === id)?.sha,
          },
        }),
      );
      return { ancestors, runs, results, head: parent };
    }
    function configurations() {
      return [
        { ...standaloneConfig("auto-prover"), configurationId: "prover-vault" },
        {
          ...standaloneConfig("auto-prover"),
          configurationId: "prover-token",
          contractPath: "src/Token.sol",
          contractName: "Token",
        },
        {
          ...standaloneConfig("auto-fuzzer"),
          configurationId: "fuzzer-pool",
          contractPath: "src/Pool.sol",
          contractName: "Pool",
        },
      ];
    }

    it("scopes request identity to configuration without exceeding the existing API limit", () => {
      const config = standaloneConfig("auto-prover");
      const first = buildRunRequest({ ...config, configurationId: "first" });
      const second = buildRunRequest({ ...config, configurationId: "second" });
      expect(first.client_reference).not.toBe(second.client_reference);
      expect(first.client_reference).toMatch(/:configuration:[0-9a-f]{64}$/);
      expect(buildRunRequest(config).client_reference).not.toContain(
        ":configuration:",
      );
      const longest = buildRunRequest({
        ...findingValidationConfig(),
        prNumber: Number.MAX_SAFE_INTEGER,
        configurationId: "a".repeat(120),
      });
      expect(longest.client_reference!.length).toBeLessThanOrEqual(200);
    });

    it.each([0, 1, 2])(
      "recovers configuration %i's own result from an AP1 + AP2 + AF3 generated chain",
      async (index) => {
        const configs = configurations();
        const ids = [RUN_ID, RETRY_RUN_ID, THIRD_ID];
        const shas = [HEAD_SHA, SECOND_SHA, THIRD_SHA];
        const fixture = generatedChain(
          configs.map((config, i) => ({ id: ids[i], sha: shas[i], config })),
        );
        getConfigMock.mockReturnValue({
          ...configs[index],
          headCommitSha: fixture.head,
        });
        await run();
        expect(apiMethods.createRun).not.toHaveBeenCalled();
        expect(apiMethods.estimateRun).not.toHaveBeenCalled();
        expect(setOutputMock).toHaveBeenCalledWith("run-id", ids[index]);
        expect(setOutputMock).toHaveBeenCalledWith(
          "generated-commit-sha",
          shas[index],
        );
        expect(upsertPrCommentMock).toHaveBeenCalledWith(
          42,
          expect.any(String),
          expect.any(String),
          THIRD_SHA,
          ids[index],
        );
        expect(apiMethods.getResult).toHaveBeenCalledExactlyOnceWith(
          ids[index],
        );
        expect(apiMethods.commitGeneratedFiles).toHaveBeenCalledTimes(3);
      },
    );

    it("fails closed rather than reusing another named configuration of the same contract or launching again", async () => {
      const own = {
        ...standaloneConfig("auto-prover"),
        configurationId: "vault-a",
        designDocPath: "docs/a.md",
      };
      const sibling = {
        ...own,
        configurationId: "vault-b",
        designDocPath: "docs/b.md",
      };
      generatedChain([{ id: RUN_ID, sha: HEAD_SHA, config: sibling }]);
      getConfigMock.mockReturnValue(own);
      await expect(run()).rejects.toThrow("No unique result exists");
      expect(setOutputMock).not.toHaveBeenCalledWith("run-id", RUN_ID);
      expect(apiMethods.getResult).not.toHaveBeenCalled();
      expect(apiMethods.createRun).not.toHaveBeenCalled();
      expect(upsertPrCommentMock).not.toHaveBeenCalled();
    });

    it.each([true, false])(
      "does not confuse legacy and named configurations (named invocation=%s)",
      async (named) => {
        const legacy = standaloneConfig("auto-prover");
        const configured = { ...legacy, configurationId: "vault" };
        generatedChain([
          { id: RUN_ID, sha: HEAD_SHA, config: named ? legacy : configured },
        ]);
        getConfigMock.mockReturnValue(named ? configured : legacy);
        await expect(run()).rejects.toThrow("No unique result exists");
        expect(apiMethods.createRun).not.toHaveBeenCalled();
        expect(apiMethods.getResult).not.toHaveBeenCalled();
      },
    );

    function completedNoFiles(config: StandaloneActionConfig): Run {
      const own = runResource(config.workflow);
      own.id = THIRD_ID;
      own.source.commit_sha = SOURCE_SHA;
      own.client_reference =
        buildRunRequest({ ...config, headCommitSha: SOURCE_SHA })
          .client_reference ?? null;
      own.delivery = {
        type: "github_pull_request",
        pull_request_number: 42,
        status: "succeeded",
        outcome: "no_changes",
        commit_sha: null,
        files: [],
        renamed_files: [],
        error: null,
      };
      return own;
    }

    it.each(["verified", "issues_found"])(
      "recovers its own completed no-files %s outcome using only a bounded GET",
      async (outcome) => {
        const [own, sibling] = configurations();
        generatedChain([{ id: RUN_ID, sha: HEAD_SHA, config: sibling }]);
        getConfigMock.mockReturnValue(own);
        const candidate = completedNoFiles(own);
        apiMethods.findRunsByReference.mockResolvedValue({
          request_id: "list",
          runs: [candidate],
          next_cursor: null,
        });
        const result = standaloneResult(own.workflow);
        result.result.run_id = THIRD_ID;
        result.result.data.report.outcome = outcome;
        apiMethods.getResult.mockResolvedValue(result);
        await run();
        expect(apiMethods.findRunsByReference).toHaveBeenCalledExactlyOnceWith({
          workflow: own.workflow,
          repositoryUrl: own.repositoryUrl,
          commitSha: SOURCE_SHA,
          clientReference: candidate.client_reference,
        });
        expect(apiMethods.createRun).not.toHaveBeenCalled();
        expect(apiMethods.cancelRun).not.toHaveBeenCalled();
        expect(apiMethods.commitGeneratedFiles).toHaveBeenCalledExactlyOnceWith(
          RUN_ID,
        );
        expect(setOutputMock).toHaveBeenCalledWith("run-id", THIRD_ID);
        expect(setOutputMock).toHaveBeenCalledWith("generated-commit-sha", "");
        expect(upsertPrCommentMock).toHaveBeenCalledWith(
          42,
          expect.any(String),
          expect.any(String),
          HEAD_SHA,
          THIRD_ID,
        );
        if (outcome === "issues_found")
          expect(setFailedMock).toHaveBeenCalledWith(
            expect.stringContaining("violated properties"),
          );
        else expect(setFailedMock).not.toHaveBeenCalled();
      },
    );

    it.each([
      "absent",
      "ambiguous",
      "next page",
      "failed",
      "wrong source",
      "wrong engine",
      "wrong repo",
      "wrong PR",
      "wrong config",
      "unconfirmed delivery",
      "committed",
      "commit SHA",
      "files",
      "renames",
    ])(
      "rejects %s no-files lookup without a launch or unrelated publication",
      async (kind) => {
        const [own, sibling] = configurations();
        generatedChain([{ id: RUN_ID, sha: HEAD_SHA, config: sibling }]);
        getConfigMock.mockReturnValue(own);
        const candidate = completedNoFiles(own);
        if (kind === "failed") candidate.status = "failed";
        if (kind === "wrong source")
          candidate.source.commit_sha = "f".repeat(40);
        if (kind === "wrong engine") candidate.run_type = "auto_fuzzer";
        if (kind === "wrong repo")
          candidate.source.repository_url = "https://github.com/other/repo";
        if (kind === "wrong PR") candidate.delivery!.pull_request_number = 99;
        if (kind === "wrong config")
          candidate.client_reference =
            buildRunRequest({ ...sibling, headCommitSha: SOURCE_SHA })
              .client_reference ?? null;
        if (candidate.delivery && !("managed_by" in candidate.delivery)) {
          if (kind === "unconfirmed delivery")
            candidate.delivery.status = "failed";
          if (kind === "committed") candidate.delivery.outcome = "committed";
          if (kind === "commit SHA") candidate.delivery.commit_sha = HEAD_SHA;
          if (kind === "files")
            candidate.delivery.files = [{ path: "certora/Vault.spec" }];
          if (kind === "renames")
            candidate.delivery.renamed_files = [{ from: "a", to: "b" }];
        }
        apiMethods.findRunsByReference.mockResolvedValue({
          request_id: "list",
          runs:
            kind === "absent"
              ? []
              : kind === "ambiguous"
                ? [candidate, candidate]
                : [candidate],
          next_cursor: kind === "next page" ? RUN_ID : null,
        });
        await expect(run()).rejects.toThrow();
        expect(apiMethods.createRun).not.toHaveBeenCalled();
        expect(apiMethods.cancelRun).not.toHaveBeenCalled();
        expect(apiMethods.getResult).not.toHaveBeenCalled();
        expect(upsertPrCommentMock).not.toHaveBeenCalled();
      },
    );

    it("waits read-only for the unique original run and no-files delivery, preserving its failing outcome", async () => {
      vi.useFakeTimers();
      const [own, sibling] = configurations();
      const fixture = generatedChain([
        { id: RUN_ID, sha: HEAD_SHA, config: sibling },
      ]);
      getConfigMock.mockReturnValue(own);
      const pending = completedNoFiles(own);
      pending.status = "running";
      const finished = completedNoFiles(own);
      const deliveryPending = completedNoFiles(own);
      deliveryPending.delivery!.status = "pending";
      apiMethods.findRunsByReference.mockResolvedValue({
        request_id: "list",
        runs: [pending],
        next_cursor: null,
      });
      apiMethods.getRun
        .mockResolvedValueOnce({ run: fixture.runs.get(RUN_ID) })
        .mockResolvedValueOnce({ run: deliveryPending })
        .mockResolvedValueOnce({ run: finished });
      const result = standaloneResult(own.workflow);
      result.result.run_id = THIRD_ID;
      result.result.data.report.outcome = "issues_found";
      apiMethods.getResult.mockResolvedValue(result);
      const task = run();
      await vi.advanceTimersByTimeAsync(2000);
      await task;
      expect(apiMethods.getRun).toHaveBeenNthCalledWith(2, THIRD_ID);
      expect(apiMethods.getRun).toHaveBeenNthCalledWith(3, THIRD_ID);
      expect(setFailedMock).toHaveBeenCalledWith(
        expect.stringContaining("violated properties"),
      );
      expect(apiMethods.cancelRun).not.toHaveBeenCalled();
      expect(apiMethods.createRun).not.toHaveBeenCalled();
      expect(apiMethods.commitGeneratedFiles).toHaveBeenCalledExactlyOnceWith(
        RUN_ID,
      );
    });

    it.each(["timeout", "read failure", "identity change"])(
      "fails closed on original-run polling %s without cancelling or launching",
      async (kind) => {
        vi.useFakeTimers();
        const [own, sibling] = configurations();
        const fixture = generatedChain([
          { id: RUN_ID, sha: HEAD_SHA, config: sibling },
        ]);
        getConfigMock.mockReturnValue({
          ...own,
          timeout: kind === "timeout" ? 1 / 60 : 1,
        });
        const candidate = completedNoFiles(own);
        candidate.status = "running";
        apiMethods.findRunsByReference.mockResolvedValue({
          request_id: "list",
          runs: [candidate],
          next_cursor: null,
        });
        apiMethods.getRun.mockResolvedValueOnce({
          run: fixture.runs.get(RUN_ID),
        });
        if (kind === "read failure")
          apiMethods.getRun.mockRejectedValueOnce(new Error("read failed"));
        if (kind === "identity change")
          apiMethods.getRun.mockResolvedValueOnce({
            run: { ...candidate, client_reference: "another-configuration" },
          });
        const assertion = expect(run()).rejects.toThrow(
          kind === "timeout"
            ? "It was not cancelled"
            : kind === "read failure"
              ? "read failed"
              : "different source",
        );
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
        expect(apiMethods.cancelRun).not.toHaveBeenCalled();
        expect(apiMethods.createRun).not.toHaveBeenCalled();
        expect(apiMethods.getResult).not.toHaveBeenCalled();
        expect(upsertPrCommentMock).not.toHaveBeenCalled();
      },
    );

    it.each(["contract", "backend"])(
      "rejects an unrelated no-files report %s",
      async (kind) => {
        const [own, sibling] = configurations();
        generatedChain([{ id: RUN_ID, sha: HEAD_SHA, config: sibling }]);
        getConfigMock.mockReturnValue(own);
        apiMethods.findRunsByReference.mockResolvedValue({
          request_id: "list",
          runs: [completedNoFiles(own)],
          next_cursor: null,
        });
        const result = standaloneResult(own.workflow);
        result.result.run_id = THIRD_ID;
        if (kind === "contract")
          result.result.data.contract.path = "src/Other.sol";
        else result.result.data.report.backend = "foundry";
        apiMethods.getResult.mockResolvedValue(result);
        await expect(run()).rejects.toThrow();
        expect(apiMethods.createRun).not.toHaveBeenCalled();
        expect(upsertPrCommentMock).not.toHaveBeenCalled();
      },
    );

    it("rejects a changed contract under the same named configuration before delivery", async () => {
      const own = {
        ...standaloneConfig("auto-prover"),
        configurationId: "vault",
      };
      generatedChain([
        {
          id: RUN_ID,
          sha: HEAD_SHA,
          config: { ...own, contractName: "Other" },
        },
      ]);
      getConfigMock.mockReturnValue(own);
      await expect(run()).rejects.toThrow("different contract");
      expect(apiMethods.commitGeneratedFiles).not.toHaveBeenCalled();
      expect(apiMethods.createRun).not.toHaveBeenCalled();
    });

    it("rejects an unattested contributor commit between generated commits", async () => {
      const [own, sibling] = configurations();
      const fixture = generatedChain([
        { id: RUN_ID, sha: HEAD_SHA, config: own },
        { id: RETRY_RUN_ID, sha: SECOND_SHA, config: sibling },
      ]);
      fixture.ancestors.delete(HEAD_SHA);
      getConfigMock.mockReturnValue({ ...own, headCommitSha: SECOND_SHA });
      await expect(run()).rejects.toThrow("unverified contributor commit");
      expect(apiMethods.createRun).not.toHaveBeenCalled();
      expect(upsertPrCommentMock).not.toHaveBeenCalled();
    });

    it.each([
      "different source",
      "different repository",
      "different PR",
      "forged delivery",
      "unconfirmed delivery",
      "invalid identity",
    ])(
      "rejects sibling %s without falsely skipping or relaunching",
      async (kind) => {
        const [own, sibling] = configurations();
        const fixture = generatedChain([
          { id: RUN_ID, sha: HEAD_SHA, config: own },
          { id: RETRY_RUN_ID, sha: SECOND_SHA, config: sibling },
        ]);
        const candidate = fixture.runs.get(RUN_ID)!;
        if (kind === "different source")
          candidate.source.commit_sha = "f".repeat(40);
        if (kind === "different repository")
          candidate.source.repository_url = "https://github.com/other/repo";
        if (kind === "different PR")
          candidate.delivery!.pull_request_number = 99;
        if (
          kind === "forged delivery" &&
          candidate.delivery &&
          !("managed_by" in candidate.delivery)
        )
          candidate.delivery.commit_sha = "f".repeat(40);
        if (kind === "unconfirmed delivery") candidate.status = "running";
        if (kind === "invalid identity")
          candidate.client_reference = "other-client";
        getConfigMock.mockReturnValue({
          ...sibling,
          headCommitSha: SECOND_SHA,
        });
        await expect(run()).rejects.toThrow();
        expect(apiMethods.createRun).not.toHaveBeenCalled();
        expect(upsertPrCommentMock).not.toHaveBeenCalled();
        expect(setOutputMock).not.toHaveBeenCalledWith("status", "skipped");
      },
    );

    it("bounds generated ancestry and never starts a run on overflow", async () => {
      const own = {
        ...standaloneConfig("auto-prover"),
        configurationId: "own",
      };
      const fixture = generatedChain(
        Array.from({ length: 17 }, (_, index) => ({
          id: `${String(index).padStart(8, "0")}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
          sha: (index + 1).toString(16).padStart(40, "0"),
          config: { ...own, configurationId: `sibling-${index}` },
        })),
      );
      getConfigMock.mockReturnValue({ ...own, headCommitSha: fixture.head });
      await expect(run()).rejects.toThrow("exceeds 16 commits");
      expect(apiMethods.getRun).toHaveBeenCalledTimes(16);
      expect(apiMethods.createRun).not.toHaveBeenCalled();
    });
  });

  describe.each(["auto-prover", "auto-fuzzer"] as const)(
    "%s generated delivery recovery",
    (workflow) => {
      let followedUpRun: Run;

      beforeEach(() => {
        getConfigMock.mockReturnValue(standaloneConfig(workflow));
        getGeneratedFollowupMock.mockResolvedValue({
          runId: RUN_ID,
          sourceCommitSha: "a".repeat(40),
        });
        followedUpRun = runResource(workflow);
        followedUpRun.source.commit_sha = "a".repeat(40);
        followedUpRun.client_reference = [
          "certora-guardian",
          "pr-42",
          "a".repeat(40),
          workflow,
        ].join(":");
        apiMethods.getRun.mockResolvedValue({
          request_id: "req-followup",
          run: followedUpRun,
        });
        apiMethods.getResult.mockResolvedValue(standaloneResult(workflow));
        apiMethods.commitGeneratedFiles.mockResolvedValue({
          ...commit,
          delivery: { ...commit.delivery, commit_sha: HEAD_SHA },
        });
      });

      afterEach(() => {
        expect(apiMethods.estimateRun).not.toHaveBeenCalled();
        expect(apiMethods.createRun).not.toHaveBeenCalled();
        expect(apiMethods.cancelRun).not.toHaveBeenCalled();
        expect(createIdempotencyKeyMock).not.toHaveBeenCalled();
      });

      it.each(["pending", "failed"] as const)(
        "reconciles a pushed generated child whose delivery remains %s",
        async (status) => {
          followedUpRun.delivery!.status = status;

          await run();

          expect(apiMethods.getRun).toHaveBeenCalledExactlyOnceWith(RUN_ID);
          expect(
            apiMethods.commitGeneratedFiles,
          ).toHaveBeenCalledExactlyOnceWith(RUN_ID);
          expect(setOutputMock).toHaveBeenCalledWith(
            "generated-commit-sha",
            HEAD_SHA,
          );
          expect(upsertPrCommentMock).toHaveBeenCalledWith(
            42,
            expect.any(String),
            `<!-- certora-guardian-ci:${workflow} -->`,
            HEAD_SHA,
            RUN_ID,
          );
        },
      );

      it.each<[string, (candidate: Run) => void]>([
        [
          "run ID",
          (candidate) => {
            candidate.id = "22222222-2222-4222-8222-222222222222";
          },
        ],
        [
          "workflow",
          (candidate) => {
            candidate.run_type = "ai_auditor_full";
          },
        ],
        [
          "repository",
          (candidate) => {
            candidate.source.repository_url = "https://github.com/other/repo";
          },
        ],
        [
          "source parent",
          (candidate) => {
            candidate.source.commit_sha = "d".repeat(40);
          },
        ],
        [
          "client reference",
          (candidate) => {
            candidate.client_reference = "other-client";
          },
        ],
        [
          "pull request",
          (candidate) => {
            candidate.delivery!.pull_request_number = 43;
          },
        ],
        [
          "missing delivery",
          (candidate) => {
            candidate.delivery = null;
          },
        ],
        [
          "unfinished run",
          (candidate) => {
            candidate.status = "running";
          },
        ],
        [
          "skipped delivery",
          (candidate) => {
            candidate.delivery!.status = "skipped";
          },
        ],
        [
          "pending with contradictory commit",
          (candidate) => {
            candidate.delivery!.commit_sha = "d".repeat(40);
          },
        ],
        [
          "pending with contradictory outcome",
          (candidate) => {
            candidate.delivery!.outcome = "no_changes";
          },
        ],
        [
          "completed different head",
          (candidate) => {
            Object.assign(candidate.delivery!, {
              status: "succeeded",
              outcome: "committed",
              commit_sha: "d".repeat(40),
            });
          },
        ],
        [
          "completed no changes",
          (candidate) => {
            Object.assign(candidate.delivery!, {
              status: "succeeded",
              outcome: "no_changes",
            });
          },
        ],
      ])(
        "rejects incompatible %s before attempting recovery",
        async (_label, mutate) => {
          mutate(followedUpRun);

          await expect(run()).rejects.toThrow();

          expect(apiMethods.getResult).not.toHaveBeenCalled();
          expect(apiMethods.commitGeneratedFiles).not.toHaveBeenCalled();
          expect(upsertPrCommentMock).not.toHaveBeenCalled();
        },
      );

      it("rejects a different result contract before attempting recovery", async () => {
        const result = standaloneResult(workflow);
        result.result.data.contract.path = "src/Other.sol";
        apiMethods.getResult.mockResolvedValue(result);

        await expect(run()).rejects.toThrow("different contract");

        expect(apiMethods.commitGeneratedFiles).not.toHaveBeenCalled();
        expect(upsertPrCommentMock).not.toHaveBeenCalled();
      });

      it.each(["different head", "no changes"])(
        "rejects recovered delivery with %s without publishing a summary",
        async (kind) => {
          apiMethods.commitGeneratedFiles.mockResolvedValue({
            ...commit,
            delivery:
              kind === "different head"
                ? commit.delivery
                : {
                    status: "no_changes",
                    commit_sha: null,
                    files: [],
                    renamed_files: [],
                  },
          });

          await expect(run()).rejects.toThrow(
            "Generated follow-up commit mismatch",
          );

          expect(apiMethods.commitGeneratedFiles).toHaveBeenCalledOnce();
          expect(upsertPrCommentMock).not.toHaveBeenCalled();
        },
      );

      it("does not fall back to a paid launch when server reconciliation fails", async () => {
        apiMethods.commitGeneratedFiles.mockRejectedValue(
          new Error("Generated file set does not match the expected child"),
        );

        await expect(run()).rejects.toThrow(
          "Generated file set does not match",
        );

        expect(upsertPrCommentMock).not.toHaveBeenCalled();
      });

      it("passes the shared deadline through recovery and stops on expiry", async () => {
        const config = standaloneConfig(workflow);
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now);
        try {
          apiMethods.commitGeneratedFiles.mockRejectedValue(
            new Error("The configured run timeout expired"),
          );

          await expect(run()).rejects.toThrow("run timeout expired");

          expect(AutoProverApi).toHaveBeenLastCalledWith(
            config.apiBaseUrl,
            config.apiKey,
            now + config.timeout * 60_000,
          );
          expect(apiMethods.commitGeneratedFiles).toHaveBeenCalledOnce();
          expect(upsertPrCommentMock).not.toHaveBeenCalled();
        } finally {
          vi.spyOn(Date, "now").mockRestore();
        }
      });
    },
  );

  it.each(["auto-prover", "auto-fuzzer"] as const)(
    "binds %s's unchanged delivery summary to the source head and canonical audit",
    async (workflow) => {
      const config = standaloneConfig(workflow);
      getConfigMock.mockReturnValue(config);
      apiMethods.createRun.mockResolvedValue({
        request_id: "req",
        run: runResource(workflow),
      });
      apiMethods.getResult.mockResolvedValue(standaloneResult(workflow));
      apiMethods.commitGeneratedFiles.mockResolvedValue({
        request_id: "req-no-changes",
        delivery: {
          status: "no_changes",
          commit_sha: null,
          files: [],
          renamed_files: [],
        },
      });

      await run();

      expect(upsertPrCommentMock).toHaveBeenCalledExactlyOnceWith(
        42,
        expect.any(String),
        `<!-- certora-guardian-ci:${workflow} -->`,
        HEAD_SHA,
        RUN_ID,
      );
      expect(setOutputMock).toHaveBeenCalledWith("generated-commit-sha", "");
    },
  );

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
