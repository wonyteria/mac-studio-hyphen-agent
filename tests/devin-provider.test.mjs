import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  codexReadiness,
  devinReadiness,
  devinSessionStatusPath,
  normalizeExecutor,
  parseDevinSession,
  devinTerminalStatus,
} from "../scripts/hermes-agent-providers.mjs";

const root = new URL("../", import.meta.url);
let baseUrl;
let child;
let dataFile;
let runtimeDir;
let sessionCookie;

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

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The process may still be binding the port.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("test server did not start");
}

async function request(path, init = {}, cookie = sessionCookie) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  return { response, data: text ? JSON.parse(text) : {} };
}

async function workerRequest(path, init = {}) {
  return request(path, {
    ...init,
    headers: { Authorization: "Bearer runtime-worker-token", ...(init.headers || {}) },
  });
}

async function login() {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  const cookie = (response.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie, "login should set a session cookie");
  return cookie;
}

before(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "hermes-devin-test-"));
  dataFile = join(runtimeDir, "requests.json");
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [fileURLToPath(new URL("../mini-server.mjs", import.meta.url))], {
    cwd: fileURLToPath(root),
    env: {
      ...process.env,
      ADMIN_PASSWORD: "test-password",
      HERMES_DATA_FILE: dataFile,
      HERMES_PROJECTS_FILE: fileURLToPath(new URL("../hermes-projects.json", import.meta.url)),
      PORT: String(port),
      SESSION_SECRET: "runtime-test-secret",
      WORKER_TOKEN: "runtime-worker-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer();
  sessionCookie = await login();
});

after(async () => {
  child?.kill("SIGTERM");
  await rm(runtimeDir, { force: true, recursive: true });
});

// --- provider contract unit tests (no network, injected runners) ---

test("normalizeExecutor allowlists codex/devin and fails closed to codex", () => {
  assert.equal(normalizeExecutor("devin"), "devin");
  assert.equal(normalizeExecutor("codex"), "codex");
  assert.equal(normalizeExecutor("jev"), "codex");
  assert.equal(normalizeExecutor(undefined), "codex");
  assert.equal(normalizeExecutor({ evil: true }), "codex");
});

test("devinReadiness is truthfully unavailable without credentials", () => {
  const missing = devinReadiness({ env: {} });
  assert.equal(missing.state, "unavailable");
  assert.equal(missing.reason, "missing_credential");
  const configured = devinReadiness({ env: { DEVIN_API_KEY: "test-key" } });
  assert.equal(configured.state, "configured");
  assert.equal(configured.apiHost, "api.devin.ai");
  const badUrl = devinReadiness({ env: { DEVIN_API_KEY: "k", DEVIN_API_URL: "not a url" } });
  assert.equal(badUrl.state, "unavailable");
  assert.equal(badUrl.reason, "invalid_api_url");
});

test("codexReadiness probes the CLI instead of trusting configuration", async () => {
  const ok = await codexReadiness({ env: {}, run: async () => ({ ok: true }) });
  assert.equal(ok.state, "ready");
  const failed = await codexReadiness({ env: {}, run: async () => ({ ok: false }) });
  assert.equal(failed.state, "unavailable");
  assert.equal(failed.reason, "cli_probe_failed");
  const missing = await codexReadiness({ env: { CODEX_BIN: "/definitely/not/here/codex" }, run: async () => ({ ok: true }) });
  assert.equal(missing.state, "unavailable");
  assert.equal(missing.reason, "binary_not_executable");
});

test("Devin session contract is bounded and rejects malformed ids", () => {
  assert.equal(devinSessionStatusPath("devin-abc_123"), "/v1/sessions/devin-abc_123");
  assert.throws(() => devinSessionStatusPath("../../etc"), /유효하지 않은 Devin 세션 ID/);
  assert.throws(() => devinSessionStatusPath(""), /유효하지 않은 Devin 세션 ID/);
});

test("parseDevinSession normalizes to bounded allowlisted fields", () => {
  const session = parseDevinSession({
    session_id: "s1",
    url: "https://app.devin.ai/sessions/s1",
    status_enum: "working",
    structured_output: { result: "done " + "x".repeat(9000) },
  });
  assert.deepEqual(Object.keys(session).sort(), ["detail", "id", "status", "url"]);
  assert.equal(session.status, "working");
  assert.equal(session.detail.length, 4000);
  assert.equal(devinTerminalStatus({ status: "finished" }), "finished");
  assert.equal(devinTerminalStatus({ status: "blocked" }), "failed");
  assert.equal(devinTerminalStatus({ status: "working" }), "running");
});

// --- server contract ---

test("POST /api/requests stores the allowlisted executor field", async () => {
  const { response, data } = await request("/api/requests", {
    method: "POST",
    body: JSON.stringify({
      type: "development",
      executor: "devin",
      title: "Devin test",
      body: "Do a thing",
      target_project: "hermes-mac-ops",
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(data.request.executor, "devin");
  assert.equal(data.request.status, "approval_required", "development stays a mutation regardless of executor");
});

test("POST /api/requests fails closed to codex for unknown executors", async () => {
  const { response, data } = await request("/api/requests", {
    method: "POST",
    body: JSON.stringify({
      type: "development",
      executor: "jev",
      title: "Bogus executor",
      body: "Do a thing",
      target_project: "hermes-mac-ops",
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(data.request.executor, "codex");
});

test("integrations status requires admin auth", async () => {
  const { response } = await request("/api/integrations/status", {}, null);
  assert.equal(response.status, 401);
});

test("worker providers endpoint requires worker auth", async () => {
  const { response } = await request("/api/worker/providers", {
    method: "POST",
    body: JSON.stringify({ codex: { state: "ready" }, devin: { state: "unavailable" } }),
  });
  assert.equal(response.status, 401);
});

test("worker provider report lands in integrations status, bounded to allowlisted states", async () => {
  const { response: post } = await workerRequest("/api/worker/providers", {
    method: "POST",
    body: JSON.stringify({
      codex: { state: "ready" },
      devin: { state: "bogus-state" },
    }),
  });
  assert.equal(post.status, 200);
  const { response, data } = await request("/api/integrations/status");
  assert.equal(response.status, 200);
  assert.equal(data.kind, "hermes-integrations-status");
  assert.equal(data.worker.state, "ready");
  assert.equal(data.executors.codex.state, "ready");
  assert.equal(data.executors.devin.state, "unavailable", "unknown provider state degrades, never upgrades");
  assert.ok(data.projects.total >= 1);
  assert.equal(data.projects.full + data.projects.statusOnly, data.projects.total);
  assert.ok(typeof data.business.state === "string");
  const serialized = JSON.stringify(data);
  assert.ok(!serialized.includes("runtime-worker-token"), "status never echoes credentials");
});

test("integrations status uses only bounded truthful states", async () => {
  const { data } = await request("/api/integrations/status");
  assert.ok(["ready", "stale", "unknown"].includes(data.worker.state));
  for (const executor of ["codex", "devin"]) {
    assert.ok(
      ["ready", "configured", "unavailable", "unknown"].includes(data.executors[executor].state),
      `${executor} reported ${data.executors[executor].state}`,
    );
    // There is no "connected"/"ok" vocabulary — absence of evidence is never health.
    assert.notEqual(data.executors[executor].state, "connected");
  }
  const store = JSON.parse(await readFile(dataFile, "utf8"));
  assert.ok(store.meta.lastWorkerSeenAt, "worker/providers touched the liveness clock");
});
