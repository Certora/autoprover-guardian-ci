# Certora Guardian CI

Certora Guardian CI runs one Certora workflow for every pull request:

- `ai-auditor-full`
- `ai-auditor-diff` (default)
- `ai-auditor-finding-validation`
- `auto-prover`
- `auto-foundry`

The action uses the public `/v2` run API. It estimates each run before launch,
submits launches with a deterministic `Idempotency-Key`, forwards the optional
AISS `Estimate-Quote-Id`, and polls the canonical run resource until it
succeeds, fails, or is cancelled. Quote forwarding is automatic and requires no
workflow input; AI Auditor estimates do not return a quote. There is no
separate progress endpoint.

## Quick start

Create an organization API key with the required run scopes in the Certora
dashboard, then save it as a repository secret named `CERTORA_API_KEY`.
Guardian needs `runs:create` and `runs:read`; grant `runs:cancel` for timeout
cancellation and `generated_files:write` for AutoProver or AutoFoundry delivery.

```yaml
name: Certora security

on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  certora:
    runs-on: ubuntu-latest
    steps:
      - uses: Certora/zeus-guardian-ci@v2
        with:
          api-key: ${{ secrets.CERTORA_API_KEY }}
          workflow: ai-auditor-diff
          context: "contracts/**/*.sol"
```

The API key is sent as a Bearer token only to the configured Certora API base
URL. `github-token` remains inside the action and is used only for GitHub issue,
comment, and commit-follow-up operations. It is never sent to Certora.

## Repository access

Public repositories are launched with `source.authentication.type: public`.
Private repositories use `organization_github_app`; connect the Certora GitHub
App to the organization and grant it access to the repository first.

AutoProver and AutoFoundry also require the organization GitHub App to write
generated files. Guardian binds the pull request number at launch and calls the
empty-body `/v2/runs/{run_id}/generated-files/commit` endpoint only after the
run succeeds. Fork pull requests are rejected for these two workflows.

## Workflow examples

### Full AI Auditor run

```yaml
- uses: Certora/zeus-guardian-ci@v2
  with:
    api-key: ${{ secrets.CERTORA_API_KEY }}
    workflow: ai-auditor-full
    context: "contracts/**/*.sol,docs/**/*.md"
    scope: "contracts/src/**/*.sol"
    instructions: "Focus on authorization and accounting invariants."
    use-memory: "true"
```

### Diff AI Auditor run

```yaml
- uses: Certora/zeus-guardian-ci@v2
  with:
    api-key: ${{ secrets.CERTORA_API_KEY }}
    workflow: ai-auditor-diff
    context: "contracts/**/*.sol"
    fail-on: "HIGH,MEDIUM"
```

### AI Auditor finding validation

```yaml
- uses: Certora/zeus-guardian-ci@v2
  with:
    api-key: ${{ secrets.CERTORA_API_KEY }}
    workflow: ai-auditor-finding-validation
    context: "contracts/**/*.sol"
    finding: "Vault.withdraw() may allow reentrancy before balances are updated."
```

Finding validation audits the pull request head commit. It posts the verdict to
the pull request and exposes `validation-verdict` (`VALID` or `INVALID`) and
`validation-severity`. A `VALID` verdict means the submitted finding is valid;
the action reports it but does not apply a built-in failure policy. Use the
output in a later workflow step when repository policy should fail on it.

### AutoProver

```yaml
- uses: Certora/zeus-guardian-ci@v2
  with:
    api-key: ${{ secrets.CERTORA_API_KEY }}
    workflow: auto-prover
    contract-path: src/Vault.sol
    contract-name: Vault
    design-doc-path: docs/vault-design.md
    threat-model-path: docs/vault-threat-model.md
```

### AutoFoundry

```yaml
- uses: Certora/zeus-guardian-ci@v2
  with:
    api-key: ${{ secrets.CERTORA_API_KEY }}
    workflow: auto-foundry
    contract-path: src/Vault.sol
    contract-name: Vault
    design-doc-path: docs/vault-design.md
```

`threat-model-path` is supported only by AutoProver.

## Generated-commit follow-up

Generated commits end with this exact trailer:

```text
Certora-Guardian-Run: <UUID>
```

When GitHub runs Guardian again for that commit, the action validates the
trailer against the canonical run, result, workflow, contract, delivery, and
current pull-request head. It reports the original outcome without launching
or billing another run. During the v2 transition, Guardian also recognizes the
legacy exact trailer `Zeus-Guardian-Job: <UUID>` so an existing generated commit
cannot accidentally trigger a second paid run. Text that matches neither exact
trailer is ignored.

If a successful run has no commit-worthy generated files, the delivery status
is `no_changes`; `generated-commit-sha` remains empty and no follow-up is
expected.

## Reliability and cancellation

The estimate and launch payloads are identical. A stable idempotency key is
derived from the GitHub workflow run and job, selected workflow, and canonical
launch body, so transient timeouts, action process restarts, and GitHub rerun
attempts first recover the same launch. A recovered queued or running run is
polled, and a recovered successful run is reused, without a second launch. Only
when a GitHub rerun finds that canonical run already `failed` or `cancelled`
does Guardian launch one retry with a key scoped to that GitHub run attempt.
That retry key is stable for restarts within the attempt. A new workflow run or
changed launch input also produces a different key.

Guardian polls `GET /v2/runs/{run_id}`. Progress is displayed from the run's
embedded `progress` object. On timeout or five consecutive polling failures it
requests cancellation when the server marks the run cancellable. Canonical
statuses are `queued`, `running`, `finalizing`, `succeeded`, `failed`,
`cancelling`, and `cancelled`. A succeeded run guarantees that its result is
ready and billing is settled.

For AutoProver and AutoFoundry, estimate and launch resolve the exact remote
commit and `contract-path` before issuing a quote or reserving balance. An
unavailable commit returns `source_revision_not_found`; a missing or unreadable
contract returns `contract_not_found`. Guardian reports both as terminal input
errors, so correcting the repository access or path and rerunning is safe.

## Inputs

| Input               | Required           | Default                   | Description                                            |
| ------------------- | ------------------ | ------------------------- | ------------------------------------------------------ |
| `api-key`           | Yes                | —                         | Certora organization API key                           |
| `workflow`          | No                 | `ai-auditor-diff`         | One of the five workflows listed above                 |
| `context`           | AI Auditor         | —                         | Comma-separated repository globs, 500 chars each       |
| `finding`           | Finding validation | —                         | Finding description to validate, up to 8000 characters |
| `scope`             | No                 | —                         | Full-run focus paths, within `context`                 |
| `instructions`      | No                 | —                         | Custom AI Auditor instructions, up to 10,000 chars     |
| `use-memory`        | No                 | `true`                    | Use repository memory for full runs                    |
| `max-iterations`    | No                 | `6`                       | AI Auditor iterations, from 4 through 10               |
| `skip-submodules`   | No                 | `false`                   | Skip repository submodules                             |
| `github-token`      | No                 | `${{ github.token }}`     | Local GitHub operations only; never sent to Certora    |
| `api-base-url`      | No                 | `https://app.certora.com` | Certora API base URL                                   |
| `poll-interval`     | No                 | `60`                      | Seconds between run polls                              |
| `timeout`           | No                 | `120`                     | Maximum minutes to wait                                |
| `create-issues`     | No                 | `true`                    | Create AI Auditor finding issues                       |
| `issue-severities`  | No                 | `HIGH,MEDIUM`             | Severities that create issues                          |
| `comment-on-pr`     | No                 | `true`                    | Post or update the PR summary                          |
| `fail-on`           | No                 | —                         | AI Auditor severities that fail the check              |
| `labels`            | No                 | `ai-auditor,security`     | Labels added to finding issues                         |
| `contract-path`     | AP/AF              | —                         | Repository-relative `.sol` path                        |
| `contract-name`     | AP/AF              | —                         | Solidity contract declaration name                     |
| `design-doc-path`   | No                 | —                         | Repository-relative `.md`, `.markdown`, or `.pdf`      |
| `threat-model-path` | No                 | —                         | AutoProver-only threat model path                      |

## Outputs

| Output                 | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `run-id`               | Certora run ID                                     |
| `workflow`             | Selected workflow                                  |
| `status`               | Last canonical run status                          |
| `highs-count`          | AI Auditor HIGH finding count                      |
| `mediums-count`        | AI Auditor MEDIUM finding count                    |
| `lows-count`           | AI Auditor LOW finding count                       |
| `infos-count`          | AI Auditor INFO finding count                      |
| `issues-created`       | Comma-separated created or reused issue references |
| `run-outcome`          | AutoProver or AutoFoundry report outcome           |
| `generated-files`      | Comma-separated generated repository paths         |
| `generated-commit-sha` | Generated commit SHA, or empty for `no_changes`    |
| `validation-verdict`   | Finding validation verdict (`VALID` or `INVALID`)  |
| `validation-severity`  | Finding validation severity, when assigned         |

## Custom API environment

```yaml
- uses: Certora/zeus-guardian-ci@v2
  with:
    api-key: ${{ secrets.CERTORA_API_KEY }}
    workflow: ai-auditor-diff
    context: "contracts/**/*.sol"
    api-base-url: "https://your-certora-deployment.example.com"
```

## License

MIT
