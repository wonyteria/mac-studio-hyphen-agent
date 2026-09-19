import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceHash = "a".repeat(64);
const servers = {};
let runtimeDir;
let registryFile;

function evidence(label = "근거", ref = "docs/private-proof.md", checkedAt = "2026-09-19") {
  return { label, ref, checkedAt };
}

function registryProject(overrides = {}) {
  return {
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
    owner: "private-owner-name",
    repositories: [],
    revenue: null,
    status: "unknown",
    ...overrides,
  };
}

const registryPayload = {
  schemaVersion: 1,
  scope: "private",
  consumer: "hermes",
  sourceHash,
  updatedAt: "2026-09-19",
  usage: {
    hyphenCoreFilter: "organization === 'hyphen'",
    unknowns: "null and unknown values mean unverified; never fill them from guesses",
  },
  projects: [
    registryProject({
      id: "core-blocked",
      name: "막힌 서비스",
      status: "degraded",
      lifecycle: "active",
      evidenceStatus: "partial",
      blockers: [{ description: "도메인 이전 승인 대기", since: "2026-09-10" }],
      nextEvidence: ["배포 로그 확인"],
    }),
    registryProject({ id: "core-quiet", name: "조용한 서비스", nextEvidence: ["주간 지표 확인"] }),
  ],
};

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

async function createRequest(server, body) {
  const result = await api(server, "/api/requests", {
    method: "POST",
    body: JSON.stringify({
      type: body.type,
      title: body.title || "테스트 요청",
      body: body.body || "테스트 본문",
      target_project: body.target_project || "hermes-mac-ops",
      ...(body.extra || {}),
    }),
  });
  return result;
}

before(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "hermes-studio-test-"));
  registryFile = join(runtimeDir, "registry.private.json");
  await writeFile(registryFile, JSON.stringify(registryPayload, null, 2), "utf8");
  const malformedFile = join(runtimeDir, "broken.json");
  await writeFile(malformedFile, "{ not json ", "utf8");
  for (const [name, registryPath] of [
    ["ok", registryFile],
    ["missing", join(runtimeDir, "absent.json")],
    ["malformed", malformedFile],
  ]) {
    const port = await availablePort();
    const server = {};
    servers[name] = server;
    server.baseUrl = `http://127.0.0.1:${port}`;
    server.dataFile = join(runtimeDir, `requests-${name}.json`);
    server.child = spawn(process.execPath, [join(repoRoot, "mini-server.mjs")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ADMIN_PASSWORD: "test-password",
        SESSION_SECRET: "studio-test-secret",
        WORKER_TOKEN: "test-worker-token",
        HERMES_DATA_FILE: server.dataFile,
        HERMES_PROJECTS_FILE: join(repoRoot, "hermes-projects.json"),
        HERMES_BUSINESS_REGISTRY: registryPath,
        HERMES_SYSTEM1_SHADOW: "",
        PORT: String(port),
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

test("studio briefing requests require an admin session", async () => {
  const unauth = await api(servers.ok, "/api/requests", {
    method: "POST",
    body: JSON.stringify({ type: "studio_priorities", title: "x", body: "y", target_project: "hermes-mac-ops" }),
  });
  assert.equal(unauth.response.status, 401);
  await login(servers.ok);
  await login(servers.missing);
  await login(servers.malformed);
});

test("studio_priorities produces a bounded deterministic owner-facing result", async () => {
  const { response, data } = await createRequest(servers.ok, {
    type: "studio_priorities",
    title: "오늘 우선순위",
    body: "전체 Hyphen Studio 프로젝트의 오늘 우선순위를 정리해줘",
  });
  assert.equal(response.status, 201);
  const request = data.request;
  assert.equal(request.type, "studio_priorities");
  assert.equal(request.status, "done", "briefing completes synchronously — never queued");
  assert.equal(request.risk, "safe");
  assert.equal(request.approved_at, null);
  assert.equal(request.claim_token ?? null, null, "never claimed by a worker");
  assert.match(request.result, /전체 Hyphen Studio · 오늘 우선순위/);
  assert.match(request.result, /소스: 전체 Studio 사업 레지스트리 · 업데이트 2026-09-19/);
  assert.match(request.result, /막힌 서비스/);
  assert.match(request.result, /조용한 서비스/);
  assert.match(request.result, /미검증 현황/);
  assert.deepEqual(Object.keys(request.briefing).sort(), ["itemCount", "sourceLabel", "updatedAt", "view"]);
  assert.equal(request.briefing.view, "priorities");
  assert.equal(request.briefing.sourceLabel, "전체 Studio 사업 레지스트리");
  assert.equal(request.briefing.updatedAt, "2026-09-19");
  assert.equal(request.briefing.itemCount, 2);
  // No source-hash material anywhere in the stored contract.
  assert.equal(JSON.stringify(request.briefing).includes(sourceHash), false);
  assert.equal(request.result.includes("지문"), false);
});

test("studio_blockers renders blocker details, not a raw CLI dump", async () => {
  const { response, data } = await createRequest(servers.ok, {
    type: "studio_blockers",
    title: "막힌 프로젝트",
    body: "전체 Hyphen Studio에서 지금 막힌 프로젝트를 알려줘",
  });
  assert.equal(response.status, 201);
  const request = data.request;
  assert.equal(request.status, "done");
  assert.equal(request.briefing.view, "blockers");
  assert.match(request.result, /전체 Hyphen Studio · 막힌 프로젝트/);
  assert.match(request.result, /막힌 서비스/);
  assert.match(request.result, /도메인 이전 승인 대기/);
  assert.match(request.result, /\(2026-09-10~\)/);
  assert.equal(request.result.includes("조용한 서비스"), false, "only blocked projects appear");
});

test("the view contract is explicit: unknown types and body text never select a briefing view", async () => {
  // An unrecognised type is coerced to "auto" by the existing contract — it is
  // never silently treated as a briefing.
  const bogus = await createRequest(servers.ok, {
    type: "studio_briefing",
    body: "막힌 프로젝트를 알려줘",
  });
  assert.equal(bogus.response.status, 201);
  assert.equal(bogus.data.request.type, "auto");
  assert.equal(bogus.data.request.briefing ?? null, null);
  // Natural-language body text never picks a view: same body on a valid type
  // still follows the type, not the words.
  const byType = await createRequest(servers.ok, {
    type: "studio_priorities",
    body: "막힌 프로젝트를 알려줘",
  });
  assert.equal(byType.data.request.briefing.view, "priorities");
  // Clean up the queued auto request so the worker queue stays empty.
  await api(servers.ok, `/api/requests/${bogus.data.request.id}/cancel`, { method: "POST", body: "{}" });
});

test("a missing registry fails closed with a neutral owner-facing state", async () => {
  const { response, data } = await createRequest(servers.missing, { type: "studio_priorities" });
  assert.equal(response.status, 201);
  const request = data.request;
  assert.equal(request.status, "failed");
  // Generic owner-facing state; the only detail persisted is the allowlisted
  // internal error code — never loader messages or paths.
  assert.deepEqual(Object.keys(request.briefing).sort(), ["error", "view"]);
  assert.equal(request.briefing.error, "registry_unreadable");
  assert.equal(request.briefing.view, "priorities");
  assert.match(request.result, /불러올 수 없습니다/);
  assert.equal(request.result.includes("registry_unreadable"), false, "no internal codes in the UI text");
  assert.equal(request.result.includes("absent.json"), false, "no source filenames");
  assert.equal(request.result.includes(runtimeDir), false, "no absolute paths");
  // Not a fake empty success: no fabricated priorities.
  assert.equal(request.result.includes("근거 없음"), false);
});

test("a malformed registry fails closed without leaking values", async () => {
  const { response, data } = await createRequest(servers.malformed, { type: "studio_blockers" });
  assert.equal(response.status, 201);
  assert.equal(data.request.status, "failed");
  assert.match(data.request.result, /불러올 수 없습니다/);
  assert.ok(
    ["registry_parse_error", "schema_mismatch"].includes(data.request.briefing.error),
    "failure carries only the allowlisted code",
  );
  assert.equal(data.request.result.includes(data.request.briefing.error), false);
});

test("results stay bounded and private", async () => {
  const { data } = await createRequest(servers.ok, { type: "studio_priorities" });
  const request = data.request;
  assert.ok(request.result.length <= 4000);
  for (const forbidden of [
    "docs/private-proof.md", // evidence refs
    "private-owner-name", // owner/contact names
    sourceHash, // full source hash
    sourceHash.slice(0, 12), // fingerprint is never part of the contract
    "지문",
    registryFile, // mounted path
    '"projects"', // raw registry JSON
    "repositories",
    "dataStores",
  ]) {
    assert.equal(request.result.includes(forbidden), false, `result leaks '${forbidden}'`);
  }
  const meta = JSON.stringify(request.briefing);
  assert.equal(meta.includes(sourceHash), false, "metadata leaks the full hash");
  assert.equal(meta.includes(sourceHash.slice(0, 12)), false, "metadata leaks a fingerprint");
});

test("studio requests never reach the worker or the approval path", async () => {
  const { data } = await createRequest(servers.ok, { type: "studio_priorities" });
  const request = data.request;
  assert.equal(request.status, "done");
  assert.equal(request.risk, "safe");
  // The worker sees nothing claimable.
  const next = await fetch(`${servers.ok.baseUrl}/api/worker/next`, {
    headers: { "x-worker-token": "test-worker-token" },
  });
  assert.equal(next.status, 200);
  assert.equal((await next.json()).request, null);
  // Approve is a no-op on a non-approval request; the stored status must not
  // move into an approval or dispatchable state.
  const approve = await api(servers.ok, `/api/requests/${request.id}/approve`, { method: "POST", body: "{}" });
  assert.equal(approve.response.status, 200);
  const listed = await api(servers.ok, "/api/requests");
  const after = listed.data.requests.find((item) => item.id === request.id);
  assert.equal(after.status, "done");
  assert.equal(after.approved_at, null);
  const cancel = await api(servers.ok, `/api/requests/${request.id}/cancel`, { method: "POST", body: "{}" });
  assert.equal(cancel.response.status, 409);
  const retry = await api(servers.ok, `/api/requests/${request.id}/retry`, { method: "POST", body: "{}" });
  assert.equal(retry.response.status, 409);
});

test("worker/next can never claim a queued Studio record (defense in depth)", async () => {
  // Forge a corrupted queued Studio record directly in the store — earlier
  // created_at than any real request so it would be claimed first if the
  // exclusion were missing.
  const raw = JSON.parse(await readFile(servers.ok.dataFile, "utf8"));
  raw.requests.push({ id: "forged-studio-queued", type: "studio_priorities", status: "queued", created_at: 1 });
  await writeFile(servers.ok.dataFile, JSON.stringify(raw), "utf8");
  const normal = await createRequest(servers.ok, { type: "auto", body: "일반 요청" });
  assert.equal(normal.data.request.status, "queued");
  const next = await fetch(`${servers.ok.baseUrl}/api/worker/next`, {
    headers: { "x-worker-token": "test-worker-token" },
  });
  const claimed = (await next.json()).request;
  assert.ok(claimed, "normal queued request is still claimable");
  assert.equal(claimed.id, normal.data.request.id);
  assert.equal(claimed.type, "auto");
  // The forged record stays queued and is never handed out.
  const listed = await api(servers.ok, "/api/requests");
  const forged = listed.data.requests.find((request) => request.id === "forged-studio-queued");
  assert.equal(forged.status, "queued");
  // Regression: a second poll after the normal claim must also skip it.
  const again = await fetch(`${servers.ok.baseUrl}/api/worker/next`, {
    headers: { "x-worker-token": "test-worker-token" },
  });
  assert.equal((await again.json()).request, null);
});

test("retrying a failed briefing regenerates synchronously instead of queueing", async () => {
  const { data } = await createRequest(servers.missing, { type: "studio_blockers" });
  assert.equal(data.request.status, "failed");
  const retry = await api(servers.missing, `/api/requests/${data.request.id}/retry`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(retry.response.status, 200);
  const listed = await api(servers.missing, "/api/requests");
  const item = listed.data.requests.find((request) => request.id === data.request.id);
  assert.equal(item.status, "failed", "regenerated — not re-queued for the worker");
  assert.notEqual(item.status, "queued", "must never become worker-claimable");
  assert.equal(item.claim_token ?? null, null);
  assert.equal(item.briefing.error, "registry_unreadable");
  assert.match(item.result, /불러올 수 없습니다/);
  // Worker-claim regression: nothing studio-typed is ever handed out.
  const next = await fetch(`${servers.missing.baseUrl}/api/worker/next`, {
    headers: { "x-worker-token": "test-worker-token" },
  });
  assert.equal((await next.json()).request, null);
});

test("studio failure states use a fixed code allowlist and fully generic copy", async () => {
  const source = await readFile(join(repoRoot, "mini-server.mjs"), "utf8");
  const set = source.match(/studioErrorCodes = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(set, "studioErrorCodes set missing");
  for (const code of [
    "registry_path_missing",
    "registry_unreadable",
    "registry_symlink",
    "registry_not_regular",
    "registry_too_large",
    "registry_parse_error",
    "schema_mismatch",
    "source_hash_mismatch",
    "registry_module_missing",
    "registry_error",
  ]) {
    assert.ok(set[1].includes(`"${code}"`), `missing allowlisted code ${code}`);
  }
  // Module-internal detail never reaches the owner-visible event stream.
  assert.equal(source.includes("브리핑 모듈 없음"), false);
  // The persisted unavailable message stays fully generic — no mount, path,
  // loader detail, deployment instruction, or internal code.
  assert.match(
    source,
    /studioUnavailableMessage = "지금은 전체 Studio 사업 브리핑을 불러올 수 없습니다\. 잠시 후 다시 시도해주세요\."/,
  );
});

test("Docker packaging ships the connector module but never the private registry", async () => {
  const dockerfile = await readFile(join(repoRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /COPY scripts\/hermes-business-registry\.mjs/);
  assert.equal(dockerfile.includes("registry.private.json"), false);
  assert.equal(dockerfile.includes("outputs/"), false);
  assert.equal(dockerfile.includes("Hyphen-Studio"), false);
});
