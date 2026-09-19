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
       -> Ollama -> Hermes 4.3 36B IQ4_XS (on demand, tool-free chat)
       -> Hermes 4.3 operation router -> fixed worker operation allowlist
       -> registered local Git repositories
       -> Codex CLI (workspace-write, secrets scrubbed)
       -> Git remote
       -> mini deploy API -> Docker container -> domain /health
```

## Request Lifecycle

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
- The registry mirrors mini deploy projects for read-only status, but grants mutation capabilities only to entries with an exact local repository and deterministic verification commands.
- Tool-free Hermes chat calls Ollama directly and cannot execute commands. Approval-required `hermes_ops` uses Hermes only to select a fixed operation enum; arbitrary model-generated shell commands are never executed.
- The public project API returns only project ID, name, and domain.
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
