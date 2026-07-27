import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  apiMethods,
  getConfigMock,
  getGeneratedFollowupJobIdMock,
  setFailedMock,
  setOutputMock,
  upsertPrCommentMock,
  warningMock,
} = vi.hoisted(() => ({
  apiMethods: {
    createStandaloneAudit: vi.fn(),
    getProgress: vi.fn(),
    getResult: vi.fn(),
    commitGeneratedFiles: vi.fn(),
    cancelAudit: vi.fn(),
    getStatus: vi.fn(),
    createFullAudit: vi.fn(),
    createDiffAudit: vi.fn(),
  },
  getConfigMock: vi.fn(),
  getGeneratedFollowupJobIdMock: vi.fn(),
  setFailedMock: vi.fn(),
  setOutputMock: vi.fn(),
  upsertPrCommentMock: vi.fn(),
  warningMock: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: warningMock,
  setOutput: setOutputMock,
  setFailed: setFailedMock,
}));

vi.mock("../src/config", () => ({
  getConfig: getConfigMock,
}));

vi.mock("../src/api", () => ({
  ZeusApi: vi.fn(function ZeusApi() {
    return apiMethods;
  }),
}));

vi.mock("../src/github", () => ({
  GitHubClient: vi.fn(function GitHubClient() {
    return {
      upsertPrComment: upsertPrCommentMock,
      getGeneratedFollowupJobId: getGeneratedFollowupJobIdMock,
    };
  }),
}));

import { run } from "../src/run";

type StandaloneEngine = "auto-prover" | "auto-foundry";
type Outcome =
  | "verified"
  | "verified_with_gaps"
  | "partial"
  | "issues_found"
  | "unknown";

const HEAD_SHA = "b".repeat(40);
const GENERATED_SHA = "c".repeat(40);
const FOLLOWUP_JOB_ID = "11111111-1111-4111-8111-111111111111";

function standaloneConfig(engine: StandaloneEngine = "auto-prover") {
  return {
    engine,
    apiKey: "zeus_live_test",
    apiBaseUrl: "https://zeus.certora.com",
    githubToken: "ghs_test",
    pollInterval: 60,
    timeout: 120,
    commentOnPr: true,
    target: "https://github.com/Certora/contracts",
    branchStarting: "a".repeat(40),
    branchEnding: HEAD_SHA,
    prNumber: 42,
    contractPath: "src/Vault.sol",
    contractName: "Vault",
    designDocPath: "docs/design.md",
    threatModelPath:
      engine === "auto-prover" ? "docs/threat-model.md" : undefined,
  };
}

function structuredResult(
  outcome: Outcome,
  options: {
    engine?: StandaloneEngine;
    jobId?: string;
    status?: string;
  } = {},
) {
  return {
    job_id: options.jobId ?? "job-1",
    engine: options.engine ?? "auto-prover",
    status: options.status ?? "succeeded",
    billed_amount_usd: 12.5,
    result: {
      report_state: "ready",
      report: {
        contractName: "Vault",
        outcome,
        ruleCounts: [{ status: "VERIFIED", count: 2 }],
        skipped: outcome === "verified_with_gaps" ? [{}] : [],
        gaveUpComponents: [],
        coverage: {
          totalProperties: 2,
          totalRules: 2,
          totalGroups: 1,
          propertyCoverageComplete: true,
          propertiesInNoGroup: [],
          rulesSpanningMultipleGroups: [],
          skippedCount: outcome === "verified_with_gaps" ? 1 : 0,
          gaveUpComponentCount: 0,
          droppedOrphanRules: 0,
          warnings: [],
        },
      },
      artifacts: [{ path: "certora/Vault.spec" }],
    },
  };
}

function generatedCommit(
  overrides: {
    commitSha?: string;
    commitCreated?: boolean;
  } = {},
) {
  return {
    commit_sha: overrides.commitSha ?? GENERATED_SHA,
    commit_created: overrides.commitCreated ?? true,
    files: [{ path: "certora/Vault.spec" }],
    renamed_files: [],
  };
}

describe("standalone engine action run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfigMock.mockReturnValue(standaloneConfig());
    getGeneratedFollowupJobIdMock.mockResolvedValue(null);
    apiMethods.createStandaloneAudit.mockResolvedValue({
      job_id: "job-1",
      status: "pending",
      current_balance_usd: 100,
    });
    apiMethods.getProgress.mockResolvedValue({
      job_id: "job-1",
      status: "succeeded",
      current_phase: "complete",
      completed_phases: 1,
      total_phases: 1,
      progress: 1,
      progress_percent: 100,
      billed_amount_usd: 12.5,
    });
    apiMethods.getStatus.mockResolvedValue({
      job_id: "job-1",
      status: "succeeded",
      created_at: "2026-07-27T00:00:00.000Z",
      started_at: "2026-07-27T00:01:00.000Z",
      completed_at: "2026-07-27T00:05:00.000Z",
      error: null,
    });
    apiMethods.getResult.mockResolvedValue(
      structuredResult("verified_with_gaps"),
    );
    apiMethods.commitGeneratedFiles.mockResolvedValue(generatedCommit());
    apiMethods.cancelAudit.mockResolvedValue({
      job_id: "job-1",
      status: "cancelled",
      message: "Audit cancelled.",
      cancelled_at: "2026-07-27T00:05:00.000Z",
    });
  });

  it("launches, commits, comments, and publishes outputs when the head has no marker", async () => {
    await run();

    expect(getGeneratedFollowupJobIdMock).toHaveBeenCalledWith(HEAD_SHA);
    expect(apiMethods.createStandaloneAudit).toHaveBeenCalledWith({
      engine: "auto-prover",
      target: "https://github.com/Certora/contracts",
      branch: HEAD_SHA,
      pull_request_number: 42,
      contract_path: "src/Vault.sol",
      contract_name: "Vault",
      design_doc_path: "docs/design.md",
      threat_model_path: "docs/threat-model.md",
      token: "ghs_test",
    });
    expect(apiMethods.commitGeneratedFiles).toHaveBeenCalledWith("job-1", {
      pull_request_number: 42,
      token: "ghs_test",
    });
    expect(setOutputMock).toHaveBeenCalledWith(
      "run-outcome",
      "verified_with_gaps",
    );
    expect(setOutputMock).toHaveBeenCalledWith(
      "generated-files",
      "certora/Vault.spec",
    );
    expect(setOutputMock).toHaveBeenCalledWith(
      "generated-commit-sha",
      GENERATED_SHA,
    );
    expect(setOutputMock).toHaveBeenCalledWith("highs-count", "0");
    expect(setOutputMock).toHaveBeenCalledWith("issues-created", "");
    expect(warningMock).toHaveBeenCalledWith(
      "The run verified its executed rules but has coverage gaps.",
    );
    expect(upsertPrCommentMock).toHaveBeenCalledWith(
      42,
      expect.stringContaining("AutoProver Results — Verified with gaps"),
    );
    expect(
      getGeneratedFollowupJobIdMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      apiMethods.createStandaloneAudit.mock.invocationCallOrder[0] as number,
    );
    expect(
      apiMethods.commitGeneratedFiles.mock.invocationCallOrder[0],
    ).toBeLessThan(upsertPrCommentMock.mock.invocationCallOrder[0] as number);
    expect(setFailedMock).not.toHaveBeenCalled();
  });

  it("waits for settled billing after provider success without launching twice", async () => {
    vi.useFakeTimers();
    try {
      apiMethods.getStatus
        .mockResolvedValueOnce({
          job_id: "job-1",
          status: "succeeded",
          created_at: "2026-07-27T00:00:00.000Z",
          started_at: "2026-07-27T00:01:00.000Z",
          completed_at: null,
          error: null,
        })
        .mockResolvedValueOnce({
          job_id: "job-1",
          status: "succeeded",
          created_at: "2026-07-27T00:00:00.000Z",
          started_at: "2026-07-27T00:01:00.000Z",
          completed_at: "2026-07-27T00:06:00.000Z",
          error: null,
        });

      const runPromise = run();
      await vi.advanceTimersByTimeAsync(60_000);
      await runPromise;

      expect(apiMethods.createStandaloneAudit).toHaveBeenCalledOnce();
      expect(apiMethods.getProgress).toHaveBeenCalledTimes(2);
      expect(apiMethods.getStatus).toHaveBeenCalledTimes(2);
      expect(apiMethods.getResult).toHaveBeenCalledOnce();
      expect(apiMethods.commitGeneratedFiles).toHaveBeenCalledOnce();
      expect(apiMethods.cancelAudit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts repeated settlement-status failures even when progress keeps succeeding", async () => {
    vi.useFakeTimers();
    try {
      getConfigMock.mockReturnValue({
        ...standaloneConfig(),
        pollInterval: 1,
      });
      apiMethods.getStatus.mockRejectedValue(
        new Error("settlement status unavailable"),
      );

      const runPromise = run();
      await vi.advanceTimersByTimeAsync(4_000);
      await runPromise;

      expect(apiMethods.getProgress).toHaveBeenCalledTimes(5);
      expect(apiMethods.getStatus).toHaveBeenCalledTimes(5);
      expect(apiMethods.cancelAudit).not.toHaveBeenCalled();
      expect(setOutputMock).toHaveBeenCalledWith("status", "succeeded");
      expect(setFailedMock).toHaveBeenCalledWith(
        expect.stringContaining(
          "The provider workflow was already terminal and was not cancelled.",
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests cancellation before exiting after repeated non-terminal poll failures", async () => {
    vi.useFakeTimers();
    try {
      getConfigMock.mockReturnValue({
        ...standaloneConfig(),
        pollInterval: 1,
      });
      apiMethods.getProgress.mockRejectedValue(new Error("API unavailable"));
      apiMethods.cancelAudit.mockResolvedValueOnce({
        job_id: "job-1",
        status: "cancellation_pending",
        message: "Final usage and billing are being reconciled.",
        requested_at: "2026-07-27T00:05:00.000Z",
      });

      const runPromise = run();
      await vi.advanceTimersByTimeAsync(4_000);
      await runPromise;

      expect(apiMethods.getProgress).toHaveBeenCalledTimes(5);
      expect(apiMethods.cancelAudit).toHaveBeenCalledWith("job-1");
      expect(setOutputMock).toHaveBeenCalledWith(
        "status",
        "cancellation_pending",
      );
      expect(setFailedMock).toHaveBeenCalledWith(
        expect.stringContaining(
          "Cancellation was requested and is still being reconciled.",
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not overstate a pending cancellation after the action timeout", async () => {
    vi.useFakeTimers();
    try {
      getConfigMock.mockReturnValue({
        ...standaloneConfig(),
        pollInterval: 60,
        timeout: 1,
      });
      apiMethods.getProgress.mockResolvedValue({
        job_id: "job-1",
        status: "running",
        current_phase: "generating",
        completed_phases: 0,
        total_phases: 2,
        progress: 0.25,
        progress_percent: 25,
        billed_amount_usd: 1,
      });
      apiMethods.cancelAudit.mockResolvedValueOnce({
        job_id: "job-1",
        status: "cancellation_pending",
        message: "Final usage and billing are being reconciled.",
        requested_at: "2026-07-27T00:05:00.000Z",
      });

      const runPromise = run();
      await vi.advanceTimersByTimeAsync(60_000);
      await runPromise;

      expect(apiMethods.cancelAudit).toHaveBeenCalledWith("job-1");
      expect(setOutputMock).toHaveBeenCalledWith(
        "status",
        "cancellation_pending",
      );
      expect(setFailedMock).toHaveBeenCalledWith(
        "Audit timed out after 1 minute. Cancellation was requested and is still being reconciled.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits and comments before failing an initial issues_found result", async () => {
    apiMethods.getResult.mockResolvedValueOnce(
      structuredResult("issues_found"),
    );

    await run();

    expect(apiMethods.commitGeneratedFiles).toHaveBeenCalledOnce();
    expect(upsertPrCommentMock).toHaveBeenCalledOnce();
    expect(setOutputMock).toHaveBeenCalledWith("run-outcome", "issues_found");
    expect(setFailedMock).toHaveBeenCalledWith(
      "auto-prover found one or more violated properties or rules.",
    );
    expect(upsertPrCommentMock.mock.invocationCallOrder[0]).toBeLessThan(
      setFailedMock.mock.invocationCallOrder[0] as number,
    );
  });

  it("describes AutoFoundry issues_found as failing generated tests", async () => {
    getConfigMock.mockReturnValue(standaloneConfig("auto-foundry"));
    apiMethods.getResult.mockResolvedValueOnce(
      structuredResult("issues_found", { engine: "auto-foundry" }),
    );

    await run();

    expect(setFailedMock).toHaveBeenCalledWith(
      "auto-foundry found one or more failing generated tests.",
    );
    expect(upsertPrCommentMock).toHaveBeenCalledWith(
      42,
      expect.stringContaining("AutoFoundry Results — Test failures found"),
    );
  });

  it.each([
    {
      name: "different job",
      result: structuredResult("verified", { jobId: "job-2" }),
    },
    {
      name: "different engine",
      result: structuredResult("verified", { engine: "auto-foundry" }),
    },
    {
      name: "non-success status",
      result: structuredResult("verified", { status: "failed" }),
    },
    {
      name: "non-AISS payload",
      result: {
        ...structuredResult("verified"),
        result: "unexpected markdown",
      },
    },
  ])(
    "rejects an initial standalone result with a $name",
    async ({ result }) => {
      apiMethods.getResult.mockResolvedValueOnce(result);

      await expect(run()).rejects.toThrow(
        "auto-prover returned an unexpected persisted audit result.",
      );

      expect(apiMethods.commitGeneratedFiles).not.toHaveBeenCalled();
      expect(upsertPrCommentMock).not.toHaveBeenCalled();
    },
  );

  it("supports a successful generated-file response from an older API deployment", async () => {
    apiMethods.commitGeneratedFiles.mockResolvedValueOnce({
      commit_sha: GENERATED_SHA,
      files: [{ path: "certora/Vault.spec" }],
      renamed_files: [],
    });

    await run();

    expect(setOutputMock).toHaveBeenCalledWith(
      "generated-commit-sha",
      GENERATED_SHA,
    );
    expect(upsertPrCommentMock).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Generated commit | Created"),
    );
    expect(setFailedMock).not.toHaveBeenCalled();
  });

  it("does not comment when PR comments are disabled", async () => {
    getConfigMock.mockReturnValue({
      ...standaloneConfig("auto-foundry"),
      commentOnPr: false,
    });
    apiMethods.getResult.mockResolvedValueOnce(
      structuredResult("verified", { engine: "auto-foundry" }),
    );

    await run();

    expect(apiMethods.createStandaloneAudit).toHaveBeenCalledOnce();
    expect(apiMethods.commitGeneratedFiles).toHaveBeenCalledOnce();
    expect(upsertPrCommentMock).not.toHaveBeenCalled();
  });

  it("fails closed before launch when the head commit cannot be inspected", async () => {
    getGeneratedFollowupJobIdMock.mockRejectedValueOnce(
      new Error("head inspection failed"),
    );

    await expect(run()).rejects.toThrow("head inspection failed");

    expect(apiMethods.createStandaloneAudit).not.toHaveBeenCalled();
    expect(apiMethods.getResult).not.toHaveBeenCalled();
    expect(apiMethods.commitGeneratedFiles).not.toHaveBeenCalled();
  });

  it("keeps the current check authoritative when no generated commit is needed", async () => {
    apiMethods.commitGeneratedFiles.mockResolvedValueOnce(
      generatedCommit({
        commitSha: HEAD_SHA,
        commitCreated: false,
      }),
    );

    await run();

    expect(setOutputMock).toHaveBeenCalledWith("generated-commit-sha", "");
    expect(warningMock).toHaveBeenCalledWith(
      "No generated files needed to be committed. The pull request head is unchanged, so the current check remains authoritative.",
    );
    expect(upsertPrCommentMock).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Not needed (head unchanged)"),
    );
    expect(setFailedMock).not.toHaveBeenCalled();
  });

  it("fails the current unchanged head for a no-op issues_found result", async () => {
    apiMethods.getResult.mockResolvedValueOnce(
      structuredResult("issues_found"),
    );
    apiMethods.commitGeneratedFiles.mockResolvedValueOnce(
      generatedCommit({
        commitSha: HEAD_SHA,
        commitCreated: false,
      }),
    );

    await run();

    expect(setFailedMock).toHaveBeenCalledWith(
      "auto-prover found one or more violated properties or rules.",
    );
  });

  it.each(["partial", "verified_with_gaps", "unknown"] as const)(
    "does not fail the initial %s outcome",
    async (outcome) => {
      getConfigMock.mockReturnValue(standaloneConfig("auto-foundry"));
      apiMethods.getResult.mockResolvedValueOnce(
        structuredResult(outcome, { engine: "auto-foundry" }),
      );

      await run();

      expect(setOutputMock).toHaveBeenCalledWith("run-outcome", outcome);
      expect(setFailedMock).not.toHaveBeenCalled();
    },
  );

  it("verifies a generated commit and reports the persisted result without launching another audit", async () => {
    getGeneratedFollowupJobIdMock.mockResolvedValueOnce(FOLLOWUP_JOB_ID);
    apiMethods.getResult.mockResolvedValueOnce(
      structuredResult("verified_with_gaps", {
        jobId: FOLLOWUP_JOB_ID,
      }),
    );
    apiMethods.commitGeneratedFiles.mockResolvedValueOnce(
      generatedCommit({ commitSha: HEAD_SHA }),
    );

    await run();

    expect(apiMethods.createStandaloneAudit).not.toHaveBeenCalled();
    expect(apiMethods.getProgress).not.toHaveBeenCalled();
    expect(apiMethods.getResult).toHaveBeenCalledWith(FOLLOWUP_JOB_ID);
    expect(apiMethods.commitGeneratedFiles).toHaveBeenCalledWith(
      FOLLOWUP_JOB_ID,
      {
        pull_request_number: 42,
        token: "ghs_test",
      },
    );
    expect(setOutputMock).toHaveBeenCalledWith("job-id", FOLLOWUP_JOB_ID);
    expect(setOutputMock).toHaveBeenCalledWith("status", "succeeded");
    expect(setOutputMock).toHaveBeenCalledWith(
      "run-outcome",
      "verified_with_gaps",
    );
    expect(setOutputMock).toHaveBeenCalledWith(
      "generated-commit-sha",
      HEAD_SHA,
    );
    expect(upsertPrCommentMock).toHaveBeenCalledWith(
      42,
      expect.stringContaining("AutoProver Results — Verified with gaps"),
    );
    expect(apiMethods.getResult.mock.invocationCallOrder[0]).toBeLessThan(
      apiMethods.commitGeneratedFiles.mock.invocationCallOrder[0] as number,
    );
    expect(setFailedMock).not.toHaveBeenCalled();
  });

  it("applies the persisted failure outcome on a verified follow-up", async () => {
    getGeneratedFollowupJobIdMock.mockResolvedValueOnce(FOLLOWUP_JOB_ID);
    apiMethods.getResult.mockResolvedValueOnce(
      structuredResult("issues_found", {
        jobId: FOLLOWUP_JOB_ID,
      }),
    );
    apiMethods.commitGeneratedFiles.mockResolvedValueOnce(
      generatedCommit({ commitSha: HEAD_SHA }),
    );

    await run();

    expect(apiMethods.createStandaloneAudit).not.toHaveBeenCalled();
    expect(setFailedMock).toHaveBeenCalledWith(
      "auto-prover found one or more violated properties or rules.",
    );
  });

  it("fails closed when a forged marker cannot be validated by Zeus", async () => {
    getGeneratedFollowupJobIdMock.mockResolvedValueOnce(FOLLOWUP_JOB_ID);
    apiMethods.getResult.mockResolvedValueOnce(
      structuredResult("verified", {
        jobId: FOLLOWUP_JOB_ID,
      }),
    );
    apiMethods.commitGeneratedFiles.mockRejectedValueOnce(
      new Error("job does not own this generated commit"),
    );

    await expect(run()).rejects.toThrow(
      "job does not own this generated commit",
    );

    expect(apiMethods.createStandaloneAudit).not.toHaveBeenCalled();
    expect(apiMethods.getProgress).not.toHaveBeenCalled();
  });

  it("rejects a follow-up whose verified commit differs from the event head", async () => {
    getGeneratedFollowupJobIdMock.mockResolvedValueOnce(FOLLOWUP_JOB_ID);
    apiMethods.getResult.mockResolvedValueOnce(
      structuredResult("verified", {
        jobId: FOLLOWUP_JOB_ID,
      }),
    );
    apiMethods.commitGeneratedFiles.mockResolvedValueOnce(generatedCommit());

    await expect(run()).rejects.toThrow(
      `Generated follow-up commit mismatch: expected ${HEAD_SHA}, received ${GENERATED_SHA}.`,
    );

    expect(apiMethods.createStandaloneAudit).not.toHaveBeenCalled();
    expect(upsertPrCommentMock).not.toHaveBeenCalled();
  });

  it("rejects a follow-up that does not resolve to a generated commit", async () => {
    getGeneratedFollowupJobIdMock.mockResolvedValueOnce(FOLLOWUP_JOB_ID);
    apiMethods.getResult.mockResolvedValueOnce(
      structuredResult("verified", {
        jobId: FOLLOWUP_JOB_ID,
      }),
    );
    apiMethods.commitGeneratedFiles.mockResolvedValueOnce(
      generatedCommit({
        commitSha: HEAD_SHA,
        commitCreated: false,
      }),
    );

    await expect(run()).rejects.toThrow(
      "Generated follow-up did not resolve to a generated commit.",
    );

    expect(apiMethods.createStandaloneAudit).not.toHaveBeenCalled();
    expect(upsertPrCommentMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "different job",
      result: structuredResult("verified", {
        jobId: "22222222-2222-4222-8222-222222222222",
      }),
    },
    {
      name: "different engine",
      result: structuredResult("verified", {
        jobId: FOLLOWUP_JOB_ID,
        engine: "auto-foundry",
      }),
    },
    {
      name: "non-success status",
      result: structuredResult("verified", {
        jobId: FOLLOWUP_JOB_ID,
        status: "failed",
      }),
    },
  ])(
    "rejects a follow-up with a $name persisted result",
    async ({ result }) => {
      getGeneratedFollowupJobIdMock.mockResolvedValueOnce(FOLLOWUP_JOB_ID);
      apiMethods.getResult.mockResolvedValueOnce(result);

      await expect(run()).rejects.toThrow(
        "Generated follow-up received an unexpected persisted audit result.",
      );

      expect(apiMethods.createStandaloneAudit).not.toHaveBeenCalled();
      expect(apiMethods.commitGeneratedFiles).not.toHaveBeenCalled();
    },
  );
});
