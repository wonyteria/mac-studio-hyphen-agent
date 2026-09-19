# Hermes System 1 Decision Layer (offline evaluation)

Evaluation-first System 1 decision layer for Hermes, inspired by TypeSafe Jev.
This slice is **offline evaluation and architecture only** — no external
execution, no API calls, no SDK, no API key, and it does **not** claim Jev is
integrated or production-ready.

## Intended Hermes flow

```text
operator request
  └─▶ deterministic policy rules        (hard allow/warn/block/route constraints)
        └─▶ System 1 provider adapter   (fixed route enum; validated output)
              └─▶ combined decision     (policy always wins; thresholds abstain)
                    └─▶ System 2 executes ELSEWHERE (worker/codex/devin — not here)
                          └─▶ deterministic verification gates
                                └─▶ System 1 result judge (fixed decision enum)
```

1. **Deterministic policy rules run first.** They own hard constraints:
   deploy/restart, paid/external API, backup mutation, prompt injection,
   destructive filesystem, secret material, insufficient context, and
   **ambiguous multi-intent** (two or more mutually exclusive action
   groups — e.g. script task + private summary, or a local task + a
   deploy/backup/paid-API action) all `block` → forced `REQUIRE_OWNER`.
   Multi-intent is a fail-closed escalation, never a provider-overrideable
   `warn`. Natural combinations inside one group — code edit + autonomous
   build, or any task + status report / reasoning / no-action — are *not*
   multi-intent and stay provider-routable.
   `privateData` adds a route constraint — the request may only resolve to
   `LOCAL_LLM`, `NO_ACTION`, or `REQUIRE_OWNER`, never an external route.
2. **System 1 provider** chooses exactly one fixed route:
   `NO_ACTION`, `LOCAL_SCRIPT`, `LOCAL_LLM`, `GPT`, `CODEX`, `DEVIN`,
   `REQUIRE_OWNER`. Provider output is always schema-validated; model text is
   untrusted.
3. **System 2 executes elsewhere.** This layer never executes — the worker,
   Codex, Devin, or a local LLM performs actual work in a separate boundary.
4. **Deterministic verification gates run before semantic judgment.**
   `security`/`policy` fail → `REQUIRE_OWNER`; `tests`/`schema` fail →
   `REWORK`; `evidence` missing or any gate `not_run` → `DEEP_REVIEW`.
   A failing or unrun gate can **never** be overridden by a model.
5. **System 1 result judge** chooses exactly one fixed decision:
   `ACCEPT`, `REWORK`, `DEEP_REVIEW`, `REQUIRE_OWNER`. `ACCEPT` is only
   reachable when every gate passed and provider confidence clears the
   threshold.
6. **Fail-closed abstention.** Ambiguous multi-intent and missing context
   are deterministic policy `block`s → `REQUIRE_OWNER` before any provider
   runs. Low confidence, conflicting top-2 signals (margin < 0.1),
   none-of-the-above, and sensitive/high-risk requests escalate to
   `REQUIRE_OWNER` (routing) or `DEEP_REVIEW`/`REQUIRE_OWNER` (judging) —
   never a guessed auto-route.

## Privacy boundary

Raw request text and raw business content stay **local** to deterministic
preprocessing — they never reach a provider adapter and are never persisted
in evaluation reports. Providers only ever see the allowlisted
`providerView.features` object from `buildProviderView()` (route) and
`buildJudgeProviderView()` (judge), containing **only**:

- `taskSignals` — hit counts per fixed task category
  (`status_report`, `script_task`, `local_llm`, `coding`, `autonomous`,
  `reasoning`, `no_action`)
- `riskFlags` — fixed enum only (`deploy_ops`, `paid_api`, `backup_ops`,
  `destructive`, `injection_pattern`, `untrusted_content`, `private_data`,
  `secret_material`, `absolute_path`)
- `capabilities` — fixed enum only (`repo_context`, `code_edit`,
  `long_running`, `local_only`, `generation`, `system_query`,
  `external_reasoning`, `none`)
- `ambiguity` — `{intentCount, multiIntent, insufficientContext}` counts/booleans
- `evidence` — `{attachmentCount, hasRepoContext}` counts/booleans
- `label` — contract slot for a redacted short label (≤48 chars, strict
  character allowlist via `sanitizeLabel`); **always `null` in this slice**
  because a sanitized label can equal the raw text for short inputs — no
  raw-derived content crosses the boundary at all

The local preprocessing that produces these features still enforces the hard
boundary rules:

- secret-like **field names** (`apiKey`, `token`, `password`, `env`,
  `credentials`, `cookie`, `privateKey`, …) are rejected at schema validation,
  anywhere in the object
- secret-looking values (`sk-…`, `ghp_…`, `AKIA…`, `xox…`, `Bearer …`,
  `-----BEGIN … PRIVATE KEY-----`) and `KEY=value` env dumps → policy
  **block** (`secret_material_in_request`) plus `secret_material` risk flag
- absolute private paths (`/Users/…`, `/home/…`, `~`, `/etc`, …) → policy
  warning plus `absolute_path` risk flag (never forwarded)
- raw file contents (text > 4000 chars) and attachment labels that are
  absolute paths are rejected
- local diagnostics (`scanLocalText`) record **counts only** in the decision
  record — never text

External/model text is always treated as untrusted input, never as
instructions.

## Contracts (all `schemaVersion: 1`, fixed enums, unknown fields rejected)

- `hermes.system1.route-request` — routing input (`request.text`,
  `request.untrustedContent`, optional minimized `context`) — **local only**
- `hermes.system1.provider-view` — allowlisted outbound feature object
  (`taskSignals`, `riskFlags`, `capabilities`, `ambiguity`, `evidence`,
  `label: null`) — the only thing a route adapter ever sees
- `hermes.system1.route-decision` — routing output (`policy`, observed
  `provider`, `final.route` + `determinedBy` + `reasons`, `boundary` counts)
- `hermes.system1.judge-request` — post-execution input (`route`,
  `execution.gates`, optional short `summary`) — **local only**
- `hermes.system1.judge-provider-view` — allowlisted outbound object
  (`route`, `gates`, `signals`, `label: null`)
- `hermes.system1.judge-decision` — judgment output (`gates`, observed
  `provider`, `final.decision`)
- `hermes.system1.eval-corpus` — labeled evaluation dataset
- `hermes.system1.eval-report` — deterministic comparison report

## Jev adapter contract

`createJevAdapter({ transport })` defines the future TypeSafe/Jev boundary:

- builds a minimized `jev.route-request.v1` / `jev.judge-request.v1` envelope
  carrying **only** the allowlisted feature object (requestId, features,
  fixed contract enums) — no text, no context, no summary
- calls the injected `transport.send(envelope)` — the only seam where a real
  network client would ever live
- validates the response kind, echoed requestId, fixed enums, confidence in
  [0,1], and probability normalization; **any** violation → fail-closed
  abstain (`invalid_provider_output` / `transport_unavailable`)
- no API key, no SDK dependency, no real request exists in this slice;
  `createOfflineTransport()` always throws, proving the fail-closed path

## Offline adapters

| adapter | role |
| --- | --- |
| `deterministic-baseline` | keyword/rule scoring, emits normalized probabilities |
| `fixture-probability` | replays `mockProvider` values from the corpus (probability validation exercised) |
| `jev-typesafe` (offline) | contract probe — offline transport always abstains; not gate-evaluated |

## Metrics

Route accuracy, **false-auto rate** (protected/`REQUIRE_OWNER`-expected cases
that still auto-routed — the most important metric), provider-level false-auto
(raw adapter output before policy/gates), abstention/escalation rate, judge
accuracy, deterministic-gate overrides, multi-class Brier score where
probabilities exist, and `latencyMs`/`costUsd` placeholders that are
explicitly `not_measured_offline`.

## Adoption gates (fail closed)

Per evaluated adapter: `false_auto_zero` (required — zero false-auto on
protected/high-risk cases before any live pilot is even discussable),
`protected_full_escalation`, `gate_precedence`, `route_accuracy_floor`,
`judge_accuracy_floor`. The report's recommendation is at most
`shadow_mode_candidate` — this slice can never recommend a live pilot.

## Staged adoption

```text
offline_corpus ─▶ shadow_mode ─▶ limited_low_risk_pilot ─▶ broader_use
```

1. **offline_corpus** (this slice): labeled synthetic corpus only.
2. **shadow_mode**: a real Jev transport may *observe* and *suggest*, but
   deterministic policy/gates still decide everything; measured against the
   same gates.
3. **limited_low_risk_pilot**: only after measured gates pass in shadow —
   low-risk routes only, owner-visible.
4. **broader_use**: only after sustained measured gates.

## Shadow mode (local instrumentation only)

`mini-server.mjs` can observe live intake with the deterministic baseline —
strictly observational, and **off by default**:

```bash
HERMES_SYSTEM1_SHADOW=1   # unset/anything else = legacy behavior, no field
```

When enabled, `POST /api/requests` runs `routeWithPolicy()` with
`createDeterministicBaselineAdapter()` **after** normal validation and
`classify()`, then persists a bounded `system1_shadow` record on the request.
Non-interference contract:

- the shadow result is **never** consulted by `type`, `resolved_type`,
  `risk`, `status`, approval gates, worker dispatch, or execution
- the System 1 text is the validated request `body` only (title is derived
  from the body and would skew signals); `context.source` is `console`;
  `hasRepoContext` is a boolean derived from the presence of `project.repo`
  — the path itself never leaves the request object
- persisted fields are a fixed allowlist: `kind`, `schemaVersion`,
  `observed_at`, `status`, `route`, `determinedBy`, `policyVerdict`,
  `confidence`, `abstained`, and `features`
  (`taskSignals`/`riskFlags`/`capabilities`/`ambiguity`/`evidence`
  — the same feature-only boundary as the provider view)
- **never** persisted: provider raw payloads, probabilities, raw text,
  reason codes or messages/explanations, secret-like values, env values,
  absolute paths, or arbitrary provider output
- **fail-open for operations, fail-closed for telemetry**: any shadow error
  (including a missing module — the import is lazy) leaves intake unchanged
  and persists only the fixed marker
  `{kind, schemaVersion, observed_at, status: "error"}` — no error message,
  no input content

Status: this is **local shadow instrumentation only** — it runs the local
deterministic baseline, makes no external calls, uses no credentials, and is
not a Jev integration. It produces evidence for the shadow-mode adoption
stage without changing any request behavior.

## Evaluation limitations

- The corpus is **synthetic** and Korean; it does not represent the real
  traffic distribution.
- Latency and cost are **not measured** offline.
- Jev/TypeSafe is **not integrated** — only the adapter contract is exercised;
  shadow mode runs the deterministic baseline only.
- Perfect offline scores are necessary but **not sufficient** evidence for
  production routing.

## CLI

```bash
node scripts/hermes-system1-eval.mjs                 # markdown report
node scripts/hermes-system1-eval.mjs --format json   # deterministic JSON
node scripts/hermes-system1-eval.mjs --adapters baseline,fixture
node scripts/hermes-system1-eval.mjs --corpus <path> --threshold 0.7 --accuracy-floor 0.7
```

Exit codes: `0` report produced and all gate-evaluated adapters pass;
`1` report produced but an evaluated adapter fails adoption gates;
`2` argument error or corpus rejection (unreadable, symlink, oversized,
malformed JSON, schema mismatch). Failure output never contains corpus
contents or request text.
