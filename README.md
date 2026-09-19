# Hermes Mac Ops Console

Hermes is an internal Korean-first chat console for operating the Mac Studio deployment server without opening remote desktop.

The production deployment at `https://hermes.hyphen.it.com` currently runs the compact Node runtime in `mini-server.mjs` through the Mac Studio mini deploy service. The React/vinext app files remain in the repository, but the Docker production path uses `Dockerfile` plus `mini-server.mjs`.

## Current Capabilities

- password-protected internal chat UI
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

The input resolves from `--registry`, then `HERMES_BUSINESS_REGISTRY`, then the sibling `../Hyphen-Studio/outputs/registry.private.json` checkout. Symlinked, oversized, malformed, schema-mismatched, or hash-drifted inputs fail closed with exit 2. The input contract, ranking and tie-break rules, and the adapter boundary for future producers are documented in `BRIEFING.md`. This registry is unrelated to `hermes-projects.json` — it carries business facts, not deployment capabilities. The production Docker image does not ship the business-briefing modules or the Studio export — `scripts/hermes-system1.mjs` is the only shipped script — so the briefing is a CLI/library surface only, with no mini-server endpoint.

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
