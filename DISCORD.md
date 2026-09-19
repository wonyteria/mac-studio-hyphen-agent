# Hermes Discord Operations

Optional Korean slash-command interface to the same request queue the web
console uses. There is no gateway websocket, no arbitrary shell, and no
Discord-specific execution path — every command lands in the existing
request-type allowlist, project capability gates, and the approval state
machine. A mutation requested over Discord is `approval_required` exactly
like one from the web UI; a worker cannot claim it until a `/승인` (or the
web console) approves it.

## Threat model

- The interactions endpoint is public by necessity — Discord calls it.
  Authentication is Discord's Ed25519 signature over `timestamp + raw body`
  (`X-Signature-Ed25519`, `X-Signature-Timestamp`) plus a 5-minute timestamp
  freshness window. Anything missing, malformed, stale, or failing
  verification is rejected `401` before the body is parsed.
- PING receives `{ "type": 1 }` (PONG) and nothing else.
- Guild, channel, and user allowlists are all mandatory and fail closed —
  an empty allowlist denies everyone, never permissive-by-omission.
- Interaction ids are deduped (bounded replay cache returns the recorded
  response verbatim), and per-user (6/min) and global (30/min) rate limits
  return a bounded Korean deferral inside the 3-second acknowledgement
  budget — no deferred followup tokens are used, so Discord's 15-minute
  interaction-token expiry never applies.
- Outbound content is length-bounded and redacted (`cog_`, `ghp_`, `sk-`,
  `xox*`, `token:`/`key:`/`password:`-shaped lines) before it can cross to
  Discord. Internal paths and raw business-registry content never leave.
- Long-running results do not use the interaction token at all: the ops
  poller delivers them through the bot Create Message API to the origin
  channel, honoring `Retry-After`/429 once, then waiting for the next poll.

## Configuration (server — `mini-server.mjs`)

| Variable | Purpose |
| --- | --- |
| `DISCORD_PUBLIC_KEY` | Application public key (Developer Portal → General Information). Hex; used only for Ed25519 verification. |
| `DISCORD_APP_ID` | Application id — when set, interactions for other app ids are denied. |
| `DISCORD_GUILD_ID` or `DISCORD_GUILD_IDS` | Comma-separated guild allowlist. |
| `DISCORD_CHANNEL_IDS` | Comma-separated channel allowlist. |
| `DISCORD_USER_IDS` | Comma-separated user allowlist. |
| `HERMES_BOT_TOKEN` | Shared bearer for `POST /api/bot/notifications` (the poller's credential — unrelated to the Discord bot token). |

Without `DISCORD_PUBLIC_KEY` the endpoint returns `503 discord_unavailable`
and `/api/integrations/status` reports `discord.state = "unavailable"` —
never a false "connected".

## Configuration (ops poller — `scripts/hermes-discord-ops.mjs`)

| Variable | Purpose |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Discord bot token (`Bot …` Authorization). Env-only; never logged or stored. |
| `HERMES_OPS_URL` | Ops server base URL. |
| `HERMES_BOT_TOKEN` | Bearer matching the server's `HERMES_BOT_TOKEN`. |
| `DISCORD_APP_ID` + `DISCORD_GUILD_ID` | Required only for `register`. |
| `DISCORD_STATE_FILE` | Cursor/state path (default `~/.local/share/hermes-ops/discord-ops-state.json`). |
| `DISCORD_POLL_MS` | Poll interval, floor 2000 ms (default 5000). |

## Operator procedure

```bash
# 1. Set the interactions endpoint URL in the Developer Portal to
#    https://<ops-host>/api/discord/interactions — Discord sends a PING and
#    expects PONG; the endpoint already answers it once DISCORD_PUBLIC_KEY
#    is configured.

# 2. Register the Korean slash commands into the allowlisted guild
#    (official guild-commands endpoint; instant availability):
DISCORD_BOT_TOKEN=… DISCORD_APP_ID=… DISCORD_GUILD_ID=… \
  node scripts/hermes-discord-ops.mjs register

# 3. Run the result notifier — foreground or as a LaunchAgent:
DISCORD_BOT_TOKEN=… HERMES_OPS_URL=… HERMES_BOT_TOKEN=… \
  node scripts/hermes-discord-ops.mjs run          # --once for a single poll

# 4. LaunchAgent (explicit install only — writes the plist, never loads it):
node scripts/hermes-discord-ops.mjs install        # prints the launchctl line
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.hyphen.hermes-discord-ops.plist
node scripts/hermes-discord-ops.mjs uninstall      # removes the plist

# 5. Truthful readiness:
node scripts/hermes-discord-ops.mjs status
```

`install` refuses to write a LaunchAgent when the script lives under
`~/Documents`, `~/Desktop`, `~/Downloads`, or `~/Library/CloudStorage` —
launchd children cannot reliably open TCC-protected paths. Deploy the ops
script beside the worker (`~/.local/share/hermes-ops/`) first.

## Commands

| Command | Effect |
| --- | --- |
| `/상태` | Queue counts + three most recent requests (public reply). |
| `/점검 프로젝트:<name>` | `project_inspect` request — capability-gated, read-only. |
| `/요청 내용:<text> [종류] [프로젝트] [실행자]` | Creates a request; `auto` resolves like the web composer, explicit types are capability-gated, `실행자` selects `codex`/`devin` for development. |
| `/승인 id:<prefix>` | Moves an `approval_required` request to `queued` — the only way Discord work executes. |
| `/취소 id:<prefix>` | Cancels while `queued`/`approval_required`. |
| `/결과 [id]` | Status + bounded redacted result. |

## Failure modes

- **401 on every interaction** — wrong/missing `DISCORD_PUBLIC_KEY`, clock
  skew beyond 5 minutes, or a proxy rewriting the body (signature covers the
  raw bytes; the endpoint reads the body itself and never re-serializes).
- **503 discord_unavailable** — `DISCORD_PUBLIC_KEY` unset; the integration
  is off by design.
- **"허용되지 않은 …"** — the guild/channel/user triplet is not fully
  allowlisted.
- **Poller silent** — `status` shows `lastError`; check `HERMES_BOT_TOKEN`
  parity and `DISCORD_BOT_TOKEN` validity. State persists in
  `DISCORD_STATE_FILE`; deleting it replays only unnotified completions.
