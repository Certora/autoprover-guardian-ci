# AutoProver Guardian CI

AutoProver Guardian CI runs one Certora workflow for every pull request:

- `ai-auditor-full`
- `ai-auditor-diff` (default)
- `ai-auditor-finding-validation`
- `auto-prover`
- `auto-fuzzer`

The action uses the public `/v2` run API. All workflows are submitted directly,
without a separate estimate or preview. Launches use a deterministic
`Idempotency-Key`: the server recovers an existing run before billing checks,
and validates source, calculates pricing, and reserves balance for new runs.
The public API still supports optional estimates and the AISS
`Estimate-Quote-Id` header for other callers; Guardian does not need either.
Guardian polls the canonical run resource until it succeeds, fails, or is
cancelled. There is no separate progress endpoint.

## Quick start

Create an organization API key with the required run scopes in the Certora
dashboard, then save it as a repository secret named `CERTORA_API_KEY`.
Guardian needs `runs:create` and `runs:read`; grant `runs:cancel` for timeout
cancellation and `generated_files:write` for AutoProver or AutoFuzzer delivery.

Omit `context` or leave it empty to let the server select context during launch.
No preview or preparation token is required. Full audits require `scope` when
context is automatic; diff audits use the complete immutable pull-request diff
as their audit scope. Finding validation selects context for the submitted
finding. Guardian never replaces empty context with every repository file or
a locally generated list of changed files. The server checks balance and
reserves the required amount before starting the audit.

An explicit `context` remains an override: select JSON arrays or comma-separated globs that
include the audited code and relevant dependencies. For full audits, an optional
`scope` focuses on a subset of that context; without it, the explicit context
is the scope. For diff audits, explicit context also filters the diff, so keep
the changed paths you want audited in that selection. AutoProver and AutoFuzzer
do not use this input.

AI Auditor loads direct submodules only, never nested submodules. Set
`skip-submodules: true` to skip all submodules. Include required libraries in
the repository or a direct submodule when they would otherwise be nested.

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
      - uses: Certora/autoprover-guardian-ci@v2
        with:
          api-key: ${{ secrets.CERTORA_API_KEY }}
          workflow: ai-auditor-diff
```

The API key is sent as a Bearer token only to the configured Certora API base
URL. `github-token` remains inside the action and is used only for GitHub issue,
comment, and commit-follow-up operations. It is never sent to Certora.

## Repository access

Public repositories are launched with `source.authentication.type: public`.
Private repositories use `organization_github_app`; connect the Certora GitHub
App to the organization and grant it access to the repository first.

AutoProver and AutoFuzzer also require the organization GitHub App to write
generated files. Guardian binds the pull request number at launch and calls the
empty-body `/v2/runs/{run_id}/generated-files/commit` endpoint only after the
run succeeds. Fork pull requests are rejected for these two workflows.

## Workflow examples

AI Auditor supports any programming language for full, diff, and finding-validation
runs. Explicit context may mix source languages, shared libraries, resources, and relevant
build manifests (for example `src/**/*.py,web/**/*.ts,lib/**,pyproject.toml`).
Only AutoProver and AutoFuzzer require Solidity contracts.

### AI Auditor model modes

`model-mode` selects the AI Auditor model set: `normal` or `frontier`. Normal
is the server default; Frontier uses the frontier model set throughout the
auditor pipeline, with the configured Luna helper unchanged. Both modes use
six DeepDive iterations by default. Model selection and iteration count are
independent: the action/API still accepts `max-iterations` from 4 through 10.
Finding validation supports both model modes but has no DeepDive iterations.

Leave `model-mode` empty to use Normal without changing existing launch bodies
or idempotency keys. An explicit selection is forwarded as `model_mode` in
every launch and retry. Guardian
never retries by removing or downgrading the requested mode. AutoProver and
AutoFuzzer reject this AI Auditor-only input.

Startup logs show the requested/default mode. PR summaries show the recorded
mode, or an explicitly requested mode when the server does not report one.
Historical runs with neither are labeled "Not recorded (legacy run)", not
retroactively Normal. Frontier summaries use a separate comment marker, so
Normal and Frontier jobs for the same workflow can coexist in a matrix.

```yaml
- uses: Certora/autoprover-guardian-ci@v2
  with:
    api-key: ${{ secrets.CERTORA_API_KEY }}
    workflow: ai-auditor-diff
    model-mode: frontier
    max-iterations: "6"
```

### Full AI Auditor run

```yaml
- uses: Certora/autoprover-guardian-ci@v2
  with:
    api-key: ${{ secrets.CERTORA_API_KEY }}
    workflow: ai-auditor-full
    scope: "contracts/src/**/*.sol"
    instructions: "Focus on authorization and accounting invariants."
    use-memory: "true"
```

### Diff AI Auditor run

```yaml
- uses: Certora/autoprover-guardian-ci@v2
  with:
    api-key: ${{ secrets.CERTORA_API_KEY }}
    workflow: ai-auditor-diff
    fail-on: "HIGH,MEDIUM"
```

### AI Auditor finding validation

```yaml
- uses: Certora/autoprover-guardian-ci@v2
  with:
    api-key: ${{ secrets.CERTORA_API_KEY }}
    workflow: ai-auditor-finding-validation
    finding: "Vault.withdraw() may allow reentrancy before balances are updated."
```

Finding validation audits the pull request head commit. It posts the verdict to
the pull request and exposes `validation-verdict` (`VALID` or `INVALID`) and
`validation-severity`. A `VALID` verdict means the submitted finding is valid;
the action reports it but does not apply a built-in failure policy. Use the
output in a later workflow step when repository policy should fail on it.

### Explicit context override

```yaml
- uses: Certora/autoprover-guardian-ci@v2
  with:
    api-key: ${{ secrets.CERTORA_API_KEY }}
    workflow: ai-auditor-full
    scope: "src/**/*.py"
    context: "src/**/*.py,lib/**/*.py"
```

This override is sent to the server during launch; it does not invoke
automatic context selection.

Both `context` and `scope` accept JSON string arrays. Prefer JSON for literal
comma filenames or complex globs; the SaaS installer emits it automatically
when needed:

```yaml
context: '["contracts/Exchange,old.sol","src/**/*.{ts,tsx}","!src/tests/**"]'
scope: '["contracts/Exchange,old.sol"]'
```

Legacy CSV remains supported, including commas inside brace globs, character
classes, and extglobs. Leading/trailing pattern whitespace is normalized, as in
the public API. JSON arrays must contain non-empty strings; malformed JSON
arrays are rejected rather than silently changing the audit selection.

### AutoProver

```yaml
- uses: Certora/autoprover-guardian-ci@v2
  with:
    api-key: ${{ secrets.CERTORA_API_KEY }}
    workflow: auto-prover
    contract-path: src/Vault.sol
    contract-name: Vault
    design-doc-path: docs/vault-design.md
    threat-model-path: docs/vault-threat-model.md
```

### AutoFuzzer

```yaml
- uses: Certora/autoprover-guardian-ci@v2
  with:
    api-key: ${{ secrets.CERTORA_API_KEY }}
    workflow: auto-fuzzer
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
or billing another run. For immutable commits created by earlier releases, the
action also accepts the historical protocol trailer
`Zeus-Guardian-Job: <UUID>`. New commits always use the current trailer. Text
that matches neither exact trailer is ignored.

If a successful run has no commit-worthy generated files, the delivery status
is `no_changes`; `generated-commit-sha` remains empty and no follow-up is
expected.

## Reliability and cancellation

A stable idempotency key is
derived from the GitHub workflow run and job, selected workflow, and canonical
launch body, so transient timeouts, action process restarts, and GitHub rerun
attempts first recover the same launch while the server retains the idempotency
record. Guardian refreshes the canonical run on a GitHub rerun, since replayed
launch responses can still contain their original queued status. A recovered queued or running run is
polled, and a recovered successful run is reused, without a second launch. Only
when a GitHub rerun finds that canonical run already `failed` or `cancelled`
does Guardian launch one retry with a key scoped to that GitHub run attempt.
That retry key is stable for restarts within the attempt. A new workflow run or
changed launch input also produces a different key.

Accepted, reservation-backed, and unresolved API launch records no longer
expire merely with age. Recovery uses the same organization, API key, endpoint,
idempotency key, and body; changing API keys or deleting the owning organization
does not preserve that scope. Only definite pre-dispatch `4xx` failures without
a run or reservation can expire after 24 hours. Records removed before this
retention fix cannot be restored automatically. A recovered run needs no new
estimate or balance reservation; new launches still enforce all server checks.

`timeout` is a shared budget for API launch/recovery, polling, and result/file
delivery. Retriable launches keep the same key until that deadline, including
when a request times out before the server finishes. `Retry-After` is respected
even for long quota resets; if the wait cannot fit, Guardian stops with recovery
guidance instead of retrying early. Cancellation gets up to 15 seconds of grace;
a run that succeeds during cancellation gets a bounded 15-second completion
grace to fetch its report and deliver files. Neither grace can launch an audit.

Guardian polls `GET /v2/runs/{run_id}`. Progress is displayed from the run's
embedded `progress` object. On timeout or five consecutive polling failures it
requests cancellation when the server marks the run cancellable. Canonical
statuses are `queued`, `running`, `finalizing`, `succeeded`, `failed`,
`cancelling`, and `cancelled`. A succeeded run guarantees that its result is
ready and billing is settled. A quota reset beyond the remaining budget stops
polling without issuing an early cancellation request; the run ID remains
available for recovery.

PR summaries are scoped to workflow, model mode, immutable PR head, and canonical
audit run. Guardian updates only comments that GitHub confirms were authored by
the authenticated token identity. It skips publication for an outdated head,
and a late older audit cannot overwrite a newer audit's summary. Legacy unscoped
comments are left intact; the first run after upgrading creates a scoped summary.

For AutoProver and AutoFuzzer, estimate and launch resolve the exact remote
commit and `contract-path` before issuing a quote or reserving balance. An
unavailable commit returns `source_revision_not_found`; a missing or unreadable
contract returns `contract_not_found`. Guardian reports both as terminal input
errors, so correcting the repository access or path and rerunning is safe.

## Inputs

| Input               | Required           | Default                   | Description                                            |
| ------------------- | ------------------ | ------------------------- | ------------------------------------------------------ |
| `api-key`           | Yes                | —                         | Certora organization API key                           |
| `workflow`          | No                 | `ai-auditor-diff`         | One of the five workflows listed above                 |
| `model-mode`        | No                 | Empty (Normal)           | AI Auditor model set: `normal` or `frontier`             |
| `context`           | No                 | Empty (automatic)         | Optional AI Auditor context override; server selects context when empty |
| `finding`           | Finding validation | —                         | Finding description to validate, up to 8000 characters |
| `scope`             | Full auto context  | —                         | Full-run audit paths; optional subset with explicit context |
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
| `model-mode`           | AI Auditor mode; empty for other engines or unrecorded historical runs |
| `status`               | Last canonical run status                          |
| `highs-count`          | AI Auditor HIGH finding count                      |
| `mediums-count`        | AI Auditor MEDIUM finding count                    |
| `lows-count`           | AI Auditor LOW finding count                       |
| `infos-count`          | AI Auditor INFO finding count                      |
| `issues-created`       | Comma-separated created or reused issue references |
| `run-outcome`          | AutoProver or AutoFuzzer report outcome            |
| `generated-files`      | Comma-separated generated repository paths         |
| `generated-commit-sha` | Generated commit SHA, or empty for `no_changes`    |
| `validation-verdict`   | Finding validation verdict (`VALID` or `INVALID`)  |
| `validation-severity`  | Finding validation severity, when assigned         |

## Custom API environment

```yaml
- uses: Certora/autoprover-guardian-ci@v2
  with:
    api-key: ${{ secrets.CERTORA_API_KEY }}
    workflow: ai-auditor-diff
    api-base-url: "https://your-certora-deployment.example.com"
```

## License

MIT
