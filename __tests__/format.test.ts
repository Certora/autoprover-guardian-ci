import { describe, expect, it } from "vitest";
import {
  formatAiAuditorMarkdownPrComment,
  formatFindingValidationPrComment,
  formatIssueBody,
  formatIssueTitle,
  formatPrComment,
  formatStandalonePrComment,
  getStandaloneWarnings,
  isFailingStandaloneOutcome,
} from "../src/format";
import type { AissRunReport, Finding } from "../src/types";
import { prCommentMarker } from "../src/constants";

const finding: Finding = {
  id: "H-01",
  title: "Unsafe external call",
  severity: "HIGH",
  locations: ["src/Vault.sol:42"],
  description: "An external call occurs before state is updated.",
  recommendation: "Apply checks-effects-interactions.",
};

const report: AissRunReport = {
  schema_version: "1",
  backend: "prover",
  contract_name: "Vault",
  outcome: "verified_with_gaps",
  rule_counts: [{ status: "VERIFIED", count: 2 }],
  skipped: [{}],
  gave_up_components: [],
  coverage: {
    total_properties: 3,
    total_rules: 2,
    total_groups: 1,
    property_coverage_complete: false,
    properties_in_no_group: [],
    rules_spanning_multiple_groups: [],
    skipped_count: 1,
    gave_up_component_count: 0,
    dropped_orphan_rules: 0,
    warnings: ["One property was skipped."],
  },
};

const commit = {
  request_id: "req-1",
  delivery: {
    status: "committed" as const,
    commit_sha: "c".repeat(40),
    files: [{ path: "certora/Vault.spec" }],
    renamed_files: [{ from: "certora.conf", to: "certora.generated.conf" }],
  },
};

describe("AI Auditor formatting", () => {
  it("keeps the legacy Normal marker and separates Frontier comments", () => {
    expect(prCommentMarker("ai-auditor-diff", "normal")).toBe(
      prCommentMarker("ai-auditor-diff"),
    );
    expect(prCommentMarker("ai-auditor-diff", "frontier")).toBe(
      "<!-- certora-guardian-ci:ai-auditor-diff:frontier -->",
    );
    expect(prCommentMarker("ai-auditor-finding-validation", "frontier")).toBe(
      "<!-- certora-guardian-ci:ai-auditor-finding-validation:frontier -->",
    );
  });

  it.each(["normal", "frontier"] as const)(
    "shows %s in all audit summary formats",
    (modelMode) => {
      const modeLabel = modelMode === "frontier" ? "Frontier" : "Normal";
      const comments = [
        formatPrComment(
          { highs: [finding], mediums: [], lows: [], infos: [] },
          "run-1",
          1,
          [],
          42,
          "ai-auditor-diff",
          modelMode,
        ),
        formatPrComment(
          { highs: [], mediums: [], lows: [], infos: [] },
          "run-1",
          1,
          [],
          42,
          "ai-auditor-full",
          modelMode,
        ),
        formatAiAuditorMarkdownPrComment({
          workflow: "ai-auditor-diff",
          runId: "run-1",
          cost: 1,
          content: "# Findings",
          modelMode,
        }),
        formatFindingValidationPrComment({
          runId: "run-1",
          cost: 1,
          report: { format: "markdown", content: "Valid finding" },
          parsed: null,
          modelMode,
        }),
      ];
      for (const comment of comments) {
        expect(comment).toContain(`**Model mode:** ${modeLabel}`);
        expect(comment.split("\n")[0]).toContain(
          modelMode === "frontier" ? ":frontier -->" : " -->",
        );
      }
    },
  );

  it("does not relabel an unrecorded historical mode as Normal", () => {
    const body = formatAiAuditorMarkdownPrComment({
      workflow: "ai-auditor-diff",
      runId: "old-run",
      cost: 1,
      content: "# Findings",
      modelMode: null,
    });
    expect(body).toContain("**Model mode:** Not recorded (legacy run)");
    expect(body).not.toContain("**Model mode:** Normal");
  });

  it("uses run terminology for issues and pull-request summaries", () => {
    expect(formatIssueTitle(finding)).toContain("[AI Auditor] HIGH");
    expect(formatIssueBody(finding, "run-1", 42)).toContain(
      "**AI Auditor Run:** `run-1`",
    );
    expect(
      formatPrComment(
        { highs: [finding], mediums: [], lows: [], infos: [] },
        "run-1",
        12.5,
        [],
        42,
        "ai-auditor-diff",
      ),
    ).toContain("**Run:** `run-1`");
  });

  it("bounds issue titles while preserving the finding ID used for deduplication", () => {
    const title = formatIssueTitle({ ...finding, title: "X".repeat(1_000) });
    expect(title.length).toBeLessThanOrEqual(240);
    expect(title).toContain("(H-01)");
  });

  it("renders public Markdown reports and bounds comment size", () => {
    const body = formatAiAuditorMarkdownPrComment({
      runId: "run-1",
      cost: 1.25,
      workflow: "ai-auditor-diff",
      content: "🔐".repeat(40_000),
    });
    expect(body).toContain("<!-- certora-guardian-ci:ai-auditor-diff -->");
    expect(body).toContain("https://app.certora.com");
    expect(body).toContain("Output truncated");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(60_000);
  });

  it.each([0, 1, 2, 3])(
    "does not split Unicode code points at truncation byte alignment %i",
    (padding) => {
      const body = formatAiAuditorMarkdownPrComment({
        runId: "run-1",
        cost: 1.25,
        workflow: "ai-auditor-diff",
        content: `${"a".repeat(padding)}${"🔐".repeat(20_000)}`,
      });

      expect(Buffer.from(body, "utf8").toString("utf8")).toBe(body);
      expect(body).toContain("Output truncated");
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(60_000);
    },
  );

  it("renders a structured finding-validation verdict", () => {
    const body = formatFindingValidationPrComment({
      runId: "run-1",
      cost: 0.5,
      report: { format: "json", content: {} },
      parsed: {
        final_verdict: "INVALID",
        final_severity: null,
        severity_reasoning: "",
        impact: "",
        likelihood: "",
        false_positive_reasoning: "The guard is updated before the call.",
        consensus_method: "unanimous_invalid",
        analysis_status: "completed",
        claude_verdict: null,
        gpt_verdict: null,
        tiebreaker_verdict: null,
      },
    });
    expect(body).toContain("Likely false positive");
    expect(body).toContain("The guard is updated before the call.");
    expect(body).toContain("https://app.certora.com");
  });
});

describe("standalone workflow formatting", () => {
  it("summarizes normalized v2 reports and generated delivery", () => {
    const body = formatStandalonePrComment({
      workflow: "auto-prover",
      runId: "run-1",
      cost: 12.5,
      report,
      commit,
    });
    expect(body).toContain("AutoProver Results — Verified with gaps");
    expect(body).toContain("`Vault`");
    expect(body).toContain("certora/Vault.spec");
    expect(body).toContain("certora.generated.conf");
    expect(body).toContain("**Run:** `run-1`");
  });

  it("translates report vocabulary for AutoFuzzer", () => {
    const body = formatStandalonePrComment({
      workflow: "auto-fuzzer",
      runId: "run-1",
      cost: 1,
      report: { ...report, outcome: "issues_found" },
      commit: {
        request_id: "req-2",
        delivery: {
          status: "no_changes",
          commit_sha: null,
          files: [],
          renamed_files: [],
        },
      },
    });
    expect(body).toContain("AutoFuzzer Results — Test failures found");
    expect(body).toContain("Test objectives");
    expect(body).toContain("Not needed (head unchanged)");
  });

  it("reports coverage gaps and fails only issues_found", () => {
    expect(getStandaloneWarnings(report, "auto-prover")).toEqual(
      expect.arrayContaining([
        "The run verified its executed rules but has coverage gaps.",
        "1 property was skipped.",
        "Property coverage is incomplete.",
      ]),
    );
    expect(isFailingStandaloneOutcome("issues_found")).toBe(true);
    expect(isFailingStandaloneOutcome("partial")).toBe(false);
    expect(isFailingStandaloneOutcome("unknown")).toBe(false);
  });
});
