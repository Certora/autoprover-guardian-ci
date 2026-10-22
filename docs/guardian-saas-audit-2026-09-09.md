# Guardian CI / SaaS integration review — 2026-09-09

## Approved remediation completed

The user authorized only the billing/recovery, retry, comment, input, and major
dependency fixes. Findings 2–7 below are now historical and have been addressed:

- Guardian launches every workflow directly through the authoritative server
  preflight; a failed estimate or balance already held by the original run can
  no longer prevent idempotent recovery. New launches still validate source and
  reserve balance on the server.
- Accepted, reservation-backed, and ambiguous launch records no longer expire
  with age. Only completed unbound pre-dispatch 4xx records expire after 24
  hours. Protection remains scoped to the same organization, API key, endpoint,
  key, and body; deleted historical records cannot be reconstructed. No database
  schema change or migration is required.
- Launch recovery uses one configured API deadline rather than three short
  retries. Server `Retry-After` delays are honored without premature retries,
  including at the end of ordinary status-request retries. Out-of-budget waits
  stop with guidance. Cancellation and terminal-result processing have bounded
  grace periods; neither can start a new audit.
- Summary updates require GitHub-confirmed authenticated authorship. Identity
  includes immutable PR head and canonical audit ID as well as workflow/mode;
  another audit cannot overwrite it, even in a head-change race. Publication
  rechecks the current head. Legacy unscoped comments remain untouched.
- Context/scope accept JSON string arrays for literal commas and complex globs,
  while retaining legacy CSV. SaaS automatically serializes ambiguous patterns.
- Actions core 2.0.3 / GitHub SDK 8.0.1, Vitest 4.1.11, and Vite 8.2.2 resolve
  patched dependencies without a global Undici override. Full and production
  `pnpm audit` are clean. Real SDK REST, GraphQL, and CommonJS/NCC compatibility
  have hermetic coverage.

Verified: 385 Guardian tests, 7,690 SaaS tests, typechecks, and the Guardian
bundle build. The original review below is retained as the evidence trail.
The missing `v2` release (finding 1), other product decisions, release refs,
and issue-deduplication policy remain unchanged as requested.

## Original review

Reviewed Guardian `2f376eb` against SaaS `d7c26dbf`, plus the local fixes below.
Scope: all five public v2 workflows, SaaS workflow installation, automatic and
explicit context, authentication, estimates, idempotency, polling/cancellation,
report publication, generated-file follow-ups, and dependency/release checks.

No paid audits, provider calls, GitHub writes, migrations, commits, or releases
were performed. GitHub refs and security advisories were checked read-only.
Hermetic tests verify the local contract; they do not certify a deployed service
or a real GitHub installation end to end.

## Fixed without changing public inputs

- **Rerun recovery:** SaaS idempotency replays the saved launch response, usually
  `queued`, not current status. Guardian now reads and validates the canonical
  run before deciding whether a GitHub rerun may retry an already failed or
  cancelled audit. Active recovered runs that subsequently fail are not retried
  automatically. Coverage includes all five workflows and real HTTP-boundary
  automatic-context tests. See `src/run.ts` and both run test suites.
- **No-issues selection:** the SaaS generator now emits `create-issues: "false"`
  when all severities are deselected. Previously an empty `issue-severities`
  silently restored Guardian's HIGH/MEDIUM default. Unneeded `issues: write`
  permission is omitted; the independent `fail-on` gate is preserved.
- **Installer validation:** SaaS trims context/scope patterns and enforces the
  same 500-character/NUL limits as Guardian and the public API before installing
  a workflow. AutoFuzzer setup-PR text now names the correct engine.
- **GitHub publication hardening:** summary markers must occupy the first line,
  not appear inside report text. Model-generated finding IDs cannot inject
  search qualifiers; matching issues must belong to the expected repository and
  cannot be pull requests. GitHub warning logs no longer include raw exception
  bodies. Byte-limited Markdown truncation preserves Unicode characters.
- **Transport validation:** result IDs must satisfy the existing UUID contract.
  Additional regressions cover same-key/quote retries, problem responses,
  redirects, malformed responses, deadlines, and cancellation.
- **Tooling:** CI now tests Node 24, matching `action.yml`. Vitest was patched
  from 3.2.4 to 3.2.7; compatible Vite, PostCSS, and nanoid patches were refreshed.
  This removes the critical development-tool advisory and several other
  advisories without migrating the Actions SDK. The critical issue concerned an
  exposed test UI/API, not an identified Guardian production RCE.
  [Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp).
- README now explicitly documents the 24-hour idempotency boundary and the
  estimator prerequisite for recovery. The runtime bundle is rebuilt in `dist/`.

## Requires review before implementation or publication

### 1. High availability: SaaS generates a nonexistent action reference

`zeus-saas/src/lib/audit-apps/ai-auditor-server.ts` hardcodes
`Certora/autoprover-guardian-ci@v2`. Read-only remote inspection returned neither
a `refs/tags/v2` nor a `refs/heads/v2` on the review date. Generated workflows
therefore cannot resolve the action before making any API request. Actions
references must identify an existing commit, branch, or tag.
[GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsuses).

Remote `APSupport` matches the reviewed Guardian baseline (`2f376eb`); `main`
(`0c59cbd`) and `v1` still use the retired v1 API and are not safe substitutes.
Publish a reviewed, rebuilt v2 release/ref or agree on an immutable compatible
SHA for the generator. This is a release decision, not permission to move tags
or publish during an audit. Recheck the remote before publishing.

### 2. Medium: estimates can block recovery of an existing audit

In `src/run.ts`, explicit-context AI, AutoProver, and AutoFuzzer require a fresh
successful estimate before the idempotent POST. For example, an original run
holds $100 of a $120 balance; the runner dies; the rerun sees $20 and exits on
`can_launch: false`, never recovering the original run that needs no new hold.
An estimator outage or changed repository access can have the same effect.
Automatic-context AI skips this estimate and is unaffected by this specific gap.

Prefer authenticated lookup/recovery before new-launch preflight. Do not simply
remove balance/quote guards: distinguish recovery from authorization for a new
billed run. This needs a cross-service recovery contract.

### 3. Medium: reruns after 24 hours can start another billed audit

`zeus-saas/src/lib/api/v2/idempotency.ts` expires completed idempotency records
24 hours after creation, including records linked to accepted runs. Guardian's
stable GitHub run/job key then becomes a new launch, even if the original audit
succeeded or is still running. This follows the current API retention contract,
but cannot provide indefinite CI deduplication.

Choose durable, authenticated CI-run binding/recovery or explicitly bounded
rerun behavior that requires confirmation after expiration. Only the README
warning was changed; retention, billing, and the public API were not changed.

### 4. Medium conditional reliability: launch and rate-limit recovery are too short

`src/api.ts` has a 60-second request timeout and three retries. A timeout followed
by quick `idempotency_in_progress` responses can exhaust recovery around 65
seconds. SaaS allows up to 120 seconds for internal repository estimation. If
the server continues processing after client abort, it can accept/start a run
after Guardian has failed without a run ID to cancel. Automatic-context LLM
selection itself runs asynchronously, not inside this POST.

Separately, `Retry-After` is capped at 30 seconds although relevant SaaS quotas
use hourly windows. A 300-second reset is retried prematurely and exhausts the
retry budget. The configured action timeout currently bounds polling, not the
entire estimate/launch lifecycle. Define an overall deadline and a deliberate
wait-versus-exit policy alongside durable launch recovery.

### 5. Medium: comment ownership and stale-head publication

`src/github.ts` still selects an existing PR summary by its leading marker,
without authenticated-author verification. Another participant can post an
exact leading marker. Guardian then targets that comment; depending on token
permissions it may overwrite it or receive an error that is logged and leaves
the real summary missing. The leading-line fix prevents embedded-marker
confusion, not exact-marker impersonation.

Also, an older audit finishing last can overwrite a newer audit's same-workflow,
same-mode summary because AI publication does not gate on the current PR head.
Choose authenticated ownership compatible with Actions/App/PAT tokens, plus
current-head gating or per-commit summaries. Merely accepting any bot author is
not adequate. GitHub supports multiple token types for comment updates.
[GitHub comment API](https://docs.github.com/en/rest/issues/comments#update-an-issue-comment).

### 6. Medium input correctness: comma-containing paths/globs do not round-trip

The SaaS generator joins arrays with commas and Guardian splits on every comma.
`src/{foo,bar}.sol` becomes two patterns; a literal comma-containing filename is
also corrupted. Choose a backward-compatible structured/newline input format
or explicitly reject unsupported commas in both entry points. Do not silently
change the existing CSV protocol for installed workflows.

### 7. Dependency migrations need separate validation

After compatible patches, `pnpm audit` reports 15 entries: 0 critical, 3 high,
9 moderate, 3 low. Counts include development-only and unused-feature issues;
they are not 15 demonstrated vulnerabilities in Guardian's runtime.

- Actions SDKs still bring Undici 5.29, while advisory fixes are in newer majors.
  GitHub REST uses that bundled fetch implementation. Response/decompression
  attacks require a malicious/compromised HTTP peer or proxy; PR source content
  alone does not control GitHub response headers. The remaining high advisories
  concern WebSockets, which Guardian does not use. Native Node fetch used for
  SaaS requests is a separate runtime dependency.
  [Undici HTTP advisory](https://github.com/nodejs/undici/security/advisories/GHSA-g9mf-h72j-4rw9).
- An SDK upgrade crosses Octokit/HTTP client majors; current latest SDKs also
  introduce ESM-only packaging while this action builds CommonJS with NCC.
  Validate authentication, proxies, token handling, and the actual compiled
  action rather than force-overriding Undici across unsupported ranges.
  [Actions SDK release notes](https://raw.githubusercontent.com/actions/toolkit/main/packages/github/RELEASES.md).
- A remaining Vitest development-server advisory has no planned 3.x fix and
  requires a major test-runner upgrade. Guardian's non-browser `vitest run` does
  not expose the identified dev-server attack path. There is also a low esbuild
  development-server advisory outside the installed compatible range.
  [Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9).

### Other product decisions / lower-priority limitations

- All installer engines share `ai-auditor-audit.yml` and the same setup branch;
  installing another engine replaces the installed workflow. If coexistence is
  intended, define migration-safe per-engine filenames and setup branches.
- `fullAuditCi` is enforced by the installer, while a manually authored full
  workflow uses the ordinary API entitlement. If this must be a CI-only billing
  restriction, it needs trusted caller identity. User-agent/client-reference
  checks are spoofable and would risk breaking legitimate API clients.
- Issue deduplication still uses finding ID/title, not a durable source/location
  fingerprint or authenticated issue ownership. Unrelated findings or a
  human-created matching issue can be conflated; legacy migration needs review.

## Verification

- Guardian: `pnpm test` — 256 tests across 7 files; `pnpm typecheck`; `pnpm build`.
- SaaS: `pnpm test:ci` — 7,657 tests across 540 files; `pnpm ts`; scoped ESLint.
- Regression coverage includes all five workflows, automatic-context HTTP
  boundaries, mixed-language paths, private-source token separation, result/run
  identity binding, and generated-commit parent/delivery invariants.
- No changes to public request schemas, database schema, orchestrator, or plugin.
- Remaining issues above were deliberately not redesigned or published.
