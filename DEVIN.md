# Devin executor — provider contract and operations

`development` requests run on either of two executors, selected in the
composer (`개발 실행자`) or via `executor` on `POST /api/requests`:

| Executor | Interface | Where it runs |
|---|---|---|
| `codex` (default) | `codex exec` CLI (non-interactive) | Mac Studio worker, inside an isolated git worktree |
| `devin` | Official **v3** API — `POST /v3/organizations/{org}/sessions`, `GET .../sessions/{devin_id}`, `GET/POST .../messages` | Devin cloud session pushes a branch; the worker applies the diff locally |

Anything not in the allowlist (`scripts/hermes-agent-providers.mjs`,
`EXECUTOR_TYPES`) fails closed to `codex`. JEV is **not** a provider in this
milestone — it remains an offline contract probe only. There is no Desktop
login reuse and no UI scraping — the service-user API is the only path.

## Credentials (worker env only)

| Variable | Required | Purpose |
|---|---|---|
| `DEVIN_API_KEY` | yes | Service user API key — must start with `cog_` (legacy `apk_`/`apk_user_` keys are rejected as `invalid_key_prefix`) |
| `DEVIN_ORG_ID` | yes | Organization id (`org-…`, from Settings > Service Users) |
| `DEVIN_API_URL` | optional | defaults to `https://api.devin.ai` |
| `DEVIN_MAX_ACU` | optional | `max_acu_limit` cost bound, capped at 100 |

The key is read from `process.env` inside the worker process only — never
written to the request store, logs, results, events, or git, and never
reaches spawned children (`childEnvironment` scrubs `TOKEN|SECRET|PASSWORD|
KEY|API_KEY|PRIVATE`-patterned variables for **every** subprocess, including
credentials a launchd child inherits from its LaunchAgent's
`EnvironmentVariables` — e.g. `MINI_VERCEL_GITHUB_TOKEN`). API errors surface
as HTTP status codes only; response bodies are discarded.

The web console never holds Devin credentials. It learns provider state from
the worker's `POST /api/worker/providers` report (allowlisted states only),
surfaced in the executor select and `GET /api/integrations/status`.

## Safety contract (identical to Codex)

1. `development` is a mutation — `approval_required` until an admin approves.
   Selecting Devin never skips approval, and the session request never sets
   `bypass_approval`.
2. Project lock → fetch registered remote → baseline commit → isolated
   worktree.
3. `POST /v3/organizations/{org}/sessions` with a bounded prompt (≤8000
   chars), `tags: ["hermes-ops", "hermes-<requestId>"]`, `resumable: false`,
   a `structured_output_schema` for the final report, the project's
   `owner/repo` (derived from `project.github`), and `max_acu_limit` when
   configured. Devin is instructed to work from the registered branch and
   push `origin/hermes/devin-<requestId>` — never to open a PR.
4. Poll `GET .../sessions/{devin_id}` every 20 s (45 min deadline, lease
   extension each poll). v3 has no idempotency key — the `hermes-<id>` tag is
   the traceability anchor; a retried request creates a new session only
   after fresh approval.
5. `status`/`status_detail` mapping (fail-closed):
   - `exit` + `finished` → success
   - `exit` without `finished`, `error`, `suspended` → failure
   - `waiting_for_approval` → failure (the worker can never satisfy Devin's
     internal approval — that is an operator decision)
   - `waiting_for_user` → one bounded Korean nudge via `POST .../messages`,
     then keep polling
   - quota/billing details (`out_of_credits`, `usage_limit_exceeded`, …) →
     failure with the detail in the message
   - `new`/`claimed`/`running`/`resuming`/unknown → keep polling
6. On finish, the worker fetches `hermes/devin-<requestId>` and applies its
   diff into the worktree — then the **shared** pipeline unchanged:
   changed-file cap (≤80), protected-path asserts, baseline-HEAD check,
   `verifyCommands`, pipeline-authored commit, push, `autoDeploy`, health.
   The final report comes from `structured_output.result` or the last agent
   message via `GET .../messages` (bounded to 4000 chars).

## Readiness vocabulary (truthful, no "connected")

- `codex` — `ready` when `codex --version` runs; else `unavailable`.
- `devin` — `configured` when `DEVIN_API_KEY` starts with `cog_` **and**
  `DEVIN_ORG_ID` is set; else `unavailable` with `missing_credential` /
  `invalid_key_prefix` / `missing_org_id` / `invalid_api_url`.
- `unknown` — no worker report yet.

## Live status

Devin is **not live-enabled** until an operator creates a service user with
`UseDevinSessions` + `ViewOrgSessions`, sets `DEVIN_API_KEY` + `DEVIN_ORG_ID`
on the Mac Studio worker environment, and the provider report confirms
`configured`. The adapter is implemented and deterministically tested;
activation is a credential-install step documented in `RUNTIME.md`.
