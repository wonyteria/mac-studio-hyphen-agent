# Hermes Mac Ops Console

The **Hyphen Studio Agent** — an internal Korean-first chat console, powered by Hermes, for operating the Mac Studio deployment server without opening remote desktop. Hyphen Studio is the project cockpit; this agent is the execution and evidence surface.

The production deployment at `https://hermes.hyphen.it.com` currently runs the compact Node runtime in `mini-server.mjs` through the Mac Studio mini deploy service. The React/vinext app files remain in the repository, but the Docker production path uses `Dockerfile` plus `mini-server.mjs`.

## Current Capabilities

- password-protected internal chat UI branded as the Hyphen Studio Agent workspace
- empty-state action presets (오늘 브리핑 / 오늘 우선순위 / 막힌 프로젝트 / 사업 현황 갱신 점검 / Mac 상태 점검 / 배포 상태 확인) that only prefill the composer — never auto-submit or bypass approval; the briefing/priority/blocked/audit presets are true cross-project actions scoped to 전체 Hyphen Studio via the `studio_overview`/`studio_priorities`/`studio_blockers`/`studio_evidence_audit` types, while Mac/deployment presets stay selected-project scoped and the composer warns with type-specific Korean guidance when the selected project lacks the required capability (the backend gate still decides)
- bounded Studio handoff prefill: the Studio cockpit's `Agent에게 실행 요청` action opens `https://hermes.hyphen.it.com` with `?project=&type=&prompt=` query parameters that draft a new composer after login — validated fail-closed against the project registry and request-type allowlist, never auto-submitted, never bypassing approval
- truthful connection indicator driven by real API results, plus visible project context on the active request
- request queue persisted to the mini deploy data volume
- local LaunchAgent worker polling the queue from the Mac Studio
- on-demand local Hermes 4.3 chat with a memory-balanced 16K context and short idle retention
- natural-language auto routing that runs safe checks immediately and pauses mutations for approval
- fast Korean routing for obvious status/development/deploy/cleanup requests without loading the 36B model
- immediate safe checks for Mac/deployment/project status
- approval-required Hermes operations, file cleanup, and redeploy requests
- approved Codex edits with verification, Git push, mini deploy, and production health check
- production-verified natural-language development and redeploy flow
- live worker progress and bounded retry behavior

## Request Types

- `auto`: default mode; Hermes classifies plain Korean into chat, status, inspection, cleanup, redeploy, or development
- `hermes_chat`: tool-free Korean chat through local Hermes 4.3; cannot change the Mac
- `hermes_ops`: after approval, let Hermes 4.3 route the request into a fixed set of verified operations
- `mac_status`: collect machine status through deterministic native commands without model latency
- `deployment_status`: inspect mini deploy state and Docker container for a registered project
- `project_inspect`: summarize Git status, recent commits, and running container
- `redeploy`: approval-required mini deploy redeploy of the registered project
- `development`: after approval, run Codex in the registered repository, verify, commit, push, redeploy, and health-check
- `file_cleanup`: approval-required cleanup planning through Hermes MacOps tools
- `custom`: legacy alias for tool-free `hermes_chat`

## Studio Handoff Prefill

The Studio cockpit and admin request inbox can hand a selected project or intake request to this workspace through one `Agent에게 실행 요청` action. The action opens `https://hermes.hyphen.it.com` with three bounded query parameters — `project`, `type`, and `prompt` — that prefill a new composer draft.

`GET /` validates every value server-side in `scripts/hermes-prefill.mjs` before it is embedded as `window.__HERMES_PREFILL__`:

- `project` resolves only against the server-side registry (id, display name, slugged name, domain host or first label). Anything else falls back to the composer default — the URL can never name a registry path.
- `type` must be a composer-selectable request type, and capability-gated types (`deployment_status`, `project_inspect`, `redeploy`, `development`) additionally require the effective project's declared `capabilities`; failures degrade to `auto`.
- `prompt` is editable natural-language text capped at 2000 characters.
- Unknown or duplicated parameters, oversized values, control characters, and malformed encoding all fail closed to neutral defaults (`project: null`, `type: "auto"`, `prompt: ""`); unrelated parameters are ignored entirely.

The embedded object carries only `{project, type, prompt}` — the browser cannot supply a registry path, shell command, credential, approval, auto-submit flag, or execution state. After login, the workspace applies the draft once: it fills the composer fields, shows a `Studio에서 넘겨받은 초안` guidance notice, clears the value, and resets the URL. It never submits automatically and never bypasses login or approval — public Studio intake arrives as editable text the owner must review, send, and approve like any manual request.

The Dockerfile ships `scripts/hermes-prefill.mjs` alongside the server; no extra configuration is required.

## Project Registry

`hermes-projects.json` is the repo source of truth for deployed projects Hermes can see. It currently mirrors all 26 mini deploy projects for deployment status. Only Hermes Mac Ops, MAKO, Festival29 Card Studio, and mako-client have confirmed local repositories and therefore expose project inspection, approved development, and redeploy capabilities. The worker reads its runtime copy from `~/.local/share/hermes-ops/hermes-projects.json` (override: `HERMES_PROJECT_REGISTRY`).

Each project declares explicit `capabilities`. Mutation-capable entries also declare the exact repository, branch, Git remote, verification commands, persistent deployment files, and whether a successful change deploys automatically. Do not infer write access from a mini deploy record alone.

Registry health is checked and repaired without touching the running services:

```bash
# read-only validation; exits 1 on error-level findings
node scripts/hermes-registry-preflight.mjs

# dry-run migration plan (default: writes nothing)
node scripts/hermes-registry-migrate.mjs

# apply: timestamped backup + atomic in-place replace
node scripts/hermes-registry-migrate.mjs --apply
```

Rollback: copy the newest `hermes-projects.json.backup-*` back over the registry, or `git checkout -- hermes-projects.json` for the source copy. Before rebooting or handing the machine to another operator, run `node scripts/hermes-registry-preflight.mjs --strict` and confirm zero errors and zero warnings. Canonical path resolution rules, finding codes, and the full checklist live in `REGISTRY.md`.

## Business Briefing

Hermes can also read the Hyphen Studio **business registry** export (`outputs/registry.private.json`, `consumer: "hermes"`) and render a deterministic Korean briefing: today's top 3 priorities, blocked work, revenue/customer signals, system anomalies, and items needing owner approval. It is read-only — the registry file is never modified, only `organization === "hyphen"` projects enter the core briefing, and every item stays traceable to explicit fields plus evidence entries.

```bash
npm run briefing         # markdown briefing to stdout
npm run briefing:json    # machine-readable JSON

# custom input location / pinned source hash
node scripts/hermes-business-briefing.mjs --registry /path/registry.private.json
HERMES_BUSINESS_REGISTRY=/path/registry.private.json npm run briefing
node scripts/hermes-business-briefing.mjs --expect-hash <sha256>
```

The input resolves from `--registry`, then `HERMES_BUSINESS_REGISTRY`, then the sibling `../Hyphen-Studio/outputs/registry.private.json` checkout. Symlinked, oversized, malformed, schema-mismatched, or hash-drifted inputs fail closed with exit 2. The input contract, ranking and tie-break rules, and the adapter boundary for future producers are documented in `BRIEFING.md`. This registry is unrelated to `hermes-projects.json` — it carries business facts, not deployment capabilities.

The agent workspace also exposes this briefing through three allowlisted request types: `studio_overview` (오늘 브리핑 preset — all five sections: 오늘의 상위 우선순위 / 막힌 일 / 매출·고객 신호 / 시스템 이상 / 소유자 승인이 필요한 일), `studio_priorities` (오늘 우선순위 preset), and `studio_blockers` (막힌 프로젝트 preset). A fourth type, `studio_evidence_audit` (사업 현황 갱신 점검 preset), renders a deterministic review checklist instead: per hyphen-core project it lists fields still carrying explicit unset markers (unknown/null/empty) plus pending `nextEvidence` asks, with a fixed priority rule (unverified evidence first), aggregate gap counts, and the top 10 review items — nothing is inferred or written back. The same builder backs `GET /api/business/audit` (`{state, audit}`, admin session only). All are generated **synchronously inside `mini-server.mjs`** — no LLM, no worker dispatch, no approval, no external call — from the same `loadBusinessRegistry` + `buildBusinessBriefing`/`buildEvidenceAudit` logic, and render a bounded Korean owner-facing result (project names, summaries, blocker descriptions, verification flags, coverage counts) plus safe freshness metadata (a generic source label and `updatedAt`). Output is deterministic and double-bounded: items are capped per section (5 for overview, 8 for single views, 50 for the audit) and every registry-derived field is flattened to one line and character-capped, with a deterministic per-section character budget so all five overview headers and the coverage line always fit inside the 4000-char result cap. Raw registry JSON, evidence refs, owner names, paths, source filenames, loader messages, and any source-hash material are never stored or shown; a failed briefing persists only a bounded allowlisted error code internally.

**Deployment contract:** the image ships `scripts/hermes-business-registry.mjs` but never the private export. The destination file reaches the runtime either through the automated sync tool below (the supported path — it lands at `HERMES_BUSINESS_REGISTRY`, production: `/app/var/data/business/registry.private.json` inside the persistent data volume) or through a one-off manual copy for pinned deployments. `HERMES_BUSINESS_REGISTRY_EXPECTED_HASH` (lowercase sha256) is a **manual-deploy pin only**: in auto-sync mode it must stay unset, because every Studio export legitimately changes `sourceHash` and a static pin would reject every update. The trust anchor in auto-sync mode is that only the sync tool writes the destination — after full schema validation, atomically — and Hermes still re-validates the file fail-closed on every read. The client can never supply a path. When the file is absent or fails validation, studio requests complete as `failed` with a fully generic unavailable state — only a bounded allowlisted error code is persisted internally, never loader messages, paths, or deployment detail — so a mounted, valid export is a prerequisite for this capability, and missing data is never reported as "no priorities" or "no blockers".

## Business Registry Sync

`scripts/hermes-registry-sync.mjs` keeps the container's business registry current: it validates a Studio export copy and atomically mirrors it into Hermes persistent data — the only writer of the destination file.

**launchd boundary (important):** a LaunchAgent cannot `open()` anything under TCC-protected or cloud-backed directories — the syscall suspends forever instead of failing, so a job pointing at `~/Documents` hangs with empty logs before a single line of tool code runs. The contract therefore keeps **every** launchd-touched path outside protected prefixes:

- `install` **stages the tool itself** — both `hermes-registry-sync.mjs` and `hermes-business-registry.mjs` are copied verbatim (0600, atomic) to a stage dir (default `~/Library/Application Support/Hyphen/hermes-registry-sync/tool`, override `--stage-dir`/`HERMES_REGISTRY_SYNC_STAGE_DIR`) and the plist references only the staged copy — never the repo path.
- The `--source` should be a **mirror** the Studio export refreshes, not the export itself: `npm run export:registry` in Hyphen-Studio reads the recorded config and atomically rewrites the mirror (see below). Studio runs in the operator's TCC-granted context; the agent never touches the Studio checkout.
- `install` **refuses** any source/destination/status/stage-dir path under `Documents`, `Desktop`, `Downloads`, `Library/Mobile Documents`, or `Library/CloudStorage` — `--allow-protected-paths` is the explicit override for operators who arranged access (e.g. MDM-granted FDA).

```bash
# one-shot sync (validates, then temp + fsync + rename; skips when unchanged)
node scripts/hermes-registry-sync.mjs sync \
  --source "/path/to/mirror/registry.private.json" \
  --destination "/path/to/project-data/<project>/business/registry.private.json"

# dry-run: validate + plan, writes nothing
node scripts/hermes-registry-sync.mjs sync --source ... --destination ... --dry-run

# macOS LaunchAgent: stage tool + install / remove / inspect (explicit commands only)
node scripts/hermes-registry-sync.mjs install --source <mirror> --destination <dest>   # stage + plist + bootstrap
node scripts/hermes-registry-sync.mjs install --source <mirror> --destination <dest> --no-load   # stage + plist only
node scripts/hermes-registry-sync.mjs status --destination <dest>                     # last sync + agent + staged tool
node scripts/hermes-registry-sync.mjs uninstall                                       # bootout + plist + staged tool + config
```

Path contract: `--source`/`HERMES_REGISTRY_SYNC_SOURCE` and `--destination`/`HERMES_REGISTRY_SYNC_DESTINATION` are **required and explicit-only** — the tool never infers the mini deploy data path from `hermes-projects.json` and has no baked-in fallback. Only the status file defaults: `<destination dir>/registry-sync-status.json` (override `--status`/`HERMES_REGISTRY_SYNC_STATUS`). `install` resolves just the operator's HOME and the current Node binary, stages the tool, and bakes the explicit paths into `~/Library/LaunchAgents/com.hyphen.hermes-registry-sync.plist` (`RunAtLoad` + `StartInterval 300`); a sibling `registry-sync.lock` prevents overlapping runs (a lock records its pid so a late release can never steal a newer run's lock).

Sync-paths config: `install` persists the explicit paths to `~/Library/Application Support/Hyphen/hermes-registry-sync/sync-paths.json` (0600, outside every repository — local-only by construction). The Studio export reads this config and mirrors to its `source`; `uninstall` removes it.

Watchdog: `HERMES_REGISTRY_SYNC_TIMEOUT_MS` bounds the whole sync pass (default 60s). A wedged `open()` — protected path, dataless cloud file, dead mount — cannot be unwound (even `process.exit()` would hang joining the dead threadpool thread), so on timeout the tool records a bounded `sync_timeout` status and self-terminates with `SIGKILL` instead of leaving a zombie that blocks the next interval. Normal runs exit in milliseconds; timers are unref'd and cancelled on settle.

Safety: source and destination symlinks are rejected; size, schema, and `sourceHash` are validated on every run before anything is written; the destination is replaced only via same-directory temp + fsync + `rename` at mode `0600`, so a failed run always preserves the last-known-good file. Each run also writes the allowlisted status JSON — `status` (`synced`/`unchanged`/`error`), `checkedAt`, `syncedAt`, `registryUpdatedAt`, `projectCount`, `errorCode` — with no business content, paths, hashes, or error text, and `sync` output itself stays path-free so launchd logs carry no local paths.

The workspace header shows a read-only freshness pill fed by `GET /api/business/status` (admin session only): `사업 데이터 최신` when the registry loads and a recent clean sync confirms it, `사업 데이터 지연` when the registry loads but the sync witness is missing, errored, or older than ~10 minutes (`HERMES_BUSINESS_REGISTRY_STALE_MS`), and `사업 데이터 사용 불가` when the registry cannot be loaded. The endpoint returns only `{state, checkedAt, syncedAt, registryUpdatedAt, projectCount, errorCode}` — never paths, hashes, or registry content — and is not connected to the request queue, approvals, or the worker. Server-side the status file resolves from `HERMES_BUSINESS_REGISTRY_STATUS` or the sibling of `HERMES_BUSINESS_REGISTRY`.

Rollback/verification: `status` prints the last recorded outcome, agent state, staged tool, and config presence (exit 1 when the last run errored); `uninstall` removes the agent, plist, staged tool copy, and sync-paths config — the synced destination and status file are left in place untouched; to return to manual mode, uninstall the agent, pin `HERMES_BUSINESS_REGISTRY_EXPECTED_HASH`, and copy a verified export by hand. Re-run `install` after repo updates to refresh the staged copy.

## Backup Readiness

`scripts/hermes-backup-readiness.mjs` is a strictly read-only dry-run tool for the Mac Studio operations boundary. It consumes the Hermes-owned `hermes-backup-manifest.json` — a versioned manifest declaring explicit backup sources (`file`, `directory`, `sqlite` with db/WAL/SHM set handling and a required quiesce-or-online-backup strategy) and targets — and produces deterministic inventory, verification, and restore-plan artifacts. It never creates, copies, deletes, restores, or schedules anything, and there is no `--apply` path.

```bash
node scripts/hermes-backup-readiness.mjs inventory      # bounded metadata inventory
node scripts/hermes-backup-readiness.mjs verify         # + sha256/expect checks + sqlite set state
node scripts/hermes-backup-readiness.mjs restore-plan   # operator instructions only
# --manifest <path> --format human|json --adapters --strict
```

Exit codes: `0` all required sources verified `ok`, `1` error findings or unknown/unverified required state (unknown is never reported as a successful backup), `2` argument error or manifest rejected (malformed, oversized, symlinked, schema mismatch, duplicate ids, invalid hash metadata, protected/secret path). Secret-named entries (.env, workers.env, credentials, tokens, cookies, keychains, private keys) are never traversed, statted, hashed, or read. Optional `--adapters` report honest Time Machine (`tmutil destinationinfo`) and launchd job status without changing schedules. The full safety boundary, manifest schema, JSON contract, and restore rehearsal procedure live in `BACKUP.md`.

## System 1 Decision Layer (offline evaluation)

`scripts/hermes-system1.mjs` is an evaluation-first System 1 decision layer inspired by TypeSafe Jev — **offline evaluation and architecture only**. Deterministic policy rules own hard allow/warn/block/route constraints first; a provider adapter then picks one fixed route (`NO_ACTION`, `LOCAL_SCRIPT`, `LOCAL_LLM`, `GPT`, `CODEX`, `DEVIN`, `REQUIRE_OWNER`); post-execution, deterministic verification gates run before a result judge picks one fixed decision (`ACCEPT`, `REWORK`, `DEEP_REVIEW`, `REQUIRE_OWNER`). Failing or unrun gates, low confidence, conflicting signals, sensitive/high-risk requests, and missing context always escalate fail-closed — a model can never override them. Nothing executes here; System 2 work happens elsewhere.

```bash
node scripts/hermes-system1-eval.mjs                 # markdown comparison of offline adapters
node scripts/hermes-system1-eval.mjs --format json   # deterministic JSON report
node scripts/hermes-system1-eval.mjs --adapters baseline,fixture   # subset selection
# --corpus <path> --threshold 0.7 --accuracy-floor 0.7
```

The CLI evaluates a deterministic baseline adapter, a fixture-probability mock, and a Jev **contract probe** (injectable transport, always-offline — no API key, SDK, or real request) against the labeled Korean synthetic corpus `eval/system1-corpus.json`. Reports include route accuracy, false-auto rate (must be zero on protected cases), abstention rate, judge accuracy, gate-precedence overrides, Brier calibration where probabilities exist, and `not_measured_offline` latency/cost placeholders. Adoption gates fail closed: exit `1` when any evaluated adapter fails (false-auto on protected/high-risk cases must be zero before any live pilot), `2` on argument/corpus rejection, `0` when all evaluated adapters pass. Provider inputs are an allowlisted feature object only — fixed-enum task categories, risk flags, capability requirements, ambiguity/evidence counts — derived by local deterministic preprocessing; raw request text, raw business content, absolute private paths, secret-like fields/values, raw file contents, and env contents never cross the boundary or reach evaluation reports. The intended flow, Jev adapter contract, evaluation limits, and staged adoption (offline corpus → shadow mode → limited low-risk pilot → broader use) are documented in `SYSTEM1.md`. Jev is **not** integrated and this layer is not production-ready.

**Shadow mode (local instrumentation only).** Setting `HERMES_SYSTEM1_SHADOW=1` on the mini-server makes `POST /api/requests` additionally run `routeWithPolicy()` with the deterministic baseline **after** validation/classification and persist a bounded `system1_shadow` record on the stored request: schema/version, `observed_at`, final route, `determinedBy`, policy verdict, confidence/abstain status, and the allowlisted feature/risk data only. It never changes `type`, `resolved_type`, `risk`, `status`, approval gates, worker dispatch, or execution, and never persists provider payloads, probabilities, raw text, explanations, secret-like values, env values, or absolute paths. Any shadow failure degrades to a fixed `status: "error"` enum marker and cannot affect request creation. Default off = legacy behavior with no field. No external calls, no credentials — see `SYSTEM1.md` for the full non-interference and privacy contract.

In the workspace UI, a stored `system1_shadow` with `status: "ok"` renders a compact Korean `빠른 판단` panel (route, policy verdict, confidence) labeled `관찰 전용 · 실행에 영향 없음`; an `error` record shows only a neutral unavailable state. Raw features, reasons, source text, paths, and provider data are never rendered.

`GET /api/system1/summary` is an admin-only, read-only traffic-coverage aggregate. It returns a strict count allowlist — kind/schema, `totalEligibleRequests` (every valid stored request), `observedOk`/`observedError` (requests carrying the bounded `system1_shadow` marker — an error marker still counts as observed), route counts, policy verdict counts, and abstained count (status `ok` records only), plus `coverageRate` = (`observedOk` + `observedError`) / `totalEligibleRequests`, or `0` when there are no eligible requests — with no request ids, titles, bodies, results, events, timestamps, features, or paths, and makes no external calls. The workspace shows a small evidence summary only when records exist.

```text
~/Documents/Hyphen Source Repositories/<RepoName>   # canonical source checkouts (e.g. Hyphen-Hermes-Ops, 29sfilm-card-studio)
~/Desktop/hyphen/<project>/develop_source/          # additional canonical roots (e.g. mako backend/frontend)
~/.local/share/hermes-ops/                          # worker runtime, queue, locks, worktrees, and backups
~/Library/Logs/hermes-ops-worker*.log               # LaunchAgent logs
```

All worker path defaults are derived from the current user's home directory — no account name is hardcoded. Repo paths under another user's home are treated as legacy and flagged by preflight.

## Worker Runtime

The worker source lives at `scripts/hermes-local-worker.mjs`. The LaunchAgent runs the copied runtime script from:

```text
~/.local/share/hermes-ops/hermes-local-worker.mjs
```

Required environment values are loaded by the existing wrapper/env setup:

- `HERMES_OPS_URL`
- `HERMES_WORKER_TOKEN`
- `CODEX_REQUEST_DIR`
- optional `HERMES_PROJECT_REGISTRY`
- optional `MINI_VERCEL_URL`
- optional `MINI_VERCEL_ADMIN_TOKEN`

If `MINI_VERCEL_ADMIN_TOKEN` is not set, the worker reads the mini deploy app env file on the Mac Studio.

The runtime install is repeatable and staging-friendly — see `RUNTIME.md` for the full procedure and the operator LaunchAgent checklist:

```bash
node scripts/hermes-runtime-install.mjs            # dry-run plan
node scripts/hermes-runtime-install.mjs --apply    # backup + atomic install into the runtime dir
node scripts/hermes-runtime-install.mjs --verify --preflight
node scripts/hermes-runtime-install.mjs --rollback # restore newest *.backup-*
```

The installer never reads or writes `.env`, never loads the LaunchAgent, and accepts `--runtime <dir>` (or `HERMES_RUNTIME_DIR`) for rehearsal in a staging directory.

## Development Pipeline

An approved development request runs this sequence:

1. acquire a per-project lock and fetch the registered remote branch
2. create a request-specific detached Git worktree without local secret files
3. run `codex exec --sandbox workspace-write --ephemeral --json` inside that worktree
4. reject protected files and paths outside the registered repository
5. run every `verifyCommands` entry from the project registry
6. commit with the Lore decision trailers and push the registered branch
7. preserve configured deployment data, request a mini deploy redeploy, restore the data, and check `/health`

Codex does not receive Hermes, mini deploy, password, or token environment variables. Successful worktrees are removed after deployment; failed worktrees remain under the Hermes runtime directory for inspection without dirtying the operator's checkout.

## Safety Model

Hermes does not expose arbitrary shell execution from the website. In the default auto mode, the model only chooses a fixed operation enum. Safe inspection jobs continue immediately; cleanup, code changes, and deployment-changing jobs return to `approval_required` before any side effect. A canceled or failed safe request can be queued again, while a mutation retry requires fresh approval. The worker, not the model, owns command arguments and filesystem boundaries. Claim tokens and heartbeats prevent an old or duplicated worker from completing another worker's request.

The worker starts Ollama only when a Hermes model request arrives. It limits the server to one loaded model and one parallel generation, uses the `hermes-4.3-admin-fast-iq4xs-32k` quantization already stored on the Mac Studio with a 16K runtime context, and lets the model unload after two idle minutes. This keeps routine status requests fast and avoids permanently reserving roughly 28 GB for the model and context cache.
