import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyObviousRequest,
  isProtectedPath,
  isSafePersistentPath,
  parseCodexOutput,
  parseHermesDecision,
} from "../scripts/hermes-local-worker.mjs";

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

before(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "hermes-runtime-test-"));
  dataFile = join(runtimeDir, "requests.json");
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [fileURLToPath(new URL("../mini-server.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      ...process.env,
      ADMIN_PASSWORD: "test-password",
      HERMES_DATA_FILE: dataFile,
      HERMES_PROJECTS_FILE: fileURLToPath(new URL("../hermes-projects.json", import.meta.url)),
      HERMES_WORKER_LEASE_MS: "80",
      PORT: String(port),
      SESSION_SECRET: "runtime-test-secret",
      WORKER_TOKEN: "runtime-worker-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer();
});

after(async () => {
  child?.kill("SIGTERM");
  await rm(runtimeDir, { force: true, recursive: true });
});

test("renders the production Hyphen Studio Agent shell", async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/html/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  const html = await response.text();
  assert.match(html, /<title>Hyphen Studio Agent<\/title>/);
  assert.match(html, /Hyphen Studio Agent/);
  assert.match(html, /id="project"/);
  assert.match(html, /<option value="auto">자동 판단<\/option>/);
  assert.match(html, /<option value="studio_evidence_audit">사업 현황 갱신 점검<\/option>/);
  assert.match(html, /Hermes 4\.3 대화/);
  assert.match(html, /Hermes 운영 요청/);
  assert.match(html, /Codex 개발 요청/);
  assert.match(html, /progress-copy/);
});

test("renders the business-data freshness pill wired to the status API", async () => {
  const html = await (await fetch(baseUrl)).text();
  assert.match(html, /id="biz" class="pill" hidden/);
  assert.match(html, /\/api\/business\/status/);
  assert.match(html, /사업 데이터 최신/);
  assert.match(html, /사업 데이터 지연/);
  assert.match(html, /사업 데이터 사용 불가/);
  // The pill is display-only: it must not submit, approve, or queue anything.
  const renderer = html.match(/function renderBusinessStatus\(data\) \{[\s\S]*?\n {4}\}/);
  assert.ok(renderer, "renderBusinessStatus missing");
  assert.equal(/api\(/.test(renderer[0]), false, "status pill must not call mutating APIs");
});

test("shows truthful connection state driven by API results", async () => {
  const html = await (await fetch(baseUrl)).text();
  assert.match(html, /id="conn" class="pill">연결 확인 중/);
  assert.match(html, /"연결됨" : "연결 끊김 · 재시도 중"/);
  const loader = html.match(/async function load\(\) \{[\s\S]*?\n {4}\}/);
  assert.ok(loader, "load() missing");
  assert.match(loader[0], /setConn\(true\)/);
  assert.match(loader[0], /setConn\(false\)/);
  assert.match(loader[0], /error\.status === 401/);
});

test("empty-state presets only prefill and select existing request types", async () => {
  const html = await (await fetch(baseUrl)).text();
  for (const label of ["오늘 브리핑", "오늘 우선순위", "막힌 프로젝트", "사업 현황 갱신 점검", "Mac 상태 점검", "배포 상태 확인"]) {
    assert.ok(html.includes(`label: "${label}"`), `missing preset ${label}`);
  }
  for (const [id, type] of [
    ["briefing", "studio_overview"],
    ["priorities", "studio_priorities"],
    ["blocked", "studio_blockers"],
    ["audit", "studio_evidence_audit"],
    ["mac", "mac_status"],
    ["deploy", "deployment_status"],
  ]) {
    assert.match(html, new RegExp(`id: "${id}"[^\\n]*type: "${type}"`), `preset ${id} must map to ${type}`);
  }
  // The cross-project presets scope to 전체 Hyphen Studio, not the selected
  // repository: explicit allowlisted studio types, never project_inspect.
  for (const id of ["briefing", "priorities", "blocked", "audit"]) {
    const line = html.match(new RegExp(`id: "${id}".*`, "g"));
    assert.ok(line && !line[0].includes("project_inspect"), `preset ${id} must not use project_inspect`);
  }
  assert.match(html, /전체 Hyphen Studio/, "cross-project scope must be visible");
  assert.match(html, /studioScopeTypes = new Set\(\["studio_priorities", "studio_blockers", "studio_overview", "studio_evidence_audit"\]\)/);
  assert.match(html, /"전체 Hyphen Studio" : \(projectNames/, "block-head scope for studio types");
  // The scope stays visible before submit (composer hint) and after submit
  // (block-head), and no source-hash fingerprint is ever rendered.
  assert.match(html, /범위: 전체 Hyphen Studio · 읽기 전용 브리핑/);
  assert.match(html, /studioScopeTypes\.has\(type\)/);
  assert.match(html, /esc\(active\.briefing\.sourceLabel\)/);
  assert.equal(html.includes("sourceHashFingerprint"), false, "no fingerprint in the UI contract");
  assert.equal(html.includes("지문"), false, "no fingerprint copy in the UI");
  // Guidance is neutral-colored; real submit errors stay danger-colored.
  assert.match(html, /\.error \{ color: var\(--danger\)/);
  assert.match(html, /\.error\[data-guide="1"\] \{ color: var\(--muted\)/);
  const knownTypes = [
    "auto",
    "hermes_chat",
    "hermes_ops",
    "mac_status",
    "deployment_status",
    "project_inspect",
    "redeploy",
    "file_cleanup",
    "development",
    "custom",
    "studio_priorities",
    "studio_blockers",
    "studio_overview",
    "studio_evidence_audit",
  ];
  for (const type of html.matchAll(/type: "([a-z_]+)"/g)) {
    assert.ok(knownTypes.includes(type[1]), `preset selects unknown type ${type[1]}`);
  }
  assert.match(html, /data-preset="/);
  const apply = html.match(/function applyPreset\(id\) \{[\s\S]*?\n {4}\}/);
  assert.ok(apply, "applyPreset missing");
  assert.match(apply[0], /\$\("body"\)\.value = preset\.body;/);
  assert.match(apply[0], /\$\("type"\)\.value = preset\.type/);
  for (const submission of ["requestSubmit", "fetch(", "api(", "submit("]) {
    assert.equal(apply[0].includes(submission), false, `preset path may auto-submit via ${submission}`);
  }
});

test("capability-limited projects get type-specific pre-submit guidance without bypassing the gate", async () => {
  const html = await (await fetch(baseUrl)).text();
  assert.match(html, /projectCapabilities = Object\.fromEntries\(projects\.map/);
  // The repository-inspection wording is reserved for project_inspect only.
  assert.match(
    html,
    /project_inspect: "선택한 프로젝트에는 저장소 점검 연결이 없습니다\. 저장소가 연결된 프로젝트를 선택해주세요\."/,
  );
  for (const type of ["deployment_status", "redeploy", "development"]) {
    const line = html.match(new RegExp(`${type}: "([^"]+)"`));
    assert.ok(line, `missing guidance for ${type}`);
    assert.equal(line[1].includes("저장소 점검"), false, `${type} guidance must not claim repository inspection`);
  }
  const guide = html.match(/function refreshPresetGuidance\(\) \{[\s\S]*?\n {4}\}/);
  assert.ok(guide, "refreshPresetGuidance missing");
  assert.match(guide[0], /capabilityGatedTypes\.includes\(type\)/);
  assert.match(guide[0], /capabilities\.includes\(type\)/);
  assert.match(guide[0], /capabilityGuidance\[type\]/);
  assert.match(html, /capabilityGatedTypes = \[[^\]]*"project_inspect"[^\]]*\]/);
  assert.match(html, /\$\("project"\)\.onchange = refreshPresetGuidance/);
  assert.match(html, /\$\("type"\)\.onchange = refreshPresetGuidance/);
  const apply = html.match(/function applyPreset\(id\) \{[\s\S]*?\n {4}\}/);
  assert.ok(apply, "applyPreset missing");
  assert.match(apply[0], /refreshPresetGuidance\(\)/);
  // A backend capability rejection is marked as guidance too, so changing the
  // project or type recomputes/clears it instead of sticking as a raw error.
  const submit = html.match(/\$\("requestForm"\)\.onsubmit = async \(event\) => \{[^\n]+\};/);
  assert.ok(submit, "requestForm onsubmit missing");
  assert.match(submit[0], /project_capability_not_enabled/);
  assert.match(submit[0], /capabilityGuidance\[\$\("type"\)\.value\]/);
  assert.match(submit[0], /dataset\.guide = "1"/);
  // Guidance must never reach the network or the approval path.
  for (const bypass of ["requestSubmit", "fetch(", "api(", "approve", "submit("]) {
    assert.equal(guide[0].includes(bypass), false, `guidance must not ${bypass}`);
  }
});

test("빠른 판단 panel renders only allowlisted observation fields", async () => {
  const html = await (await fetch(baseUrl)).text();
  assert.match(html, /빠른 판단/);
  assert.match(html, /관찰 전용 · 실행에 영향 없음/);
  const panel = html.match(/function shadowPanel\(shadow\) \{[\s\S]*?\n {4}\}/);
  assert.ok(panel, "shadowPanel missing");
  for (const allowed of ["shadow.kind", "shadow.status", "shadow.route", "shadow.policyVerdict", "shadow.confidence"]) {
    assert.ok(panel[0].includes(allowed), `panel should read ${allowed}`);
  }
  for (const forbidden of [
    "features",
    "taskSignals",
    "riskFlags",
    "capabilities",
    "ambiguity",
    "determinedBy",
    "reasons",
    "observed_at",
    "shadow.body",
    "shadow.title",
    "JSON.stringify(shadow)",
  ]) {
    assert.equal(panel[0].includes(forbidden), false, `panel must not reference ${forbidden}`);
  }
});

test("mobile history drawer is accessible and mirrors the sidebar contract", async () => {
  const html = await (await fetch(baseUrl)).text();
  // Menu button only appears on narrow screens and controls the drawer.
  assert.match(html, /id="menuBtn" class="icon-btn menu-btn"[^>]*aria-expanded="false"[^>]*aria-controls="drawer"/);
  assert.match(html, /\.menu-btn \{ display: none; \}/);
  assert.match(html, /@media \(max-width: 760px\)[\s\S]*?\.menu-btn \{ display: inline-flex; \}/);
  // The drawer is a labelled modal sheet with the full navigation contract.
  assert.match(html, /id="drawer" class="drawer" hidden aria-label="요청 기록" role="dialog" aria-modal="true"/);
  assert.match(html, /id="drawerScrim" class="drawer-scrim" hidden/);
  for (const id of ["drawerClose", "drawerHome", "drawerNew", "drawerThreads", "drawerRefresh", "drawerLogout"]) {
    assert.ok(html.includes(`id="${id}"`), `missing drawer control ${id}`);
  }
  // Escape closes it, scrim tap closes it, selecting a request closes it.
  assert.match(html, /event\.key === "Escape" && !\$\("drawer"\)\.hidden/);
  assert.match(html, /\$\("drawerScrim"\)\.onclick = \(\) => closeDrawer\(false\)/);
  assert.match(html, /\$\("drawerThreads"\)\.onclick = async \(event\)[^\n]*closeDrawer\(false\); current = id/);
  // Focus returns to the menu button on close.
  assert.match(html, /if \(restoreFocus\) \$\("menuBtn"\)\.focus\(\)/);
  // The thread list renders into both sidebar and drawer from one source.
  assert.match(html, /\$\("drawerThreads"\)\.innerHTML = threadHtml/);
});

test("persistent Home entry renders greeting, live state, and grouped actions", async () => {
  const html = await (await fetch(baseUrl)).text();
  // Reachable from desktop sidebar and the mobile drawer.
  assert.match(html, /id="homeBtn" class="new-chat"[^>]*>홈 · 빠른 작업/);
  assert.match(html, /id="drawerHome" class="drawer-action"[^>]*>홈 · 빠른 작업/);
  assert.match(html, /\$\("homeBtn"\)\.onclick = goHome/);
  assert.match(html, /function goHome\(\) \{ current = null; composingNew = true/);
  // Grouped launcher: business / operations / development categories.
  const home = html.match(/function homeHtml\(\) \{[\s\S]*?\n {4}\}/);
  assert.ok(home, "homeHtml missing");
  assert.match(html, /action-groups/);
  assert.match(html, /id: "business", title: "사업"/);
  assert.match(html, /id: "ops", title: "운영"/);
  assert.match(html, /id: "dev", title: "개발"/);
  for (const label of ["프로젝트 점검", "개발 요청"]) {
    assert.ok(html.includes(`label: "${label}"`), `missing preset ${label}`);
  }
  assert.match(html, /id: "inspect"[^\n]*type: "project_inspect"/);
  assert.match(html, /id: "dev"[^\n]*type: "development"/);
  // Live state strip reads cached truth, never fabricated placeholders.
  assert.match(html, /function homeStateHtml\(\)[\s\S]*?connState/);
  assert.match(html, /bizState && bizState\.state === "fresh"/);
  // Scope copy distinguishes studio-wide vs selected-project actions.
  assert.match(html, /전체 Hyphen Studio 기준으로 읽기만 합니다/);
  assert.match(html, /선택한 프로젝트에 적용됩니다/);
});

test("home stays selected until an explicit request selection — no auto reselect", async () => {
  const html = await (await fetch(baseUrl)).text();
  // Regression: goHome must suppress the newest-request auto-select, else the
  // drawer/sidebar home button snaps back to the latest request.
  assert.match(html, /function goHome\(\) \{ current = null; composingNew = true; void load\(\); \}/);
  // Initial load still auto-selects the newest request only when the user has
  // expressed no intent (composingNew false).
  assert.match(html, /if \(!current && !composingNew && sorted\[0\]\) current = sorted\[0\]\.id;/);
  // Selecting a thread — sidebar or drawer — clears the home flag.
  assert.match(html, /\$\("threads"\)\.onclick = async \(event\)[^\n]*composingNew = false/);
  assert.match(html, /\$\("drawerThreads"\)\.onclick = async \(event\)[^\n]*composingNew = false/);
  // The drawer home entry closes the drawer before going home.
  assert.match(html, /\$\("drawerHome"\)\.onclick = \(\) => \{ closeDrawer\(false\); goHome\(\); \}/);
  // Creating a request leaves the home surface for the new request.
  assert.match(html, /current = created\.request\.id; composingNew = false;/);
});

test("status-only projects surface their capability reason in the UI", async () => {
  const html = await (await fetch(baseUrl)).text();
  // Server passes capabilityReason through the projects API (server-side
  // contract — asserted against the module source, not the HTML response).
  const source = await readFile(fileURLToPath(new URL("../mini-server.mjs", import.meta.url)), "utf8");
  assert.match(source, /capabilityReason: typeof capabilityReason === "string" \? capabilityReason\.slice\(0, 80\) : null/);
  // The composer marks status-only projects in the option label.
  assert.match(html, /" · 상태 조회만"/);
  // Guidance shows the audit reason before the generic capability copy.
  assert.match(html, /capabilityReasonLabels\[projectReasons\[project\]\]/);
  assert.match(html, /branch_remote_missing: "리모트에 브랜치 없음"/);
  const login = await request(
    "/api/login",
    { method: "POST", body: JSON.stringify({ password: "test-password" }) },
    null,
  );
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get("set-cookie").split(";")[0];
  const { response, data } = await request("/api/projects", {}, cookie);
  assert.equal(response.status, 200);
  const reasoned = data.projects.find((project) => project.capabilityReason);
  assert.ok(reasoned, "expected at least one status-only project with a reason");
  assert.ok(reasoned.capabilityReason.length <= 80);
  assert.deepEqual(reasoned.capabilities, ["deployment_status"]);
});

test("composer stacks fields on narrow screens and shows plain-Korean scope", async () => {
  const html = await (await fetch(baseUrl)).text();
  assert.match(html, /<label class="field"><span>프로젝트<\/span><select id="project"/);
  assert.match(html, /<label class="field"><span>작업 종류<\/span><select id="type"/);
  assert.match(html, /id="scopeLine" class="scope-line"/);
  assert.match(html, /scopeEl\.textContent = studioScopeTypes\.has\(type\)/);
  assert.match(html, /"프로젝트: " \+ \(projectNames\[project\]/);
  // Fields wrap below 760px and go fully stacked below 420px.
  assert.match(html, /\.composer-fields \{ display: flex; flex: 1; flex-wrap: wrap; gap: 8px; min-width: 0; \}/);
  assert.match(html, /@media \(max-width: 760px\)[\s\S]*?\.field \{ flex-basis: 45%; \}/);
  assert.match(html, /@media \(max-width: 420px\)[\s\S]*?\.field \{ flex-basis: 100%; \}/);
  // Enter-to-send and Shift+Enter newline preserved.
  assert.match(html, /event\.key === "Enter" && !event\.shiftKey/);
});

test("results render as readable panels; the audit gets a bounded structured view", async () => {
  const html = await (await fetch(baseUrl)).text();
  // No monospace dump — text results use a wrapping sans-serif panel.
  assert.equal(html.includes("<pre>"), false, "results must not render as pre blocks");
  assert.match(html, /\.result-text \{[^}]*overflow-wrap: anywhere[^}]*white-space: pre-wrap/);
  assert.match(html, /'<div class="result-text">' \+ esc\(active\.result\) \+ '<\/div>'/);
  // Structured audit view model contract — the builder lives in the server
  // module, so check the source rather than the served page.
  const serverSource = await readFile(fileURLToPath(new URL("../mini-server.mjs", import.meta.url)), "utf8");
  assert.match(serverSource, /function auditViewModel\(audit\)/);
  assert.match(serverSource, /kind: "audit-v1"/);
  assert.match(serverSource, /audit: auditViewModel\(audit\)/);
  assert.match(html, /audit\.kind === "audit-v1"/);
  const view = html.match(/function auditView\(audit\) \{[\s\S]*?\n {4}\}/);
  assert.ok(view, "auditView missing");
  for (const key of ["audit.coverage.hyphenCore", "audit.coverage.statusUnknown", "audit.coverage.evidenceUnverified", "audit.coverage.ownerMissing", "audit.summary.projectsNeedingReview", "audit.summary.pendingEvidence", "audit.remaining"]) {
    assert.ok(view[0].includes(key), `auditView should read ${key}`);
  }
  // Korean labels replace internal field tokens in the UI.
  assert.match(html, /auditFieldLabels = \{ status: "상태", lifecycle: "사업 단계", businessType: "사업 유형", owner: "담당자"/);
  // Fallback: old records without briefing.audit still render safely.
  const result = html.match(/function resultHtml\(active\) \{[\s\S]*?\n {4}\}/);
  assert.ok(result, "resultHtml missing");
  assert.match(result[0], /audit\.kind === "audit-v1"/);
  assert.match(result[0], /Array\.isArray\(audit\.items\)/);
  // Observation and event history are collapsible, subordinate regions.
  assert.match(html, /<details class="fold s1">/);
  assert.match(html, /<details class="fold events-fold"><summary>최근 기록/);
  // No source-hash fingerprint anywhere in the UI contract.
  assert.equal(html.includes("sourceHash"), false);
});

test("layout prevents horizontal overflow down to 320px", async () => {
  const html = await (await fetch(baseUrl)).text();
  // Single-column app grid on mobile; every grid/flex child can shrink.
  assert.match(html, /#app \{[^}]*grid-template-columns: 272px minmax\(0, 1fr\)/);
  assert.match(html, /@media \(max-width: 760px\) \{\s*#app \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(html, /\.chat \{[^}]*min-width: 0/);
  assert.match(html, /\.messages \{[^}]*min-width: 0/);
  assert.match(html, /\.chat-title \{[^}]*min-width: 0/);
  assert.match(html, /\.status-row \{[^}]*flex-wrap: wrap/);
  assert.match(html, /\.chat-top \{[^}]*flex-wrap: wrap/);
  // 100dvh keeps mobile browser chrome honest.
  assert.match(html, /height: 100dvh/);
  // Touch targets: presets, send button, thread rows, drawer actions ≥44px.
  assert.match(html, /\.preset \{[^}]*min-height: 44px/);
  assert.match(html, /\.send \{[^}]*height: 44px;[^}]*width: 44px/);
  assert.match(html, /\.thread \{[^}]*min-height: 44px/);
  assert.match(html, /\.drawer-action \{[^}]*min-height: 44px/);
  // Visible focus + reduced-motion safety.
  assert.match(html, /:focus-visible \{\s*outline: 2px solid var\(--focus\)/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
});

test("requires login for requests and exposes only public project fields", async () => {
  const unauthorized = await request("/api/requests", {}, null);
  assert.equal(unauthorized.response.status, 401);

  const builtInPassword = await request(
    "/api/login",
    { method: "POST", body: JSON.stringify({ password: "1234" }) },
    null,
  );
  assert.equal(builtInPassword.response.status, 401);

  const login = await request(
    "/api/login",
    { method: "POST", body: JSON.stringify({ password: "test-password" }) },
    null,
  );
  assert.equal(login.response.status, 200);
  sessionCookie = login.response.headers.get("set-cookie").split(";")[0];

  const projects = await request("/api/projects");
  assert.equal(projects.response.status, 200);
  assert.deepEqual(Object.keys(projects.data.projects[0]).sort(), [
    "capabilities",
    "capabilityReason",
    "domain",
    "id",
    "name",
  ]);
  assert.equal(projects.data.projects[0].id, "hermes-mac-ops");
  assert.equal(projects.data.projects.length, 26);
});

test("runs the approval, claim, heartbeat, and result state machine", async () => {
  const created = await request("/api/requests", {
    method: "POST",
    body: JSON.stringify({
      body: "버튼 문구를 더 짧게 수정해줘",
      target_project: "hermes-mac-ops",
      title: "버튼 문구 수정",
      type: "development",
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.request.status, "approval_required");

  const id = created.data.request.id;
  const approved = await request(`/api/requests/${id}/approve`, { method: "POST", body: "{}" });
  assert.equal(approved.response.status, 200);

  const claimed = await request(
    "/api/worker/next",
    { headers: { "X-Worker-Token": "runtime-worker-token" } },
    null,
  );
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.data.request.id, id);
  assert.equal(claimed.data.request.status, "running");
  assert.ok(claimed.data.request.claim_token);

  const heartbeat = await request(
    "/api/worker/heartbeat",
    {
      method: "POST",
      headers: { "X-Worker-Token": "runtime-worker-token" },
      body: JSON.stringify({
        claimToken: claimed.data.request.claim_token,
        id,
        progress: "Codex가 수정 중입니다.",
        step: "codex",
      }),
    },
    null,
  );
  assert.equal(heartbeat.response.status, 200);

  const rejectedResult = await request(
    "/api/worker/result",
    {
      method: "POST",
      headers: { "X-Worker-Token": "runtime-worker-token" },
      body: JSON.stringify({ claimToken: "wrong", id, result: "no", status: "done" }),
    },
    null,
  );
  assert.equal(rejectedResult.response.status, 409);

  const completed = await request(
    "/api/worker/result",
    {
      method: "POST",
      headers: { "X-Worker-Token": "runtime-worker-token" },
      body: JSON.stringify({
        claimToken: claimed.data.request.claim_token,
        id,
        result: "수정 및 배포 완료",
        status: "done",
      }),
    },
    null,
  );
  assert.equal(completed.response.status, 200);

  const requests = await request("/api/requests");
  const item = requests.data.requests.find((candidate) => candidate.id === id);
  assert.equal(item.status, "done");
  assert.equal(item.progress_step, "done");
  assert.equal(item.result, "수정 및 배포 완료");
  assert.ok(item.events.some((event) => event.message === "Codex가 수정 중입니다."));
});

test("fails a stale mutation instead of executing it twice", async () => {
  const created = await request("/api/requests", {
    method: "POST",
    body: JSON.stringify({
      body: "오래 걸리는 수정",
      target_project: "hermes-mac-ops",
      title: "stale mutation",
      type: "development",
    }),
  });
  const id = created.data.request.id;
  await request(`/api/requests/${id}/approve`, { method: "POST", body: "{}" });
  const claimed = await request(
    "/api/worker/next",
    { headers: { "X-Worker-Token": "runtime-worker-token" } },
    null,
  );
  assert.equal(claimed.data.request.id, id);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await request(
    "/api/worker/next",
    { headers: { "X-Worker-Token": "runtime-worker-token" } },
    null,
  );
  const requests = await request("/api/requests");
  const item = requests.data.requests.find((candidate) => candidate.id === id);
  assert.equal(item.status, "failed");
  assert.match(item.result, /중복 변경을 막기 위해/);
});

test("queues tool-free Hermes chat and gates Hermes operations", async () => {
  const chat = await request("/api/requests", {
    method: "POST",
    body: JSON.stringify({
      body: "파일 삭제 원칙을 설명해줘",
      target_project: "hermes-mac-ops",
      title: "Hermes chat",
      type: "hermes_chat",
    }),
  });
  assert.equal(chat.response.status, 201);
  assert.equal(chat.data.request.status, "queued");
  assert.equal(chat.data.request.risk, "safe");

  const operations = await request("/api/requests", {
    method: "POST",
    body: JSON.stringify({
      body: "실행 중인 서비스를 점검해줘",
      target_project: "hermes-mac-ops",
      title: "Hermes operations",
      type: "hermes_ops",
    }),
  });
  assert.equal(operations.response.status, 201);
  assert.equal(operations.data.request.status, "approval_required");
  assert.equal(operations.data.request.risk, "approval_required");
  await request(`/api/requests/${chat.data.request.id}/cancel`, { method: "POST", body: "{}" });
  await request(`/api/requests/${operations.data.request.id}/cancel`, { method: "POST", body: "{}" });
});

test("auto mode runs safe plans immediately", async () => {
  const created = await request("/api/requests", {
    method: "POST",
    body: JSON.stringify({
      body: "현재 Mac 메모리 상태 알려줘",
      target_project: "hermes-mac-ops",
      title: "automatic safe route",
      type: "auto",
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.request.status, "queued");
  assert.equal(created.data.request.risk, "pending");

  const claimed = await request(
    "/api/worker/next",
    { headers: { "X-Worker-Token": "runtime-worker-token" } },
    null,
  );
  assert.equal(claimed.data.request.id, created.data.request.id);
  const planned = await request(
    "/api/worker/plan",
    {
      method: "POST",
      headers: { "X-Worker-Token": "runtime-worker-token" },
      body: JSON.stringify({
        claimToken: claimed.data.request.claim_token,
        id: claimed.data.request.id,
        reason: "현재 장비 상태 조회",
        resolvedType: "mac_status",
      }),
    },
    null,
  );
  assert.equal(planned.response.status, 200);
  assert.equal(planned.data.deferred, false);
  await request(
    "/api/worker/result",
    {
      method: "POST",
      headers: { "X-Worker-Token": "runtime-worker-token" },
      body: JSON.stringify({
        claimToken: claimed.data.request.claim_token,
        id: claimed.data.request.id,
        result: "메모리 정상",
        status: "done",
      }),
    },
    null,
  );
  const requests = await request("/api/requests");
  const item = requests.data.requests.find((candidate) => candidate.id === claimed.data.request.id);
  assert.equal(item.resolved_type, "mac_status");
  assert.equal(item.risk, "safe");
  assert.equal(item.plan, "현재 장비 상태 조회");
  assert.equal(item.status, "done");
});

test("auto mode defers mutations until explicit approval", async () => {
  const created = await request("/api/requests", {
    method: "POST",
    body: JSON.stringify({
      body: "README 문구를 수정하고 배포해줘",
      target_project: "hermes-mac-ops",
      title: "automatic mutation route",
      type: "auto",
    }),
  });
  const claimed = await request(
    "/api/worker/next",
    { headers: { "X-Worker-Token": "runtime-worker-token" } },
    null,
  );
  assert.equal(claimed.data.request.id, created.data.request.id);
  const planned = await request(
    "/api/worker/plan",
    {
      method: "POST",
      headers: { "X-Worker-Token": "runtime-worker-token" },
      body: JSON.stringify({
        claimToken: claimed.data.request.claim_token,
        id: claimed.data.request.id,
        reason: "파일 변경과 배포 요청",
        resolvedType: "development",
      }),
    },
    null,
  );
  assert.equal(planned.response.status, 200);
  assert.equal(planned.data.deferred, true);

  let requests = await request("/api/requests");
  let item = requests.data.requests.find((candidate) => candidate.id === created.data.request.id);
  assert.equal(item.status, "approval_required");
  assert.equal(item.claim_token, null);
  assert.equal(item.resolved_type, "development");

  await request(`/api/requests/${item.id}/approve`, { method: "POST", body: "{}" });
  const reclaimed = await request(
    "/api/worker/next",
    { headers: { "X-Worker-Token": "runtime-worker-token" } },
    null,
  );
  assert.equal(reclaimed.data.request.id, item.id);
  assert.equal(reclaimed.data.request.resolved_type, "development");
  assert.ok(reclaimed.data.request.approved_at);
  const extended = await request(
    "/api/worker/heartbeat",
    {
      method: "POST",
      headers: { "X-Worker-Token": "runtime-worker-token" },
      body: JSON.stringify({
        claimToken: reclaimed.data.request.claim_token,
        id: reclaimed.data.request.id,
        leaseExtensionMs: 1000,
        progress: "배포 전환 중입니다.",
        step: "deploy_start",
      }),
    },
    null,
  );
  assert.equal(extended.response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const noDuplicateClaim = await request(
    "/api/worker/next",
    { headers: { "X-Worker-Token": "runtime-worker-token" } },
    null,
  );
  assert.equal(noDuplicateClaim.data.request, null);
  await request(
    "/api/worker/result",
    {
      method: "POST",
      headers: { "X-Worker-Token": "runtime-worker-token" },
      body: JSON.stringify({
        claimToken: reclaimed.data.request.claim_token,
        id: reclaimed.data.request.id,
        result: "승인된 변경 완료",
        status: "done",
      }),
    },
    null,
  );
  requests = await request("/api/requests");
  item = requests.data.requests.find((candidate) => candidate.id === created.data.request.id);
  assert.equal(item.status, "done");
});

test("Studio handoff prefill is validated server-side and embedded safely", async () => {
  const clean = await (await fetch(`${baseUrl}/?project=hermes-mac-ops&type=development&prompt=%ED%85%8C%EC%8A%A4%ED%8A%B8`)).text();
  assert.match(clean, /window\.__HERMES_PREFILL__ = \{"project":"hermes-mac-ops","type":"development","prompt":"테스트"\};/);
  assert.equal(clean.includes("__PREFILL_JSON__"), false, "placeholder must be replaced");

  const bad = await (await fetch(`${baseUrl}/?project=..%2Fetc&type=shell&prompt=a%07b`)).text();
  assert.match(bad, /window\.__HERMES_PREFILL__ = \{"project":null,"type":"auto","prompt":""\};/);

  const duplicated = await (await fetch(`${baseUrl}/?prompt=x&prompt=y`)).text();
  assert.match(duplicated, /window\.__HERMES_PREFILL__ = \{"project":null,"type":"auto","prompt":""\};/);

  // Params outside the allowlist can never smuggle approval, execution, or
  // submission state into the page.
  const foreign = await (await fetch(`${baseUrl}/?approve=1&autoSubmit=true&execute=yes&token=abc`)).text();
  assert.match(foreign, /window\.__HERMES_PREFILL__ = null;/);

  const breaking = await (await fetch(`${baseUrl}/?prompt=${encodeURIComponent("</script><img src=x>")}`)).text();
  assert.equal(breaking.includes("</script><img"), false, "prefill must not break out of the script tag");
});

test("handoff prefill only drafts the composer after login and never submits", async () => {
  const html = await (await fetch(baseUrl)).text();
  // Applied only inside the authenticated load() path, after project options exist.
  const loader = html.match(/async function load\(\) \{[\s\S]*?\n {4}\}/);
  assert.ok(loader, "load() missing");
  assert.match(loader[0], /applyHandoffPrefill\(\)/);
  assert.ok(loader[0].indexOf('document.body.classList.add("authed")') < loader[0].indexOf("applyHandoffPrefill()"), "prefill must apply after auth succeeds");
  const apply = html.match(/function applyHandoffPrefill\(\) \{[\s\S]*?\n {4}\}/);
  assert.ok(apply, "applyHandoffPrefill missing");
  // The draft stays editable: notice copy, capability guidance, focus — and no
  // path to submission, approval, or any network call.
  assert.match(apply[0], /확인하고 직접 보내야 실행됩니다/);
  assert.match(apply[0], /refreshPresetGuidance\(\)/);
  for (const forbidden of ["requestSubmit", "fetch(", "api(", "approve", "/api/", "submit("]) {
    assert.equal(apply[0].includes(forbidden), false, `prefill path must not ${forbidden}`);
  }
  // Reapplication is impossible: the global is cleared and the URL is reset.
  assert.match(apply[0], /window\.__HERMES_PREFILL__ = null/);
  assert.match(apply[0], /history\.replaceState/);
});

test("cancels queued requests before the worker starts", async () => {
  const created = await request("/api/requests", {
    method: "POST",
    body: JSON.stringify({
      body: "이 요청은 취소할게",
      target_project: "hermes-mac-ops",
      title: "cancel queued",
      type: "auto",
    }),
  });
  const canceled = await request(`/api/requests/${created.data.request.id}/cancel`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(canceled.response.status, 200);
  const requests = await request("/api/requests");
  const item = requests.data.requests.find((candidate) => candidate.id === created.data.request.id);
  assert.equal(item.status, "canceled");
  const retried = await request(`/api/requests/${created.data.request.id}/retry`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(retried.response.status, 200);
  const afterRetry = await request("/api/requests");
  assert.equal(
    afterRetry.data.requests.find((candidate) => candidate.id === created.data.request.id).status,
    "queued",
  );
  await request(`/api/requests/${created.data.request.id}/cancel`, { method: "POST", body: "{}" });
});

test("rejects unknown project ids", async () => {
  const result = await request("/api/requests", {
    method: "POST",
    body: JSON.stringify({
      body: "inspect",
      target_project: "outside-project",
      title: "invalid",
      type: "project_inspect",
    }),
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error, "unknown_project");
});

test("rejects mutations for status-only mini deploy projects", async () => {
  const result = await request("/api/requests", {
    method: "POST",
    body: JSON.stringify({
      body: "코드를 고쳐줘",
      target_project: "project_058b0b3e024941c2ad259ca9927f9f15",
      title: "blocked mutation",
      type: "development",
    }),
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error, "project_capability_not_enabled");
});

test("parses Codex JSONL and protects credential-like paths", () => {
  const parsed = parseCodexOutput(
    [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "완료" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12 } }),
    ].join("\n"),
  );
  assert.equal(parsed.threadId, "thread-1");
  assert.equal(parsed.finalMessage, "완료");
  assert.equal(parsed.usage.input_tokens, 12);
  assert.equal(isProtectedPath(".dev.vars"), true);
  assert.equal(isProtectedPath("config/.env.production"), true);
  assert.equal(isProtectedPath(".env.example"), false);
  assert.equal(isProtectedPath("certs/server.pem"), true);
  assert.equal(isProtectedPath("config/secrets/database.json"), true);
  assert.equal(isProtectedPath("src/.env/production.json"), true);
  assert.equal(isProtectedPath("app/page.tsx"), false);
  assert.equal(isSafePersistentPath("data/requests.json"), true);
  assert.equal(isSafePersistentPath("../requests.json"), false);
  assert.equal(isSafePersistentPath("/tmp/requests.json"), false);
  assert.equal(isSafePersistentPath("data/../requests.json"), false);
});

test("accepts only allowlisted Hermes operation decisions", () => {
  assert.deepEqual(
    parseHermesDecision('<think>분류</think>\n```json\n{"action":"mac_status","reason":"현재 상태 확인"}\n```'),
    { action: "mac_status", message: "", reason: "현재 상태 확인" },
  );
  assert.deepEqual(
    parseHermesDecision(
      '{"action":"mac_status","reason":"상태 확인"}\n{"action":"deployment_status","reason":"배포 확인"}',
    ),
    { action: "mac_status", message: "", reason: "상태 확인" },
  );
  assert.throws(
    () => parseHermesDecision('{"action":"arbitrary_shell","reason":"임의 명령"}'),
    /안전한 JSON/,
  );
});

test("routes obvious Korean operations without waking the local model", () => {
  assert.equal(classifyObviousRequest("현재 Mac 메모리와 프로세스 상태 알려줘").action, "mac_status");
  assert.equal(classifyObviousRequest("배포 상태 확인해줘").action, "deployment_status");
  assert.equal(classifyObviousRequest("README 문구 수정하고 배포해줘").action, "development");
  assert.equal(classifyObviousRequest("Docker 빌드 캐시 정리해줘").action, "file_cleanup");
  assert.equal(classifyObviousRequest("그 프로젝트 다시 배포해줘").action, "redeploy");
  assert.equal(classifyObviousRequest("안녕하세요"), null);
});

test("persists a readable JSON request store", async () => {
  const store = JSON.parse(await readFile(dataFile, "utf8"));
  assert.ok(Array.isArray(store.requests));
  assert.ok(store.requests.length >= 1);
});

test("test files resolve from the repository root", () => {
  assert.equal(new URL("./package.json", root).pathname.endsWith("/package.json"), true);
});
