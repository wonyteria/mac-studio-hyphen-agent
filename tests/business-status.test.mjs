import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
let baseUrl;
let child;
let workDir;
let registryFile;
let statusFile;
let sessionCookie;

function evidence() {
  return { label: "근거", ref: "docs/proof.md", checkedAt: "2026-09-19" };
}

function exportPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    scope: "private",
    consumer: "hermes",
    sourceHash: "a".repeat(64),
    updatedAt: "2026-09-19",
    projects: [
      {
        blockers: [],
        businessGroup: "테스트 그룹",
        businessType: "internal-ops",
        dataStores: [],
        deploys: [],
        evidence: [evidence()],
        evidenceStatus: "insufficient",
        id: "alpha",
        kpis: [],
        lifecycle: "unknown",
        name: "Alpha",
        nextEvidence: [],
        organization: "hyphen",
        owner: null,
        repositories: [],
        revenue: null,
        status: "unknown",
      },
    ],
    ...overrides,
  };
}

function statusDoc(overrides = {}) {
  return {
    status: "synced",
    checkedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    syncedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    registryUpdatedAt: "2026-09-19",
    projectCount: 1,
    errorCode: null,
    ...overrides,
  };
}

async function writeRegistry(payload = exportPayload()) {
  await writeFile(registryFile, JSON.stringify(payload, null, 2), "utf8");
}

async function writeStatus(doc = statusDoc()) {
  await writeFile(statusFile, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

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
      // still binding
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("test server did not start");
}

async function api(path, cookie = sessionCookie) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  });
  const text = await response.text();
  return { response, data: text ? JSON.parse(text) : {} };
}

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "hermes-biz-status-test-"));
  registryFile = join(workDir, "business", "registry.private.json");
  statusFile = join(workDir, "business", "registry-sync-status.json");
  await mkdir(join(workDir, "business"), { recursive: true });
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [fileURLToPath(new URL("../mini-server.mjs", import.meta.url))], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ADMIN_PASSWORD: "test-password",
      HERMES_BUSINESS_REGISTRY: registryFile,
      HERMES_BUSINESS_REGISTRY_STATUS: statusFile,
      HERMES_DATA_FILE: join(workDir, "requests.json"),
      HERMES_PROJECTS_FILE: fileURLToPath(new URL("../hermes-projects.json", import.meta.url)),
      PORT: String(port),
      SESSION_SECRET: "biz-status-test-secret",
      WORKER_TOKEN: "biz-status-worker-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer();
  const login = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  sessionCookie = (login.headers.get("set-cookie") || "").split(";")[0];
});

after(async () => {
  child?.kill("SIGTERM");
  await rm(workDir, { force: true, recursive: true });
});

test("the status endpoint requires authentication", async () => {
  const { response } = await api("/api/business/status", null);
  assert.equal(response.status, 401);
});

test("unavailable when no registry exists at the destination", async () => {
  const { response, data } = await api("/api/business/status");
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(data).sort(), [
    "checkedAt",
    "errorCode",
    "projectCount",
    "registryUpdatedAt",
    "state",
    "syncedAt",
  ]);
  assert.equal(data.state, "unavailable");
  assert.equal(data.projectCount, null);
});

test("fresh when a validated registry and a recent clean status agree", async () => {
  await writeRegistry();
  await writeStatus();
  const { data } = await api("/api/business/status");
  assert.equal(data.state, "fresh");
  assert.equal(data.registryUpdatedAt, "2026-09-19");
  assert.equal(data.projectCount, 1);
  assert.equal(data.errorCode, null);
  assert.ok(data.checkedAt && data.syncedAt);
});

test("the response never carries paths, hashes, or registry content", async () => {
  await writeRegistry();
  await writeStatus();
  const response = await fetch(`${baseUrl}/api/business/status`, {
    headers: { Cookie: sessionCookie },
  });
  const body = await response.text();
  assert.equal(body.includes(workDir), false, "no local path leaks");
  assert.equal(body.includes("a".repeat(64)), false, "no sourceHash leaks");
  assert.equal(body.includes("Alpha"), false, "no project names leak");
  assert.equal(body.includes("테스트 그룹"), false, "no business fields leak");
  assert.equal(/registry\.private\.json/.test(body), false, "no filename leaks");
});

test("stale when the last sync run recorded an error", async () => {
  await writeStatus(statusDoc({ status: "error", errorCode: "schema_mismatch", syncedAt: null }));
  const { data } = await api("/api/business/status");
  assert.equal(data.state, "stale");
  assert.equal(data.errorCode, "schema_mismatch");
  await writeStatus();
});

test("stale when the status file is absent even though the registry loads", async () => {
  await rm(statusFile, { force: true });
  const { data } = await api("/api/business/status");
  assert.equal(data.state, "stale");
  assert.equal(data.registryUpdatedAt, "2026-09-19");
});

test("stale when the sync tool stopped checking in", async () => {
  const old = "2020-01-01T00:00:00Z";
  await writeStatus(statusDoc({ checkedAt: old, syncedAt: old }));
  const { data } = await api("/api/business/status");
  assert.equal(data.state, "stale");
  await writeStatus();
});

test("stale when the status no longer describes the destination content", async () => {
  await writeStatus(statusDoc({ registryUpdatedAt: "2026-09-01" }));
  const { data } = await api("/api/business/status");
  assert.equal(data.state, "stale");
  await writeStatus();
});

test("a malformed or over-keyed status file is ignored rather than trusted", async () => {
  await writeFile(statusFile, "{ not json", "utf8");
  let { data } = await api("/api/business/status");
  assert.equal(data.state, "stale");

  await writeFile(statusFile, JSON.stringify({ ...statusDoc(), path: "/etc/passwd" }), "utf8");
  ({ data } = await api("/api/business/status"));
  assert.equal(data.state, "stale");
  await writeStatus();
});

test("a symlinked status file or registry is never followed", async () => {
  const realStatus = join(workDir, "elsewhere-status.json");
  await writeFile(realStatus, JSON.stringify(statusDoc()), "utf8");
  await rm(statusFile, { force: true });
  await symlink(realStatus, statusFile);
  let { data } = await api("/api/business/status");
  assert.equal(data.state, "stale", "symlinked status file must not be read");
  await rm(statusFile, { force: true });
  await writeStatus();

  const realRegistry = join(workDir, "elsewhere-registry.json");
  await writeFile(realRegistry, JSON.stringify(exportPayload()), "utf8");
  await rm(registryFile, { force: true });
  await symlink(realRegistry, registryFile);
  ({ data } = await api("/api/business/status"));
  assert.equal(data.state, "unavailable", "symlinked registry must not be read");
  await rm(registryFile, { force: true });
  await writeRegistry();
});

test("the endpoint never touches the request queue", async () => {
  await api("/api/business/status");
  const { data } = await api("/api/requests");
  assert.deepEqual(data.requests, [], "status reads must not create or mutate requests");
});
