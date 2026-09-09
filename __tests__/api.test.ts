import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIdempotencyKey,
  getAutoProverApiErrorMessage,
  AutoProverApi,
  AutoProverApiDeadlineError,
  AutoProverApiError,
} from "../src/api";
import type {
  AiAuditorFullRunRequest,
  Run,
  RunRequest,
  Workflow,
} from "../src/types";
import { workflowRunType } from "../src/types";

const body: AiAuditorFullRunRequest = {
  source: {
    repository_url: "https://github.com/Certora/contracts",
    commit_sha: "a".repeat(40),
    authentication: { type: "organization_github_app" },
  },
  context: ["contracts/**/*.sol"],
  use_memory: true,
};

const run: Run = {
  id: "11111111-1111-4111-8111-111111111111",
  run_type: "ai_auditor_full",
  status: "queued",
  source: {
    repository_url: body.source.repository_url,
    commit_sha: body.source.commit_sha,
  },
  client_reference: null,
  progress: null,
  result: { available: false },
  billing: { status: "reserved", reserved_usd: "10.0000", charged_usd: null },
  failure: null,
  delivery: null,
  cancellable: true,
  created_at: "2026-08-07T00:00:00.000Z",
  started_at: null,
  completed_at: null,
  dashboard_url: "https://app.certora.com/runs/1",
};

describe("AutoProverApi v2", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.useRealTimers());

  it("estimates through the workflow collection with Bearer authentication", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          request_id: "req-1",
          estimate: {
            estimated_cost_usd: "12.5000",
            minimum_balance_required_usd: "10.0000",
            balance_usd: "100.0000",
            can_launch: true,
          },
        }),
        { status: 200 },
      ),
    );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");

    await api.estimateRun("ai-auditor-full", body);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.certora.com/v2/ai-auditor-full-runs/estimate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(body),
        redirect: "error",
        headers: expect.objectContaining({
          Authorization: "Bearer certora_test",
        }),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      "X-API-Key",
    );
  });

  it("accepts a negative balance in an insufficient-balance estimate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          request_id: "req-1",
          estimate: {
            estimated_cost_usd: "12.5000",
            minimum_balance_required_usd: "10.0000",
            balance_usd: "-2.7500",
            can_launch: false,
          },
        }),
        { status: 200 },
      ),
    );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");

    await expect(api.estimateRun("ai-auditor-full", body)).resolves.toEqual({
      request_id: "req-1",
      estimate: {
        estimated_cost_usd: "12.5000",
        minimum_balance_required_usd: "10.0000",
        balance_usd: "-2.7500",
        can_launch: false,
      },
    });
  });

  it("rejects non-canonical USD precision", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          request_id: "req-1",
          estimate: {
            estimated_cost_usd: "12.50",
            minimum_balance_required_usd: "10.0000",
            balance_usd: "100.0000",
            can_launch: true,
          },
        }),
        { status: 200 },
      ),
    );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");

    await expect(api.estimateRun("ai-auditor-full", body)).rejects.toThrow(
      "malformed estimate",
    );
  });

  it("launches with the required stable Idempotency-Key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ request_id: "req-1", run }), {
        status: 201,
      }),
    );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");
    const key = createIdempotencyKey(
      "ai-auditor-full",
      body,
      "run-1:attempt-1",
    );

    await api.createRun("ai-auditor-full", body, key);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.certora.com/v2/ai-auditor-full-runs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Idempotency-Key": key }),
      }),
    );
    expect(
      createIdempotencyKey("ai-auditor-full", body, "run-1:attempt-1"),
    ).toBe(key);
    expect(
      createIdempotencyKey("ai-auditor-full", body, "run-1:attempt-2"),
    ).not.toBe(key);
    expect(
      createIdempotencyKey(
        "ai-auditor-full",
        { ...body, context: ["src/**/*.sol"] },
        "run-1:attempt-1",
      ),
    ).not.toBe(key);
  });

  it("forwards an AISS estimate quote without changing the launch body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ request_id: "req-1", run }), {
        status: 202,
      }),
    );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");
    const quoteId = "22222222-2222-4222-8222-222222222222";

    await api.createRun("auto-prover", body, "stable-key", quoteId);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.certora.com/v2/auto-prover-runs",
      expect.objectContaining({
        body: JSON.stringify(body),
        headers: expect.objectContaining({
          "Idempotency-Key": "stable-key",
          "Estimate-Quote-Id": quoteId,
        }),
      }),
    );
  });

  it("keeps omitted-mode idempotency stable and distinguishes explicit model modes", () => {
    const legacy = createIdempotencyKey("ai-auditor-full", body, "stable-seed");
    expect(
      createIdempotencyKey(
        "ai-auditor-full",
        { ...body, model_mode: undefined },
        "stable-seed",
      ),
    ).toBe(legacy);
    const normal = createIdempotencyKey(
      "ai-auditor-full",
      { ...body, model_mode: "normal" },
      "stable-seed",
    );
    const frontier = createIdempotencyKey(
      "ai-auditor-full",
      { ...body, model_mode: "frontier" },
      "stable-seed",
    );
    expect(frontier).not.toBe(normal);
    expect(frontier).not.toBe(legacy);
    expect(
      createIdempotencyKey(
        "ai-auditor-full",
        { ...body, model_mode: "frontier" },
        "stable-seed",
      ),
    ).toBe(frontier);
  });

  it.each([undefined, null, "normal", "frontier"])(
    "accepts optional recorded model mode %j",
    async (modelMode) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            request_id: "req-mode",
            run: { ...run, model_mode: modelMode },
          }),
          { status: 200 },
        ),
      );
      const api = new AutoProverApi("https://app.certora.com", "certora_test");

      expect((await api.getRun(run.id)).run.model_mode).toBe(modelMode);
    },
  );

  it.each(["fast", 1, {}, ""])(
    "rejects invalid recorded model mode %j",
    async (modelMode) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            request_id: "req-mode",
            run: { ...run, model_mode: modelMode },
          }),
          { status: 200 },
        ),
      );
      const api = new AutoProverApi("https://app.certora.com", "certora_test");

      await expect(api.getRun(run.id)).rejects.toThrow("malformed run");
    },
  );

  it.each<[Workflow, string]>([
    ["ai-auditor-full", "/v2/ai-auditor-full-runs"],
    ["ai-auditor-diff", "/v2/ai-auditor-diff-runs"],
    [
      "ai-auditor-finding-validation",
      "/v2/ai-auditor-finding-validations-runs",
    ],
    ["auto-prover", "/v2/auto-prover-runs"],
    ["auto-fuzzer", "/v2/auto-fuzzer-runs"],
  ])("uses the dedicated %s launch collection", async (workflow, path) => {
    const workflowRun = { ...run, run_type: workflowRunType(workflow) };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ request_id: "req-1", run: workflowRun }), {
        status: 201,
      }),
    );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");

    await api.createRun(
      workflow,
      body as RunRequest,
      `certora-guardian-${workflow}`,
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://app.certora.com${path}`);
  });

  it("safely retries an idempotent launch after a retryable failure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: "about:blank",
            title: "Unavailable",
            status: 503,
            detail: "Try again",
            code: "temporarily_unavailable",
            request_id: "req-1",
            retryable: true,
          }),
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: "req-2", run }), {
          status: 201,
        }),
      );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");
    const promise = api.createRun(
      "ai-auditor-full",
      body,
      createIdempotencyKey("ai-auditor-full", body, "run-1:attempt-1"),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toMatchObject({ run: { id: run.id } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the body, launch key, quote and redirect protection after a network failure", async () => {
    vi.useFakeTimers();
    const proverBody: RunRequest = {
      source: body.source,
      contract: { path: "contracts/Token.sol", name: "Token" },
      delivery: { type: "github_pull_request", pull_request_number: 7 },
    };
    const proverRun: Run = {
      ...run,
      run_type: "auto_prover",
      delivery: {
        type: "github_pull_request",
        pull_request_number: 7,
        status: "pending",
        outcome: null,
        commit_sha: null,
        files: [],
        renamed_files: [],
        error: null,
      },
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ request_id: "req-retry", run: proverRun }),
          { status: 202 },
        ),
      );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");
    const quoteId = "22222222-2222-4222-8222-222222222222";
    const promise = api.createRun(
      "auto-prover",
      proverBody,
      "same-launch-key",
      quoteId,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toMatchObject({ run: { id: run.id } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe("https://app.certora.com/v2/auto-prover-runs");
      expect(options).toMatchObject({
        method: "POST",
        body: JSON.stringify(proverBody),
        redirect: "error",
        headers: {
          Authorization: "Bearer certora_test",
          "Idempotency-Key": "same-launch-key",
          "Estimate-Quote-Id": quoteId,
        },
      });
    }
  });

  it.each(["2", "Wed, 09 Sep 2026 12:00:02 GMT"])(
    "honors Retry-After %s while recovering the same in-progress launch",
    async (retryAfter) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              status: 409,
              code: "idempotency_in_progress",
              detail: "This launch is still being processed.",
              retryable: true,
              request_id: "req-pending",
            }),
            {
              status: 409,
              headers: {
                "Content-Type": "application/problem+json",
                "Retry-After": retryAfter,
              },
            },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ request_id: "req-recovered", run }), {
            status: 202,
          }),
        );
      const api = new AutoProverApi("https://app.certora.com", "certora_test");
      const promise = api.createRun("ai-auditor-full", body, "same-launch-key");

      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toMatchObject({ run: { id: run.id } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
        "Idempotency-Key": "same-launch-key",
      });
    },
  );

  it("does not retry an explicit non-retryable problem even with a server-error HTTP status", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 503,
          code: "launch_rejected",
          detail: "Do not repeat this request.",
          retryable: false,
          request_id: "req-rejected",
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/problem+json" },
        },
      ),
    );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");

    await expect(
      api.createRun("ai-auditor-full", body, "same-launch-key"),
    ).rejects.toMatchObject({
      code: "launch_rejected",
      statusCode: 503,
      retryable: false,
      requestId: "req-rejected",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers an accepted launch after a timeout and more than three pending responses", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      )
      .mockImplementation(() =>
        Promise.resolve(
          Date.now() < start + 85_000
            ? new Response(
                JSON.stringify({
                  status: 409,
                  code: "idempotency_in_progress",
                  detail: "Still preparing",
                  retryable: true,
                }),
                {
                  status: 409,
                  headers: { "Retry-After": "2" },
                },
              )
            : new Response(
                JSON.stringify({ request_id: "req-recovered", run }),
                { status: 202 },
              ),
        ),
      );
    const api = new AutoProverApi(
      "https://app.certora.com",
      "certora_test",
      start + 120_000,
    );
    const pending = api.createRun("ai-auditor-full", body, "stable-launch");

    await vi.advanceTimersByTimeAsync(85_000);

    await expect(pending).resolves.toMatchObject({ run: { id: run.id } });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(4);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.body).toBe(JSON.stringify(body));
      expect(new Headers(options?.headers).get("Idempotency-Key")).toBe(
        "stable-launch",
      );
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["300", "Wed, 09 Sep 2026 12:05:00 GMT"])(
    "does not shorten a long Retry-After value %s",
    async (retryAfter) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              status: 429,
              code: "rate_limit_exceeded",
              detail: "Wait",
              retryable: true,
            }),
            {
              status: 429,
              headers: { "Retry-After": retryAfter },
            },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ request_id: "req-after-reset", run }), {
            status: 202,
          }),
        );
      const api = new AutoProverApi(
        "https://app.certora.com",
        "certora_test",
        Date.now() + 600_000,
      );
      const pending = api.createRun("ai-auditor-full", body, "stable-launch");

      await vi.advanceTimersByTimeAsync(299_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ run: { id: run.id } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("stops launch recovery exactly at the shared deadline without changing its key", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const api = new AutoProverApi(
      "https://app.certora.com",
      "certora_test",
      Date.now() + 70_000,
    );
    const pending = api
      .createRun("ai-auditor-full", body, "stable-launch")
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(70_000);

    expect(await pending).toBeInstanceOf(AutoProverApiDeadlineError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, options] of fetchMock.mock.calls) {
      expect(new Headers(options?.headers).get("Idempotency-Key")).toBe(
        "stable-launch",
      );
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails with reset guidance without an early retry when Retry-After exceeds the budget", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 429,
            code: "rate_limit_exceeded",
            detail: "Wait",
            retryable: true,
          }),
          { status: 429, headers: { "Retry-After": "3600" } },
        ),
      );
    const api = new AutoProverApi(
      "https://app.certora.com",
      "certora_test",
      Date.now() + 600_000,
    );

    await expect(
      api.createRun("ai-auditor-full", body, "stable-launch"),
    ).rejects.toThrow("retry after 3600 seconds");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds zero-delay server retries instead of spinning", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 503,
            code: "pending",
            detail: "Wait",
            retryable: true,
          }),
          {
            status: 503,
            headers: { "Retry-After": "0" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: "req-recovered", run }), {
          status: 202,
        }),
      );
    const api = new AutoProverApi(
      "https://app.certora.com",
      "certora_test",
      Date.now() + 60_000,
    );
    const pending = api.createRun("ai-auditor-full", body, "stable-launch");
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ run: { id: run.id } });
  });

  it("honors a status response Retry-After even when the ordinary retry count is exhausted", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 429,
            code: "rate_limit_exceeded",
            detail: "Wait",
            retryable: true,
          }),
          {
            status: 429,
            headers: { "Retry-After": "120" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: "req-after-reset", run }), {
          status: 200,
        }),
      );
    const api = new AutoProverApi(
      "https://app.certora.com",
      "certora_test",
      Date.now() + 300_000,
    );
    const pending = api.getRun(run.id);

    await vi.advanceTimersByTimeAsync(126_999);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ run: { id: run.id } });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("uses the shared deadline for result and generated-file requests, with an explicit cancellation grace override", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ request_id: "req-cancel", run }), {
          status: 202,
        }),
      );
    const api = new AutoProverApi(
      "https://app.certora.com",
      "certora_test",
      Date.now() - 1,
    );

    await expect(api.getResult(run.id)).rejects.toBeInstanceOf(
      AutoProverApiDeadlineError,
    );
    await expect(api.commitGeneratedFiles(run.id)).rejects.toBeInstanceOf(
      AutoProverApiDeadlineError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      api.cancelRun(run.id, Date.now() + 15_000),
    ).resolves.toMatchObject({ run: { id: run.id } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves the HTTP error and does not expose malformed upstream error bodies", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<html>private upstream diagnostics</html>", {
        status: 403,
        statusText: "Forbidden",
        headers: { "Content-Type": "text/html" },
      }),
    );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");

    await expect(api.getRun(run.id)).rejects.toMatchObject({
      code: "unknown_error",
      statusCode: 403,
      message: "HTTP 403: Forbidden",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not send credentials or make a request after the caller deadline", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const api = new AutoProverApi("https://app.certora.com", "certora_test");

    await expect(api.getRun(run.id, Date.now() - 1)).rejects.toBeInstanceOf(
      AutoProverApiDeadlineError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts an in-flight request at the caller deadline without retrying", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_url, options) => {
        requestSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      });
    const api = new AutoProverApi("https://app.certora.com", "certora_test");
    const result = api
      .getRun(run.id, Date.now() + 250)
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toBeInstanceOf(AutoProverApiDeadlineError);
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a server retry delay overrun the caller deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 429,
          code: "rate_limit_exceeded",
          detail: "Try later",
          retryable: true,
        }),
        { status: 429, headers: { "Retry-After": "30" } },
      ),
    );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");
    const result = api
      .getRun(run.id, Date.now() + 250)
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toBeInstanceOf(AutoProverApiDeadlineError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the canonical run resource and never a progress route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ request_id: "req-1", run }), {
        status: 200,
      }),
    );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");

    await api.getRun(run.id);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://app.certora.com/v2/runs/${run.id}`,
    );
  });

  it.each(["reserved", "metering", "releasing", "settled"] as const)(
    "accepts the canonical %s billing status",
    async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            request_id: "req-1",
            run: { ...run, billing: { ...run.billing, status } },
          }),
          { status: 200 },
        ),
      );
      const api = new AutoProverApi("https://app.certora.com", "certora_test");

      await expect(api.getRun(run.id)).resolves.toMatchObject({
        run: { billing: { status } },
      });
    },
  );

  it("rejects pre-v2 billing statuses at runtime", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          request_id: "req-1",
          run: { ...run, billing: { ...run.billing, status: "charged" } },
        }),
        { status: 200 },
      ),
    );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");

    await expect(api.getRun(run.id)).rejects.toThrow("malformed run");
  });

  it("decodes the exact AI Auditor public report envelope", async () => {
    const report = {
      format: "json",
      content: {
        findings: { highs: [], mediums: [], lows: [], infos: [] },
      },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          request_id: "req-1",
          result: {
            schema_version: "1",
            run_id: run.id,
            run_type: "ai_auditor_full",
            data: { report, intermediate: null },
          },
        }),
        { status: 200 },
      ),
    );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");

    await expect(api.getResult(run.id)).resolves.toMatchObject({
      result: { data: { report } },
    });
  });

  it("decodes the finding-validation result discriminator", async () => {
    const report = {
      format: "json",
      content: { final_verdict: "VALID" },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          request_id: "req-1",
          result: {
            schema_version: "1",
            run_id: run.id,
            run_type: "ai_auditor_finding_validation",
            data: { report },
          },
        }),
        { status: 200 },
      ),
    );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");

    await expect(api.getResult(run.id)).resolves.toMatchObject({
      result: { run_type: "ai_auditor_finding_validation", data: { report } },
    });
  });

  it.each(["", "not-a-run-id", "../../other-resource"])(
    "rejects a non-UUID result identity %j",
    async (runId) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            request_id: "req-result",
            result: {
              schema_version: "1",
              run_id: runId,
              run_type: "ai_auditor_finding_validation",
              data: {
                report: { format: "json", content: { final_verdict: "VALID" } },
              },
            },
          }),
          { status: 200 },
        ),
      );
      const api = new AutoProverApi("https://app.certora.com", "certora_test");

      await expect(api.getResult(run.id)).rejects.toThrow(
        "malformed run result",
      );
    },
  );

  it.each([
    {
      name: "result unavailable",
      mutate: { result: { available: false } },
      message: "succeeded run without an available result",
    },
    {
      name: "billing unsettled",
      mutate: {
        result: { available: true },
        billing: {
          status: "metering",
          reserved_usd: "10.0000",
          charged_usd: null,
        },
      },
      message: "terminal run with unsettled billing",
    },
  ])("rejects a succeeded run with $name", async ({ mutate, message }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          request_id: "req-1",
          run: {
            ...run,
            status: "succeeded",
            result: { available: true },
            billing: {
              status: "settled",
              reserved_usd: "10.0000",
              charged_usd: "1.0000",
            },
            ...mutate,
          },
        }),
        { status: 200 },
      ),
    );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");

    await expect(api.getRun(run.id)).rejects.toThrow(message);
  });

  it("sends empty POST requests for cancel and generated-file commit", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: "req-1", run }), {
          status: 202,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            request_id: "req-2",
            delivery: {
              status: "no_changes",
              commit_sha: null,
              files: [],
              renamed_files: [],
            },
          }),
          { status: 200 },
        ),
      );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");

    await api.cancelRun(run.id);
    await api.commitGeneratedFiles(run.id);

    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({ method: "POST" });
      expect(call[1]?.body).toBeUndefined();
      expect(call[1]?.headers).not.toHaveProperty("Content-Type");
    }
  });

  it.each([
    { status: "committed", commit_sha: null },
    { status: "no_changes", commit_sha: "c".repeat(40) },
  ])(
    "rejects inconsistent generated-file delivery: $status",
    async (delivery) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            request_id: "req-2",
            delivery: {
              ...delivery,
              files: [],
              renamed_files: [],
            },
          }),
          { status: 200 },
        ),
      );
      const api = new AutoProverApi("https://app.certora.com", "certora_test");

      await expect(api.commitGeneratedFiles(run.id)).rejects.toThrow(
        "inconsistent generated-file delivery",
      );
    },
  );

  it("surfaces RFC problem details and scope guidance", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: "https://app.certora.com/problems/missing-scope",
          title: "Forbidden",
          status: 403,
          detail: "runs:create is required",
          code: "missing_scope",
          request_id: "req-1",
          retryable: false,
        }),
        { status: 403 },
      ),
    );
    const api = new AutoProverApi("https://app.certora.com", "certora_test");

    const error = await api.getRun(run.id).catch((caught) => caught);
    expect(error).toBeInstanceOf(AutoProverApiError);
    expect(error).toMatchObject({
      code: "missing_scope",
      statusCode: 403,
      requestId: "req-1",
    });
    expect(getAutoProverApiErrorMessage(error as AutoProverApiError)).toContain(
      "required by this workflow",
    );
  });

  it.each([
    ["source_revision_not_found", "source.commit_sha", "pull request commit"],
    ["contract_not_found", "contract.path", "contract-path"],
  ])(
    "preserves and explains the non-retryable %s response",
    async (code, field, guidance) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: `https://app.certora.com/problems/${code}`,
            title: "Source validation failed",
            status: 422,
            detail: "The requested source input could not be resolved.",
            code,
            request_id: "req-source",
            retryable: false,
            field_errors: {
              [field]: ["The requested source input could not be resolved."],
            },
          }),
          { status: 422 },
        ),
      );
      const api = new AutoProverApi("https://app.certora.com", "certora_test");

      const error = await api
        .estimateRun("auto-prover", body)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code,
        statusCode: 422,
        retryable: false,
        requestId: "req-source",
        fieldErrors: {
          [field]: ["The requested source input could not be resolved."],
        },
      });
      expect(
        getAutoProverApiErrorMessage(error as AutoProverApiError),
      ).toContain(guidance);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});
