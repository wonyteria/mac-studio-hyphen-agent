import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_AUDIT_KIND,
  EVIDENCE_AUDIT_MAX_ITEMS,
  buildEvidenceAudit,
} from "../scripts/hermes-business-registry.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceHash = "a".repeat(64);

function evidence(label = "근거", ref = "docs/proof.md", checkedAt = "2026-09-19") {
  return { label, ref, checkedAt };
}

// Mirrors the real Studio registry shape: hyphen-core projects carry the
// explicit unset markers (unknown / null / empty), never absent keys.
function auditProject(overrides = {}) {
  return {
    blockers: [],
    businessGroup: "테스트 그룹",
    businessType: "unknown",
    dataStores: [],
    deploys: [],
    evidence: [evidence()],
    evidenceStatus: "insufficient",
    id: "alpha",
    kpis: [],
    lifecycle: "unknown",
    name: "Alpha",
    nextEvidence: ["운영 상태 확인"],
    organization: "hyphen",
    owner: null,
    repositories: [],
    revenue: null,
    status: "unknown",
    ...overrides,
  };
}

function auditRegistry(projects, overrides = {}) {
  return {
    schemaVersion: 1,
    scope: "private",
    consumer: "hermes",
    sourceHash,
    updatedAt: "2026-09-19",
    projects,
    ...overrides,
  };
}

// A fully verified project: every field set, no pending asks — it must not
// produce a review item.
const verifiedProject = {
  blockers: [],
  businessGroup: "공유 인프라",
  businessType: "internal-ops",
  dataStores: [{ name: "requests", kind: "json-file", location: "container:/app/var/data/requests.json", backup: null }],
  deploys: [{ url: "https://example.internal", healthcheck: "https://example.internal/health", platform: "mini-vercel" }],
  evidence: [evidence("git remote", "repo-url"), evidence("healthcheck", "health.js")],
  evidenceStatus: "verified",
  id: "verified-proj",
  kpis: [{ name: "요청 수", value: 10, unit: "건", source: "api", measuredAt: "2026-09-19" }],
  lifecycle: "active",
  name: "검증 완료 프로젝트",
  nextEvidence: [],
  organization: "hyphen",
  owner: "ops-owner",
  repositories: [{ url: "https://git.example/repo.git", branch: "main", role: "canonical", localPath: "/srv/private/path" }],
  revenue: { amount: 1000, currency: "KRW", period: "monthly", source: "ledger", asOf: "2026-09-01" },
  status: "operational",
};

test("buildEvidenceAudit is deterministic and mirrors the current registry shape", () => {
  // The live registry: 36 hyphen-core projects, every one status unknown /
  // evidence unmet / owner unset — plus 2 excluded 29sfilm entries.
  const projects = [];
  for (let index = 0; index < 36; index += 1) {
    projects.push(auditProject({ id: `core-${String(index).padStart(2, "0")}`, name: `코어 ${index}` }));
  }
  projects.push(auditProject({ id: "film-a", organization: "29sfilm" }));
  projects.push(auditProject({ id: "film-b", organization: "29sfilm" }));
  const registry = auditRegistry(projects);

  const audit = buildEvidenceAudit(registry);
  assert.equal(audit.kind, EVIDENCE_AUDIT_KIND);
  assert.equal(audit.schemaVersion, 1);
  assert.equal(audit.source.updatedAt, "2026-09-19");
  assert.equal(audit.source.sourceHash, sourceHash);

  // Hyphen core only: 29sfilm entries are excluded, never audited.
  assert.equal(audit.coverage.projects, 38);
  assert.equal(audit.coverage.hyphenCore, 36);
  assert.equal(audit.coverage.excluded, 2);
  assert.deepEqual(audit.coverage.excludedOrganizations, [{ organization: "29sfilm", count: 2 }]);
  for (const item of audit.items) {
    assert.notEqual(item.projectId.startsWith("film-"), true, "29sfilm projects must not appear in items");
  }

  // The current-registry aggregate, exactly: all 36 core projects carry
  // status unknown, evidence unmet, and owner unset.
  assert.equal(audit.coverage.statusUnknown, 36);
  assert.equal(audit.coverage.evidenceUnverified, 36);
  assert.equal(audit.coverage.ownerMissing, 36);
  assert.equal(audit.summary.projectsNeedingReview, 36);
  assert.equal(audit.summary.fieldGaps.status, 36);
  assert.equal(audit.summary.fieldGaps.owner, 36);
  assert.equal(audit.summary.fieldGaps.revenue, 36);
  assert.equal(audit.summary.pendingEvidence, 36);
  assert.equal(audit.summary.byPriority.high, 36);
  assert.equal(audit.summary.byPriority.medium + audit.summary.byPriority.low, 0);

  // Identical input must produce byte-identical output.
  assert.deepEqual(buildEvidenceAudit(registry), audit);
});

test("a fully verified project produces no review item", () => {
  const audit = buildEvidenceAudit(auditRegistry([auditProject(), verifiedProject]));
  assert.equal(audit.summary.projectsNeedingReview, 1);
  assert.equal(audit.items.length, 1);
  assert.equal(audit.items[0].projectId, "alpha");
  assert.equal(audit.items.some((item) => item.projectId === "verified-proj"), false);
});

test("audit items expose only the allowlisted fields and no sensitive material", () => {
  const audit = buildEvidenceAudit(
    auditRegistry([
      auditProject({
        nextEvidence: [
          // Operator-authored asks may embed private detail — the audit must
          // reduce them to a count, never copy the text.
          "백업 경로 /Users/Example/private/secrets 확인",
          "token sk-abc123def456 재발급 여부 확인",
        ],
      }),
      verifiedProject,
      auditProject({ id: "film", organization: "29sfilm" }),
    ]),
  );
  const allowedItemKeys = new Set([
    "projectId",
    "projectName",
    "businessGroup",
    "priority",
    "missingFields",
    "actions",
    "basis",
    "pendingEvidence",
  ]);
  for (const item of audit.items) {
    assert.deepEqual(Object.keys(item).sort(), [...allowedItemKeys].sort());
    for (const field of item.missingFields) {
      assert.ok(
        ["status", "lifecycle", "businessType", "owner", "evidenceStatus", "repositories", "deploys", "dataStores", "kpis", "revenue"].includes(field),
        `unexpected missing-field label ${field}`,
      );
    }
  }
  const serialized = JSON.stringify(audit);
  // No raw registry details: evidence refs, nextEvidence text, local paths,
  // repo URLs, and secret-shaped values must never cross into the output.
  assert.equal(serialized.includes("docs/proof.md"), false, "evidence refs must not leak");
  assert.equal(serialized.includes("/Users/Example/private"), false, "nextEvidence local paths must not leak");
  assert.equal(serialized.includes("sk-abc123def456"), false, "secret-shaped tokens must not leak");
  assert.equal(serialized.includes("/srv/private/path"), false, "local paths must not leak");
  assert.equal(serialized.includes("git.example"), false, "repository URLs must not leak");
  assert.equal(serialized.includes("ops-owner"), false, "owner names must not leak");
  assert.equal(serialized.includes("container:/app/var/data"), false, "data-store locations must not leak");
  assert.deepEqual(Object.keys(audit).sort(), ["coverage", "items", "kind", "schemaVersion", "source", "summary"].sort());
});

test("audit priority ordering is stable and rule-based", () => {
  const registry = auditRegistry([
    auditProject({ id: "z-last", evidenceStatus: "insufficient" }),
    verifiedProject,
    auditProject({ id: "m-mid", evidenceStatus: "partial", businessType: "internal-ops", lifecycle: "active" }),
    auditProject({ id: "a-first", evidenceStatus: "insufficient" }),
    auditProject({ id: "b-more-gaps", evidenceStatus: "insufficient", nextEvidence: [] }),
  ]);
  const audit = buildEvidenceAudit(registry);
  const order = audit.items.map((item) => item.projectId);
  // high items come first; among them more missing fields first, then more
  // pending evidence, then id ascending. b-more-gaps has no pending evidence
  // so a-first (same missing count, 1 pending) outranks it; z-last ties
  // a-first on missing+pending so id asc puts a-first, then b-more-gaps,
  // then z-last. m-mid is partial → medium, after all highs.
  assert.deepEqual(order, ["a-first", "z-last", "b-more-gaps", "m-mid"]);
  assert.equal(audit.items[0].priority, "high");
  assert.equal(audit.items.at(-1).priority, "medium");
  // verified-proj never produces a review item.
  assert.equal(audit.items.some((item) => item.projectId === "verified-proj"), false);
});

test("audit caps items and bounds every string", () => {
  const projects = [];
  for (let index = 0; index < EVIDENCE_AUDIT_MAX_ITEMS + 10; index += 1) {
    projects.push(
      auditProject({
        id: `bulk-${String(index).padStart(3, "0")}`,
        name: `이름\n${"가".repeat(200)}`,
        nextEvidence: [`확인\n${"요청".repeat(200)}`, "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n"],
      }),
    );
  }
  const audit = buildEvidenceAudit(auditRegistry(projects));
  assert.equal(audit.items.length, EVIDENCE_AUDIT_MAX_ITEMS);
  assert.equal(audit.summary.projectsNeedingReview, EVIDENCE_AUDIT_MAX_ITEMS + 10);
  for (const item of audit.items) {
    assert.ok(item.projectName.length <= 81, "names are bounded");
    assert.equal(item.projectName.includes("\n"), false, "names are flattened to one line");
    for (const action of item.actions) {
      assert.equal(action.includes("\n"), false, "actions are flattened to one line");
    }
  }
});

// ---- server integration: synchronous completion, never the worker queue ----

const servers = {};
let runtimeDir;

const serverRegistry = auditRegistry([
  auditProject({
    id: "alpha",
    name: "알파",
    // Operator-authored asks may carry local paths or secret-shaped text —
    // the request record must never store them.
    nextEvidence: ["백업 경로 /Users/Example/private/secrets 확인", "token sk-abc123def456 재발급 여부 확인"],
  }),
  auditProject({ id: "beta", name: "베타" }),
  verifiedProject,
  auditProject({ id: "film", organization: "29sfilm", name: "필름" }),
]);

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
  runtimeDir = await mkdtemp(join(tmpdir(), "hermes-audit-test-"));
  const registryFile = join(runtimeDir, "registry.private.json");
  await writeFile(registryFile, JSON.stringify(serverRegistry, null, 2), "utf8");
  for (const [name, registryPath] of [
    ["ok", registryFile],
    ["missing", join(runtimeDir, "absent.json")],
  ]) {
    const port = await availablePort();
    const server = {};
    servers[name] = server;
    server.baseUrl = `http://127.0.0.1:${port}`;
    server.dataFile = join(runtimeDir, `requests-audit-${name}.json`);
    server.child = spawn(process.execPath, [join(repoRoot, "mini-server.mjs")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ADMIN_PASSWORD: "test-password",
        SESSION_SECRET: "audit-test-secret",
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

test("studio_evidence_audit POST completes synchronously — never queued for the worker", async () => {
  await login(servers.ok);
  const created = await api(servers.ok, "/api/requests", {
    method: "POST",
    body: JSON.stringify({
      type: "studio_evidence_audit",
      title: "사업 현황 갱신 점검",
      body: "전체 Hyphen Studio 사업 현황을 점검해줘",
      target_project: "hermes-mac-ops",
    }),
  });
  assert.equal(created.response.status, 201);
  const request = created.data.request;
  assert.equal(request.type, "studio_evidence_audit");
  assert.equal(request.status, "done", "audit must finish in the request handler, not queue");
  assert.ok(
    Number.isFinite(request.completed_at) && request.completed_at >= request.created_at,
    "completed synchronously — no worker round-trip (ms boundary can differ)",
  );
  assert.equal(request.claimed_at, null, "worker never claims it");
  assert.equal(request.lease_expires_at, null);
  assert.ok(request.result.includes("사업 현황 갱신 점검"));
  assert.ok(request.result.includes("공백 집계"));
  assert.match(request.result, /담당자 미지정 \d+개/, "coverage line uses natural Korean, not field tokens");
  assert.equal(request.result.includes("owner 미지정"), false, "internal field token must not surface");
  assert.ok(request.result.includes("우선 갱신 작업"));
  assert.ok(request.result.includes("알파"), "project names render");
  assert.equal(request.result.includes("film"), false, "29sfilm never renders");
  assert.equal(request.result.includes("docs/proof.md"), false, "evidence refs never render");
  assert.equal(request.result.includes("localPath"), false);
  assert.equal(request.briefing.view, "evidence_audit");
  assert.equal(request.briefing.itemCount, 2);

  // Structured view model persisted for the console renderer — bounded and
  // allowlisted, never the raw audit document.
  const view = request.briefing.audit;
  assert.equal(view.kind, "audit-v1");
  assert.deepEqual(
    Object.keys(view).sort(),
    ["coverage", "items", "kind", "remaining", "summary"],
  );
  assert.deepEqual(
    Object.keys(view.coverage).sort(),
    ["evidenceUnverified", "excluded", "hyphenCore", "ownerMissing", "statusUnknown"],
  );
  assert.deepEqual(
    Object.keys(view.summary).sort(),
    ["byPriority", "pendingEvidence", "projectsNeedingReview"],
  );
  assert.equal(view.items.length, 2);
  assert.equal(view.remaining, 0);
  for (const item of view.items) {
    assert.deepEqual(
      Object.keys(item).sort(),
      ["actions", "businessGroup", "missingFields", "priority", "projectId", "projectName"],
    );
    assert.ok(item.actions.length >= 1 && item.actions.length <= 4);
  }
  const serialized = JSON.stringify(request.briefing);
  for (const leaked of [sourceHash, "docs/proof.md", "repo-url", "localPath", "/Users/", "sk-abc123def456"]) {
    assert.equal(serialized.includes(leaked), false, `briefing must not store ${leaked}`);
  }
});

test("owner-facing audit actions are natural Korean — no internal field tokens", () => {
  const audit = buildEvidenceAudit(serverRegistry);
  assert.ok(audit.items.length > 0);
  for (const item of audit.items) {
    for (const action of item.actions) {
      assert.equal(
        /[A-Za-z]/.test(action),
        false,
        `action must be plain Korean, got: ${action}`,
      );
    }
  }
  // The API schema keeps enum keys (missingFields/basis) — wording only
  // changes in the owner-facing action phrases.
  assert.deepEqual(
    audit.items[0].missingFields.every((field) => typeof field === "string"),
    true,
  );
});

test("studio_evidence_audit fails closed when the registry is unavailable", async () => {
  await login(servers.missing);
  const created = await api(servers.missing, "/api/requests", {
    method: "POST",
    body: JSON.stringify({
      type: "studio_evidence_audit",
      title: "사업 현황 갱신 점검",
      body: "점검해줘",
      target_project: "hermes-mac-ops",
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.request.status, "failed");
  assert.equal(created.data.request.result, "지금은 사업 현황 갱신 점검을 불러올 수 없습니다. 잠시 후 다시 시도해주세요.");
  assert.equal(created.data.request.briefing.error, "registry_unreadable");
  // The bounded failure code stays internal — the user-facing text is fixed.
  assert.equal(created.data.request.result.includes("registry_unreadable"), false);
});

test("GET /api/business/audit is authenticated and returns the same builder output", async () => {
  // A bogus cookie, not an absent one — earlier tests already logged this
  // server in, so an empty Cookie header would just reuse the session.
  const unauth = await api(servers.ok, "/api/business/audit", { headers: { Cookie: "hermes_session=forged" } });
  assert.equal(unauth.response.status, 401);

  await login(servers.ok);
  const result = await api(servers.ok, "/api/business/audit");
  assert.equal(result.response.status, 200);
  assert.equal(result.data.state, "ok");
  assert.equal(result.data.audit.kind, EVIDENCE_AUDIT_KIND);
  assert.equal(result.data.audit.coverage.hyphenCore, 3);
  assert.equal(result.data.audit.coverage.excluded, 1);
  assert.equal(result.data.audit.summary.projectsNeedingReview, 2);
  assert.deepEqual(
    result.data.audit,
    buildEvidenceAudit(serverRegistry),
    "endpoint returns the identical pure-builder output — no second implementation",
  );

  const missing = await api(servers.missing, "/api/business/audit");
  assert.equal(missing.response.status, 200);
  assert.deepEqual(missing.data, { state: "unavailable", audit: null });
});

test("a failed audit regenerates synchronously on retry", async () => {
  await login(servers.missing);
  const created = await api(servers.missing, "/api/requests", {
    method: "POST",
    body: JSON.stringify({
      type: "studio_evidence_audit",
      title: "재시도 점검",
      body: "점검",
      target_project: "hermes-mac-ops",
    }),
  });
  const id = created.data.request.id;
  const retried = await api(servers.missing, `/api/requests/${id}/retry`, { method: "POST", body: "{}" });
  assert.equal(retried.response.status, 200);
  const list = await api(servers.missing, "/api/requests");
  const item = list.data.requests.find((entry) => entry.id === id);
  assert.equal(item.status, "failed", "still failed — registry still absent — but never queued for a worker");
  assert.equal(item.claimed_at, null);
  assert.ok(item.events.some((event) => event.message === "갱신 점검 재생성"));
});
