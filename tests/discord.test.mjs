import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DISCORD_RESPONSE_PONG,
  RATE_LIMIT_USER,
  commandOptions,
  createRateLimiter,
  createReplayCache,
  discordAllowed,
  discordConfig,
  discordReadiness,
  redactSecrets,
  verifyDiscordSignature,
} from "../scripts/hermes-discord-lib.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// Real Ed25519 fixtures — the public key is handed to the server exactly as
// Discord's portal would (hex), the private key signs (timestamp + rawBody).
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = publicKey.export({ format: "jwk" }).x
  ? Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex")
  : "";

function signedHeaders(body, { timestamp = String(Math.floor(Date.now() / 1000)) } = {}) {
  const signature = cryptoSign(
    null,
    Buffer.concat([Buffer.from(timestamp), Buffer.from(body, "utf8")]),
    privateKey,
  ).toString("hex");
  return {
    "Content-Type": "application/json",
    "X-Signature-Ed25519": signature,
    "X-Signature-Timestamp": timestamp,
  };
}

const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";
const USER = "333333333333333333";
// Each integration test uses a distinct allowlisted user so the real
// per-user rate limit (6/min) stays exercised without cross-test bleed.
const EXTRA_USERS = ["u-a", "u-b", "u-c", "u-d", "u-e", "u-f", "u-g", "u-h", "u-i", "u-j"];
const ALL_USERS = [USER, ...EXTRA_USERS].join(",");

function interaction({ id = "900000000000000001", name = "상태", options = [], user = USER, channel = CHANNEL, guild = GUILD, type = 2 } = {}) {
  return JSON.stringify({
    id,
    type,
    application_id: "444444444444444444",
    guild_id: guild,
    channel_id: channel,
    member: { user: { id: user } },
    data: name ? { name, options } : {},
  });
}

// ---- unit: signature contract ----

test("verifyDiscordSignature accepts the official timestamp+rawBody scheme", () => {
  const body = interaction({ name: "상태" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = cryptoSign(
    null,
    Buffer.concat([Buffer.from(timestamp), Buffer.from(body, "utf8")]),
    privateKey,
  ).toString("hex");
  assert.equal(
    verifyDiscordSignature({ publicKeyHex, signatureHex: signature, timestamp, rawBody: body }),
    true,
  );
});

test("verifyDiscordSignature rejects tampered bodies, wrong keys, and stale timestamps", () => {
  const body = interaction();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = cryptoSign(
    null,
    Buffer.concat([Buffer.from(timestamp), Buffer.from(body, "utf8")]),
    privateKey,
  ).toString("hex");
  // Tampered body — a single whitespace change must invalidate.
  assert.equal(
    verifyDiscordSignature({ publicKeyHex, signatureHex: signature, timestamp, rawBody: `${body} ` }),
    false,
  );
  // Different keypair.
  const other = generateKeyPairSync("ed25519");
  const otherHex = Buffer.from(other.publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
  assert.equal(
    verifyDiscordSignature({ publicKeyHex: otherHex, signatureHex: signature, timestamp, rawBody: body }),
    false,
  );
  // Stale timestamp (>5min).
  const stale = String(Math.floor(Date.now() / 1000) - 600);
  const staleSig = cryptoSign(
    null,
    Buffer.concat([Buffer.from(stale), Buffer.from(body, "utf8")]),
    privateKey,
  ).toString("hex");
  assert.equal(
    verifyDiscordSignature({ publicKeyHex, signatureHex: staleSig, timestamp: stale, rawBody: body }),
    false,
  );
  // Malformed/missing material.
  for (const bad of [
    { publicKeyHex: "", signatureHex: signature, timestamp, rawBody: body },
    { publicKeyHex, signatureHex: "zz", timestamp, rawBody: body },
    { publicKeyHex, signatureHex: signature, timestamp: "not-a-number", rawBody: body },
    { publicKeyHex, signatureHex: signature.slice(2), timestamp, rawBody: body },
  ]) {
    assert.equal(verifyDiscordSignature(bad), false);
  }
});

// ---- unit: readiness / allowlists / rate limit / replay / redaction ----

test("discordReadiness is truthful — missing config is unavailable, never connected", () => {
  assert.deepEqual(discordReadiness({}), { state: "unavailable", reason: "missing_public_key" });
  assert.deepEqual(
    discordReadiness({ DISCORD_PUBLIC_KEY: "aa" }),
    { state: "unavailable", reason: "missing_guild_allowlist" },
  );
  assert.deepEqual(
    discordReadiness({ DISCORD_PUBLIC_KEY: "aa", DISCORD_GUILD_ID: GUILD }),
    { state: "unavailable", reason: "missing_channel_allowlist" },
  );
  assert.deepEqual(
    discordReadiness({ DISCORD_PUBLIC_KEY: "aa", DISCORD_GUILD_ID: GUILD, DISCORD_CHANNEL_IDS: CHANNEL }),
    { state: "unavailable", reason: "missing_user_allowlist" },
  );
  assert.deepEqual(
    discordReadiness({
      DISCORD_PUBLIC_KEY: "aa",
      DISCORD_GUILD_ID: GUILD,
      DISCORD_CHANNEL_IDS: CHANNEL,
      DISCORD_USER_IDS: USER,
    }),
    { state: "configured" },
  );
});

test("discordAllowed fails closed — empty allowlists deny, every list must pass", () => {
  const config = discordConfig({
    DISCORD_PUBLIC_KEY: "aa",
    DISCORD_APP_ID: "444444444444444444",
    DISCORD_GUILD_ID: GUILD,
    DISCORD_CHANNEL_IDS: CHANNEL,
    DISCORD_USER_IDS: USER,
  });
  const parsed = JSON.parse(interaction());
  assert.equal(discordAllowed(parsed, config), true);
  assert.equal(discordAllowed(JSON.parse(interaction({ user: "999" })), config), false);
  assert.equal(discordAllowed(JSON.parse(interaction({ channel: "999" })), config), false);
  assert.equal(discordAllowed(JSON.parse(interaction({ guild: "999" })), config), false);
  const noApp = discordConfig({
    DISCORD_PUBLIC_KEY: "aa",
    DISCORD_GUILD_ID: GUILD,
    DISCORD_CHANNEL_IDS: CHANNEL,
    DISCORD_USER_IDS: USER,
  });
  assert.equal(discordAllowed(parsed, noApp), true);
  assert.equal(
    discordAllowed(parsed, discordConfig({ DISCORD_GUILD_ID: GUILD, DISCORD_CHANNEL_IDS: CHANNEL, DISCORD_USER_IDS: USER })),
    true,
  );
  assert.equal(discordAllowed(parsed, discordConfig({})), false, "empty allowlists deny everything");
});

test("rate limiter and replay cache are bounded and deterministic", () => {
  const limit = createRateLimiter({ count: 2, windowMs: 1000 });
  assert.equal(limit("u", 0), true);
  assert.equal(limit("u", 100), true);
  assert.equal(limit("u", 200), false);
  assert.equal(limit("u", 2000), true, "window slides");
  const cache = createReplayCache({ max: 3 });
  cache.store("a", { type: 4 });
  cache.store("b", { type: 4 });
  cache.store("c", { type: 4 });
  cache.store("d", { type: 4 });
  assert.equal(cache.check("a"), null, "oldest entry evicted at bound");
  assert.deepEqual(cache.check("d"), { type: 4 });
  assert.equal(RATE_LIMIT_USER.count <= 10, true, "user budget stays tight");
});

test("redactSecrets strips secret-shaped lines and values before Discord", () => {
  const out = redactSecrets("결과 정상\napi_key: cog_abc123def456\npassword=hunter2\n fine");
  assert.equal(out.includes("cog_abc123def456"), false);
  assert.equal(out.includes("hunter2"), false);
  assert.equal(out.includes("비공개 값 숨김"), true);
  assert.ok(out.length <= 1500);
});

test("commandOptions flattens Discord option arrays", () => {
  const parsed = JSON.parse(interaction({ name: "승인", options: [{ name: "id", value: "abcd1234" }] }));
  assert.deepEqual(commandOptions(parsed), { id: "abcd1234" });
});

// ---- server integration: signed HTTP interactions ----

const servers = {};
let runtimeDir;

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // still binding
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("test server did not start");
}

async function interact(server, body, { headers } = {}) {
  const response = await fetch(`${server.baseUrl}/api/discord/interactions`, {
    method: "POST",
    headers: headers || signedHeaders(body),
    body,
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : {} };
}

before(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "hermes-discord-test-"));
  for (const [name, discordEnv] of [
    [
      "signed",
      {
        DISCORD_PUBLIC_KEY: publicKeyHex,
        DISCORD_APP_ID: "444444444444444444",
        DISCORD_GUILD_ID: GUILD,
        DISCORD_CHANNEL_IDS: CHANNEL,
        DISCORD_USER_IDS: ALL_USERS,
      },
    ],
    ["unconfigured", {}],
  ]) {
    const port = await availablePort();
    const server = {};
    servers[name] = server;
    server.baseUrl = `http://127.0.0.1:${port}`;
    server.dataFile = join(runtimeDir, `requests-discord-${name}.json`);
    server.child = spawn(process.execPath, [join(repoRoot, "mini-server.mjs")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ADMIN_PASSWORD: "test-password",
        SESSION_SECRET: "discord-test-secret",
        WORKER_TOKEN: "test-worker-token",
        HERMES_BOT_TOKEN: "test-bot-token",
        HERMES_DATA_FILE: server.dataFile,
        HERMES_PROJECTS_FILE: join(repoRoot, "hermes-projects.json"),
        HERMES_SYSTEM1_SHADOW: "",
        HERMES_BACKUP_DESTINATION: "",
        PORT: String(port),
        ...discordEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(server.baseUrl);
  }
});

after(async () => {
  for (const server of Object.values(servers)) server.child?.kill("SIGTERM");
  await rm(runtimeDir, { force: true, recursive: true });
});

test("unsigned, badly-signed, and stale interactions are rejected before parsing", async () => {
  const body = interaction();
  const noSig = await interact(servers.signed, body, {
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(noSig.status, 401);
  assert.equal(noSig.data.error, "invalid_signature");
  const badSig = await interact(servers.signed, body, {
    headers: { "Content-Type": "application/json", "X-Signature-Ed25519": "ab".repeat(64), "X-Signature-Timestamp": String(Math.floor(Date.now() / 1000)) },
  });
  assert.equal(badSig.status, 401);
  const stale = await interact(servers.signed, body, {
    headers: signedHeaders(body, { timestamp: String(Math.floor(Date.now() / 1000) - 600) }),
  });
  assert.equal(stale.status, 401);
  // Tampered body: the signature covers the original payload but the body
  // sent differs — Discord's raw-body contract must reject it.
  const tampered = await interact(servers.signed, `${body} `, { headers: signedHeaders(body) });
  assert.equal(tampered.status, 401);
});

test("endpoint reports unavailable when the public key is not configured", async () => {
  const result = await interact(servers.unconfigured, interaction());
  assert.equal(result.status, 503);
  assert.equal(result.data.error, "discord_unavailable");
});

test("PING receives the official PONG contract", async () => {
  const result = await interact(servers.signed, JSON.stringify({ id: "ping-1", type: 1, application_id: "444444444444444444" }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { type: DISCORD_RESPONSE_PONG });
});

test("non-allowlisted guild/channel/user are denied even with a valid signature", async () => {
  for (const [index, overrides] of [{ user: "999" }, { channel: "999" }, { guild: "999" }].entries()) {
    const result = await interact(servers.signed, interaction({ id: `deny-${index}`, user: EXTRA_USERS[index], ...overrides }));
    assert.equal(result.status, 200);
    assert.equal(result.data.data.content, "허용되지 않은 서버, 채널, 또는 사용자입니다.");
  }
});

test("/상태 returns a bounded Korean status summary", async () => {
  const result = await interact(servers.signed, interaction({ id: "status-1", user: "u-a" }));
  assert.equal(result.status, 200);
  assert.equal(result.data.type, 4);
  assert.ok(result.data.data.content.includes("Hermes 운영 상태"));
});

test("/요청 creates a Discord-sourced request; mutations need approval before a worker can claim", async () => {
  const created = await interact(
    servers.signed,
    interaction({
      id: "req-1",
      user: "u-b",
      name: "요청",
      options: [
        { name: "내용", value: "배포 파이프라인을 재배포해줘" },
        { name: "종류", value: "redeploy" },
        { name: "프로젝트", value: "hermes-mac-ops" },
      ],
    }),
  );
  assert.equal(created.status, 200);
  assert.ok(created.data.data.content.includes("승인"));

  const store = JSON.parse(await readFile(servers.signed.dataFile, "utf8"));
  const request = store.requests.find((entry) => entry.source === "discord" && entry.type === "redeploy");
  assert.ok(request, "discord request persisted");
  assert.equal(request.status, "approval_required");
  assert.equal(request.discord.channelId, CHANNEL);
  assert.equal(request.discord.userId, "u-b");
  assert.equal(request.executor, "codex", "unspecified executor defaults to codex");

  // The worker must not be able to claim it before approval.
  const next = await fetch(`${servers.signed.baseUrl}/api/worker/next`, {
    headers: { "X-Worker-Token": "test-worker-token" },
  });
  const nextData = await next.json();
  assert.equal(nextData.request, null);

  // /승인 moves it to queued; the worker can then claim it.
  const approved = await interact(
    servers.signed,
    interaction({ id: "approve-1", user: "u-c", name: "승인", options: [{ name: "id", value: request.id.slice(0, 8) }] }),
  );
  assert.equal(approved.status, 200);
  assert.ok(approved.data.data.content.includes("승인했습니다"));
  const after = JSON.parse(await readFile(servers.signed.dataFile, "utf8"));
  const updated = after.requests.find((entry) => entry.id === request.id);
  assert.equal(updated.status, "queued");
  assert.ok(updated.approved_at > 0);
});

test("/취소 cancels a queued Discord request and /결과 reads it back", async () => {
  const created = await interact(
    servers.signed,
    interaction({
      id: "req-2",
      user: "u-d",
      name: "요청",
      options: [
        { name: "내용", value: "맥 상태 확인해줘" },
        { name: "종류", value: "mac_status" },
        { name: "프로젝트", value: "hermes-mac-ops" },
      ],
    }),
  );
  assert.equal(created.status, 200);
  const store = JSON.parse(await readFile(servers.signed.dataFile, "utf8"));
  const request = store.requests.find((entry) => entry.title.includes("맥 상태"));
  assert.equal(request.status, "queued", "safe types queue immediately");

  const canceled = await interact(
    servers.signed,
    interaction({ id: "cancel-1", user: "u-e", name: "취소", options: [{ name: "id", value: request.id.slice(0, 8) }] }),
  );
  assert.ok(canceled.data.data.content.includes("취소했습니다"));

  const result = await interact(
    servers.signed,
    interaction({ id: "result-1", user: "u-f", name: "결과", options: [{ name: "id", value: request.id.slice(0, 8) }] }),
  );
  assert.ok(result.data.data.content.includes("취소됨"));
});

test("interaction-id replays return the recorded response verbatim", async () => {
  const body = interaction({ id: "replay-1", user: "u-g", name: "상태" });
  const first = await interact(servers.signed, body);
  const second = await interact(servers.signed, body);
  assert.equal(second.status, 200);
  assert.deepEqual(second.data, first.data);
});

test("/점검 enforces project capability gates", async () => {
  const missing = await interact(
    servers.signed,
    interaction({ id: "inspect-1", user: "u-h", name: "점검", options: [{ name: "프로젝트", value: "nonexistent-xyz" }] }),
  );
  assert.ok(missing.data.data.content.includes("찾지 못했습니다"));
  // EVENTOS is status-only (repo_unset) — inspect must be refused.
  const refused = await interact(
    servers.signed,
    interaction({ id: "inspect-2", user: "u-i", name: "점검", options: [{ name: "프로젝트", value: "EVENTOS" }] }),
  );
  assert.ok(refused.data.data.content.includes("연결되어 있지 않"));
});

test("the per-user rate limit returns a bounded Korean deferral", async () => {
  let last;
  for (let index = 0; index < 7; index += 1) {
    last = await interact(servers.signed, interaction({ id: `rate-${index}`, name: "상태" }));
  }
  assert.equal(last.status, 200);
  assert.equal(last.data.data.content, "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.");
});

test("/api/bot/notifications requires the bot token and returns bounded redacted results", async () => {
  const unauth = await fetch(`${servers.signed.baseUrl}/api/bot/notifications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(unauth.status, 401);
  const ok = await fetch(`${servers.signed.baseUrl}/api/bot/notifications`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-bot-token" },
    body: JSON.stringify({ since: 0 }),
  });
  assert.equal(ok.status, 200);
  const { notifications } = await ok.json();
  assert.ok(Array.isArray(notifications));
  for (const note of notifications) {
    assert.ok(["done", "failed", "canceled"].includes(note.status));
    assert.ok(note.channelId === CHANNEL);
    assert.equal(JSON.stringify(note).includes("/Users/"), false);
  }
});

test("/api/integrations/status reports discord and backup truthfully to admins", async () => {
  const login = await fetch(`${servers.signed.baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const status = await fetch(`${servers.signed.baseUrl}/api/integrations/status`, { headers: { Cookie: cookie } });
  assert.equal(status.status, 200);
  const data = await status.json();
  assert.equal(data.discord.state, "configured");
  assert.equal(data.backup.state, "unavailable");
  assert.equal(data.backup.reason, "destination_missing");

  const login2 = await fetch(`${servers.unconfigured.baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  const cookie2 = login2.headers.get("set-cookie").split(";")[0];
  const status2 = await fetch(`${servers.unconfigured.baseUrl}/api/integrations/status`, { headers: { Cookie: cookie2 } });
  const data2 = await status2.json();
  assert.equal(data2.discord.state, "unavailable");
});
