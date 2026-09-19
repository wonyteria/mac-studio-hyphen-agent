import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";

const port = Number(process.env.PORT || 3000);
const adminPassword = process.env.ADMIN_PASSWORD || "";
const sessionSecret = process.env.SESSION_SECRET || "";
const workerToken = process.env.WORKER_TOKEN || "";
const dataFile = process.env.HERMES_DATA_FILE || "/app/var/data/requests.json";
const projectsFile = process.env.HERMES_PROJECTS_FILE || "/app/hermes-projects.json";
const system1ShadowEnabled = process.env.HERMES_SYSTEM1_SHADOW === "1";
const sessionCookie = "hermes_session";
const requestTypes = new Set([
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
]);
const resolvedRequestTypes = new Set([
  "hermes_chat",
  "mac_status",
  "deployment_status",
  "project_inspect",
  "redeploy",
  "file_cleanup",
  "development",
]);
const mutationTypes = new Set(["redeploy", "file_cleanup", "development", "hermes_ops"]);
const defaultProject = "hermes-mac-ops";
const sessionMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const workerLeaseMs = Number(process.env.HERMES_WORKER_LEASE_MS || 3 * 60 * 1000);
const maxDeploymentLeaseMs = 30 * 60 * 1000;
const staleRunningMs = 50 * 60 * 1000;
const maxBodyBytes = 32 * 1024;
const loginAttempts = new Map();
let storeMutation = Promise.resolve();

const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hermes Chat</title>
  <style>
    :root {
      color-scheme: light;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --bg: #ffffff;
      --sidebar: #f9f9f9;
      --surface: #ffffff;
      --line: #e5e5e5;
      --line-strong: #d9d9d9;
      --text: #0d0d0d;
      --muted: #6f6f6f;
      --soft: #f4f4f4;
      --assistant: #f7f7f8;
      --accent: #10a37f;
      --danger: #d92d20;
      --warning: #b54708;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    html, body { height: 100%; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    button, input, textarea, select { font: inherit; }
    button { border: 0; cursor: pointer; }
    #login {
      align-items: center;
      display: grid;
      min-height: 100vh;
      padding: 24px;
    }
    .login-card {
      display: grid;
      gap: 22px;
      margin: 0 auto;
      max-width: 420px;
      width: 100%;
    }
    .mark {
      align-items: center;
      background: #0d0d0d;
      border-radius: 50%;
      color: white;
      display: inline-flex;
      font-weight: 700;
      height: 38px;
      justify-content: center;
      width: 38px;
    }
    h1 { font-size: 28px; letter-spacing: 0; line-height: 1.15; margin: 0; }
    p { margin: 0; }
    .muted { color: var(--muted); line-height: 1.5; }
    .login-form { display: grid; gap: 12px; }
    input, textarea, select {
      background: var(--surface);
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      color: var(--text);
      outline: 0;
      padding: 12px 13px;
      width: 100%;
    }
    input:focus, textarea:focus, select:focus { border-color: #8f8f8f; box-shadow: 0 0 0 2px rgb(0 0 0 / 5%); }
    .primary {
      align-items: center;
      background: #0d0d0d;
      border-radius: 8px;
      color: white;
      display: inline-flex;
      font-weight: 650;
      justify-content: center;
      min-height: 44px;
      padding: 0 16px;
    }
    .icon-btn {
      align-items: center;
      background: transparent;
      border-radius: 8px;
      color: var(--text);
      display: inline-flex;
      height: 36px;
      justify-content: center;
      width: 36px;
    }
    .icon-btn:hover, .thread:hover, .pill:hover { background: var(--soft); }
    #app {
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      height: 100vh;
      min-height: 0;
    }
    .sidebar {
      background: var(--sidebar);
      border-right: 1px solid var(--line);
      display: grid;
      grid-template-rows: auto 1fr auto;
      min-height: 0;
      padding: 12px;
    }
    .side-top, .side-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .brand { align-items: center; display: flex; gap: 10px; font-weight: 700; }
    .new-chat { background: transparent; border-radius: 8px; color: var(--text); padding: 9px 10px; text-align: left; width: 100%; }
    .threads { display: grid; gap: 4px; margin-top: 16px; overflow: auto; }
    .thread {
      background: transparent;
      border-radius: 8px;
      color: var(--text);
      display: grid;
      gap: 3px;
      padding: 10px;
      text-align: left;
      width: 100%;
    }
    .thread strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .thread span { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .side-bottom { color: var(--muted); font-size: 13px; padding-top: 12px; }
    .chat {
      display: grid;
      grid-template-rows: auto 1fr auto;
      height: 100vh;
      min-width: 0;
    }
    .chat-top {
      align-items: center;
      border-bottom: 1px solid transparent;
      display: flex;
      justify-content: space-between;
      min-height: 56px;
      padding: 10px 18px;
    }
    .chat-title { align-items: center; display: flex; gap: 10px; min-width: 0; }
    .chat-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pill {
      align-items: center;
      background: transparent;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      display: inline-flex;
      font-size: 13px;
      gap: 6px;
      min-height: 34px;
      padding: 0 12px;
    }
    .messages {
      overflow-y: auto;
      padding: 24px 18px 120px;
    }
    .message {
      display: grid;
      grid-template-columns: 36px minmax(0, 760px);
      gap: 14px;
      justify-content: center;
      padding: 12px 0;
    }
    .avatar {
      align-items: center;
      border-radius: 50%;
      display: flex;
      font-size: 13px;
      font-weight: 700;
      height: 32px;
      justify-content: center;
      width: 32px;
    }
    .user .avatar { background: #0d0d0d; color: white; }
    .assistant .avatar { background: var(--accent); color: white; }
    .bubble { line-height: 1.62; min-width: 0; padding-top: 3px; }
    .bubble h2 { font-size: 16px; margin: 0 0 6px; }
    .bubble p { white-space: pre-wrap; }
    .assistant-block {
      background: var(--assistant);
      border: 1px solid var(--line);
      border-radius: 8px;
      margin-top: 10px;
      overflow: hidden;
    }
    .block-head {
      align-items: center;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      padding: 9px 12px;
    }
    .status {
      border-radius: 999px;
      color: var(--muted);
      font-size: 12px;
      padding: 4px 8px;
    }
    .approval_required { color: var(--warning); }
    .running { color: #0969da; }
    .done { color: #087443; }
    .failed { color: var(--danger); }
    pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      line-height: 1.5;
      margin: 0;
      overflow-x: auto;
      padding: 12px;
      white-space: pre-wrap;
    }
    .composer-wrap {
      background: linear-gradient(180deg, rgb(255 255 255 / 0), #fff 22%);
      bottom: 0;
      left: 280px;
      padding: 34px 18px 18px;
      position: fixed;
      right: 0;
    }
    .composer {
      background: var(--surface);
      border: 1px solid var(--line-strong);
      border-radius: 18px;
      box-shadow: 0 8px 28px rgb(0 0 0 / 8%);
      margin: 0 auto;
      max-width: 780px;
      overflow: hidden;
    }
    .composer textarea {
      border: 0;
      border-radius: 0;
      box-shadow: none;
      display: block;
      min-height: 58px;
      max-height: 220px;
      resize: none;
    }
    .composer-bar {
      align-items: center;
      display: flex;
      gap: 8px;
      justify-content: space-between;
      padding: 8px;
    }
    .composer-options { align-items: center; display: flex; gap: 6px; min-width: 0; }
    .composer select {
      border-radius: 999px;
      color: var(--muted);
      font-size: 13px;
      max-width: 170px;
      padding: 8px 10px;
    }
    .composer select.project { max-width: 210px; }
    .send {
      align-items: center;
      background: #0d0d0d;
      border-radius: 50%;
      color: white;
      display: inline-flex;
      height: 34px;
      justify-content: center;
      width: 34px;
    }
    .error { color: var(--danger); font-size: 13px; min-height: 18px; }
    .progress-copy { color: var(--muted); font-size: 13px; padding: 10px 12px 0; }
    .event-list { border-top: 1px solid var(--line); display: grid; gap: 6px; padding: 10px 12px; }
    .event { color: var(--muted); display: grid; font-size: 12px; gap: 2px; grid-template-columns: 82px minmax(0, 1fr); }
    .event strong { color: var(--text); font-weight: 600; }
    .empty { color: var(--muted); margin: 22vh auto 0; max-width: 520px; text-align: center; }
    .empty h1 { font-size: clamp(28px, 5vw, 38px); margin-bottom: 12px; }
    @media (max-width: 760px) {
      #app { grid-template-columns: 1fr; }
      .sidebar { display: none; }
      .composer-wrap { left: 0; }
      .message { grid-template-columns: 30px minmax(0, 1fr); justify-content: stretch; }
      .messages { padding-inline: 14px; }
      .composer-options { flex: 1; }
      .composer select, .composer select.project { max-width: none; min-width: 0; }
      .composer select.project { flex: 1.2; }
      .composer select#type { flex: 1; }
    }
  </style>
</head>
<body>
  <main id="login">
    <section class="login-card">
      <span class="mark">H</span>
      <div>
        <h1>Hermes에 로그인</h1>
        <p class="muted">사내 Mac Studio 운영 요청을 남기는 내부 챗봇입니다.</p>
      </div>
      <form id="loginForm" class="stack">
        <input id="password" type="password" placeholder="1234" autocomplete="current-password" />
        <button class="primary">계속</button>
        <p id="loginError" class="error"></p>
      </form>
    </section>
  </main>
  <section id="app" hidden>
    <aside class="sidebar">
      <div>
        <div class="side-top">
          <div class="brand"><span class="mark">H</span><span>Hermes</span></div>
          <button id="refresh" class="icon-btn" title="새로고침">↻</button>
        </div>
        <button id="newChat" class="new-chat">+ 새 요청</button>
        <nav id="threads" class="threads"></nav>
      </div>
      <div class="side-bottom">
        <span>Mac Studio</span>
        <button id="logout" class="icon-btn" title="로그아웃">⌁</button>
      </div>
    </aside>
    <section class="chat">
      <header class="chat-top">
        <div class="chat-title"><strong>Hermes 사내 챗봇</strong><span class="pill">운영 큐</span></div>
        <button id="refreshTop" class="pill">새로고침</button>
      </header>
      <div id="messages" class="messages"></div>
      <form id="requestForm" class="composer-wrap">
        <div class="composer">
          <textarea id="body" placeholder="Hermes에게 요청하기"></textarea>
          <div class="composer-bar">
            <div class="composer-options">
              <select id="project" class="project" aria-label="대상 프로젝트"></select>
              <select id="type" aria-label="요청 종류">
                <option value="auto">자동 판단</option>
                <option value="hermes_chat">Hermes 4.3 대화</option>
                <option value="mac_status">Mac 상태</option>
                <option value="deployment_status">배포 상태</option>
                <option value="project_inspect">프로젝트 점검</option>
                <option value="redeploy">재배포</option>
                <option value="development">Codex 개발 요청</option>
                <option value="file_cleanup">파일 정리</option>
                <option value="hermes_ops">Hermes 운영 요청</option>
              </select>
            </div>
            <button class="send" title="보내기">↑</button>
          </div>
        </div>
        <p id="formStatus" class="error"></p>
      </form>
    </section>
  </section>
  <script>
    const $ = (id) => document.getElementById(id);
    const labels = { auto: "자동 판단", hermes_chat: "Hermes 4.3 대화", hermes_ops: "Hermes 운영 요청", mac_status: "Mac 상태", deployment_status: "배포 상태", project_inspect: "프로젝트 점검", redeploy: "재배포", file_cleanup: "파일 정리", development: "Codex 개발 요청", custom: "Hermes 4.3 대화" };
    const statusLabels = { queued: "대기 중", approval_required: "승인 필요", running: "실행 중", done: "완료", failed: "실패", canceled: "취소됨" };
    let current = null;
    let composingNew = false;
    let pollTimer = null;
    async function api(path, init) {
      const res = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...init });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.detail || res.statusText);
      return data;
    }
    async function load() {
      try {
        const [{ requests }, { projects }] = await Promise.all([api("/api/requests"), api("/api/projects")]);
        $("login").hidden = true; $("app").hidden = false;
        document.body.classList.add("authed");
        const selectedProject = $("project").value;
        $("project").innerHTML = projects.map((project) => '<option value="' + esc(project.id) + '">' + esc(project.name) + '</option>').join("");
        if (projects.some((project) => project.id === selectedProject)) $("project").value = selectedProject;
        render(requests);
        clearTimeout(pollTimer);
        const busy = requests.some((request) => ["queued", "running"].includes(request.status));
        pollTimer = setTimeout(load, busy ? 2000 : 8000);
      } catch {
        $("login").hidden = false; $("app").hidden = true;
        document.body.classList.remove("authed");
        clearTimeout(pollTimer);
      }
    }
    function esc(v) { return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
    function titleFrom(text) { return String(text || "새 요청").trim().replace(/\\s+/g, " ").slice(0, 56) || "새 요청"; }
    function assistantText(r) {
      if (r.status === "approval_required") return "Hermes가 변경 작업으로 판단했습니다. 아래 승인 버튼을 누르면 Mac Studio 워커가 이어서 처리합니다.";
      if (r.status === "queued") return "요청을 큐에 넣었습니다. Mac Studio 워커가 곧 가져갑니다.";
      if (r.status === "running") return "Mac Studio에서 실행 중입니다.";
      if (r.status === "failed") return "처리 중 오류가 발생했습니다.";
      if (r.status === "canceled") return "요청이 실행 전에 취소되었습니다.";
      return "처리가 완료되었습니다.";
    }
    function render(requests) {
      const sorted = [...requests].sort((a, b) => b.created_at - a.created_at);
      if (!current && !composingNew && sorted[0]) current = sorted[0].id;
      $("threads").innerHTML = sorted.map((r) => '<button class="thread" data-thread="' + r.id + '"><strong>' + esc(r.title) + '</strong><span>' + esc(statusLabels[r.status] || r.status) + ' · ' + esc(labels[r.resolved_type || r.type] || r.resolved_type || r.type) + '</span></button>').join("");
      const active = current ? sorted.find((r) => r.id === current) : null;
      if (!active) {
        $("messages").innerHTML = '<div class="empty"><h1>무엇을 도와드릴까요?</h1><p>Mac 상태 확인, 파일 정리 후보 점검, Codex 개발 요청을 채팅처럼 남길 수 있습니다.</p></div>';
        return;
      }
      const events = (active.events || []).slice(-6).reverse().map((event) => '<div class="event"><span>' + esc(new Date(event.at).toLocaleTimeString()) + '</span><strong>' + esc(event.message) + '</strong></div>').join("");
      $("messages").innerHTML = '<article class="message user"><div class="avatar">나</div><div class="bubble"><h2>' + esc(active.title) + '</h2><p>' + esc(active.body) + '</p></div></article>' +
        '<article class="message assistant"><div class="avatar">H</div><div class="bubble"><h2>Hermes</h2><p>' + esc(assistantText(active)) + '</p><div class="assistant-block"><div class="block-head"><span>' + esc(labels[active.resolved_type || active.type] || active.resolved_type || active.type) + '</span><span class="status ' + active.status + '">' + esc(statusLabels[active.status] || active.status) + '</span></div>' +
        (active.plan ? '<p class="progress-copy"><strong>판단:</strong> ' + esc(active.plan) + '</p>' : '') +
        (active.progress ? '<p class="progress-copy">' + esc(active.progress) + '</p>' : '') +
        (active.result ? '<pre>' + esc(active.result) + '</pre>' : '<pre>' + esc(new Date(active.updated_at).toLocaleString()) + '</pre>') +
        (events ? '<div class="event-list">' + events + '</div>' : '') +
        (active.status === 'approval_required' ? '<div class="block-head"><button class="primary" data-approve="' + active.id + '">실행 승인</button><button class="pill" data-cancel="' + active.id + '">취소</button></div>' : '') +
        (active.status === 'queued' ? '<div class="block-head"><button class="pill" data-cancel="' + active.id + '">취소</button></div>' : '') +
        (['failed', 'canceled'].includes(active.status) ? '<div class="block-head"><button class="primary" data-retry="' + active.id + '">다시 실행</button></div>' : '') +
        '</div></div></article>';
      $("messages").scrollTop = $("messages").scrollHeight;
    }
    $("loginForm").onsubmit = async (event) => { event.preventDefault(); try { const password = $("password").value; if (!password) { $("loginError").textContent = "비밀번호를 입력해주세요."; return; } await api("/api/login", { method: "POST", body: JSON.stringify({ password }) }); await load(); } catch (e) { $("loginError").textContent = "비밀번호가 맞지 않습니다."; } };
    $("requestForm").onsubmit = async (event) => { event.preventDefault(); $("formStatus").textContent = ""; const body = $("body").value.trim(); if (!body) return; try { const created = await api("/api/requests", { method: "POST", body: JSON.stringify({ type: $("type").value, title: titleFrom(body), body, target_project: $("project").value || "hermes-mac-ops" }) }); current = created.request.id; composingNew = false; $("body").value = ""; await load(); } catch (error) { $("formStatus").textContent = error.message || "요청을 보내지 못했습니다."; } };
    $("threads").onclick = async (event) => { const id = event.target?.closest?.("[data-thread]")?.dataset?.thread; if (id) { current = id; composingNew = false; await load(); } };
    $("messages").onclick = async (event) => { const approveId = event.target?.dataset?.approve; const cancelId = event.target?.dataset?.cancel; const retryId = event.target?.dataset?.retry; if (approveId) await api("/api/requests/" + approveId + "/approve", { method: "POST", body: "{}" }); if (cancelId) await api("/api/requests/" + cancelId + "/cancel", { method: "POST", body: "{}" }); if (retryId) await api("/api/requests/" + retryId + "/retry", { method: "POST", body: "{}" }); if (approveId || cancelId || retryId) await load(); };
    $("newChat").onclick = () => { current = null; composingNew = true; $("body").focus(); void load(); };
    $("refresh").onclick = load;
    $("refreshTop").onclick = load;
    $("logout").onclick = async () => { await api("/api/logout", { method: "POST", body: "{}" }); await load(); };
    $("body").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("requestForm").requestSubmit(); } });
    load();
  </script>
</body>
</html>`;

function sign(value) {
  return createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function cookie(req, name) {
  const raw = req.headers.cookie || "";
  return raw.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.split("=")[1] || "";
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cleanPassword(value) {
  return String(value || "")
    .trim()
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
}

function isAdmin(req) {
  const raw = cookie(req, sessionCookie);
  const [value, mac] = raw.split(".");
  const issuedAt = Number(value);
  return Boolean(
    value &&
      mac &&
      Number.isFinite(issuedAt) &&
      Date.now() - issuedAt >= 0 &&
      Date.now() - issuedAt <= sessionMaxAgeMs &&
      safeEqual(mac, sign(value)),
  );
}

function isWorker(req) {
  const auth = req.headers.authorization || "";
  return Boolean(workerToken && (req.headers["x-worker-token"] === workerToken || auth === `Bearer ${workerToken}`));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBodyBytes) throw new Error("request_body_too_large");
  }
  return raw ? JSON.parse(raw) : {};
}

async function readProjects() {
  const parsed = JSON.parse(await readFile(projectsFile, "utf8"));
  return Array.isArray(parsed.projects) ? parsed.projects : [];
}

async function readStore() {
  try {
    return JSON.parse(await readFile(dataFile, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { requests: [] };
  }
}

async function writeStore(store) {
  await mkdir(dirname(dataFile), { recursive: true });
  const temp = `${dataFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(store, null, 2), "utf8");
  await rename(temp, dataFile);
}

async function mutateStore(mutator) {
  const operation = storeMutation.then(async () => {
    const store = await readStore();
    const result = await mutator(store);
    await writeStore(store);
    return result;
  });
  storeMutation = operation.catch(() => {});
  return operation;
}

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...headers,
  });
  res.end(text);
}

function classify(type) {
  if (type === "auto") return { risk: "pending", status: "queued" };
  const risky = mutationTypes.has(type);
  return { risk: risky ? "approval_required" : "safe", status: risky ? "approval_required" : "queued" };
}

const system1ShadowKind = "hermes.system1.shadow";
let system1Module = null;
let system1ModuleFailed = false;

async function loadSystem1() {
  if (system1Module || system1ModuleFailed) return system1Module;
  try {
    system1Module = await import("./scripts/hermes-system1.mjs");
  } catch {
    system1ModuleFailed = true;
  }
  return system1Module;
}

// Observational only: the returned record is persisted on the request but never
// consulted by classification, approval, dispatch, or execution paths.
async function computeSystem1Shadow(request, project) {
  const marker = (status) => ({
    kind: system1ShadowKind,
    schemaVersion: 1,
    observed_at: request.created_at,
    status,
  });
  try {
    const system1 = await loadSystem1();
    if (!system1) return marker("error");
    const routeRequest = {
      kind: system1.ROUTE_REQUEST_KIND,
      schemaVersion: 1,
      requestId: request.id,
      request: {
        locale: "ko",
        text: request.body,
        untrustedContent: false,
      },
      context: {
        source: "console",
        hasRepoContext: typeof project?.repo === "string" && project.repo.length > 0,
        privateData: false,
        attachments: [],
      },
    };
    const decision = await system1.routeWithPolicy(routeRequest, system1.createDeterministicBaselineAdapter());
    const { features } = system1.buildProviderView(routeRequest);
    return {
      ...marker("ok"),
      route: decision.final.route,
      determinedBy: decision.final.determinedBy,
      policyVerdict: decision.policy.verdict,
      confidence: decision.final.confidence,
      abstained: decision.final.route === "REQUIRE_OWNER",
      features: {
        taskSignals: features.taskSignals,
        riskFlags: features.riskFlags,
        capabilities: features.capabilities,
        ambiguity: features.ambiguity,
        evidence: features.evidence,
      },
    };
  } catch {
    return marker("error");
  }
}

function projectSupports(project, type) {
  if (!["deployment_status", "project_inspect", "redeploy", "development"].includes(type)) return true;
  return Array.isArray(project.capabilities) && project.capabilities.includes(type);
}

function clientAddress(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function loginBlocked(address) {
  const now = Date.now();
  const record = loginAttempts.get(address);
  if (!record || now - record.startedAt > 15 * 60 * 1000) {
    loginAttempts.delete(address);
    return false;
  }
  return record.count >= 10;
}

function recordLoginFailure(address) {
  const now = Date.now();
  const record = loginAttempts.get(address);
  if (!record || now - record.startedAt > 15 * 60 * 1000) {
    loginAttempts.set(address, { count: 1, startedAt: now });
    return;
  }
  record.count += 1;
}

function addEvent(item, message) {
  item.events = [...(item.events || []), { at: Date.now(), message: String(message).slice(0, 240) }].slice(-30);
}

if (!adminPassword || !sessionSecret || !workerToken) {
  throw new Error("ADMIN_PASSWORD, SESSION_SECRET, WORKER_TOKEN are required.");
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/health") return send(res, 200, { status: "ok" });
    if (url.pathname === "/") return send(res, 200, html);
    if (url.pathname === "/api/login" && req.method === "POST") {
      const address = clientAddress(req);
      if (loginBlocked(address)) return send(res, 429, { error: "too_many_attempts" });
      const body = await readBody(req);
      if (!safeEqual(cleanPassword(body.password), adminPassword)) {
        recordLoginFailure(address);
        return send(res, 401, { error: "invalid_password" });
      }
      loginAttempts.delete(address);
      const value = String(Date.now());
      return send(res, 200, { ok: true }, { "Set-Cookie": `${sessionCookie}=${value}.${sign(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800` });
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
      return send(res, 200, { ok: true }, { "Set-Cookie": `${sessionCookie}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` });
    }
    if (url.pathname === "/api/requests" && req.method === "GET") {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      const store = await readStore();
      return send(res, 200, { requests: store.requests.sort((a, b) => b.created_at - a.created_at).slice(0, 80) });
    }
    if (url.pathname === "/api/projects" && req.method === "GET") {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      const projects = (await readProjects()).map(({ id, name, domain, capabilities = [] }) => ({
        id,
        name,
        domain,
        capabilities,
      }));
      return send(res, 200, { projects });
    }
    if (url.pathname === "/api/requests" && req.method === "POST") {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      const body = await readBody(req);
      const type = requestTypes.has(body.type) ? body.type : "auto";
      const title = String(body.title || "Untitled request").slice(0, 140);
      const text = String(body.body || "").slice(0, 8000);
      const targetProject = String(body.target_project || defaultProject).slice(0, 80);
      if (!title || !text) return send(res, 400, { error: "missing_title_or_body" });
      const projects = await readProjects();
      const project = projects.find((candidate) => candidate.id === targetProject);
      if (!project) return send(res, 400, { error: "unknown_project" });
      if (type !== "auto" && !projectSupports(project, type)) {
        return send(res, 400, { error: "project_capability_not_enabled" });
      }
      const now = Date.now();
      const request = {
        id: randomUUID(),
        type,
        resolved_type: null,
        target_project: targetProject,
        title,
        body: text,
        ...classify(type),
        result: null,
        plan: null,
        worker_log: null,
        progress: "요청을 접수했습니다.",
        progress_step: "created",
        events: [{ at: now, message: "요청 접수" }],
        attempts: 0,
        created_at: now,
        updated_at: now,
        claimed_at: null,
        lease_expires_at: null,
        completed_at: null,
        approved_at: null,
      };
      if (system1ShadowEnabled) {
        request.system1_shadow = await computeSystem1Shadow(request, project);
      }
      await mutateStore((store) => store.requests.push(request));
      return send(res, 201, { request });
    }
    const approveMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/approve$/);
    if (approveMatch && req.method === "POST") {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      await mutateStore((store) => {
        const item = store.requests.find((request) => request.id === approveMatch[1] && request.status === "approval_required");
        if (item) {
          item.status = "queued";
          item.approved_at = Date.now();
          item.progress = "승인되었습니다. Mac Studio 워커를 기다리는 중입니다.";
          item.progress_step = "approved";
          item.updated_at = Date.now();
          addEvent(item, "실행 승인");
        }
      });
      return send(res, 200, { ok: true });
    }
    const cancelMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === "POST") {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      const canceled = await mutateStore((store) => {
        const item = store.requests.find(
          (request) => request.id === cancelMatch[1] && ["queued", "approval_required"].includes(request.status),
        );
        if (!item) return false;
        item.status = "canceled";
        item.progress = "실행 전에 요청을 취소했습니다.";
        item.progress_step = "canceled";
        item.completed_at = Date.now();
        item.updated_at = Date.now();
        addEvent(item, "요청 취소");
        return true;
      });
      return send(res, canceled ? 200 : 409, { ok: canceled });
    }
    const retryMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/retry$/);
    if (retryMatch && req.method === "POST") {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      const retried = await mutateStore((store) => {
        const item = store.requests.find(
          (request) => request.id === retryMatch[1] && ["failed", "canceled"].includes(request.status),
        );
        if (!item) return false;
        const risky = mutationTypes.has(item.resolved_type || item.type);
        item.status = risky ? "approval_required" : "queued";
        item.risk = risky ? "approval_required" : item.type === "auto" ? "pending" : "safe";
        if (risky) item.approved_at = null;
        if (item.type === "auto" && !item.resolved_type) item.plan = null;
        item.result = null;
        item.worker_log = null;
        item.progress = risky
          ? "재시도 전 실행 승인을 기다립니다."
          : "요청을 다시 대기열에 넣었습니다.";
        item.progress_step = risky ? "approval_required" : "retried";
        item.claim_token = null;
        item.claimed_at = null;
        item.lease_expires_at = null;
        item.completed_at = null;
        item.updated_at = Date.now();
        addEvent(item, risky ? "재시도 승인 대기" : "요청 재시도");
        return true;
      });
      return send(res, retried ? 200 : 409, { ok: retried });
    }
    if (url.pathname === "/api/worker/next" && req.method === "GET") {
      if (!isWorker(req)) return send(res, 401, { error: "unauthorized" });
      const item = await mutateStore((store) => {
        const now = Date.now();
        for (const request of store.requests) {
          const stale =
            request.status === "running" &&
            request.claimed_at &&
            now > (request.lease_expires_at || request.claimed_at + staleRunningMs);
          if (!stale) continue;
          const effectiveType = request.resolved_type || request.type;
          if (mutationTypes.has(effectiveType)) {
            request.status = "failed";
            request.result = "워커 연결이 장시간 끊겨 중복 변경을 막기 위해 중단 처리했습니다. 저장소와 배포 상태를 점검한 뒤 다시 요청하세요.";
            request.completed_at = now;
            addEvent(request, "워커 임대 만료로 중단");
          } else {
            request.status = "queued";
            request.progress = "워커 재시작을 감지해 안전 요청을 다시 대기열에 넣었습니다.";
            addEvent(request, "안전 요청 재대기");
          }
          request.claim_token = null;
          request.updated_at = now;
        }
        const next = store.requests.filter((request) => request.status === "queued").sort((a, b) => a.created_at - b.created_at)[0];
        if (!next) return null;
        next.status = "running";
        next.claimed_at = now;
        next.lease_expires_at = now + workerLeaseMs;
        next.claim_token = randomUUID();
        next.attempts = Number(next.attempts || 0) + 1;
        next.progress = "Mac Studio 워커가 요청을 가져갔습니다.";
        next.progress_step = "claimed";
        next.updated_at = now;
        addEvent(next, `워커 실행 시작 (${next.attempts}회차)`);
        return structuredClone(next);
      });
      return send(res, 200, { request: item });
    }
    if (url.pathname === "/api/worker/plan" && req.method === "POST") {
      if (!isWorker(req)) return send(res, 401, { error: "unauthorized" });
      const body = await readBody(req);
      const resolvedType = String(body.resolvedType || "");
      if (!resolvedRequestTypes.has(resolvedType)) return send(res, 400, { error: "invalid_resolved_type" });
      const projects = await readProjects();
      const updated = await mutateStore((store) => {
        const item = store.requests.find(
          (request) =>
            request.id === body.id &&
            request.type === "auto" &&
            request.status === "running" &&
            request.claim_token === body.claimToken,
        );
        if (!item) return null;
        const project = projects.find((candidate) => candidate.id === item.target_project);
        if (!project || !projectSupports(project, resolvedType)) return { unsupported: true };
        const now = Date.now();
        const risky = mutationTypes.has(resolvedType);
        item.resolved_type = resolvedType;
        item.plan = String(body.reason || resolvedType).slice(0, 500);
        item.risk = risky ? "approval_required" : "safe";
        item.updated_at = now;
        addEvent(item, `Hermes 판단: ${item.plan}`);
        if (risky && !item.approved_at) {
          item.status = "approval_required";
          item.progress = "변경 작업으로 판단되어 실행 승인을 기다립니다.";
          item.progress_step = "approval_required";
          item.claim_token = null;
          item.claimed_at = null;
          item.lease_expires_at = null;
          addEvent(item, "변경 작업 승인 대기");
          return { deferred: true };
        }
        item.progress = "Hermes 판단이 끝나 허용된 작업을 실행합니다.";
        item.progress_step = "planned";
        return { deferred: false };
      });
      if (!updated) return send(res, 409, { error: "claim_lost" });
      if (updated.unsupported) return send(res, 400, { error: "project_capability_not_enabled" });
      return send(res, 200, { ok: true, deferred: updated.deferred });
    }
    if (url.pathname === "/api/worker/heartbeat" && req.method === "POST") {
      if (!isWorker(req)) return send(res, 401, { error: "unauthorized" });
      const body = await readBody(req);
      const updated = await mutateStore((store) => {
        const item = store.requests.find(
          (request) => request.id === body.id && request.status === "running" && request.claim_token === body.claimToken,
        );
        if (!item) return false;
        const now = Date.now();
        const message = String(body.progress || "실행 중입니다.").slice(0, 500);
        if (message && message !== item.progress) addEvent(item, message);
        item.progress = message;
        item.progress_step = String(body.step || item.progress_step || "running").slice(0, 80);
        item.worker_log = String(body.workerLog || item.worker_log || "").slice(0, 12000);
        const requestedLeaseMs = Number(body.leaseExtensionMs || 0);
        const isMutation = mutationTypes.has(item.resolved_type || item.type);
        const leaseMs =
          isMutation && Number.isFinite(requestedLeaseMs) && requestedLeaseMs > workerLeaseMs
            ? Math.min(requestedLeaseMs, maxDeploymentLeaseMs)
            : workerLeaseMs;
        item.lease_expires_at = now + leaseMs;
        item.updated_at = now;
        return true;
      });
      return send(res, updated ? 200 : 409, { ok: updated });
    }
    if (url.pathname === "/api/worker/result" && req.method === "POST") {
      if (!isWorker(req)) return send(res, 401, { error: "unauthorized" });
      const body = await readBody(req);
      const updated = await mutateStore((store) => {
        const item = store.requests.find(
          (request) =>
            request.id === body.id &&
            request.status === "running" &&
            Boolean(request.claim_token) &&
            request.claim_token === body.claimToken,
        );
        if (!item) return false;
        item.status = body.status === "failed" ? "failed" : "done";
        item.result = String(body.result || "").slice(0, 30000);
        item.worker_log = String(body.workerLog || "").slice(0, 12000);
        item.progress = item.status === "done" ? "모든 작업이 완료되었습니다." : "작업이 중단되었습니다.";
        item.progress_step = item.status;
        item.claim_token = null;
        item.lease_expires_at = null;
        item.completed_at = Date.now();
        item.updated_at = Date.now();
        addEvent(item, item.status === "done" ? "작업 완료" : "작업 실패");
        return true;
      });
      return send(res, updated ? 200 : 409, { ok: updated });
    }
    send(res, 404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(res, message === "request_body_too_large" ? 413 : 500, { error: message });
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`Hermes Mac Ops listening on ${port}`);
});
