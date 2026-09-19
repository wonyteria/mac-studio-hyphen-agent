# Hermes Backup Readiness

Dry-run backup-readiness tooling for the Mac Studio operations boundary.
`scripts/hermes-backup-readiness.mjs` consumes the Hermes-owned manifest
`hermes-backup-manifest.json` and produces **inventory / verify / restore-plan
artifacts only**.

## Safety boundary

This slice is strictly read-only. It must never:

- create, copy, move, delete, restore, mount, schedule, or modify backups
- write any file, touch services, load/unload LaunchAgents, or edit schedules
- run `tmutil startbackup`, `launchctl` mutations, sqlite backup/copy commands
- read or print file contents other than hashing explicitly allowed data files
- traverse, stat, hash, or read protected names: `.env`, `.env.*`, `*.env`
  (`workers.env` included), `.dev.vars`, `auth.json`, `.netrc`, `.npmrc`,
  `.pgpass`, `*credential*`, `*secret*`, `*token*`, `*cookie*`, `*keychain*`,
  `*password*`/`passwd`, private keys (`*.key`, `*.pem`, `*.p12`, `*.pfx`,
  `*.ppk`, `*.keystore`, `*.kdbx`, `id_rsa`/`id_ed25519`/…), `.ssh`, `.gnupg`,
  `.aws`. Safe templates `.env.example`/`.env.sample`/`.env.template` are exempt.

There is **no `--apply` path**. `restore-plan` emits operator instructions only;
the only command it references is re-running this same read-only tool plus
manual operator steps.

Protected names inside a scanned directory are recorded as `kind: "protected"`
entries (name only — never statted, descended, or hashed). A manifest that
points a source or lstat-able target **directly** at a protected path segment
is rejected at load with `secret_path` (exit 2).

## Manifest contract (`hermes-backup-manifest.json`, schemaVersion 1)

Hermes-owned, versioned, explicit — no path is ever guessed. `~/…` expands to
the current user's home; all other paths must be absolute. Any deviation fails
closed: unknown fields, missing required fields, duplicate ids, bad enums,
relative paths, and the legacy identity marker in any string.

```jsonc
{
  "schemaVersion": 1,
  "kind": "hermes-backup-manifest",
  "manifestId": "mac-studio-ops-boundary",
  "updatedAt": "2026-09-19",              // ISO date/datetime
  "bounds": {                              // optional; may tighten defaults,
    "maxSources": 32,                      // never exceed the hard caps
    "maxEntriesPerSource": 4000,           // default 64 / 5000 / 8 / 32 MiB,
    "maxDepth": 6,                         // hard caps 128 / 50000 / 16 / 256 MiB
    "maxHashFileBytes": 33554432
  },
  "sources": [ /* … */ ],
  "targets": [ /* … */ ],
  "adapters": [ /* … optional … */ ]
}
```

### sources[]

| field | file | directory | sqlite |
|---|---|---|---|
| `id`, `path`, `label`, `required` | required | required | required |
| `expect` `{bytes?, sha256?}` | optional | — | — |
| `recursive`, `maxDepth`, `maxEntries`, `hashFiles`, `exclude[]` | — | optional | — |
| `sqlite` `{consistency, strategy}` | — | — | required |

- `type: "file"` — must resolve to a regular file. `expect` pins bytes and/or a
  lowercase sha256 hex; mismatches are `expect_bytes_mismatch`/`hash_mismatch`
  errors. Malformed hash metadata is a schema violation (exit 2).
- `type: "directory"` — must resolve to a directory. Traversal is name-sorted
  and bounded (`maxEntries`, `maxDepth`, `recursive` default true). `exclude[]`
  lists literal relative prefixes to skip. `hashFiles: true` allows sha256 of
  regular non-protected files ≤ `maxHashFileBytes` during `verify` — the only
  file-content access this tool performs.
- `type: "sqlite"` — `path` is the `.db` file; `-wal`/`-shm` sidecars are
  inspected as a set:
  - `at-rest` (no sidecars): consistent file-copy state → `ok` (+db sha256 in verify)
  - `live` (both sidecars): hot WAL → `unverified`, never a successful backup;
    the declared strategy must run first
  - `incomplete` (exactly one sidecar) → `incomplete_set` error
  - `stale` (sidecar without database) → `stale_sidecar` error
  - `missing` (db absent): required → error; optional → `unknown` informational
  - `consistency` ∈ `quiesce | online-backup`; `strategy` is a required
    documented procedure (e.g. stop writers vs `sqlite3 .backup`). The tool
    requires it to exist — it never performs it.

### targets[]

`{id, type, location, notes}` — all required. `type` ∈ `time-machine`,
`git-mirror`, `directory`, `external`. Targets describe where backups live;
only `directory`/`git-mirror` locations are lstat'd for `presence`
(`present`/`absent`/`symlink`/`unexpected`), `time-machine` resolves via its
adapter, `external` is never checked. Targets are restore-plan inputs — the
tool never writes to them.

### adapters[] (optional)

`{id, type, enabled, label?}` + `job` for `launchd`, `path` for `path`. Run only
with `--adapters`, honest statuses: `available` / `unavailable` (tool missing
or failed) / `unknown` (job not loaded, path absent, nothing parsed) /
`disabled`. Adapters are informational and never change the exit decision.

- `time-machine` → `tmutil destinationinfo` (read-only destination metadata)
- `launchd` → `launchctl list` parsed for the job label (pid, last exit status)
- `path` → lstat existence/kind only

## Modes and exit codes

```bash
node scripts/hermes-backup-readiness.mjs inventory      # metadata inventory (no hashing)
node scripts/hermes-backup-readiness.mjs verify         # + sha256/expect + sqlite set state
node scripts/hermes-backup-readiness.mjs restore-plan   # operator instructions; no fs access
# options: --manifest <path> --format human|json --adapters --strict
#          --max-manifest-bytes <n>
```

Manifest resolution: `--manifest` → `HERMES_BACKUP_MANIFEST` → the repo's
`hermes-backup-manifest.json`.

| code | meaning |
|---|---|
| 0 | complete — every **required** source is `ok` |
| 1 | any error finding, or any required source `unknown`/`unverified`, or warnings under `--strict` |
| 2 | argument error or manifest rejected (`manifest_unreadable`/`manifest_symlink`/`manifest_not_regular`/`manifest_too_large`/`manifest_parse_error`/`schema_mismatch`/`secret_path`) |

`unknown`/`unverified` is never reported as a successful backup: it drives
`summary.status: "unknown"` and exit 1 for required sources. Optional
(`required: false`) absences stay informational.

## JSON contract

```jsonc
{
  "kind": "hermes-backup-readiness",
  "schemaVersion": 1,
  "mode": "inventory|verify|restore-plan",
  "readOnly": true,
  "manifest": { "path", "manifestId", "schemaVersion", "updatedAt", "sourceCount", "targetCount" },
  "summary": { "status": "ok|unknown|error", "sources": n, "ok": n,
               "unknown": n, "unverified": n, "missing": n, "error": n,
               "errors": n, "warnings": n },
  "sources": [ { "id", "type", "label", "path", "required",
                 "status": "ok|unknown|unverified|error",
                 "detail": { /* file: bytes/mtimeMs/sha256/hashStatus/verified
                                directory: stats + sorted entries[]
                                sqlite: setState + database/wal/shm + strategy */ },
                 "findings": [ {"level": "error|warning", "code", "message", "path"?} ] } ],
  "targets": [ { "id", "type", "location", "notes", "presence" } ],
  "adapters": [ … ],   // only with --adapters
  "plan":    { … }     // only in restore-plan mode
}
```

Determinism: manifest order is the source order; directory entries are
name-sorted; no wall-clock, environment, or random input is consulted —
identical input state yields byte-identical output. Finding codes:
`missing_required`, `missing_optional`, `unreadable`, `source_symlink`,
`unexpected_type`, `path_escape`, `symlink_dangling`, `symlinks_skipped`,
`depth_limit`, `bounds_exceeded`, `hash_bound_exceeded`, `hash_mismatch`,
`expect_bytes_mismatch`, `expect_unverified`, `stale_sidecar`,
`incomplete_set`, `sidecar_symlink`, `scan_failed`.

## Restore rehearsal procedure

1. `verify --format json` — capture the current inventory; every required
   source must be `ok` before rehearsing. A `live` sqlite set means quiesce or
   the declared `online-backup` strategy has to produce a consistent artifact
   first — a plain file copy is not restorable.
2. `restore-plan` — review the five phases (preflight → quiesce → restore →
   verify → resume) with an operator. Rehearse against a **staging copy** of
   the manifest whose paths point at a scratch directory (`--manifest`), never
   against live paths.
3. During rehearsal the operator performs each step manually: pick the target
   snapshot, stop writers, restore files/dirs, restore the sqlite `.db`/`-wal`/
   `-shm` as a same-snapshot set (or restore the online-backup artifact), run
   `PRAGMA integrity_check`, then re-run `verify` and compare hashes and entry
   counts.
4. `preflight`/`verify` after the rehearsal — all required sources `ok`, zero
   findings, before resuming services.

## Remaining manual steps (never automated here)

- Running actual backups: Time Machine runs on its own schedule; the
  `com.hyphen.project-mirror-backups` job and mini deploy `*.backup-*`
  snapshots are owned by their own tooling — this tool only reads their status.
- The sqlite quiesce/online-backup strategy itself (e.g.
  `sqlite3 platform.db ".backup out.db"` or stopping `com.hyphen.mini-vercel`).
- Restoring protected files (`.env`, `auth.json`, tokens) — operators handle
  them from the backup directly; this tool never carries their contents.
- Docker volume data (e.g. `HERMES_DATA_FILE` at `/app/var/data/requests.json`
  inside the mini deploy container) — covered by the container's own backup
  story, not by host paths; inspect via the mini deploy tooling.
- Writer stop/start, LaunchAgent load/unload, and any schedule changes.
