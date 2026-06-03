import { beforeEach, describe, expect, it, vi } from "vitest";

import { ZeusApi } from "../src/api";

describe("ZeusApi", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
});
