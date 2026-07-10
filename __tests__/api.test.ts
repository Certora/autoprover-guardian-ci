import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getZeusApiErrorMessage,
  ZeusApi,
  ZeusApiError,
} from "../src/api";

describe("ZeusApi", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards use_memory when creating a full audit", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
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
      target: "https://github.com/Certora/zeus-guardian-ci",
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
          { status: 502 }
        )
      );
      const api = new ZeusApi("https://zeus.certora.com", "zeus_live_test");

      const request =
        auditType === "full"
          ? api.createFullAudit({
              target: "https://github.com/Certora/zeus-guardian-ci",
              branch: "b".repeat(40),
              context: ["contracts/**/*.sol"],
            })
          : api.createDiffAudit({
              target: "https://github.com/Certora/zeus-guardian-ci",
              branch_starting: "a".repeat(40),
              branch_ending: "b".repeat(40),
              context: ["contracts/**/*.sol"],
            });

      await expect(request).rejects.toMatchObject({
        code: "audit_backend_error",
        statusCode: 502,
      } satisfies Partial<ZeusApiError>);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

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
          { status: 400 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(result), { status: 200 })
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
        { status: 200 }
      )
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
        "Insufficient Auto Prover balance. Please top up at https://zeus.certora.com."
      );
    }
  );
});
