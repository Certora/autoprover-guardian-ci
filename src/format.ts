import type {
  AissRunReport,
  AissRunOutcome,
  AuditFindings,
  CommitGeneratedFilesResponse,
  Engine,
  Finding,
  Severity,
} from "./types";
import { PR_COMMENT_MARKER, SEVERITY_EMOJI } from "./constants";

export function formatIssueTitle(finding: Finding): string {
  return `[AI Auditor] ${finding.severity}: ${finding.title} (${finding.id})`;
}

export function formatIssueBody(
  finding: Finding,
  jobId: string,
  prNumber: number,
): string {
  const locations =
    finding.locations.length > 0
      ? finding.locations.map((l) => `\`${l}\``).join(", ")
      : "_No specific location_";

  return `## ${finding.severity} ${finding.id}: ${finding.title}

**Severity:** ${finding.severity}
**Locations:** ${locations}
**Detected in:** PR #${prNumber}
**AI Auditor Job:** \`${jobId}\`

### Description

${finding.description}

### Recommendation

${finding.recommendation}

---
_This issue was automatically created by [AI Auditor](https://zeus.certora.com). To dismiss, close this issue._`;
}

export function formatPrComment(
  findings: AuditFindings,
  jobId: string,
  cost: number,
  issueLinks: { finding: Finding; url: string }[],
  prNumber: number,
): string {
  const counts = {
    HIGH: findings.highs.length,
    MEDIUM: findings.mediums.length,
    LOW: findings.lows.length,
    INFO: findings.infos.length,
  };

  const totalFindings = Object.values(counts).reduce((a, b) => a + b, 0);

  let body: string;

  if (totalFindings === 0) {
    body = `${PR_COMMENT_MARKER}
## \u2705 AI Auditor Results — No Findings

No security issues were detected in this PR.

**Job:** \`${jobId}\` | **Cost:** $${cost.toFixed(2)}
`;
  } else {
    body = `${PR_COMMENT_MARKER}
## ${SEVERITY_EMOJI.HIGH} AI Auditor Results

| Severity | Count |
|----------|-------|
| ${SEVERITY_EMOJI.HIGH} HIGH | ${counts.HIGH} |
| ${SEVERITY_EMOJI.MEDIUM} MEDIUM | ${counts.MEDIUM} |
| ${SEVERITY_EMOJI.LOW} LOW | ${counts.LOW} |
| ${SEVERITY_EMOJI.INFO} INFO | ${counts.INFO} |
| **Total** | **${totalFindings}** |

**Job:** \`${jobId}\` | **Cost:** $${cost.toFixed(2)}
`;
  }

  if (issueLinks.length > 0) {
    body += `\n### Issues Created\n`;
    for (const { finding, url } of issueLinks) {
      body += `- ${url} — [${finding.id}] ${finding.title}\n`;
    }
  }

  const lowInfoFindings = [...findings.lows, ...findings.infos];
  if (lowInfoFindings.length > 0) {
    body += `\n<details>\n<summary>Low & Info Findings (${lowInfoFindings.length})</summary>\n\n`;
    for (const finding of lowInfoFindings) {
      body += `#### ${SEVERITY_EMOJI[finding.severity as Severity]} [${finding.id}] ${finding.title}\n`;
      body += `**Locations:** ${finding.locations.map((l) => `\`${l}\``).join(", ") || "_N/A_"}\n\n`;
      body += `${finding.description}\n\n`;
      if (finding.recommendation) {
        body += `**Recommendation:** ${finding.recommendation}\n\n`;
      }
      body += `---\n\n`;
    }
    body += `</details>\n`;
  }

  body += `\n---\n_Powered by [AI Auditor](https://zeus.certora.com)_\n`;

  return body;
}

export function formatLegacyPrComment(
  markdownResult: string,
  jobId: string,
  prNumber: number,
): string {
  return `${PR_COMMENT_MARKER}
## ${SEVERITY_EMOJI.HIGH} AI Auditor Results

**Job:** \`${jobId}\` | **PR:** #${prNumber}

> **Note:** This audit returned a legacy markdown report. Structured findings are not available.

<details>
<summary>Full Report</summary>

${markdownResult}

</details>

---
_Powered by [AI Auditor](https://zeus.certora.com)_
`;
}

function engineDisplayName(engine: Exclude<Engine, "ai-auditor">): string {
  return engine === "auto-prover" ? "AutoProver" : "AutoFoundry";
}

function outcomeLabel(
  outcome: AissRunOutcome,
  engine: Exclude<Engine, "ai-auditor">,
): string {
  if (engine === "auto-foundry") {
    if (outcome === "verified") return "Tests passed";
    if (outcome === "verified_with_gaps") return "Tests passed with gaps";
    if (outcome === "issues_found") return "Test failures found";
    if (outcome === "partial") return "Partial test run";
    return "Unknown";
  }
  if (outcome === "verified") return "Verified";
  if (outcome === "verified_with_gaps") return "Verified with gaps";
  if (outcome === "issues_found") return "Issues found";
  if (outcome === "partial") return "Partial";
  return "Unknown";
}

function autoFoundryStatusLabel(status: string): string {
  const normalized = status.trim().toUpperCase();
  if (["GOOD", "VERIFIED", "PASS", "PASSED", "SUCCESS"].includes(normalized)) {
    return "PASSED";
  }
  if (["BAD", "VIOLATED", "FAIL", "FAILED", "FAILURE"].includes(normalized)) {
    return "FAILED";
  }
  return status;
}

export function isFailingStandaloneOutcome(outcome: AissRunOutcome): boolean {
  return outcome === "issues_found";
}

export function getStandaloneWarnings(
  reportState: string,
  report: AissRunReport | null,
  engine: Exclude<Engine, "ai-auditor"> = "auto-prover",
): string[] {
  const isFoundry = engine === "auto-foundry";
  const warnings: string[] = [];
  if (reportState !== "ready") {
    warnings.push(`The structured report state is ${reportState}.`);
  }
  if (!report) {
    warnings.push(
      isFoundry
        ? "No structured Foundry test report was available."
        : "No structured property report was available.",
    );
    return warnings;
  }

  if (report.outcome === "partial") {
    warnings.push(
      isFoundry
        ? "The run completed with partial Foundry test coverage."
        : "The run completed with partial verification coverage.",
    );
  } else if (report.outcome === "verified_with_gaps") {
    warnings.push(
      isFoundry
        ? "The executed Foundry tests passed, but test coverage has gaps."
        : "The run verified its executed rules but has coverage gaps.",
    );
  } else if (report.outcome === "unknown") {
    warnings.push("The run outcome could not be determined.");
  }

  const skipped = Math.max(report.skipped.length, report.coverage.skippedCount);
  if (skipped > 0) {
    warnings.push(
      isFoundry
        ? `${skipped} ${skipped === 1 ? "test objective was" : "test objectives were"} skipped.`
        : `${skipped} ${skipped === 1 ? "property was" : "properties were"} skipped.`,
    );
  }
  if (!report.coverage.propertyCoverageComplete) {
    warnings.push(
      isFoundry
        ? "Foundry test coverage is incomplete."
        : "Property coverage is incomplete.",
    );
  }
  if (report.coverage.gaveUpComponentCount > 0) {
    warnings.push(
      isFoundry
        ? `${report.coverage.gaveUpComponentCount} component test-generation ${report.coverage.gaveUpComponentCount === 1 ? "attempt was" : "attempts were"} abandoned.`
        : `${report.coverage.gaveUpComponentCount} component verification ${report.coverage.gaveUpComponentCount === 1 ? "attempt was" : "attempts were"} abandoned.`,
    );
  }
  if (report.coverage.droppedOrphanRules > 0) {
    warnings.push(
      isFoundry
        ? `${report.coverage.droppedOrphanRules} generated ${report.coverage.droppedOrphanRules === 1 ? "test was" : "tests were"} omitted from coverage.`
        : `${report.coverage.droppedOrphanRules} orphan ${report.coverage.droppedOrphanRules === 1 ? "rule was" : "rules were"} omitted from coverage.`,
    );
  }
  warnings.push(
    ...report.coverage.warnings.map((warning) =>
      isFoundry
        ? warning
            .replace(/\bproperties\b/gi, "test objectives")
            .replace(/\bproperty\b/gi, "test objective")
            .replace(/\brules\b/gi, "tests")
            .replace(/\brule\b/gi, "test")
            .replace(/\bverification\b/gi, "test execution")
            .replace(/\bverified\b/gi, "passed")
        : warning,
    ),
  );
  return [...new Set(warnings)];
}

export function formatStandalonePrComment(args: {
  engine: Exclude<Engine, "ai-auditor">;
  jobId: string;
  cost: number;
  reportState: string;
  report: AissRunReport | null;
  commit: CommitGeneratedFilesResponse;
}): string {
  const name = engineDisplayName(args.engine);
  const outcome = args.report?.outcome ?? "unknown";
  const warnings = getStandaloneWarnings(
    args.reportState,
    args.report,
    args.engine,
  );
  const generatedPaths = args.commit.files.map((file) => file.path);
  const commitCreated = args.commit.commit_created !== false;
  const isFoundry = args.engine === "auto-foundry";
  const outcomeText = outcomeLabel(outcome, args.engine);
  const firstCountLabel = isFoundry ? "Test objectives" : "Properties";
  const secondCountLabel = isFoundry ? "Generated tests" : "Rules";
  const coverageLabel = isFoundry ? "Test coverage" : "Coverage";
  const countOrUnavailable = (count: number | undefined) =>
    args.report ? (count ?? 0) : "Unavailable";

  let body = `${PR_COMMENT_MARKER}
## ${name} Results — ${outcomeText}

| Result | Value |
|--------|-------|
| Outcome | **${outcomeText}** |
| Contract | ${args.report ? `\`${args.report.contractName}\`` : "Unavailable"} |
| Report | ${args.reportState} |
| ${firstCountLabel} | ${countOrUnavailable(args.report?.coverage.totalProperties)} |
| ${secondCountLabel} | ${countOrUnavailable(args.report?.coverage.totalRules)} |
| ${coverageLabel} | ${args.report ? (args.report.coverage.propertyCoverageComplete ? "Complete" : "Has gaps") : "Unavailable"} |
| Generated files | ${generatedPaths.length} |
| Generated commit | ${commitCreated ? "Created" : "Not needed (head unchanged)"} |

**Job:** \`${args.jobId}\` | **Cost:** $${args.cost.toFixed(2)} | **Generated commit:** ${commitCreated ? `\`${args.commit.commit_sha}\`` : "None"}
`;

  if (args.report && args.report.ruleCounts.length > 0) {
    body += `\n### ${isFoundry ? "Test results" : "Rule results"}\n\n| Status | Count |\n|--------|-------|\n`;
    for (const count of args.report.ruleCounts) {
      body += `| ${isFoundry ? autoFoundryStatusLabel(count.status) : count.status} | ${count.count} |\n`;
    }
  }

  if (warnings.length > 0) {
    body += `\n### ${isFoundry ? "Test coverage warnings" : "Coverage warnings"}\n\n`;
    for (const warning of warnings) {
      body += `- ${warning}\n`;
    }
  }

  if (generatedPaths.length > 0) {
    body += "\n### Generated files\n\n";
    for (const path of generatedPaths) {
      body += `- \`${path}\`\n`;
    }
  }

  if (args.commit.renamed_files.length > 0) {
    body += "\n### Preserved path collisions\n\n";
    for (const renamed of args.commit.renamed_files) {
      body += `- \`${renamed.from}\` → \`${renamed.to}\`\n`;
    }
  }

  body += `\n---\n_Powered by [${name}](https://zeus.certora.com)_\n`;
  return body;
}
