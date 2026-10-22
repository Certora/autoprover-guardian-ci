import { describe, expect, it } from "vitest";
import { formatProgressPhase, formatRunFailure } from "../src/automatic-context";

describe("AutoContext phase and legacy failure formatting", () => {
  it.each(["planning_context", "_11_context_preparation"])("labels %s", (phase) => {
    expect(formatProgressPhase(phase)).toBe("Planning context");
  });
  it("keeps existing unrelated phases and failure messages", () => {
    expect(formatProgressPhase("prove")).toBe("prove");
    expect(formatRunFailure(null)).toBe("Unknown error");
    expect(formatRunFailure({ code: "provider_failed", detail: "Original failure" })).toBe("Original failure");
  });
});
