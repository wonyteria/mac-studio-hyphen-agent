// Hermes Discord ops — self-contained companion to the public
// /api/discord/interactions endpoint in mini-server.mjs. Commands:
//
//   run        poll the ops server for completed Discord-sourced requests and
//              post bounded redacted results to their origin channel (bot
//              Create Message). Bounded polling, Retry-After honored.
//   register   install the Korean slash commands into the allowlisted guild
//              (official guild-commands endpoint; operator command only)
//   status     truthful readiness: configured/unavailable + last poll state
//   install    write the com.hyphen.hermes-discord-ops LaunchAgent (explicit)
//   uninstall  remove it (explicit)
//
// Credentials are env-only: DISCORD_BOT_TOKEN (Bot ...), HERMES_BOT_TOKEN
// (ops server bearer), DISCORD_APP_ID + DISCORD_GUILD_ID for register. The
// interactions endpoint itself needs no bot token — Discord signs requests
// with the app public key (DISCORD_PUBLIC_KEY on the server).

import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DISCORD_API = "https://discord.com/api/v10";
const LAUNCH_AGENT_LABEL = "com.hyphen.hermes-discord-ops";
const STATE_KIND = "hermes-discord-ops-state";
const MIN_POLL_MS = 2000;
const MAX_MESSAGE_CHARS = 1900;

const botToken = process.env.DISCORD_BOT_TOKEN || "";
const opsUrl = (process.env.HERMES_OPS_URL || "").replace(/\/$/, "");
const opsToken = process.env.HERMES_BOT_TOKEN || "";
const appId = process.env.DISCORD_APP_ID || "";
const guildId = process.env.DISCORD_GUILD_ID || "";
const stateFile =
  process.env.DISCORD_STATE_FILE || join(homedir(), ".local", "share", "hermes-ops", "discord-ops-state.json");
const pollMs = Math.max(MIN_POLL_MS, Number(process.env.DISCORD_POLL_MS || 5000));

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const SECRET_LINE = /(api[_-]?key|token|secret|password|passwd|credential|bearer|private[_-]?key|cog_)\s*[:=]\s*\S+/i;
const SECRET_VALUE = /(cog_[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})/g;

function redactSecrets(text, maxChars = 1500) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => (SECRET_LINE.test(line) ? "[비공개 값 숨김]" : line))
    .join("\n");
  return lines.replace(SECRET_VALUE, "[비공개 값 숨김]").slice(0, maxChars);
}

async function readState() {
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    if (state?.kind === STATE_KIND) return state;
  } catch {
    // absent/corrupt state starts fresh
  }
  return { kind: STATE_KIND, lastCompletedAt: 0, notifiedIds: [], lastPollAt: null, lastError: null };
}

async function writeState(state) {
  await mkdir(join(stateFile, ".."), { recursive: true });
  const temp = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ ...state, kind: STATE_KIND }, null, 2), "utf8");
  await rename(temp, stateFile);
}

// Discord REST call with bounded Retry-After handling — one retry on 429,
// then the caller decides. Never echoes response bodies into errors.
async function discordApi(path, init = {}, { allowRetry = true } = {}) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    method: init.method || "GET",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 429 && allowRetry) {
    const retryAfter = Number(response.headers.get("retry-after") || 1);
    await sleep(Math.min(Math.max(retryAfter, 0.5), 30) * 1000);
    return discordApi(path, init, { allowRetry: false });
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(`Discord API 오류: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function opsApi(path, init = {}) {
  const response = await fetch(`${opsUrl}${path}`, {
    method: init.method || "GET",
    headers: { Authorization: `Bearer ${opsToken}`, "Content-Type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`Ops API 오류: ${response.status}`);
  return data;
}

const statusLabels = { done: "완료", failed: "실패", canceled: "취소됨" };

function notificationMessage(request) {
  const status = statusLabels[request.status] || request.status;
  const lines = [`[${status}] ${request.title} (${String(request.id).slice(0, 8)})`];
  if (request.result) lines.push(redactSecrets(request.result));
  return lines.join("\n").slice(0, MAX_MESSAGE_CHARS);
}

export async function notifyLoop({ once = false } = {}) {
  if (!botToken || !opsUrl || !opsToken) {
    throw new Error("DISCORD_BOT_TOKEN/HERMES_OPS_URL/HERMES_BOT_TOKEN이 설정되지 않았습니다.");
  }
  const state = await readState();
  while (true) {
    try {
      const { notifications } = await opsApi("/api/bot/notifications", {
        method: "POST",
        body: JSON.stringify({ since: state.lastCompletedAt }),
      });
      const notified = new Set(state.notifiedIds);
      for (const request of notifications || []) {
        if (notified.has(request.id)) {
          state.lastCompletedAt = Math.max(state.lastCompletedAt, request.completed_at || 0);
          continue;
        }
        if (request.channelId) {
          await discordApi(`/channels/${request.channelId}/messages`, {
            method: "POST",
            body: { content: notificationMessage(request) },
          });
        }
        notified.add(request.id);
        state.lastCompletedAt = Math.max(state.lastCompletedAt, request.completed_at || 0);
      }
      state.notifiedIds = [...notified].slice(-500);
      state.lastPollAt = Date.now();
      state.lastError = null;
      await writeState(state);
    } catch (error) {
      state.lastPollAt = Date.now();
      state.lastError = String(error?.message || error).slice(0, 200);
      await writeState(state).catch(() => {});
      if (once) throw error;
      await sleep(pollMs * 2);
    }
    if (once) return state;
    await sleep(pollMs);
  }
}

// Slash-command definitions — identical to hermes-discord-lib.mjs (the ops
// script stays self-contained for single-file deployment).
const COMMANDS = [
  { name: "상태", description: "운영 상태와 최근 요청 요약", options: [] },
  {
    name: "점검",
    description: "프로젝트 점검 요청 (읽기 전용)",
    options: [{ name: "프로젝트", description: "프로젝트 이름 또는 id", type: 3, required: true }],
  },
  {
    name: "요청",
    description: "새 작업 요청 — 변경 작업은 승인 후에만 실행됩니다",
    options: [
      { name: "내용", description: "요청 내용", type: 3, required: true },
      {
        name: "종류",
        description: "작업 종류",
        type: 3,
        required: false,
        choices: [
          { name: "자동 판단", value: "auto" },
          { name: "개발 요청", value: "development" },
          { name: "재배포", value: "redeploy" },
          { name: "Mac 상태", value: "mac_status" },
          { name: "배포 상태", value: "deployment_status" },
          { name: "프로젝트 점검", value: "project_inspect" },
        ],
      },
      { name: "프로젝트", description: "프로젝트 이름 또는 id", type: 3, required: false },
      {
        name: "실행자",
        description: "개발 실행자",
        type: 3,
        required: false,
        choices: [
          { name: "Codex", value: "codex" },
          { name: "Devin", value: "devin" },
        ],
      },
    ],
  },
  {
    name: "승인",
    description: "승인 대기 중인 변경 작업을 승인합니다",
    options: [{ name: "id", description: "요청 id (앞 8자 이상)", type: 3, required: true }],
  },
  {
    name: "취소",
    description: "실행 전 요청을 취소합니다",
    options: [{ name: "id", description: "요청 id (앞 8자 이상)", type: 3, required: true }],
  },
  {
    name: "결과",
    description: "요청 결과를 확인합니다",
    options: [{ name: "id", description: "요청 id (앞 8자 이상, 생략 시 최근 요청)", type: 3, required: false }],
  },
];

export async function registerCommands() {
  if (!botToken || !appId || !guildId) {
    throw new Error("DISCORD_BOT_TOKEN/DISCORD_APP_ID/DISCORD_GUILD_ID가 필요합니다.");
  }
  return discordApi(`/applications/${appId}/guilds/${guildId}/commands`, {
    method: "PUT",
    body: COMMANDS,
  });
}

export async function opsStatus() {
  const state = await readState().catch(() => null);
  const missing = [];
  if (!botToken) missing.push("DISCORD_BOT_TOKEN");
  if (!opsUrl) missing.push("HERMES_OPS_URL");
  if (!opsToken) missing.push("HERMES_BOT_TOKEN");
  return {
    kind: STATE_KIND,
    state: missing.length ? "unavailable" : "configured",
    missing,
    lastPollAt: state?.lastPollAt || null,
    lastError: state?.lastError || null,
    lastCompletedAt: state?.lastCompletedAt || 0,
  };
}

const TCC_SEGMENTS = ["/Documents", "/Desktop", "/Downloads", "/Library/CloudStorage"];

export async function installLaunchAgent({ labelDir } = {}) {
  const scriptPath = fileURLToPath(new URL(import.meta.url));
  if (TCC_SEGMENTS.some((segment) => scriptPath.includes(segment))) {
    throw new Error(
      `스크립트가 TCC 보호 경로 아래에 있습니다 (${scriptPath}) — Documents/Desktop 밖으로 옮긴 뒤 install하세요.`,
    );
  }
  const agentsDir = labelDir || join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(agentsDir, `${LAUNCH_AGENT_LABEL}.plist`);
  await mkdir(agentsDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${scriptPath}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(homedir(), ".local", "share", "hermes-ops", "discord-ops.log")}</string>
  <key>StandardErrorPath</key><string>${join(homedir(), ".local", "share", "hermes-ops", "discord-ops.log")}</string>
</dict>
</plist>
`;
  const temp = `${plistPath}.${process.pid}.tmp`;
  await writeFile(temp, plist, "utf8");
  await rename(temp, plistPath);
  return { ok: true, plistPath, label: LAUNCH_AGENT_LABEL, note: `load explicitly: launchctl bootstrap gui/$UID ${plistPath}` };
}

export async function uninstallLaunchAgent({ labelDir } = {}) {
  const agentsDir = labelDir || join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(agentsDir, `${LAUNCH_AGENT_LABEL}.plist`);
  const info = await lstat(plistPath).catch(() => null);
  if (!info) return { ok: true, removed: false, plistPath };
  await rm(plistPath, { force: true });
  return { ok: true, removed: true, plistPath };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "status";
  const labelDirIndex = argv.indexOf("--label-dir");
  const labelDir = labelDirIndex >= 0 ? argv[labelDirIndex + 1] : undefined;
  try {
    if (command === "run") return (await notifyLoop({ once: argv.includes("--once") }), 0);
    if (command === "register") return (printJson(await registerCommands()), 0);
    if (command === "status") return (printJson(await opsStatus()), 0);
    if (command === "install") return (printJson(await installLaunchAgent({ labelDir })), 0);
    if (command === "uninstall") return (printJson(await uninstallLaunchAgent({ labelDir })), 0);
    process.stderr.write(`unknown command '${command}' — run|register|status|install|uninstall\n`);
    return 2;
  } catch (error) {
    printJson({ ok: false, error: String(error?.message || error).slice(0, 200) });
    return 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const code = await main();
  process.exitCode = code;
}
