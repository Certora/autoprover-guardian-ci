import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getZeusApiErrorMessage,
  ZeusApi,
  ZeusApiDeadlineError,
  ZeusApiError,
} from "../src/api";
import { API_REQUEST_TIMEOUT_MS } from "../src/constants";

describe("ZeusApi", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards use_memory when creating a full audit", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          job_id: "job-1",
          status: "pending",
          audit_type: "full",
          remaining_credits: 10,
        }),
        { status: 200 },
      ),
    );

    const api = new ZeusApi("https://zeus.certora.com", "zeus_live_test");

    await api.createFullAudit({
      engine: "ai-auditor",
      target: "https://github.com/Certora/autoprover-guardian-ci",
      branch: "a".repeat(40),
      context: ["contracts/**/*.sol"],
      use_memory: false,
    });

    const requestBody = JSON.parse(
      fetchMock.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(requestBody.use_memory).toBe(false);
  });

  it.each(["full", "diff"] as const)(
    "does not retry %s audit creation after an ambiguous server failure",
    async (auditType) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "audit_backend_error",
              message: "Temporary backend failure",
            },
          }),
          { status: 502 },
        ),
      );
      const api = new ZeusApi("https://zeus.certora.com", "zeus_live_test");

      const request =
        auditType === "full"
          ? api.createFullAudit({
              engine: "ai-auditor",
              target: "https://github.com/Certora/autoprover-guardian-ci",
              branch: "b".repeat(40),
              context: ["contracts/**/*.sol"],
            })
          : api.createDiffAudit({
              target: "https://github.com/Certora/autoprover-guardian-ci",
              branch_starting: "a".repeat(40),
              branch_ending: "b".repeat(40),
              context: ["contracts/**/*.sol"],
            });

      await expect(request).rejects.toMatchObject({
        code: "audit_backend_error",
        statusCode: 502,
        message: expect.stringContaining(
          "The launch outcome may be unknown; inspect the audit list before rerunning.",
        ),
      } satisfies Partial<ZeusApiError>);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("warns when a launch transport failure has an ambiguous outcome", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("socket closed"));
    const api = new ZeusApi("https://zeus.certora.com", "zeus_live_test");

    await expect(
      api.createStandaloneAudit({
        engine: "auto-prover",
        target: "https://github.com/Certora/autoprover-guardian-ci",
        branch: "b".repeat(40),
        pull_request_number: 42,
        contract_path: "src/Vault.sol",
        contract_name: "Vault",
      }),
    ).rejects.toMatchObject({
      name: "ZeusApiAmbiguousLaunchError",
      message: expect.stringContaining(
        "The launch outcome may be unknown; inspect the audit list before rerunning.",
      ),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("warns when a successful launch response cannot be decoded", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{", { status: 200 }));
    const api = new ZeusApi("https://zeus.certora.com", "zeus_live_test");

    await expect(
      api.createStandaloneAudit({
        engine: "auto-foundry",
        target: "https://github.com/Certora/autoprover-guardian-ci",
        branch: "b".repeat(40),
        pull_request_number: 42,
        contract_path: "src/Vault.sol",
        contract_name: "Vault",
      }),
    ).rejects.toMatchObject({
      name: "ZeusApiAmbiguousLaunchError",
      message: expect.stringContaining(
        "The launch outcome may be unknown; inspect the audit list before rerunning.",
      ),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["auto-prover", "auto-foundry"] as const)(
    "creates %s through the unified audits endpoint",
    async (engine) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            job_id: "job-standalone",
            engine,
            status: "pending",
          }),
          { status: 200 },
        ),
      );
      const api = new ZeusApi("https://zeus.certora.com", "zeus_live_test");

      await api.createStandaloneAudit({
        engine,
        target: "https://github.com/Certora/autoprover-guardian-ci",
        branch: "b".repeat(40),
        pull_request_number: 42,
        contract_path: "src/Vault.sol",
        contract_name: "Vault",
        design_doc_path: "docs/design.md",
        threat_model_path:
          engine === "auto-prover" ? "docs/threat-model.md" : undefined,
        token: "ghs_test",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://zeus.certora.com/api/v1/audits",
        expect.objectContaining({ method: "POST" }),
      );
      expect(
        JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string),
      ).toMatchObject({
        engine,
        branch: "b".repeat(40),
        pull_request_number: 42,
        contract_path: "src/Vault.sol",
        contract_name: "Vault",
        token: "ghs_test",
      });
    },
  );

  it("commits generated files through the authenticated job endpoint", async () => {
    const response = {
      commit_sha: "c".repeat(40),
      commit_created: true,
      files: [{ path: "certora/Vault.spec" }],
      renamed_files: [
        {
          from: "certora/Vault.spec",
          to: "certora/Vault.zeus-1.spec",
        },
      ],
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(response), { status: 200 }),
      );
    const api = new ZeusApi("https://zeus.certora.com", "zeus_live_test");

    await expect(
      api.commitGeneratedFiles("job-1", {
        pull_request_number: 42,
        token: "ghs_test",
      }),
    ).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://zeus.certora.com/api/v1/audits/job-1/generated-files/commit",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          pull_request_number: 42,
          token: "ghs_test",
        }),
      }),
    );
  });

  it.each([
    {
      status: 409,
      code: "generated_files_not_ready",
      message: "Generated files are still publishing",
    },
    {
      status: 503,
      code: "audit_backend_unavailable",
      message: "Temporary backend failure",
    },
  ])(
    "retries the idempotent generated-file commit after $code",
    async ({ status, code, message }) => {
      vi.useFakeTimers();
      const committed = {
        commit_sha: "c".repeat(40),
        commit_created: true,
        files: [{ path: "certora/Vault.spec" }],
        renamed_files: [],
      };
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: { code, message },
            }),
            { status },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(committed), { status: 200 }),
        );
      const api = new ZeusApi("https://zeus.certora.com", "zeus_live_test");

      const result = api.commitGeneratedFiles("job-1", {
        pull_request_number: 42,
        token: "ghs_test",
      });
      await vi.advanceTimersByTimeAsync(1000);

      await expect(result).resolves.toEqual(committed);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("does not retry a stale generated-file commit request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "stale_pull_request",
            message: "The pull request head changed",
          },
        }),
        { status: 409 },
      ),
    );
    const api = new ZeusApi("https://zeus.certora.com", "zeus_live_test");

    await expect(
      api.commitGeneratedFiles("job-1", {
        pull_request_number: 42,
        token: "ghs_test",
      }),
    ).rejects.toMatchObject({
      code: "stale_pull_request",
      statusCode: 409,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the cancellation state instead of claiming every request completed", async () => {
    const pending = {
      job_id: "job-1",
      status: "cancellation_pending",
      message: "Final usage and billing are being reconciled.",
      requested_at: "2026-07-27T12:00:00.000Z",
    } as const;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(pending), { status: 200 }),
    );
    const api = new ZeusApi("https://zeus.certora.com", "zeus_live_test");

    await expect(api.cancelAudit("job-1")).resolves.toEqual(pending);
  });

  it("bounds a launch request without retrying its ambiguous outcome", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_url, options) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = options?.signal;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Request timed out", "AbortError")),
            { once: true },
          );
        });
      });
    const api = new ZeusApi("https://zeus.certora.com", "zeus_live_test");

    const launch = api.createStandaloneAudit({
      engine: "auto-prover",
      target: "https://github.com/Certora/autoprover-guardian-ci",
      branch: "b".repeat(40),
      pull_request_number: 42,
      contract_path: "src/Vault.sol",
      contract_name: "Vault",
    });
    const assertion = expect(launch).rejects.toMatchObject({
      name: "ZeusApiTimeoutError",
      message: expect.stringContaining(
        "The launch outcome may be unknown; inspect the audit list before rerunning.",
      ),
    });
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not let nested retries exceed a caller's absolute deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_url, options) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = options?.signal;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Request timed out", "AbortError")),
            { once: true },
          );
        });
      });
    const api = new ZeusApi("https://zeus.certora.com", "zeus_live_test");

    const progress = api.getProgress("job-1", Date.now() + 5_000);
    const assertion =
      expect(progress).rejects.toBeInstanceOf(ZeusApiDeadlineError);
    await vi.advanceTimersByTimeAsync(5_000);

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports deadline expiry when the final retry consumes the remaining time", async () => {
    vi.useFakeTimers();
    const transientFailure = () =>
      new Response(
        JSON.stringify({
          error: {
            code: "audit_backend_error",
            message: "Temporary backend failure",
          },
        }),
        { status: 502 },
      );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(transientFailure())
      .mockResolvedValueOnce(transientFailure())
      .mockResolvedValueOnce(transientFailure())
      .mockImplementationOnce((_url, options) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = options?.signal;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Request timed out", "AbortError")),
            { once: true },
          );
        });
      });
    const api = new ZeusApi("https://zeus.certora.com", "zeus_live_test");

    const progress = api.getProgress("job-1", Date.now() + 10_000);
    const assertion =
      expect(progress).rejects.toBeInstanceOf(ZeusApiDeadlineError);
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries result_not_ready and returns the result once storage catches up", async () => {
    vi.useFakeTimers();
    const result = {
      job_id: "job-1",
      status: "succeeded",
      result: "legacy report",
      intermediate_result: null,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "result_not_ready",
              message: "Result URL not available yet",
            },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(result), { status: 200 }),
      );
    const api = new ZeusApi("https://zeus.certora.com", "zeus_live_test");

    const resultPromise = api.getResult("job-1");
    await vi.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("normalizes the API's canceled spelling before the polling loop sees it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          job_id: "job-1",
          status: "canceled",
          current_phase: "cancelled",
          completed_phases: 1,
          total_phases: 1,
          progress: 1,
          progress_percent: 100,
          billed_amount_usd: 1,
        }),
        { status: 200 },
      ),
    );
    const api = new ZeusApi("https://zeus.certora.com", "zeus_live_test");

    await expect(api.getProgress("job-1")).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it.each(["insufficient_balance", "insufficient_credits"])(
    "shows the balance guidance for %s",
    (code) => {
      const error = new ZeusApiError(code, "Balance too low", 402);

      expect(getZeusApiErrorMessage(error)).toBe(
        "Insufficient Zeus balance. Please top up at https://zeus.certora.com.",
      );
    },
  );

  it("keeps invalid-key guidance independent of the workflow secret name", () => {
    const error = new ZeusApiError("invalid_api_key", "Invalid key", 401);

    expect(getZeusApiErrorMessage(error)).toBe(
      "Invalid Zeus API key. Check the API key supplied to this action.",
    );
  });
});
