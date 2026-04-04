# Zeus Guardian CI

A GitHub Action that runs [Zeus](https://zeus-audit.com) security audits on pull request changes and automatically creates GitHub issues for each finding.

## How It Works

1. When a PR is opened or updated, the action sends the diff to Zeus for analysis
2. Zeus audits the code changes between the base and head commits
3. The action polls for completion and logs progress in real-time
4. Once done, it creates GitHub issues for findings (configurable: HIGH, MEDIUM, LOW, INFO)
5. A summary comment is always posted on the PR — even when no findings are detected, so you know Zeus ran

## Quick Start

### Step 1: Get a Zeus API Key

1. Sign up at [zeus-audit.com](https://zeus-audit.com)
2. Navigate to **API** in your organization sidebar
3. Click **Generate Key** and copy the key

### Step 2: Add the Secret to Your Repository

1. Go to your repo on GitHub
2. Navigate to **Settings > Secrets and variables > Actions**
3. Click **New repository secret**
4. Name: `ZEUS_API_KEY`
5. Value: your Zeus API key (starts with `zeus_live_`)

### Step 3: Create the Workflow File

Create `.github/workflows/zeus-audit.yml` in your repository:

```yaml
name: Zeus Security Audit
on:
  pull_request:
    branches: [main]

permissions:
  issues: write
  pull-requests: write
  contents: read

jobs:
  zeus-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: zeus-audit/guardian-ci@v1
        with:
          api-key: ${{ secrets.ZEUS_API_KEY }}
          context: "contracts/**/*.sol"
```

That's it. Every PR will now be audited automatically.

## Private Repositories

The default `GITHUB_TOKEN` may not have sufficient permissions for Zeus to clone private repositories. In that case, create a **Personal Access Token (PAT)** with `contents: read` scope and pass it:

```yaml
- uses: zeus-audit/guardian-ci@v1
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "contracts/**/*.sol"
    github-token: ${{ secrets.PAT_TOKEN }}
```

## Examples

### Fail on HIGH Severity Findings

```yaml
- uses: zeus-audit/guardian-ci@v1
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "contracts/**/*.sol"
    fail-on: "HIGH"
```

### Choose Which Severities Create Issues

By default, only HIGH and MEDIUM findings create GitHub issues. Use `issue-severities` to control this — any combination of `HIGH`, `MEDIUM`, `LOW`, `INFO`:

```yaml
# Create issues for everything except INFO
- uses: zeus-audit/guardian-ci@v1
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "src/**/*.sol,lib/**/*.sol"
    issue-severities: "HIGH,MEDIUM,LOW"
    fail-on: "HIGH,MEDIUM"
```

```yaml
# Only create issues for HIGH findings
- uses: zeus-audit/guardian-ci@v1
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "contracts/**/*.sol"
    issue-severities: "HIGH"
```

```yaml
# Create issues for all severities
- uses: zeus-audit/guardian-ci@v1
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "contracts/**/*.sol"
    issue-severities: "HIGH,MEDIUM,LOW,INFO"
```

### Maximum DeepDive Iterations

```yaml
- uses: zeus-audit/guardian-ci@v1
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "contracts/**/*.sol"
    max-iterations: "10"
    timeout: "180"
```

### Disable Issue Creation (PR Comment Only)

```yaml
- uses: zeus-audit/guardian-ci@v1
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "contracts/**/*.sol"
    create-issues: "false"
```

### Use Outputs in Subsequent Steps

```yaml
steps:
  - uses: zeus-audit/guardian-ci@v1
    id: audit
    with:
      api-key: ${{ secrets.ZEUS_API_KEY }}
      context: "contracts/**/*.sol"

  - run: |
      echo "Job ID: ${{ steps.audit.outputs.job-id }}"
      echo "Status: ${{ steps.audit.outputs.status }}"
      echo "High findings: ${{ steps.audit.outputs.highs-count }}"
      echo "Issues created: ${{ steps.audit.outputs.issues-created }}"
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api-key` | Yes | - | Zeus API key (`zeus_live_...`) |
| `context` | Yes | - | Comma-separated glob patterns for files to analyze |
| `github-token` | No | `${{ github.token }}` | GitHub token for issues/comments and private repo access |
| `api-base-url` | No | `https://zeus-audit.com` | Zeus API base URL |
| `preprompt` | No | - | Custom instructions for the audit |
| `max-iterations` | No | `6` | DeepDive iterations (4-10) |
| `skip-submodules` | No | `false` | Skip git submodule loading |
| `poll-interval` | No | `60` | Seconds between status polls |
| `timeout` | No | `120` | Maximum minutes to wait for completion |
| `create-issues` | No | `true` | Create GitHub issues for findings |
| `issue-severities` | No | `HIGH,MEDIUM` | Which severities create GitHub issues (`HIGH,MEDIUM,LOW,INFO`) |
| `comment-on-pr` | No | `true` | Post summary comment on the PR |
| `fail-on` | No | - | Fail the action if these severities are found |
| `labels` | No | `zeus-audit,security` | Labels added to created issues |

## Outputs

| Output | Description |
|--------|-------------|
| `job-id` | Zeus audit job ID |
| `status` | Final status (`succeeded`, `failed`, `cancelled`) |
| `highs-count` | Number of HIGH findings |
| `mediums-count` | Number of MEDIUM findings |
| `lows-count` | Number of LOW findings |
| `infos-count` | Number of INFO findings |
| `issues-created` | Comma-separated list of created issue references |

## Issue Deduplication

The action avoids creating duplicate issues:

- Each finding creates an issue with a unique title: `[Zeus] HIGH: Finding Title (H-01)`
- Before creating, it searches for open issues with the same title and `zeus-audit` label
- If a duplicate is found, it adds a comment noting the finding recurred in the new PR
- Closing an issue "dismisses" it — if the same finding appears in a future PR, a new issue is created

## PR Comment

The action **always** posts a summary comment on the PR — including when no findings are detected, so you can confirm Zeus ran successfully.

When findings exist, the comment includes:
- Severity breakdown table
- Links to created/updated issues
- LOW and INFO findings in a collapsible section
- Job ID and cost information

When no findings are detected, you get a clean "No Findings" confirmation.

Re-running the action updates the existing comment rather than posting a new one.

## Credits

Each diff audit consumes **1 Zeus credit**. Credits are refunded if the Zeus backend fails to start the audit. See [zeus-audit.com](https://zeus-audit.com) for pricing.

## License

MIT
