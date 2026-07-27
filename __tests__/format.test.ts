import { describe, expect, it } from "vitest";

import {
  formatIssueBody,
  formatIssueTitle,
  formatLegacyPrComment,
  formatPrComment,
  formatStandalonePrComment,
  getStandaloneWarnings,
  isFailingStandaloneOutcome,
} from "../src/format";
import type { AissRunReport, AuditFindings, Finding } from "../src/types";

const auditFinding: Finding = {
  id: "H-01",
  title: "Unsafe external call",
  severity: "HIGH",
  locations: ["src/Vault.sol:42"],
  description: "State is updated after the external call.",
  recommendation: "Update state before making the call.",
};

const auditFindings: AuditFindings = {
  highs: [auditFinding],
  mediums: [],
  lows: [],
  infos: [],
};

function report(overrides: Partial<AissRunReport> = {}): AissRunReport {
  return {
    contractName: "Vault",
    outcome: "verified_with_gaps",
    ruleCounts: [
      { status: "VERIFIED", count: 3 },
      { status: "TIMEOUT", count: 1 },
    ],
    groupCounts: [],
    skipped: [{}],
    gaveUpComponents: [],
    coverage: {
      totalProperties: 4,
      totalRules: 4,
      totalGroups: 2,
      propertyCoverageComplete: false,
      propertiesInNoGroup: [],
      rulesSpanningMultipleGroups: [],
      skippedCount: 1,
      gaveUpComponentCount: 0,
      droppedOrphanRules: 0,
      warnings: ["One property lacks a rule mapping."],
    },
    ...overrides,
  };
}

describe("AI Auditor formatting", () => {
  it("uses AI Auditor branding for issues and pull-request summaries", () => {
    expect(formatIssueTitle(auditFinding)).toBe(
      "[AI Auditor] HIGH: Unsafe external call (H-01)",
    );

    const issueBody = formatIssueBody(auditFinding, "job-1", 42);
    expect(issueBody).toContain("**AI Auditor Job:** `job-1`");
    expect(issueBody).toContain("created by [AI Auditor]");
    expect(issueBody).not.toContain("Auto Prover");

    const comment = formatPrComment(auditFindings, "job-1", 12.5, [], 42);
    expect(comment).toContain("AI Auditor Results");
    expect(comment).toContain("Powered by [AI Auditor]");
    expect(comment).not.toContain("Auto Prover");

    const legacy = formatLegacyPrComment("# Legacy report", "job-1", 42);
    expect(legacy).toContain("AI Auditor Results");
    expect(legacy).toContain("Powered by [AI Auditor]");
    expect(legacy).not.toContain("Auto Prover");
  });
});

describe("standalone engine formatting", () => {
  it("summarizes rule results, coverage, generated files, and collisions", () => {
    const comment = formatStandalonePrComment({
      engine: "auto-prover",
      jobId: "job-1",
      cost: 42.5,
      reportState: "ready",
      report: report(),
      commit: {
        commit_sha: "c".repeat(40),
        commit_created: true,
        files: [
          { path: "certora/Vault.spec" },
          { path: "certora/conf/Vault.conf" },
        ],
        renamed_files: [
          {
            from: "certora/Vault.spec",
            to: "certora/Vault.zeus-1.spec",
          },
        ],
      },
    });

    expect(comment).toContain("AutoProver Results — Verified with gaps");
    expect(comment).toContain("| VERIFIED | 3 |");
    expect(comment).toContain("| TIMEOUT | 1 |");
    expect(comment).toContain("1 property was skipped.");
    expect(comment).toContain("`certora/Vault.spec`");
    expect(comment).toContain(
      "`certora/Vault.spec` → `certora/Vault.zeus-1.spec`",
    );
    expect(comment).toContain("$42.50");
  });

  it("warns for partial, gap, skipped, and unknown results", () => {
    expect(
      getStandaloneWarnings(
        "ready",
        report({ outcome: "partial", skipped: [] }),
      ),
    ).toContain("The run completed with partial verification coverage.");
    expect(
      getStandaloneWarnings("ready", report({ outcome: "verified_with_gaps" })),
    ).toContain("The run verified its executed rules but has coverage gaps.");
    expect(
      getStandaloneWarnings(
        "ready",
        report({ outcome: "verified_with_gaps" }),
        "auto-foundry",
      ),
    ).toEqual(
      expect.arrayContaining([
        "The executed Foundry tests passed, but test coverage has gaps.",
        "1 test objective was skipped.",
        "One test objective lacks a test mapping.",
      ]),
    );
    expect(
      getStandaloneWarnings(
        "unavailable",
        report({ outcome: "unknown", skipped: [] }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "The structured report state is unavailable.",
        "The run outcome could not be determined.",
      ]),
    );
  });

  it("fails only the issues_found report outcome", () => {
    expect(isFailingStandaloneOutcome("issues_found")).toBe(true);
    expect(isFailingStandaloneOutcome("verified")).toBe(false);
    expect(isFailingStandaloneOutcome("verified_with_gaps")).toBe(false);
    expect(isFailingStandaloneOutcome("partial")).toBe(false);
    expect(isFailingStandaloneOutcome("unknown")).toBe(false);
  });

  it("describes structured AutoFoundry output as generated tests", () => {
    const comment = formatStandalonePrComment({
      engine: "auto-foundry",
      jobId: "job-2",
      cost: 8.75,
      reportState: "ready",
      report: report(),
      commit: {
        commit_sha: "d".repeat(40),
        commit_created: true,
        files: [{ path: "test/generated/Vault.t.sol" }],
        renamed_files: [],
      },
    });

    expect(comment).toContain("AutoFoundry Results — Tests passed with gaps");
    expect(comment).toContain("| Test objectives | 4 |");
    expect(comment).toContain("| Generated tests | 4 |");
    expect(comment).toContain("### Test results");
    expect(comment).toContain("| PASSED | 3 |");
    expect(comment).toContain("### Test coverage warnings");
    expect(comment).toContain("1 test objective was skipped.");
    expect(comment).not.toMatch(
      /\b(?:properties|property|rules|rule|verification|verified)\b/i,
    );
  });

  it("formats AutoFoundry and a missing report without throwing", () => {
    const comment = formatStandalonePrComment({
      engine: "auto-foundry",
      jobId: "job-2",
      cost: 0,
      reportState: "not_published",
      report: null,
      commit: {
        commit_sha: "d".repeat(40),
        commit_created: false,
        files: [],
        renamed_files: [],
      },
    });

    expect(comment).toContain("AutoFoundry Results — Unknown");
    expect(comment).toContain(
      "No structured Foundry test report was available.",
    );
    expect(comment).toContain("| Test objectives | Unavailable |");
    expect(comment).toContain("| Generated tests | Unavailable |");
    expect(comment).toContain("Not needed (head unchanged)");
    expect(comment).toContain("**Generated commit:** None");
  });
});
