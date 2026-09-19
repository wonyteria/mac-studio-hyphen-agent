# Hermes Project Registry

How `hermes-projects.json` is produced, loaded, and kept pointed at real local repositories.

## Who reads the registry

Two runtimes consume the same JSON document (`{ "projects": [...] }`):

- `mini-server.mjs` (web console) reads `HERMES_PROJECTS_FILE` (default `/app/hermes-projects.json` in Docker). It uses only `id`, `name`, `domain`, `capabilities`, and `miniVercelProjectId`:
  - `GET /api/projects` returns those public fields for the project picker.
  - `POST /api/requests` rejects a request when the target project lacks the requested capability.
  - `POST /api/worker/plan` rejects an auto-mode plan whose resolved type the project does not support.
  - The gateway never reads `repo`, `branch`, `gitRemote`, or `github`. Broken local paths cannot crash the site, but they make repo-backed capabilities fail on the worker.
- `scripts/hermes-local-worker.mjs` reads `HERMES_PROJECT_REGISTRY` (default `~/.local/share/hermes-ops/hermes-projects.json`). `getProject()` enforces capability membership per request and additionally requires `repo`, `branch`, and `gitRemote` for `project_inspect` and `development`. `project.repo` is then used by `git -C` commands, worktree creation, the `realpath` repository-root check, `assertProjectPath`, and the `verifyCommands` working directory. `redeploy` and `deployment_status` do not use `repo` at all — they only call the mini deploy API.

The worker is deployed as a single self-contained file (it is copied to `~/.local/share/hermes-ops/`). It therefore must not import sibling modules; all shared registry logic lives in `scripts/hermes-project-registry.mjs` for the CLI tools, while the worker keeps its own small `homedir()`-derived defaults.

## Capability → filesystem requirements

| Capability | Needs `miniVercelProjectId` | Needs `repo` + `branch` + `gitRemote` |
|---|---|---|
| `deployment_status` | yes | no |
| `redeploy` | yes | no |
| `project_inspect` | yes | yes |
| `development` | yes | yes |

A project that declares `project_inspect` or `development` with a missing/legacy/broken `repo` is an error. The same broken `repo` on a `deployment_status`-only project is a warning, because nothing reads it.

## Runtime path defaults (worker)

All worker defaults are derived from `os.homedir()`; nothing assumes a specific username. Environment variables override every default:

| Purpose | Env override | Default |
|---|---|---|
| Runtime root | `HERMES_RUNTIME_DIR` | `~/.local/share/hermes-ops` |
| Request artifacts | `CODEX_REQUEST_DIR` | `$RUNTIME/requests` |
| Project registry | `HERMES_PROJECT_REGISTRY` | `$RUNTIME/hermes-projects.json` |
| Project locks | `HERMES_PROJECT_LOCK_DIR` | `$RUNTIME/locks` |
| Worktrees | `HERMES_WORKTREE_DIR` | `$RUNTIME/worktrees` |
| Persistence backups | `HERMES_PERSISTENCE_BACKUP_DIR` | `$RUNTIME/persistence` |
| mini deploy env file | `MINI_VERCEL_ENV_PATH` | `~/Library/Application Support/Hyphen/mini-vercel/app/.env` |
| mini deploy workspaces | `MINI_VERCEL_WORKSPACE_ROOT` | `~/Library/Application Support/Hyphen/mini-vercel/runner-workspaces` |
| Codex binary | `CODEX_BIN` | `~/.local/node-current/bin/codex` |

## Canonical path resolution

Implemented by `scripts/hermes-project-registry.mjs` and used by the preflight and migration tools.

A declared `project.repo` is classified as:

- `ok` — exists, is a directory, contains a `.git` (directory or worktree pointer)
- `legacy` — absolute path under another `/Users/<name>` home that is not the current one (`/Users/Shared` is excluded)
- `missing` — does not exist
- `broken_symlink` — exists as a symlink whose target is gone
- `not_git` — exists but is not a Git worktree
- `unset` — no `repo` declared

Resolution order:

1. If the declared `repo` is `ok`, it wins — nothing is searched.
2. Otherwise each repo search root is scanned (max depth 3, skipping dot-dirs and `node_modules`) for a directory whose Git remote URL — parsed from `.git/config`, following `commondir` for worktrees — normalizes equal to `project.github` (`git@` and `https` forms, `.git` suffix and case ignored).
3. Exactly-one or multiple matches: the match under the earliest-declared root wins; remaining matches are reported as `alternates`. Zero matches → `unresolved` and nothing is guessed.

Default search roots, in priority order (`HERMES_REPO_ROOTS`, colon-separated, replaces the list):

1. `~/Documents/Hyphen Source Repositories`
2. `~/Documents/Codex/projects`
3. `~/Desktop/hyphen`

## Preflight validator (read-only)

```bash
node scripts/hermes-registry-preflight.mjs [--registry PATH] [--roots a:b:c] [--project ID] [--no-git] [--json] [--strict]
```

Registry selection order: `--registry` flag, `HERMES_PROJECT_REGISTRY`, `~/.local/share/hermes-ops/hermes-projects.json`, then the repository copy. The tool never writes anything.

Exit codes: `0` all checks pass (warnings allowed), `1` at least one error-level finding (or warnings under `--strict`), `2` the registry or arguments could not be read.

Finding codes: `missing_id`, `missing_capabilities`, `unknown_capability`, `missing_mini_vercel_id`, `incomplete_repo_config`, `legacy_repo_path`, `broken_symlink`, `missing_repo_path`, `repo_not_git`, `remote_missing`, `remote_url_mismatch`, `branch_not_found`.

## Registry migration

```bash
node scripts/hermes-registry-migrate.mjs [--registry PATH] [--roots a:b:c] [--backup-dir DIR] [--json]
node scripts/hermes-registry-migrate.mjs --apply   # required for any write
```

- Default is dry-run: prints the planned edits, touches no file.
- A change is planned only when `repo` is legacy/missing/broken/not-git and exactly one best canonical match exists, or when `gitRemote` names a remote the resolved repo lacks while another remote already points at `project.github`.
- Edits are applied surgically inside each project object so one-line status-only entries keep their formatting.
- `--apply` first copies the original to `hermes-projects.json.backup-<timestamp>` (in `--backup-dir` or beside the registry), verifies the edited JSON parses with the same project count, writes a temp file in the same directory, then `rename(2)`s it into place — atomic on the same filesystem.
- If anything fails before or during the swap, the original is restored from the backup and the command exits `2`.
- Unresolved or ambiguous projects are skipped and reported, never guessed. Exit `1` after apply means changes were written but some projects still need manual work.
- Migration resolves repos by matching `project.github` to a local remote URL. If the registry's `github` fields are stale (for example an older runtime copy still pointing at a previous GitHub organization), URL matching finds nothing and every entry reports `unresolved`. Sync the corrected source `hermes-projects.json` to the runtime location — or fix the `github` fields first — then re-run the migration.

Rollback: copy the newest `hermes-projects.json.backup-*` back over the registry path (or `git checkout -- hermes-projects.json` for the source copy). No restart is required for the gateway; the worker reads the file per request.

## Pre-reboot / pre-change checklist

1. `node scripts/hermes-registry-preflight.mjs --strict` — expect `통과` with zero errors and zero warnings.
2. If errors reference `legacy_repo_path` or `missing_repo_path`, run the migration dry-run, review the plan, then `--apply`.
3. Re-run preflight. Remaining `branch_not_found` warnings usually mean stale local refs — `git -C <repo> fetch <gitRemote>` — or a registered branch that no longer exists upstream.
4. Commit the source `hermes-projects.json` so the runtime copy can be re-synced later.
