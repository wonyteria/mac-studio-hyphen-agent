import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach, before } from "node:test";
import { fileURLToPath } from "node:url";
import { MAX_TEXT_CHARS, ROUTES } from "../scripts/hermes-system1.mjs";

const DETERMINED_BY = new Set([
  "policy_block",
  "missing_provider",
  "provider_abstain",
  "threshold",
  "conflicting_signals",
  "policy_constraint",
  "provider",
]);
const POLICY_VERDICTS = new Set(["allow", "warn", "block"]);
const servers = { off: {}, on: {} };
const createdOnShadowServer = new Set();
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
      // The process may still be binding the port.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("test server did not start");
}

async function api(server, path, init = {}) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(server.cookie ? { Cookie: server.cookie } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  return { response, data: text ? JSON.parse(text) : {} };
}

async function login(server) {
  const result = await api(server, "/api/login", {
    method: "POST",
    body: JSON.stringify({ password: "test-password" }),
  });
  assert.equal(result.response.status, 200);
  server.cookie = result.response.headers.get("set-cookie").split(";")[0];
}

before(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "hermes-shadow-test-"));
  for (const [name, shadowFlag] of [
    ["off", ""],
    ["on", "1"],
  ]) {
    const port = await availablePort();
    const server = servers[name];
    server.baseUrl = `http://127.0.0.1:${port}`;
    server.dataFile = join(runtimeDir, `requests-${name}.json`);
    server.child = spawn(process.execPath, [fileURLToPath(new URL("../mini-server.mjs", import.meta.url))], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        ...process.env,
        ADMIN_PASSWORD: "test-password",
        HERMES_DATA_FILE: server.dataFile,
        HERMES_PROJECTS_FILE: fileURLToPath(new URL("../hermes-projects.json", import.meta.url)),
        HERMES_SYSTEM1_SHADOW: shadowFlag,
        PORT: String(port),
        SESSION_SECRET: "shadow-test-secret",
        WORKER_TOKEN: "shadow-worker-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(server.baseUrl);
    await login(server);
  }
});

afterEach(async () => {
  // Keep queue state isolated: cancel anything a test left dispatchable on the
  // shadow-on server so later tests can assert /api/worker/next deterministically.
  if (!createdOnShadowServer.size) return;
  const requests = await api(servers.on, "/api/requests");
  for (const item of requests.data.requests) {
    if (createdOnShadowServer.has(item.id) && ["queued", "approval_required"].includes(item.status)) {
      await api(servers.on, `/api/requests/${item.id}/cancel`, { method: "POST", body: "{}" });
    }
  }
  createdOnShadowServer.clear();
});

after(async () => {
  servers.off.child?.kill("SIGTERM");
  servers.on.child?.kill("SIGTERM");
  await rm(runtimeDir, { force: true, recursive: true });
});

test("feature off preserves legacy intake with no shadow field", async () => {
  const created = await api(servers.off, "/api/requests", {
    method: "POST",
    body: JSON.stringify({
      body: "버튼 문구를 더 짧게 수정해줘",
      target_project: "hermes-mac-ops",
      title: "shadow off",
      type: "development",
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.request.status, "approval_required");
  assert.equal(created.data.request.risk, "approval_required");
  assert.equal("system1_shadow" in created.data.request, false);
  const requests = await api(servers.off, "/api/requests");
  const item = requests.data.requests.find((candidate) => candidate.id === created.data.request.id);
  assert.equal("system1_shadow" in item, false);
  const stored = JSON.parse(await readFile(servers.off.dataFile, "utf8"));
  assert.equal("system1_shadow" in stored.requests.find((candidate) => candidate.id === item.id), false);
});

test("feature on records a bounded feature-only shadow record", async () => {
  const created = await api(servers.on, "/api/requests", {
    method: "POST",
    body: JSON.stringify({
      body: "현재 Mac 메모리와 프로세스 상태 알려줘",
      target_project: "hermes-mac-ops",
      title: "status probe",
      type: "auto",
    }),
  });
  assert.equal(created.response.status, 201);
  createdOnShadowServer.add(created.data.request.id);
  assert.equal(created.data.request.status, "queued");
  const shadow = created.data.request.system1_shadow;
  assert.deepEqual(
    Object.keys(shadow).sort(),
    [
      "abstained",
      "confidence",
      "determinedBy",
      "features",
      "kind",
      "observed_at",
      "policyVerdict",
      "route",
      "schemaVersion",
      "status",
    ].sort(),
  );
  assert.equal(shadow.kind, "hermes.system1.shadow");
  assert.equal(shadow.schemaVersion, 1);
  assert.equal(shadow.status, "ok");
  assert.equal(shadow.observed_at, created.data.request.created_at);
  assert.ok(ROUTES.includes(shadow.route));
  assert.equal(shadow.route, "LOCAL_SCRIPT");
  assert.ok(DETERMINED_BY.has(shadow.determinedBy));
  assert.equal(shadow.determinedBy, "provider");
  assert.ok(POLICY_VERDICTS.has(shadow.policyVerdict));
  assert.equal(shadow.policyVerdict, "allow");
  assert.equal(typeof shadow.confidence, "number");
  assert.ok(shadow.confidence >= 0 && shadow.confidence <= 1);
  assert.equal(shadow.abstained, false);
  assert.deepEqual(
    Object.keys(shadow.features).sort(),
    ["ambiguity", "capabilities", "evidence", "riskFlags", "taskSignals"].sort(),
  );
  assert.ok(shadow.features.taskSignals.status_report >= 1);
  assert.equal(shadow.features.evidence.hasRepoContext, true);
  for (const key of ["text", "label", "summary", "probabilities", "reasonCodes", "reasons"]) {
    assert.equal(key in shadow, false, `shadow record has forbidden key ${key}`);
    assert.equal(key in shadow.features, false, `shadow features have forbidden key ${key}`);
  }
  const serialized = JSON.stringify(shadow);
  assert.equal(serialized.includes("메모리"), false, "shadow record leaked request text");
  const stored = JSON.parse(await readFile(servers.on.dataFile, "utf8"));
  const persisted = stored.requests.find((candidate) => candidate.id === created.data.request.id);
  assert.deepEqual(persisted.system1_shadow, shadow);
});

test("shadow route never changes classification, approval, or dispatch", async () => {
  const payload = {
    body: "로그인 버그를 수정해줘",
    target_project: "hermes-mac-ops",
    title: "shadow classification",
    type: "development",
  };
  const [legacy, shadowed] = await Promise.all([
    api(servers.off, "/api/requests", { method: "POST", body: JSON.stringify(payload) }),
    api(servers.on, "/api/requests", { method: "POST", body: JSON.stringify(payload) }),
  ]);
  assert.equal(legacy.response.status, 201);
  assert.equal(shadowed.response.status, 201);
  for (const field of ["type", "resolved_type", "risk", "status"]) {
    assert.equal(shadowed.data.request[field], legacy.data.request[field]);
  }
  assert.equal(shadowed.data.request.status, "approval_required");
  assert.equal(shadowed.data.request.system1_shadow.route, "CODEX");
  assert.equal(shadowed.data.request.system1_shadow.status, "ok");
  const id = shadowed.data.request.id;
  createdOnShadowServer.add(id);
  const approved = await api(servers.on, `/api/requests/${id}/approve`, { method: "POST", body: "{}" });
  assert.equal(approved.response.status, 200);
  const claimed = await api(
    servers.on,
    "/api/worker/next",
    { headers: { "X-Worker-Token": "shadow-worker-token" } },
  );
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.data.request.id, id);
  assert.equal(claimed.data.request.status, "running");
  const completed = await api(
    servers.on,
    "/api/worker/result",
    {
      method: "POST",
      headers: { "X-Worker-Token": "shadow-worker-token" },
      body: JSON.stringify({
        claimToken: claimed.data.request.claim_token,
        id,
        result: "shadow dispatch 완료",
        status: "done",
      }),
    },
  );
  assert.equal(completed.response.status, 200);
});

test("secret-like input never leaks into the shadow record", async () => {
  const fakeToken = `Bearer ${"a".repeat(24)}`;
  const secretBody = `이 토큰으로 요약해줘: ${fakeToken} 그리고 /Users/hyphen/secret.pem 참고`;
  const created = await api(servers.on, "/api/requests", {
    method: "POST",
    body: JSON.stringify({
      body: secretBody,
      target_project: "hermes-mac-ops",
      title: "secret probe",
      type: "auto",
    }),
  });
  assert.equal(created.response.status, 201);
  createdOnShadowServer.add(created.data.request.id);
  const shadow = created.data.request.system1_shadow;
  assert.equal(shadow.status, "ok");
  assert.equal(shadow.route, "REQUIRE_OWNER");
  assert.equal(shadow.determinedBy, "policy_block");
  assert.equal(shadow.abstained, true);
  assert.equal(shadow.policyVerdict, "block");
  assert.ok(shadow.features.riskFlags.includes("secret_material"));
  assert.ok(shadow.features.riskFlags.includes("absolute_path"));
  const serialized = JSON.stringify(shadow);
  for (const fragment of [fakeToken, "Bearer", "aaaa", "secret.pem", "/Users/", "토큰으로", "요약해줘"]) {
    assert.equal(serialized.includes(fragment), false, `shadow record leaked ${fragment}`);
  }
  for (const flag of shadow.features.riskFlags) assert.match(flag, /^[a-z_]+$/);
  const stored = JSON.parse(await readFile(servers.on.dataFile, "utf8"));
  const persisted = stored.requests.find((candidate) => candidate.id === created.data.request.id);
  const persistedShadow = JSON.stringify(persisted.system1_shadow);
  assert.equal(persistedShadow.includes(fakeToken), false);
  assert.equal(persistedShadow.includes("/Users/"), false);
});

test("shadow computation failure degrades to an enum marker without breaking intake", async () => {
  // Intake accepts bodies up to 8000 chars; the System 1 contract caps analyzed
  // text at MAX_TEXT_CHARS — one char over fails closed to the marker while the
  // request itself is still created normally.
  const overLimit = await api(servers.on, "/api/requests", {
    method: "POST",
    body: JSON.stringify({
      body: "x".repeat(MAX_TEXT_CHARS + 1),
      target_project: "hermes-mac-ops",
      title: "overflow probe",
      type: "auto",
    }),
  });
  assert.equal(overLimit.response.status, 201);
  createdOnShadowServer.add(overLimit.data.request.id);
  assert.equal(overLimit.data.request.status, "queued");
  assert.equal(overLimit.data.request.risk, "pending");
  const marker = overLimit.data.request.system1_shadow;
  assert.deepEqual(Object.keys(marker).sort(), ["kind", "observed_at", "schemaVersion", "status"].sort());
  assert.equal(marker.status, "error");
  assert.equal(marker.kind, "hermes.system1.shadow");

  const atLimit = await api(servers.on, "/api/requests", {
    method: "POST",
    body: JSON.stringify({
      body: "x".repeat(MAX_TEXT_CHARS),
      target_project: "hermes-mac-ops",
      title: "boundary probe",
      type: "auto",
    }),
  });
  assert.equal(atLimit.response.status, 201);
  createdOnShadowServer.add(atLimit.data.request.id);
  assert.equal(atLimit.data.request.system1_shadow.status, "ok");

  const requests = await api(servers.on, "/api/requests");
  const item = requests.data.requests.find((candidate) => candidate.id === overLimit.data.request.id);
  assert.equal(item.status, "queued");
});

test("policy-blocked shadow result still leaves the request queued untouched", async () => {
  const created = await api(servers.on, "/api/requests", {
    method: "POST",
    body: JSON.stringify({
      body: "프로덕션 서버 재시작하고 배포해줘",
      target_project: "hermes-mac-ops",
      title: "deploy probe",
      type: "auto",
    }),
  });
  assert.equal(created.response.status, 201);
  createdOnShadowServer.add(created.data.request.id);
  const shadow = created.data.request.system1_shadow;
  assert.equal(shadow.route, "REQUIRE_OWNER");
  assert.equal(shadow.determinedBy, "policy_block");
  assert.equal(shadow.policyVerdict, "block");
  assert.equal(shadow.abstained, true);
  assert.equal(created.data.request.status, "queued");
  assert.equal(created.data.request.risk, "pending");
});
