# Zeus Guardian CI

A GitHub Action that runs [Zeus](https://zeus.certora.com) AI Auditor,
AutoProver, or AutoFoundry on pull requests.

## How It Works

1. A pull request selects one engine:
   - **AI Auditor** (default) performs a diff or full security audit.
   - **AutoProver** verifies generated formal properties for one Solidity contract.
   - **AutoFoundry** generates and runs Foundry tests for one Solidity contract.
2. The action sends the immutable PR head commit to Zeus and polls the generic
   audit lifecycle until it completes.
3. AI Auditor can create severity-based GitHub issues and posts its findings
   summary.
4. AutoProver and AutoFoundry commit any generated files to the triggering PR
   branch. AutoProver posts a formal property/rule summary; AutoFoundry posts a
   generated Foundry test summary. Existing user files are preserved under
   collision-safe generated paths.
5. The generated commit triggers the pull request workflow normally. Guardian
   recognizes its job trailer, verifies it against Zeus and the exact PR
   head, then reports the persisted result without running or billing another
   audit.
6. AutoProver and AutoFoundry fail the check only when the outcome is
   `issues_found` (or the workflow itself fails). Partial runs and coverage
   gaps produce warnings.

## Quick Start

### Step 1: Get a Zeus API Key

1. Sign up at [zeus.certora.com](https://zeus.certora.com)
2. Navigate to **API** in your organization sidebar
3. Click **Generate Key** and copy the key

### Step 2: Add the Secret to Your Repository

1. Go to your repo on GitHub
2. Navigate to **Settings > Secrets and variables > Actions**
3. Click **New repository secret**
4. Name: `ZEUS_API_KEY`
5. Value: your Zeus API key (starts with `live_`; legacy `zeus_live_` keys are also accepted)

### Step 3: Create the Workflow File

Create `.github/workflows/zeus-audit.yml` in your repository:

```yaml
name: Zeus Security Audit
on:
  pull_request:
    branches: [main, dev]

permissions:
  issues: write
  pull-requests: write
  contents: read

jobs:
  zeus-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: Certora/zeus-guardian-ci@main
        with:
          api-key: ${{ secrets.ZEUS_API_KEY }}
          context: "contracts/**/*.sol"
```

That's it. Every PR will now be audited automatically.

AutoProver and AutoFoundry need `contents: read` to inspect and verify commits
and `pull-requests: write` for their summary. Zeus commits generated files with
the organization's connected GitHub App so GitHub emits a normal pull request
`synchronize` event. Generated-file commits are supported only for
same-repository pull requests whose head still matches the audited commit.

## One-Click Install from Dashboard

Prefer a visual setup? You can install Zeus Guardian CI directly from the Zeus dashboard — no manual file creation needed.

1. Go to your organization on [zeus.certora.com](https://zeus.certora.com)
2. Click **GitHub Action** in the sidebar
3. Connect your GitHub account
4. Select the repository you want to protect
5. Choose which branches to audit (e.g., `main`, `dev`, `staging`)
6. Choose an engine and configure its context or contract inputs
7. Click **Create Pull Request**

Zeus will automatically open a PR on your repository with the workflow file configured exactly as you specified. Just merge the PR, then add your `AI_AUDITOR_API_KEY` secret in **Settings > Secrets and variables > Actions**.

## Private Repositories

`github-token` is used for Guardian's GitHub operations and is forwarded for
paid launch or repository validation. When the workflow grants the permissions
shown above, the default `GITHUB_TOKEN` can normally read the triggering
repository and post the configured issue/comment output; otherwise pass a
**Personal Access Token (PAT)** with the required repository permissions.

A PAT is not a replacement for the organization GitHub App in every flow:

- Private AI Auditor runs require the organization App to read the repository
  and every included private submodule for the unmetered cost preview. The
  request token is forwarded only to the paid launch. If the App cannot price
  an included submodule that the request token may expose, the launch stops
  with `submodule_preview_incomplete`; grant App access or set
  `skip-submodules: "true"`.
- AutoProver and AutoFoundry can use the request token for launch, but generated
  files are written by the organization App. Connect it and authorize the
  repository before enabling generated commits.

The PAT is revalidated for generated-file follow-ups but is never used as the
server-side generated-commit write credential.

```yaml
- uses: Certora/zeus-guardian-ci@main
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "contracts/**/*.sol"
    github-token: ${{ secrets.PAT_TOKEN }}
```

## Examples

### Multiple Target Branches

Audit PRs targeting any of your main branches:

```yaml
on:
  pull_request:
    branches: [main, dev, staging]
```

### Full Audit (Configured Context)

By default, the action runs a diff audit between the PR base and head. Set
`audit-type: "full"` to analyze the configured `context` at the PR head commit:

```yaml
- uses: Certora/zeus-guardian-ci@main
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "contracts/**/*.sol"
    audit-type: "full"
```

Full audits use repo memory by default, matching the dashboard: accepted
assumptions from previous audits are sent as context so Zeus does not re-report
them. Disable it with `use-memory: "false"`:

```yaml
- uses: Certora/zeus-guardian-ci@main
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "contracts/**/*.sol"
    audit-type: "full"
    use-memory: "false"
```

You can optionally narrow the focus with `scope`:

```yaml
- uses: Certora/zeus-guardian-ci@main
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "contracts/**/*.sol"
    audit-type: "full"
    scope: "contracts/src/**/*.sol"
```

### AutoProver

AutoProver targets exactly one Solidity contract. A design document and threat
model are optional repository-relative `.md`, `.markdown`, or `.pdf` files.

```yaml
permissions:
  pull-requests: write
  contents: read

steps:
  - uses: Certora/zeus-guardian-ci@main
    with:
      api-key: ${{ secrets.ZEUS_API_KEY }}
      engine: "auto-prover"
      contract-path: "src/Vault.sol"
      contract-name: "Vault"
      design-doc-path: "docs/vault-design.md"
      threat-model-path: "docs/vault-threat-model.md"
```

### AutoFoundry

```yaml
permissions:
  pull-requests: write
  contents: read

steps:
  - uses: Certora/zeus-guardian-ci@main
    with:
      api-key: ${{ secrets.ZEUS_API_KEY }}
      engine: "auto-foundry"
      contract-path: "src/Vault.sol"
      contract-name: "Vault"
      design-doc-path: "docs/vault-design.md"
```

`threat-model-path` is intentionally unsupported by AutoFoundry.

### Generated-Commit Follow-up

Committing generated files changes the pull request head SHA. Zeus uses the
organization's connected GitHub App for that commit, so GitHub triggers the
same `pull_request` workflow on the new head through a normal `synchronize`
event.

The generated commit ends with an exact `Zeus-Guardian-Job: <UUID>` trailer.
Before starting a standalone audit, Guardian inspects the current head commit.
When that trailer is present, Guardian fetches the persisted Zeus result and
calls the idempotent generated-file endpoint to verify that the returned
commit SHA is exactly the current PR head. It then posts the result and applies
the original pass/fail outcome without launching or billing another audit.
Recognized UUID trailers are revalidated against the server-side job, engine,
contract path/name, PR, artifact, and commit binding; a forged or
contract-mismatched recognized marker fails closed. Initial runs remain
compatible with older result responses that omit contract identity, but a
generated follow-up requires the current API response fields so it cannot be
misattributed in a multi-contract workflow.
Malformed text that does not match the exact trailer format is ignored and
starts a normal run.

If a successful run produces no commit-worthy files, the API reports that the
head is unchanged. Guardian warns, leaves `generated-commit-sha` empty, and
uses the current check because it already belongs to that SHA. Transient
generated-file publishing and backend failures are retried; the commit
endpoint is idempotent for the exact generated child commit.

### Reliability and Cancellation

Every Zeus API request has a 60-second per-request deadline. Lifecycle requests
and their retries are also bounded by the remaining overall action timeout, so
nested retries cannot extend the configured wait indefinitely. Read-only
lifecycle requests and the idempotent generated-file commit can retry transient
failures. Audit launches are submitted only once because public launch endpoints do not
currently accept an idempotency key. If a launch response is
lost, rejected by the server after it may have been accepted, or cannot be
decoded, inspect the organization's audit list for the repository and commit
before manually rerunning the workflow.

If the configured action timeout expires, or five consecutive lifecycle polls
fail while the provider is still running, Guardian makes one best-effort
cancellation request before exiting. The `status` output and logs distinguish a
confirmed `cancelled` run from `cancellation_pending`; they do not claim that an
asynchronous cancellation has already completed. Once provider work is
terminal, Guardian waits for billing settlement and does not send a misleading
late cancellation. If the provider reports success before the persisted audit
result is available, Guardian continues checking at `poll-interval` until the
same overall `timeout` expires. The explicit `result_not_ready` state and
transient `429`/`5xx` result failures are retried within that deadline; terminal
`4xx` result errors fail immediately. After a final cancellation attempt,
Guardian checks authoritative status once more so a success that won the race
continues to result handling instead of being reported as a timeout.

### Fail on HIGH Severity Findings

```yaml
- uses: Certora/zeus-guardian-ci@main
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "contracts/**/*.sol"
    fail-on: "HIGH"
```

### Choose Which Severities Create Issues

By default, only HIGH and MEDIUM findings create GitHub issues. Use `issue-severities` to control this — any combination of `HIGH`, `MEDIUM`, `LOW`, `INFO`:

```yaml
# Create issues for everything except INFO
- uses: Certora/zeus-guardian-ci@main
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "src/**/*.sol,lib/**/*.sol"
    issue-severities: "HIGH,MEDIUM,LOW"
    fail-on: "HIGH,MEDIUM"
```

```yaml
# Only create issues for HIGH findings
- uses: Certora/zeus-guardian-ci@main
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "contracts/**/*.sol"
    issue-severities: "HIGH"
```

```yaml
# Create issues for all severities
- uses: Certora/zeus-guardian-ci@main
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "contracts/**/*.sol"
    issue-severities: "HIGH,MEDIUM,LOW,INFO"
```

### Maximum DeepDive Iterations

```yaml
- uses: Certora/zeus-guardian-ci@main
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "contracts/**/*.sol"
    max-iterations: "10"
    timeout: "180"
```

### Disable Issue Creation (PR Comment Only)

```yaml
- uses: Certora/zeus-guardian-ci@main
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "contracts/**/*.sol"
    create-issues: "false"
```

### Use Outputs in Subsequent Steps

```yaml
steps:
  - uses: Certora/zeus-guardian-ci@main
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

### Custom API URL (Staging / Self-hosted)

If you're using a different Zeus environment (e.g., staging):

```yaml
- uses: Certora/zeus-guardian-ci@main
  with:
    api-key: ${{ secrets.ZEUS_API_KEY }}
    context: "contracts/**/*.sol"
    api-base-url: "https://dev.zeus.certora.com"
```

> When installing via the Zeus dashboard, the correct `api-base-url` is set automatically based on the environment you're on.

## Inputs

| Input               | Required               | Default                    | Description                                                                                                |
| ------------------- | ---------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `api-key`           | Yes                    | -                          | Zeus API key (`live_...`; legacy `zeus_live_...` is accepted)                                              |
| `engine`            | No                     | `ai-auditor`               | `ai-auditor`, `auto-prover`, or `auto-foundry`                                                             |
| `context`           | AI Auditor             | -                          | Comma-separated glob patterns for files to analyze                                                         |
| `github-token`      | No                     | `${{ github.token }}`      | GitHub token for output and launch validation; App still required for private AI previews/generated writes |
| `api-base-url`      | No                     | `https://zeus.certora.com` | Zeus API base URL                                                                                          |
| `audit-type`        | No                     | `diff`                     | AI Auditor only: `"diff"`, `"full"`, or a branch mapping                                                   |
| `scope`             | No                     | -                          | AI Auditor only: scope patterns for full audits (subset of context)                                        |
| `preprompt`         | No                     | -                          | AI Auditor only: custom audit instructions                                                                 |
| `use-memory`        | No                     | `true`                     | AI Auditor only: use repo memory for full audits                                                           |
| `max-iterations`    | No                     | `6`                        | AI Auditor only: DeepDive iterations (4-10)                                                                |
| `skip-submodules`   | No                     | `false`                    | AI Auditor only: skip git submodule loading                                                                |
| `poll-interval`     | No                     | `60`                       | Seconds between status polls                                                                               |
| `timeout`           | No                     | `120`                      | Maximum minutes to wait for completion                                                                     |
| `create-issues`     | No                     | `true`                     | AI Auditor only: create GitHub issues for findings                                                         |
| `issue-severities`  | No                     | `HIGH,MEDIUM`              | AI Auditor only: severities that create issues                                                             |
| `comment-on-pr`     | No                     | `true`                     | Post summary comment on the PR                                                                             |
| `fail-on`           | No                     | -                          | AI Auditor only: fail on selected severities; standalone fails on `issues_found`                           |
| `labels`            | No                     | `ai-auditor,security`      | AI Auditor only: labels added to created issues                                                            |
| `contract-path`     | AutoProver/AutoFoundry | -                          | Repository-relative `.sol` contract path                                                                   |
| `contract-name`     | AutoProver/AutoFoundry | -                          | Solidity contract declaration name                                                                         |
| `design-doc-path`   | No                     | -                          | Optional repository-relative `.md`, `.markdown`, or `.pdf` design document for AutoProver/AutoFoundry      |
| `threat-model-path` | No                     | -                          | Optional repository-relative `.md`, `.markdown`, or `.pdf` threat model for AutoProver only                |

## Outputs

| Output                 | Description                                                                       |
| ---------------------- | --------------------------------------------------------------------------------- |
| `job-id`               | Zeus audit job ID                                                                 |
| `status`               | Last known status (`succeeded`, `failed`, `cancelled`, or `cancellation_pending`) |
| `highs-count`          | AI Auditor HIGH finding count                                                     |
| `mediums-count`        | AI Auditor MEDIUM finding count                                                   |
| `lows-count`           | AI Auditor LOW finding count                                                      |
| `infos-count`          | AI Auditor INFO finding count                                                     |
| `issues-created`       | AI Auditor comma-separated created issue references                               |
| `engine`               | Selected engine                                                                   |
| `run-outcome`          | AutoProver verification or AutoFoundry generated-test outcome                     |
| `generated-files`      | Comma-separated generated paths committed to the PR                               |
| `generated-commit-sha` | Commit containing generated files, or empty when no commit was needed             |

## Issue Deduplication

AI Auditor avoids creating duplicate issues:

- Each finding creates an issue with a unique title: `[AI Auditor] HIGH: Finding Title (H-01)`
- Before creating, it searches for an open issue with the same exact title. Legacy `[Auto Prover]` titles remain recognized so the branding update does not duplicate existing findings.
- If a duplicate is found, it adds a comment noting the finding recurred in the new PR
- Closing an issue "dismisses" it — if the same finding appears in a future PR, a new issue is created

## PR Comment

By default, the action posts a summary comment on the PR — including when no findings are detected, so you can confirm Zeus ran successfully. Set `comment-on-pr: "false"` to disable it.

When findings exist, the comment includes:

- Severity breakdown table
- Links to created/updated issues
- LOW and INFO findings in a collapsible section
- Job ID and cost information

When no findings are detected, you get a clean "No Findings" confirmation.

Re-running the action updates the existing comment rather than posting a new one.

AutoProver comments show the formal property/rule outcome, rule status counts,
coverage gaps, and skipped properties. AutoFoundry comments instead show
generated test counts, test outcomes, test-coverage gaps, and skipped test
objectives. Both include billed cost, the generated commit, and any
collision-renamed files. These engines do not create severity-based GitHub
issues.

## Credits

The action reports the plan-adjusted billed amount returned by Zeus. See
[zeus.certora.com](https://zeus.certora.com) for current pricing.

## License

MIT
