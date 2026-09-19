# Hermes Worker Runtime Install

How `scripts/hermes-local-worker.mjs` and `hermes-projects.json` are delivered to
`~/.local/share/hermes-ops/` and how to verify or roll back the install.
Everything here is repeatable and safe to re-run; nothing in this repo loads the
LaunchAgent or restarts services — operators apply the runtime.

## What the installer manages

`node scripts/hermes-runtime-install.mjs` (default mode is a dry-run **plan**):

| Artifact | Target | Notes |
|---|---|---|
| worker | `<runtime>/hermes-local-worker.mjs` | single self-contained file, mode 0755 |
| registry | `<runtime>/hermes-projects.json` | synced copy of the repo source of truth |
| LaunchAgent plist | `<runtime>/com.hyphen.hermes-ops-worker.plist` | generated template, **never loaded** |
| manifest | `<runtime>/hermes-runtime-manifest.json` | current-state evidence: sha256 + transaction + timestamp |
| journal | `<runtime>/hermes-runtime-journal.json` | append-only apply transaction log |
| runtime dirs | `requests/ locks/ worktrees/ persistence/` | created only if missing |

Safety properties:

- `.env` is never read, printed, or overwritten — the installer only stats it.
- Every write is a temp file + `rename(2)` in the same directory (atomic).
- Every `--apply` is journaled **before** files change: each entry records
  `existedBefore`, `action` (install/update/unchanged), `backup` path, and the
  post-apply sha256.
- Before replacing a diverged file the installer copies it to
  `<name>.backup-<transaction-id>` beside the target.
- `.env`, request artifacts, and any non-managed file are never touched.
- The runtime dir is `HERMES_RUNTIME_DIR` or `--runtime <dir>`
  (default `~/.local/share/hermes-ops`), so the whole flow can be rehearsed in a
  staging directory first.

## Commands

```bash
# 1. plan — show what would change, touch nothing
node scripts/hermes-runtime-install.mjs

# 2. apply — journal transaction, back up diverged files, atomic install + manifest
node scripts/hermes-runtime-install.mjs --apply

# 3. verify — checksums, node --check, module-load smoke test, journal/manifest consistency
node scripts/hermes-runtime-install.mjs --verify

# 4. verify + registry preflight against the installed copy
node scripts/hermes-runtime-install.mjs --verify --preflight

# rollback — undo the most recent applied transaction
node scripts/hermes-runtime-install.mjs --rollback
```

Exit codes: `0` success, `1` verify found errors (or warnings under `--strict`)
/ no transaction to roll back / rollback skipped entries, `2` argument,
journal, or filesystem failure.

Verify checks: per-file sha256 vs source, `node --check` on the installed
worker, a module-load smoke test that imports the worker and asserts its exports
without running `main()`, a scan rejecting relative imports (the worker must
stay a single file), registry JSON validity, runtime dirs, `.env` presence
(warning only — never read), journal health (corrupt or interrupted
transactions surface as warnings), manifest-vs-actual consistency, and
optionally the registry preflight tool.

## Rollback semantics

`--rollback` finds the newest journal transaction with status `applied`,
`in-progress`, or `rolled-back-partial` and restores the exact pre-apply state:

- `update` entries → the recorded `*.backup-<tx-id>` is copied back atomically.
- `install` entries (first-time install) → the file is **removed**, so a fresh
  `--apply` followed by `--rollback` returns the runtime to empty.
- Directories the apply created are removed if still empty.
- The transaction is marked `rolled-back` (or `rolled-back-partial` when entries
  were skipped) and the manifest is rewritten from the actual on-disk state —
  deleted entirely when no managed files remain. The journal stays as the audit
  trail.

If a managed file was edited *after* its apply, rollback skips it with a
warning and exits `1`; re-run with `--force` to restore/remove it anyway. If the
newest transaction is `in-progress` (an interrupted or partially compensated
apply), rollback treats it the same way — this is how a crashed install is
cleaned up.

## Failure handling during apply

If any step fails mid-apply, the installer automatically compensates: files
already written are removed (`install`) or restored from their backup
(`update`), and directories it created are removed. The transaction is marked
`failed` when compensation succeeds; if compensation itself fails it stays
`in-progress` so `--rollback` can finish the job. The error message states which
of these actually happened. A failed journal write aborts the apply before any
file changes, and a corrupt journal blocks both `--apply` and `--rollback`
until an operator inspects `hermes-runtime-journal.json` manually.

## First runtime bring-up (operator checklist)

The runtime dir must already contain a real `.env` with `HERMES_OPS_URL` and
`HERMES_WORKER_TOKEN` (see `.env.example` for keys). The installer reports
`env_missing` if it is absent and never creates a placeholder.

1. Rehearse in staging: `node scripts/hermes-runtime-install.mjs --runtime "$(mktemp -d)/rt" --apply --verify`
2. `node scripts/hermes-runtime-install.mjs` — review the plan for the real runtime dir.
3. `node scripts/hermes-runtime-install.mjs --apply`
4. `node scripts/hermes-runtime-install.mjs --verify --preflight` — expect zero errors; existing registry warnings (if any) still appear in preflight.
5. Install the LaunchAgent manually (not automated by this repo):
   ```bash
   cp ~/.local/share/hermes-ops/com.hyphen.hermes-ops-worker.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.hyphen.hermes-ops-worker.plist
   launchctl list | grep hermes-ops
   ```
   The plist runs `/bin/zsh -c 'set -a; source <runtime>/.env; set +a; exec node <runtime>/hermes-local-worker.mjs'`, so secrets stay in `.env` and out of the plist. Logs go to `~/Library/Logs/hermes-ops-worker*.log`.
6. To unload later: `launchctl unload ~/Library/LaunchAgents/com.hyphen.hermes-ops-worker.plist`

## Known warnings (2026-09-19 baseline)

`--verify --preflight` currently surfaces two `branch_not_found` warnings in the
installed registry — `MAKO` (`deploy/mako-20260712`) and `mako-client` (`main`).
These are stale local git refs in the MAKO checkouts, not install defects; they
are tracked separately and intentionally not auto-fixed.
