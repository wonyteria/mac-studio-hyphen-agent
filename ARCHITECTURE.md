# Hermes Mac Ops Architecture

## Outcome

Hermes lets an authenticated operator manage the Mac Studio and registered deployments from a browser without opening remote desktop. Safe inspections run immediately. Any request that changes files, removes data, or affects deployment requires one explicit approval, then continues automatically through verification and production health checking.

## Runtime Topology

```text
Browser
  -> hermes.hyphen.it.com (mini-server.mjs)
       -> persistent request JSON volume
       <- HTTPS polling and progress events

Mac Studio LaunchAgent
  -> hermes-local-worker.mjs
       -> native macOS status commands
       -> Ollama -> configured local model (on demand, tool-free chat)
       -> local-LLM operation router -> fixed worker operation allowlist
       -> registered local Git repositories
       -> Codex CLI (workspace-write, secrets scrubbed)
       -> Git remote
       -> mini deploy API -> Docker container -> domain /health

Studio cockpit (studio.hyphen.it.com, admin scope)
  -> "Agent에게 실행 요청" action
       -> GET /?project=&type=&prompt=  (bounded prefill params)
       -> server-side validation in scripts/hermes-prefill.mjs
       -> editable composer draft after login -> manual submit -> normal lifecycle

Studio business registry (outputs/registry.private.json, TCC-protected)
  -> Studio export mirrors to Application Support staging source
       (trigger: recorded sync-paths.json config from install)
  -> staged hermes-registry-sync.mjs (host, LaunchAgent com.hyphen.hermes-registry-sync, 5 min)
       -> validate (symlink/size/schema/sourceHash fail-closed)
       -> temp + fsync + atomic rename into Hermes persistent data (0600)
       -> registry-sync-status.json (allowlisted outcome, sibling file)
       -> sync_timeout watchdog: wedged open() -> bounded error + SIGKILL
  -> mini-server.mjs GET /api/business/status (admin session)
       -> freshness pill: 사업 데이터 최신 / 지연 / 사용 불가
```

LaunchAgents cannot open() TCC-protected or cloud-backed paths (Documents, Desktop, Downloads, Mobile Documents, CloudStorage) — the syscall suspends forever, so install stages the tool into Application Support, refuses protected paths, and the plist references only staged/mirror paths.

```text
created -> queued -> running -> done
              |        |
              |        -> approval_required -> queued -> running
              |                    |                        |
              -> canceled          -> canceled              -> failed
```

- `auto` is the default. Hermes first resolves it to one allowlisted request type.
- `hermes_chat`, `mac_status`, `deployment_status`, and `project_inspect` are safe and continue immediately.
- `hermes_ops`, `development`, `redeploy`, and `file_cleanup` always require approval.
- Auto-routed mutations release their worker claim and wait for approval before being claimed again.
- Queued or approval-pending requests can be canceled. Failed or canceled requests can be retried; mutations require fresh approval.
- The worker receives a per-claim token and renews a three-minute lease through heartbeats.
- Before a mutation switches mini deploy containers, the authenticated worker extends only that claim to a server-capped 30-minute deployment lease.
- Safe stale jobs can return to the queue. Mutation jobs fail closed to prevent duplicate edits or deployments.

## Development Transaction

1. Resolve the project only from `hermes-projects.json`.
2. Acquire a per-project local lock.
3. Fetch the configured Git remote and record its branch head as the baseline.
4. Create a detached request-specific Git worktree under the Hermes runtime directory.
5. Record the baseline commit and a durable request artifact.
6. Run Codex with `workspace-write` inside the isolated worktree; scrub token, key, secret, and password environment variables.
7. Reject protected credential files, paths outside the repo, and changes spanning more than 80 files.
8. Run configured verification commands.
9. Commit and push only the files produced by the request.
10. Snapshot configured persistent files, redeploy through mini deploy, restore them into the new deployment workspace, and check the public `/health` endpoint.

If Codex or verification fails, its isolated worktree is retained for diagnosis and the operator's checkout remains untouched. If push or deployment fails after commit, the exact commit and worktree remain visible; mini deploy keeps the prior healthy container when a new build cannot become ready.

During a deployment switch, request heartbeats pause while `persistentFiles` are copied from the old mini deploy workspace to the new one. A second backup remains under the Hermes runtime directory so a failed restore is recoverable without relying on the retired container.

Operational auto-development was verified in production automation on 2026-08-16.
Production deployment lease extension was verified on 2026-08-16.

## Trust Boundaries

- The website never accepts arbitrary commands or repository paths.
- The Studio handoff accepts only `project`, `type`, and `prompt` query parameters. `project` resolves strictly against registry ids, names, and domain aliases; `type` must be a composer-selectable type that satisfies the effective project's `capabilities`; `prompt` is editable text capped at 2000 characters. Unknown, duplicated, oversized, control-character, or malformed values fail closed to neutral defaults, and foreign parameters are ignored — the URL can never carry a registry path, shell command, credential, approval, auto-submit flag, or execution state, and the applied draft can never submit itself or bypass login or approval.
- The registry mirrors mini deploy projects for read-only status, but grants mutation capabilities only to entries with an exact local repository and deterministic verification commands.
- Tool-free Hermes chat calls Ollama directly and cannot execute commands. Approval-required `hermes_ops` uses Hermes only to select a fixed operation enum; arbitrary model-generated shell commands are never executed.
- The public project API returns only project ID, name, and domain.
- The business registry reaches the runtime only through `hermes-registry-sync.mjs` (explicit `--source`/`--destination`, never inferred from the deployment registry) or a manual pinned copy. Every sync run re-validates schema before writing and replaces the destination atomically, so the last-known-good file survives failures. The sync status JSON and `GET /api/business/status` carry only allowlisted freshness fields — `state`, timestamps, `projectCount`, bounded `errorCode` — never business content, local paths, hashes, or error text, and the freshness read never touches the request queue, approvals, or the worker.
- The worker token authenticates the machine; the claim token binds progress and results to one request execution.
- Codex can write only inside an isolated worktree of the registered repository and cannot see the operator checkout's untracked secret files or Hermes/mini deploy credentials.
- `.env`, `.dev.vars`, authentication files, private keys, and credential-like files are blocked from automated commits.
- Password login is rate-limited. The intentionally simple operator password remains a deployment setting and should be replaced by SSO or network allowlisting if more users are added.

## Adding A Project

Add one explicit object to `hermes-projects.json` with:

- stable `id`, display `name`, and production `domain`
- exact local `repo` path and GitHub URL
- mini deploy project ID
- `gitRemote`, `branch`, and `autoDeploy`
- deterministic `verifyCommands`

Copy the registry to the worker runtime directory and redeploy the web console so both sides expose the same project set. Validate status first, then run a no-change approved development smoke before allowing production edits.
