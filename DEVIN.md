# Devin executor — provider contract and operations

`development` requests can now run on either of two executors, selected in the
composer (`개발 실행자`) or via `executor` on `POST /api/requests`:

| Executor | Interface | Where it runs |
|---|---|---|
| `codex` (default) | `codex exec` CLI (non-interactive) | Mac Studio worker, inside an isolated git worktree |
| `devin` | Official Devin API `POST /v1/sessions` + `GET /v1/sessions/{id}` | Devin cloud session pushes a branch; the worker applies the diff locally |

Anything not in the allowlist (`scripts/hermes-agent-providers.mjs`,
`EXECUTOR_TYPES`) fails closed to `codex`. JEV is **not** a provider in this
milestone — it remains an offline contract probe only.

## Safety contract (identical for both executors)

Devin goes through exactly the same gate as Codex:

1. `development` is a mutation — a request sits in `approval_required` until an
   admin explicitly approves it. Selecting Devin never skips approval.
2. Project lock is acquired before any work (`acquireProjectLock`).
3. The repo is fetched and a baseline commit is recorded
   (`prepareRepository`); an isolated worktree is created at that baseline.
4. The Devin session is instructed (prompt contract in `devinPrompt`) to work
   from the registered branch and push to `hermes/devin-<requestId>` on the
   registered remote — never to open a PR or touch protected files.
5. The worker fetches that branch and applies its **diff** into the isolated
   worktree. From here the shared pipeline is unchanged: changed-file
   collection (≤80 files), protected-path assertions, `git apply` failure is
   fatal, worktree HEAD must still equal baseline, verification commands run,
   commit is authored by the pipeline (never by the provider), push to the
   registered branch, optional `autoDeploy` + health check.
6. If Devin produces no diff, the request completes as "no changes" — same as
   Codex.

The worker never executes provider-returned shell text. It only applies a git
diff produced inside a bounded session.

## Credentials

| Variable | Location | Purpose |
|---|---|---|
| `DEVIN_API_KEY` | worker environment (LaunchAgent plist env / `workers.env`) | Bearer token for `api.devin.ai` |
| `DEVIN_API_URL` | optional override | defaults to `https://api.devin.ai` |

The key is read from `process.env` inside the worker process only. It is never
written to the request store, worker logs, result text, events, or git. API
errors are reported as HTTP status codes only — response bodies are discarded.

The web console never holds `DEVIN_API_KEY`. It learns provider state from the
worker's `POST /api/worker/providers` report (allowlisted states only:
`ready`/`configured`/`unavailable`), surfaced in the executor select and
`GET /api/integrations/status`.

## Readiness vocabulary (truthful, no "connected")

- `codex` — `ready` when `codex --version` runs successfully (bounded probe);
  `unavailable` when the binary is missing or the probe fails.
- `devin` — `configured` when `DEVIN_API_KEY` is present (credential exists,
  live call not verified); `unavailable`/`missing_credential` otherwise.
- `unknown` — no worker report yet.

The UI renders `Devin (미설정)` / `Codex (미설정)` when unavailable and
`(미확인)` when the worker has not reported — never a false "연결됨".

## Bounded failure modes

| Failure | Result |
|---|---|
| `DEVIN_API_KEY` unset | request fails: "Devin 실행자가 설정되지 않았습니다" |
| Session create error | `Devin API 오류: <status>` |
| Session ends expired/blocked/failed/suspended | fail with terminal status enum |
| Session exceeds 45 min | fail with timeout message |
| `hermes/devin-<id>` branch not pushed | fail: branch not pushed |
| Diff fails `git apply` in worktree | fail: apply error |
| Lease lost mid-session | `reporter.assertLease()` aborts |

All polling is bounded (45 min deadline, 20 s interval, lease extension each
poll). Session creation is idempotent (`idempotency_key = hermes-<requestId>`)
so a retried request reuses rather than duplicates sessions.

## Live status

Devin is **not live-enabled** in this milestone's deployment until an operator
sets `DEVIN_API_KEY` on the Mac Studio worker and the provider report confirms
`configured`. The request/status/result adapter is implemented and
deterministically tested; activation is a credential-install step documented
in `RUNTIME.md`.
