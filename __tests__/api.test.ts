import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIdempotencyKey,
  getAutoProverApiErrorMessage,
  AutoProverApi,
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

  it.each<[Workflow, string]>([
    ["ai-auditor-full", "/v2/ai-auditor-full-runs"],
    ["ai-auditor-diff", "/v2/ai-auditor-diff-runs"],
    [
      "ai-auditor-finding-validation",
      "/v2/ai-auditor-finding-validations-runs",
    ],
    ["auto-prover", "/v2/auto-prover-runs"],
    ["auto-foundry", "/v2/auto-foundry-runs"],
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

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://app.certora.com${path}`,
    );
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
      expect(getAutoProverApiErrorMessage(error as AutoProverApiError)).toContain(guidance);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});
