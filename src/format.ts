import type {
  AissRunReport,
  AissRunOutcome,
  AuditFindings,
  CommitGeneratedFilesResponse,
  Finding,
  FindingValidationReport,
  PublicReport,
  Severity,
} from "./types";
import { prCommentMarker, SEVERITY_EMOJI } from "./constants";

export function formatIssueTitle(finding: Finding): string {
  const prefix = `[AI Auditor] ${finding.severity}: `;
  const suffix = ` (${finding.id})`;
  const titleLimit = 240;
  const available = titleLimit - prefix.length - suffix.length;
  if (available <= 1) {
    const raw = `${prefix}${finding.title}${suffix}`;
    return `${raw.slice(0, Math.floor((titleLimit - 1) / 2))}…${raw.slice(-Math.ceil((titleLimit - 1) / 2))}`;
  }
  const title =
    finding.title.length > available
      ? `${finding.title.slice(0, available - 1)}…`
      : finding.title;
  return `${prefix}${title}${suffix}`;
}

export function formatIssueBody(
  finding: Finding,
  runId: string,
  prNumber: number,
): string {
  const locations =
    finding.locations.length > 0
      ? finding.locations.map((l) => `\`${l}\``).join(", ")
      : "_No specific location_";

  return truncateReport(
    `## ${finding.severity} ${finding.id}: ${finding.title}

**Severity:** ${finding.severity}
**Locations:** ${locations}
**Detected in:** PR #${prNumber}
**AI Auditor Run:** \`${runId}\`

### Description

${finding.description}

### Recommendation

${finding.recommendation}

---
_This issue was automatically created by [AI Auditor](https://app.certora.com). To dismiss, close this issue._`,
    60_000,
  );
}

export function formatPrComment(
  findings: AuditFindings,
  runId: string,
  cost: number | null,
  issueLinks: { finding: Finding; url: string }[],
  prNumber: number,
  workflow: "ai-auditor-full" | "ai-auditor-diff",
): string {
  const displayedCost = cost === null ? "unavailable" : `$${cost.toFixed(2)}`;
  const counts = {
    HIGH: findings.highs.length,
    MEDIUM: findings.mediums.length,
    LOW: findings.lows.length,
    INFO: findings.infos.length,
  };

  const totalFindings = Object.values(counts).reduce((a, b) => a + b, 0);

  let body: string;

  if (totalFindings === 0) {
    body = `${prCommentMarker(workflow)}
## \u2705 AI Auditor Results — No Findings

No security issues were detected in this PR.

**Run:** \`${runId}\` | **Cost:** ${displayedCost}
`;
  } else {
    body = `${prCommentMarker(workflow)}
## ${SEVERITY_EMOJI.HIGH} AI Auditor Results

| Severity | Count |
|----------|-------|
| ${SEVERITY_EMOJI.HIGH} HIGH | ${counts.HIGH} |
| ${SEVERITY_EMOJI.MEDIUM} MEDIUM | ${counts.MEDIUM} |
| ${SEVERITY_EMOJI.LOW} LOW | ${counts.LOW} |
| ${SEVERITY_EMOJI.INFO} INFO | ${counts.INFO} |
| **Total** | **${totalFindings}** |

**Run:** \`${runId}\` | **Cost:** ${displayedCost}
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

  body += `\n---\n_Powered by [AI Auditor](https://app.certora.com)_\n`;

  return truncateReport(body, 60_000);
}

function truncateReport(value: string, limit = 45_000): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  const suffix = "\n\n_Output truncated._";
  const contentLimit = limit - Buffer.byteLength(suffix, "utf8");
  let low = 0;
  let high = value.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, midpoint), "utf8") <= contentLimit) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return `${value.slice(0, low)}${suffix}`;
}

export function formatAiAuditorMarkdownPrComment(args: {
  workflow: "ai-auditor-full" | "ai-auditor-diff";
  runId: string;
  cost: number | null;
  content: string;
}): string {
  const displayedCost =
    args.cost === null ? "unavailable" : `$${args.cost.toFixed(2)}`;
  const content = truncateReport(args.content, 50_000);
  return truncateReport(
    `${prCommentMarker(args.workflow)}
## AI Auditor Results

${content}

**Run:** \`${args.runId}\` | **Cost:** ${displayedCost}

---
_Powered by [AI Auditor](https://app.certora.com)_
`,
    60_000,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function formatFindingValidationPrComment(args: {
  runId: string;
  cost: number | null;
  report: PublicReport;
  parsed: FindingValidationReport | null;
}): string {
  const displayedCost =
    args.cost === null ? "unavailable" : `$${args.cost.toFixed(2)}`;
  let body = `${prCommentMarker("ai-auditor-finding-validation")}\n## AI Auditor Finding Validation\n\n`;

  if (args.parsed) {
    const verdict =
      args.parsed.final_verdict === "VALID"
        ? "Valid finding"
        : "Likely false positive";
    body += `**Verdict:** ${verdict}\n`;
    body += `**Severity:** ${args.parsed.final_severity ?? "Not assigned"}\n`;
    body += `**Consensus:** ${args.parsed.consensus_method}\n`;
    body += `**Analysis status:** ${args.parsed.analysis_status}\n`;
    if (args.parsed.severity_reasoning) {
      body += `\n### Severity reasoning\n\n${args.parsed.severity_reasoning}\n`;
    }
    if (args.parsed.impact) {
      body += `\n### Impact\n\n${args.parsed.impact}\n`;
    }
    if (args.parsed.likelihood) {
      body += `\n### Likelihood\n\n${args.parsed.likelihood}\n`;
    }
    if (args.parsed.false_positive_reasoning) {
      body += `\n### False-positive reasoning\n\n${args.parsed.false_positive_reasoning}\n`;
    }
  } else if (args.report.format === "markdown") {
    body += `${truncateReport(args.report.content)}\n`;
  } else {
    const json = truncateReport(
      JSON.stringify(args.report.content, null, 2) ?? "null",
    );
    body += `<details>\n<summary>Unrecognized validation result</summary>\n\n<pre>${escapeHtml(json)}</pre>\n</details>\n`;
  }

  body += `\n**Run:** \`${args.runId}\` | **Cost:** ${displayedCost}\n`;
  body += `\n---\n_Powered by [AI Auditor](https://app.certora.com)_\n`;
  return truncateReport(body, 60_000);
}

function engineDisplayName(engine: "auto-prover" | "auto-fuzzer"): string {
  return engine === "auto-prover" ? "AutoProver" : "AutoFuzzer";
}

function outcomeLabel(
  outcome: AissRunOutcome,
  engine: "auto-prover" | "auto-fuzzer",
): string {
  if (engine === "auto-fuzzer") {
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

function autoFuzzerStatusLabel(status: string): string {
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
  report: AissRunReport,
  engine: "auto-prover" | "auto-fuzzer" = "auto-prover",
): string[] {
  const isFoundry = engine === "auto-fuzzer";
  const warnings: string[] = [];

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

  const skipped = Math.max(
    report.skipped.length,
    report.coverage.skipped_count,
  );
  if (skipped > 0) {
    warnings.push(
      isFoundry
        ? `${skipped} ${skipped === 1 ? "test objective was" : "test objectives were"} skipped.`
        : `${skipped} ${skipped === 1 ? "property was" : "properties were"} skipped.`,
    );
  }
  if (!report.coverage.property_coverage_complete) {
    warnings.push(
      isFoundry
        ? "Foundry test coverage is incomplete."
        : "Property coverage is incomplete.",
    );
  }
  if (report.coverage.gave_up_component_count > 0) {
    warnings.push(
      isFoundry
        ? `${report.coverage.gave_up_component_count} component test-generation ${report.coverage.gave_up_component_count === 1 ? "attempt was" : "attempts were"} abandoned.`
        : `${report.coverage.gave_up_component_count} component verification ${report.coverage.gave_up_component_count === 1 ? "attempt was" : "attempts were"} abandoned.`,
    );
  }
  if (report.coverage.dropped_orphan_rules > 0) {
    warnings.push(
      isFoundry
        ? `${report.coverage.dropped_orphan_rules} generated ${report.coverage.dropped_orphan_rules === 1 ? "test was" : "tests were"} omitted from coverage.`
        : `${report.coverage.dropped_orphan_rules} orphan ${report.coverage.dropped_orphan_rules === 1 ? "rule was" : "rules were"} omitted from coverage.`,
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
  workflow: "auto-prover" | "auto-fuzzer";
  runId: string;
  cost: number | null;
  report: AissRunReport;
  commit: CommitGeneratedFilesResponse;
}): string {
  const name = engineDisplayName(args.workflow);
  const outcome = args.report.outcome;
  const warnings = getStandaloneWarnings(args.report, args.workflow);
  const generatedPaths = args.commit.delivery.files.map((file) => file.path);
  const commitCreated = args.commit.delivery.status === "committed";
  const isFoundry = args.workflow === "auto-fuzzer";
  const outcomeText = outcomeLabel(outcome, args.workflow);
  const firstCountLabel = isFoundry ? "Test objectives" : "Properties";
  const secondCountLabel = isFoundry ? "Generated tests" : "Rules";
  const coverageLabel = isFoundry ? "Test coverage" : "Coverage";
  const displayedCost =
    args.cost === null ? "unavailable" : `$${args.cost.toFixed(2)}`;
  const countOrUnavailable = (count: number | undefined) => count ?? 0;

  let body = `${prCommentMarker(args.workflow)}
## ${name} Results — ${outcomeText}

| Result | Value |
|--------|-------|
| Outcome | **${outcomeText}** |
| Contract | \`${args.report.contract_name}\` |
| ${firstCountLabel} | ${countOrUnavailable(args.report.coverage.total_properties)} |
| ${secondCountLabel} | ${countOrUnavailable(args.report.coverage.total_rules)} |
| ${coverageLabel} | ${args.report.coverage.property_coverage_complete ? "Complete" : "Has gaps"} |
| Generated files | ${generatedPaths.length} |
| Generated commit | ${commitCreated ? "Created" : "Not needed (head unchanged)"} |

**Run:** \`${args.runId}\` | **Cost:** ${displayedCost} | **Generated commit:** ${commitCreated ? `\`${args.commit.delivery.commit_sha}\`` : "None"}
`;

  if (args.report.rule_counts.length > 0) {
    body += `\n### ${isFoundry ? "Test results" : "Rule results"}\n\n| Status | Count |\n|--------|-------|\n`;
    for (const count of args.report.rule_counts) {
      body += `| ${isFoundry ? autoFuzzerStatusLabel(count.status) : count.status} | ${count.count} |\n`;
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

  if (args.commit.delivery.renamed_files.length > 0) {
    body += "\n### Preserved path collisions\n\n";
    for (const renamed of args.commit.delivery.renamed_files) {
      body += `- \`${renamed.from}\` → \`${renamed.to}\`\n`;
    }
  }

  body += `\n---\n_Powered by [${name}](https://app.certora.com)_\n`;
  return truncateReport(body, 60_000);
}
