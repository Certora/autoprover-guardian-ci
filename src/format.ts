import type { AuditFindings, Finding, Severity } from "./types";
import { PR_COMMENT_MARKER, SEVERITY_EMOJI } from "./constants";

export function formatIssueTitle(finding: Finding): string {
  return `[Zeus] ${finding.severity}: ${finding.title} (${finding.id})`;
}

export function formatIssueBody(
  finding: Finding,
  jobId: string,
  prNumber: number
): string {
  const locations =
    finding.locations.length > 0
      ? finding.locations.map((l) => `\`${l}\``).join(", ")
      : "_No specific location_";

  return `## ${finding.severity} ${finding.id}: ${finding.title}

**Severity:** ${finding.severity}
**Locations:** ${locations}
**Detected in:** PR #${prNumber}
**Zeus Job:** \`${jobId}\`

### Description

${finding.description}

### Recommendation

${finding.recommendation}

---
_This issue was automatically created by [Zeus Audit](https://zeus.certora.com). To dismiss, close this issue._`;
}

export function formatPrComment(
  findings: AuditFindings,
  jobId: string,
  cost: number,
  issueLinks: { finding: Finding; url: string }[],
  prNumber: number
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
## \u2705 Zeus Audit Results — No Findings

No security issues were detected in this PR.

**Job:** \`${jobId}\` | **Cost:** $${cost.toFixed(2)}
`;
  } else {
    body = `${PR_COMMENT_MARKER}
## ${SEVERITY_EMOJI.HIGH} Zeus Audit Results

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

  body += `\n---\n_Powered by [Zeus Audit](https://zeus.certora.com)_\n`;

  return body;
}

export function formatLegacyPrComment(
  markdownResult: string,
  jobId: string,
  prNumber: number
): string {
  return `${PR_COMMENT_MARKER}
## ${SEVERITY_EMOJI.HIGH} Zeus Audit Results

**Job:** \`${jobId}\` | **PR:** #${prNumber}

> **Note:** This audit returned a legacy markdown report. Structured findings are not available.

<details>
<summary>Full Report</summary>

${markdownResult}

</details>

---
_Powered by [Zeus Audit](https://zeus.certora.com)_
`;
}
