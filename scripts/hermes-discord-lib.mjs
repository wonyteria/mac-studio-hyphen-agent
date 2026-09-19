// Discord operations contract — shared by the public interactions endpoint in
// mini-server.mjs and the ops/notifier script. Implements the official HTTP
// interactions model: Ed25519 signature verification on (timestamp + raw
// body), PING/PONG, bounded Korean slash commands, allowlists, replay
// dedupe, and secret redaction. No gateway websocket, no arbitrary shell.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

export const DISCORD_INTERACTION_PING = 1;
export const DISCORD_INTERACTION_COMMAND = 2;
export const DISCORD_RESPONSE_PONG = 1;
export const DISCORD_RESPONSE_MESSAGE = 4;
export const DISCORD_EPHEMERAL = 64;

export const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
export const COMMAND_TEXT_MAX = 1500;
export const COMMAND_ID_MAX = 80;
export const RESULT_MAX_CHARS = 1500;
export const RATE_LIMIT_USER = { count: 6, windowMs: 60_000 };
export const RATE_LIMIT_GLOBAL = { count: 30, windowMs: 60_000 };
export const REPLAY_CACHE_MAX = 500;

// Official signature check: ed25519 over (timestamp + raw body) using the
// application's hex-encoded public key. Any failure is a hard reject.
export function verifyDiscordSignature({ publicKeyHex, signatureHex, timestamp, rawBody, now = Date.now() }) {
  if (!publicKeyHex || !signatureHex || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts * 1000) > SIGNATURE_MAX_AGE_MS) return false;
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKeyHex, "hex").toString("base64url") },
      format: "jwk",
    });
    const message = Buffer.concat([Buffer.from(String(timestamp)), Buffer.from(String(rawBody), "utf8")]);
    return cryptoVerify(null, message, key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

export function csvSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function discordConfig(env = process.env) {
  return {
    publicKey: env.DISCORD_PUBLIC_KEY || "",
    applicationId: env.DISCORD_APP_ID || "",
    guildIds: csvSet(env.DISCORD_GUILD_ID || env.DISCORD_GUILD_IDS),
    channelIds: csvSet(env.DISCORD_CHANNEL_IDS),
    userIds: csvSet(env.DISCORD_USER_IDS),
  };
}

// Truthful readiness — presence of configuration only, never "connected".
export function discordReadiness(env = process.env) {
  const config = discordConfig(env);
  if (!config.publicKey) return { state: "unavailable", reason: "missing_public_key" };
  if (config.guildIds.size === 0) return { state: "unavailable", reason: "missing_guild_allowlist" };
  if (config.channelIds.size === 0) return { state: "unavailable", reason: "missing_channel_allowlist" };
  if (config.userIds.size === 0) return { state: "unavailable", reason: "missing_user_allowlist" };
  return { state: "configured" };
}

// The invoker must pass every configured allowlist. Empty allowlists deny
// everything — fail closed, never permissive-by-omission.
export function discordAllowed(interaction, config) {
  const guildId = String(interaction?.guild_id || "");
  const channelId = String(interaction?.channel_id || "");
  const userId = String(interaction?.member?.user?.id || interaction?.user?.id || "");
  if (config.guildIds.size === 0 || config.channelIds.size === 0 || config.userIds.size === 0) return false;
  if (config.applicationId && String(interaction?.application_id || "") !== config.applicationId) return false;
  return config.guildIds.has(guildId) && config.channelIds.has(channelId) && config.userIds.has(userId);
}

// Sliding-window rate limiter — in-memory, bounded map.
export function createRateLimiter({ count, windowMs, maxKeys = 500 } = {}) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    if (hits.size > maxKeys) {
      for (const [entryKey, list] of hits) {
        if (list.every((at) => now - at > windowMs)) hits.delete(entryKey);
      }
    }
    const list = (hits.get(key) || []).filter((at) => now - at <= windowMs);
    if (list.length >= count) {
      hits.set(key, list);
      return false;
    }
    list.push(now);
    hits.set(key, list);
    return true;
  };
}

// Interaction-id dedupe — retries return the recorded response verbatim.
export function createReplayCache({ max = REPLAY_CACHE_MAX } = {}) {
  const seen = new Map();
  return {
    check(id) {
      if (seen.has(id)) return seen.get(id);
      return null;
    },
    store(id, response) {
      if (seen.size >= max) seen.delete(seen.keys().next().value);
      seen.set(id, response);
    },
  };
}

const SECRET_LINE = /(api[_-]?key|token|secret|password|passwd|credential|bearer|private[_-]?key|cog_)\s*[:=]\s*\S+/i;
const SECRET_VALUE = /(cog_[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})/g;

// Outbound redaction — defense in depth before anything crosses to Discord.
export function redactSecrets(text, maxChars = RESULT_MAX_CHARS) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => (SECRET_LINE.test(line) ? "[비공개 값 숨김]" : line))
    .join("\n");
  return lines.replace(SECRET_VALUE, "[비공개 값 숨김]").slice(0, maxChars);
}

// Korean slash-command definitions — names use Discord's unicode-letter
// support; registration happens via the ops script's `register` command.
export const DISCORD_COMMANDS = [
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

export function commandOptions(interaction) {
  const out = {};
  for (const option of interaction?.data?.options || []) {
    out[option.name] = option.value;
  }
  return out;
}

export function reply(text, { ephemeral = true } = {}) {
  return {
    type: DISCORD_RESPONSE_MESSAGE,
    data: { content: String(text).slice(0, 1900), ...(ephemeral ? { flags: DISCORD_EPHEMERAL } : {}) },
  };
}
