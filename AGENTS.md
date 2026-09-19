# Hermes Mac Ops Console — agent notes

Internal Korean-first chat console that operates the Mac Studio deployment server.

## Layout

- `mini-server.mjs` — production web gateway (request queue, auth, capability gates). Reads `hermes-projects.json` via `HERMES_PROJECTS_FILE`. `GET /` renders the Studio handoff prefill via `scripts/hermes-prefill.mjs` (`?project=&type=&prompt=` only).
- `scripts/hermes-prefill.mjs` — bounded Studio→Hermes composer prefill contract: validates `project`/`type`/`prompt` query params against the registry and request-type allowlist, fails closed to neutral defaults on unknown/duplicate/oversized/control-character/malformed values, and serializes only `{project, type, prompt}` for safe embedding. No registry paths, shell commands, credentials, approval, auto-submit, or execution state can cross; the draft never submits itself.
- `scripts/hermes-local-worker.mjs` — Mac Studio worker. Deployed as a **single self-contained file** to `~/.local/share/hermes-ops/`; it must not import sibling modules. All path defaults derive from `os.homedir()` — never hardcode `/Users/<name>`.
- `scripts/hermes-project-registry.mjs` — shared registry library: canonical path resolution, validation, migration planning.
- `scripts/hermes-registry-preflight.mjs` — read-only registry validator (exit 0/1/2).
- `scripts/hermes-registry-migrate.mjs` — registry migration; dry-run by default, `--apply` does backup + atomic replace.
- `scripts/hermes-runtime-install.mjs` — worker runtime installer: plan (dry-run) / `--apply` / `--verify` / `--rollback`. Never reads or writes `.env`; atomic writes + timestamped backups; generates (but never loads) the LaunchAgent plist.
- `scripts/hermes-business-registry.mjs` — Studio **business** registry reader (distinct from the deployment registry): fail-closed schema validation, safe file loading, deterministic briefing builder + markdown renderer. Read-only.
- `scripts/hermes-business-briefing.mjs` — briefing CLI consuming `../Hyphen-Studio/outputs/registry.private.json` (override: `HERMES_BUSINESS_REGISTRY` / `--registry`). Exit 0/2.
- `scripts/hermes-backup-manifest.mjs` — backup-readiness manifest contract + scanner: fail-closed schema validation, protected-name guard, bounded deterministic traversal, inventory/verify/restore-plan builders, read-only adapters (tmutil/launchd/path). Read-only.
- `scripts/hermes-backup-readiness.mjs` — readiness CLI (modes `inventory`/`verify`/`restore-plan`; default manifest `hermes-backup-manifest.json`, override `HERMES_BACKUP_MANIFEST` / `--manifest`). Dry-run only, no `--apply` path. Exit 0/1/2.
- `hermes-backup-manifest.json` — Hermes-owned versioned backup manifest for the Mac Studio ops boundary: explicit sources (file/directory/sqlite) and targets. Schema in `BACKUP.md`.
- `scripts/hermes-system1.mjs` — System 1 decision-layer library (offline only): versioned route/judge/corpus contracts, deterministic policy rules, redacted provider boundary, adapter interface (deterministic baseline, fixture-probability, Jev injectable-transport contract), verification gates, metrics, adoption gates, markdown renderer. No API calls, no SDK, no execution.
- `scripts/hermes-system1-eval.mjs` — offline evaluation CLI comparing adapters on `eval/system1-corpus.json` (override: `HERMES_SYSTEM1_CORPUS` / `--corpus`). Exit 0/1/2; exit 1 when any evaluated adapter fails adoption gates.
- `eval/system1-corpus.json` — labeled Korean synthetic eval corpus (route + judge cases). Synthetic only — no real traffic or secrets. Schema in `SYSTEM1.md`.
- `hermes-projects.json` — source-of-truth project registry. Runtime copy lives at `~/.local/share/hermes-ops/hermes-projects.json`.
- `REGISTRY.md` — registry behavior trace, capability→path rules, resolution/migration rules, pre-reboot checklist.
- `RUNTIME.md` — runtime install/verify/rollback procedure and the operator LaunchAgent bring-up checklist.
- `BRIEFING.md` — Studio business registry input contract, section/ranking rules, fail-closed behavior, and the future-adapter input boundary.
- `BACKUP.md` — backup-readiness safety boundary, manifest schema, exit codes, JSON contract, restore rehearsal, and remaining manual steps.
- `SYSTEM1.md` — System 1 decision-layer flow, privacy boundary, Jev adapter contract, evaluation limits, and staged adoption (offline corpus → shadow → limited pilot → broader).
- `tests/*.test.mjs` — node:test suites.

## Commands

```bash
npm run test:runtime        # node --test tests/rendered-html.test.mjs tests/project-registry.test.mjs tests/runtime-install.test.mjs tests/business-briefing.test.mjs tests/backup-readiness.test.mjs tests/system1.test.mjs tests/system1-shadow.test.mjs tests/studio-briefing.test.mjs tests/prefill.test.mjs
npm run lint                # eslint .
node --check <file.mjs>     # syntax check worker/server scripts
node scripts/hermes-registry-preflight.mjs   # registry health (read-only)
node scripts/hermes-runtime-install.mjs      # runtime install plan (dry-run; --apply/--verify/--rollback)
node scripts/hermes-business-briefing.mjs    # Studio business briefing (read-only; --format json|--registry|--expect-hash)
node scripts/hermes-backup-readiness.mjs inventory      # backup-boundary inventory (read-only; --format json|--adapters|--strict)
node scripts/hermes-backup-readiness.mjs verify         # + sha256/expect checks + sqlite set state
node scripts/hermes-backup-readiness.mjs restore-plan   # operator restore instructions only (no --apply)
node scripts/hermes-system1-eval.mjs                  # System 1 offline adapter comparison (read-only; --format json|--corpus|--adapters|--threshold)
```

## Rules for changes

- Preserve existing local changes; never `git reset`/`clean` or bulk-revert.
- The worker, registry tools, and docs must not depend on a specific user account. Legacy `/Users/<other>/...` paths are migration inputs, not defaults.
- Do not touch the runtime registry, LaunchAgents, or service processes from this repo — ship code + procedures, operators apply them.
- `project_inspect`/`development` capabilities require a real local `repo` + `branch` + `gitRemote`; `deployment_status`/`redeploy` only need `miniVercelProjectId`. See `REGISTRY.md`.
- The backup-readiness tool stays read-only: no `--apply` path, no backup/restore execution, no schedule changes. `unknown`/`unverified` is never reported as backup success, and protected names (.env, workers.env, credentials, tokens, cookies, keychains, private keys) are never traversed or read. See `BACKUP.md`.
- The System 1 layer is offline evaluation only: no external API calls, no execution, deterministic policy/gates always outrank provider output, and provider inputs are an allowlisted feature object only (fixed-enum task categories, risk flags, capability requirements, ambiguity/evidence counts, `label: null`) — raw request text, raw business content, absolute private paths, secret-like fields/values, raw file contents, and env contents never cross the boundary or reach reports. See `SYSTEM1.md`.
- No pushes unless explicitly requested.
