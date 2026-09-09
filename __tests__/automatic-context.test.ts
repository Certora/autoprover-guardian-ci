import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { inputs, githubContext, info, setFailed, setOutput } = vi.hoisted(() => ({
  inputs: new Map<string, string>(),
  githubContext: {
    payload: {
      repository: { private: false },
      pull_request: {
        base: { sha: "a".repeat(40) },
        head: { sha: "b".repeat(40) },
        number: 42,
      },
    },
    repo: { owner: "example", repo: "mixed-language-app" },
    runId: 123,
    runAttempt: 1,
    job: "security",
  },
  info: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getInput: (name: string, options?: { required?: boolean }) => {
    const value = inputs.get(name) ?? "";
    if (options?.required && !value) throw new Error(`${name} is required`);
    return value;
  },
  setSecret: vi.fn(),
  warning: vi.fn(),
  info,
  setFailed,
  setOutput,
}));
vi.mock("@actions/github", () => ({ context: githubContext }));
vi.mock("../src/github", () => ({
  GitHubClient: vi.fn(function GitHubClient() {
    return {};
  }),
}));

// Keep config parsing, request building, idempotency, HTTP retries, response
// validation, and polling real. Only the external HTTP/GitHub boundaries are fake.
import { AutoProverApiError } from "../src/api";
import { run } from "../src/run";
import type { Run } from "../src/types";
import { workflowRunType } from "../src/types";

const WORKFLOWS = [
  "ai-auditor-full",
  "ai-auditor-diff",
  "ai-auditor-finding-validation",
] as const;
type AuditorWorkflow = (typeof WORKFLOWS)[number];
const API_URL = "https://certora.example.test";
const REPOSITORY_URL = "https://github.com/example/mixed-language-app";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const RETRY_RUN_ID = "22222222-2222-4222-8222-222222222222";
const QUOTE_ID = "33333333-3333-4333-8333-333333333333";
const FINDING = "src/api.py trusts an unvalidated tenant identifier.";
const SCOPE = ["src/api.py", "web/[tenant]/route.ts", "!src/tests/**"];
const CONTEXT = [
  "src/**/*.py",
  "web/[tenant]/route.ts",
  "lib/**/*.rs",
  "!src/tests/**",
  "pyproject.toml",
];
const fetchMock = vi.fn<typeof fetch>();

function collection(workflow: AuditorWorkflow): string {
  return workflow === "ai-auditor-finding-validation"
    ? `${API_URL}/v2/ai-auditor-finding-validations-runs`
    : `${API_URL}/v2/${workflow}-runs`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function runResponse(
  workflow: AuditorWorkflow,
  status: Run["status"] = "succeeded",
  overrides: Partial<Run> = {},
): Response {
  const resource: Run = {
    id: RUN_ID,
    run_type: workflowRunType(workflow),
    model_mode: "frontier",
    status,
    source: workflow === "ai-auditor-diff"
      ? {
          repository_url: REPOSITORY_URL,
          base_commit_sha: "a".repeat(40),
          head_commit_sha: "b".repeat(40),
        }
      : { repository_url: REPOSITORY_URL, commit_sha: "b".repeat(40) },
    client_reference: `certora-guardian:pr-42:${"b".repeat(40)}:${workflow}`,
    progress: status === "running"
      ? { phase: "_11_context_split", percent: null, completed_steps: 0, total_steps: null }
      : null,
    result: { available: status === "succeeded" },
    billing: {
      status: status === "queued" ? "reserved" : "settled",
      reserved_usd: "42.1250",
      charged_usd: status === "succeeded" ? "7.7500" : null,
    },
    failure: status === "failed"
      ? { code: "context_selection_failed", detail: "Context selection failed", retryable: false }
      : null,
    delivery: null,
    cancellable: status === "queued" || status === "running",
    created_at: "2026-09-09T00:00:00.000Z",
    started_at: null,
    completed_at: status === "succeeded" ? "2026-09-09T00:01:00.000Z" : null,
    dashboard_url: `${API_URL}/runs/${RUN_ID}`,
    ...overrides,
  };
  return json({ request_id: "req-run", run: resource }, 202);
}

function resultResponse(workflow: AuditorWorkflow, runId = RUN_ID): Response {
  const content = workflow === "ai-auditor-finding-validation"
    ? {
        final_verdict: "INVALID",
        final_severity: null,
        consensus_method: "unanimous_invalid",
        analysis_status: "completed",
        claude_verdict: null,
        gpt_verdict: null,
        tiebreaker_verdict: null,
      }
    : { findings: { highs: [], mediums: [], lows: [], infos: [] } };
  return json({
    request_id: "req-result",
    result: {
      schema_version: "1",
      run_id: runId,
      run_type: workflowRunType(workflow),
      data: { report: { format: "json", content } },
    },
  });
}

function estimateResponse(canLaunch = true): Response {
  return json({
    request_id: "req-estimate",
    estimate: {
      estimated_cost_usd: "8.0000",
      minimum_balance_required_usd: "10.0000",
      balance_usd: canLaunch ? "100.0000" : "1.0000",
      can_launch: canLaunch,
      estimate_quote_id: QUOTE_ID,
    },
  });
}

function expectedBody(workflow: AuditorWorkflow, context: string[] = []) {
  const source = {
    repository_url: REPOSITORY_URL,
    authentication: {
      type: githubContext.payload.repository.private ? "organization_github_app" : "public",
    },
  };
  return {
    source: workflow === "ai-auditor-diff"
      ? { ...source, base_commit_sha: "a".repeat(40), head_commit_sha: "b".repeat(40) }
      : { ...source, commit_sha: "b".repeat(40) },
    context,
    model_mode: "frontier",
    skip_submodules: inputs.get("skip-submodules") === "true",
    client_reference: `certora-guardian:pr-42:${"b".repeat(40)}:${workflow}`,
    ...(workflow === "ai-auditor-finding-validation"
      ? { finding: FINDING }
      : { instructions: "Check tenant isolation.", max_iterations: 8 }),
    ...(workflow === "ai-auditor-full" ? { scope: SCOPE, use_memory: false } : {}),
  };
}

function launchCalls(workflow: AuditorWorkflow) {
  return fetchMock.mock.calls.filter(([url]) => url === collection(workflow));
}

function assertAutomaticLaunch(workflow: AuditorWorkflow, count = 1): void {
  const calls = launchCalls(workflow);
  expect(calls).toHaveLength(count);
  for (const [, options] of calls) {
    expect(options?.method).toBe("POST");
    expect(JSON.parse(String(options?.body))).toEqual(expectedBody(workflow));
    const headers = new Headers(options?.headers);
    expect(headers.get("Authorization")).toBe("Bearer certora_hermetic_test");
    expect(headers.get("Idempotency-Key")).toMatch(/^certora-guardian-[a-f0-9]{64}$/);
    expect(headers.has("Estimate-Quote-Id")).toBe(false);
    expect(JSON.stringify(options)).not.toContain("ghs_local_test_only");
  }
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/estimate"))).toBe(false);
}

describe("automatic context through the real Guardian request pipeline", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockRejectedValue(new Error("Unexpected HTTP request in hermetic test"));
    githubContext.runAttempt = 1;
    githubContext.payload.repository.private = false;
    inputs.clear();
    for (const [key, value] of Object.entries({
      "api-key": "certora_hermetic_test",
      "github-token": "ghs_local_test_only",
      "api-base-url": API_URL,
      "model-mode": "frontier",
      "max-iterations": "8",
      "comment-on-pr": "false",
      "create-issues": "false",
      "poll-interval": "1",
      timeout: "1",
      "use-memory": "false",
      scope: SCOPE.join(", "),
      instructions: "Check tenant isolation.",
      finding: FINDING,
    })) inputs.set(key, value);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe.each(WORKFLOWS)("%s", (workflow) => {
    beforeEach(() => inputs.set("workflow", workflow));

    it.each([false, true])("polls server-selected context without local file inference (private=%s)", async (isPrivate) => {
      githubContext.payload.repository.private = isPrivate;
      inputs.set("skip-submodules", String(isPrivate));
      fetchMock
        .mockResolvedValueOnce(runResponse(workflow, "queued"))
        .mockResolvedValueOnce(runResponse(workflow, "running"))
        .mockResolvedValueOnce(runResponse(workflow))
        .mockResolvedValueOnce(resultResponse(workflow));

      const pending = run();
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;

      assertAutomaticLaunch(workflow);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        collection(workflow),
        `${API_URL}/v2/runs/${RUN_ID}`,
        `${API_URL}/v2/runs/${RUN_ID}`,
        `${API_URL}/v2/runs/${RUN_ID}/result`,
      ]);
      expect(info).toHaveBeenCalledWith("Reserved balance: $42.1250.");
      expect(info).toHaveBeenCalledWith("Status: running | Phase: _11_context_split");
      expect(setOutput).toHaveBeenCalledWith("status", "succeeded");
      expect(setFailed).not.toHaveBeenCalled();
    });

    it.each(["", "  \n ", ", ,,"])("sends blank input %j as an empty array, not an inferred scope", async (context) => {
      inputs.set("context", context);
      fetchMock
        .mockResolvedValueOnce(runResponse(workflow))
        .mockResolvedValueOnce(resultResponse(workflow));

      await run();

      assertAutomaticLaunch(workflow);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each(["network", "503"])("retries a %s launch failure with identical bytes and idempotency key", async (failure) => {
      if (failure === "network") {
        fetchMock.mockRejectedValueOnce(new TypeError("Connection closed after submitting request"));
      } else {
        fetchMock.mockResolvedValueOnce(json({
          code: "temporarily_unavailable", detail: "Please retry", status: 503, retryable: true,
        }, 503));
      }
      fetchMock
        .mockResolvedValueOnce(runResponse(workflow))
        .mockResolvedValueOnce(resultResponse(workflow));

      const pending = run();
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;

      assertAutomaticLaunch(workflow, 2);
      const [first, second] = launchCalls(workflow);
      expect(second?.[1]?.body).toBe(first?.[1]?.body);
      expect(second?.[1]?.headers).toEqual(first?.[1]?.headers);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it.each([
      [402, "insufficient_balance"],
      [403, "source_access_denied"],
      [422, "invalid_context_scope"],
    ] as const)("preserves nonretryable %i %s without preview or manual fallback", async (status, code) => {
      fetchMock.mockResolvedValueOnce(json({
        code, detail: "Launch refused before reservation", status,
        retryable: false, request_id: "req-rejected",
      }, status));

      const error = await run().catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(AutoProverApiError);
      expect(error).toMatchObject({ code, statusCode: status, retryable: false, requestId: "req-rejected" });
      assertAutomaticLaunch(workflow);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(setOutput).not.toHaveBeenCalledWith("run-id", RUN_ID);
    });

    it.each(["failed", "cancelled"] as const)("retries a recovered %s run once without changing its automatic request", async (status) => {
      githubContext.runAttempt = 2;
      fetchMock
        .mockResolvedValueOnce(runResponse(workflow, status))
        .mockResolvedValueOnce(runResponse(workflow, "succeeded", { id: RETRY_RUN_ID }))
        .mockResolvedValueOnce(resultResponse(workflow, RETRY_RUN_ID));

      await run();

      assertAutomaticLaunch(workflow, 2);
      const [first, second] = launchCalls(workflow);
      expect(second?.[1]?.body).toBe(first?.[1]?.body);
      const firstKey = new Headers(first?.[1]?.headers).get("Idempotency-Key");
      const retryKey = new Headers(second?.[1]?.headers).get("Idempotency-Key");
      expect(retryKey).not.toBe(firstKey);
      expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${API_URL}/v2/runs/${RETRY_RUN_ID}/result`);
      expect(setFailed).not.toHaveBeenCalled();
    });

    it("does not relaunch a recovered active job when its context selection fails", async () => {
      githubContext.runAttempt = 2;
      fetchMock
        .mockResolvedValueOnce(runResponse(workflow, "running"))
        .mockResolvedValueOnce(runResponse(workflow, "failed"));

      const pending = run();
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;

      assertAutomaticLaunch(workflow);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(setFailed).toHaveBeenCalledWith("Certora run failed: Context selection failed");
    });

    it("preserves manual mixed-language patterns and quote binding byte-for-byte", async () => {
      inputs.set("context", CONTEXT.join(", "));
      fetchMock
        .mockResolvedValueOnce(estimateResponse())
        .mockResolvedValueOnce(runResponse(workflow))
        .mockResolvedValueOnce(resultResponse(workflow));

      await run();

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `${collection(workflow)}/estimate`, collection(workflow), `${API_URL}/v2/runs/${RUN_ID}/result`,
      ]);
      const estimateOptions = fetchMock.mock.calls[0]?.[1];
      const launchOptions = fetchMock.mock.calls[1]?.[1];
      expect(JSON.parse(String(launchOptions?.body))).toEqual(expectedBody(workflow, CONTEXT));
      expect(launchOptions?.body).toBe(estimateOptions?.body);
      expect(new Headers(launchOptions?.headers).get("Estimate-Quote-Id")).toBe(QUOTE_ID);
    });

    it("still blocks a manual override before launch when its estimate exceeds balance", async () => {
      inputs.set("context", CONTEXT.join(","));
      fetchMock.mockResolvedValueOnce(estimateResponse(false));

      await expect(run()).rejects.toThrow("minimum required $10.0000");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${collection(workflow)}/estimate`);
      expect(launchCalls(workflow)).toHaveLength(0);
    });

    it("rejects a returned run for another commit without polling or fallback", async () => {
      fetchMock.mockResolvedValueOnce(runResponse(workflow, "queued", {
        source: workflow === "ai-auditor-diff"
          ? { repository_url: REPOSITORY_URL, base_commit_sha: "a".repeat(40), head_commit_sha: "c".repeat(40) }
          : { repository_url: REPOSITORY_URL, commit_sha: "c".repeat(40) },
      }));

      await expect(run()).rejects.toThrow("different source");

      assertAutomaticLaunch(workflow);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("cancels the canonical job on timeout while context selection is running", async () => {
      inputs.set("poll-interval", "60");
      fetchMock
        .mockResolvedValueOnce(runResponse(workflow, "running"))
        .mockResolvedValueOnce(runResponse(workflow, "cancelled"));

      const pending = run();
      await vi.advanceTimersByTimeAsync(60_000);
      await pending;

      assertAutomaticLaunch(workflow);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]?.[0]).toBe(`${API_URL}/v2/runs/${RUN_ID}/cancel`);
      expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
      expect(fetchMock.mock.calls[1]?.[1]?.body).toBeUndefined();
      expect(setFailed).toHaveBeenCalledWith("Certora run was cancelled.");
    });
  });
});
