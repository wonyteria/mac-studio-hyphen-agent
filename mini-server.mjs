import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { parseHandoffPrefill, serializePrefillForHtml } from "./scripts/hermes-prefill.mjs";

const port = Number(process.env.PORT || 3000);
const adminPassword = process.env.ADMIN_PASSWORD || "";
const sessionSecret = process.env.SESSION_SECRET || "";
const workerToken = process.env.WORKER_TOKEN || "";
const dataFile = process.env.HERMES_DATA_FILE || "/app/var/data/requests.json";
const projectsFile = process.env.HERMES_PROJECTS_FILE || "/app/hermes-projects.json";
// Server-configured only: the Studio business registry is mounted read-only
// into the runtime, never embedded in the image and never accepted from a
// client-supplied path.
const businessRegistryFile = process.env.HERMES_BUSINESS_REGISTRY || "/app/var/business/registry.private.json";
const businessRegistryExpectedHash = process.env.HERMES_BUSINESS_REGISTRY_EXPECTED_HASH || "";
// Sync-status contract: hermes-registry-sync.mjs writes an allowlisted status
// document next to the destination it manages. The server reads both files
// fail-closed and serves only bounded freshness state — never paths, hashes,
// or registry content.
const businessRegistryStatusFile =
  process.env.HERMES_BUSINESS_REGISTRY_STATUS ||
  join(dirname(businessRegistryFile), "registry-sync-status.json");
const configuredStaleMs = Number(process.env.HERMES_BUSINESS_REGISTRY_STALE_MS);
const businessRegistryStaleMs =
  Number.isFinite(configuredStaleMs) && configuredStaleMs > 0 ? configuredStaleMs : 10 * 60 * 1000;
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
  "studio_priorities",
  "studio_blockers",
  "studio_overview",
  "studio_evidence_audit",
]);
const studioBriefingTypes = new Set(["studio_priorities", "studio_blockers", "studio_overview"]);
const studioAuditTypes = new Set(["studio_evidence_audit"]);
const studioViewByType = {
  studio_priorities: "priorities",
  studio_blockers: "blockers",
  studio_overview: "overview",
};
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
  <title>Hyphen Studio Agent</title>
  <style>
    :root {
      color-scheme: light;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", sans-serif;
      --bg: #faf8f4;
      --sidebar: #f5f1ea;
      --surface: #ffffff;
      --line: #e7e1d7;
      --line-strong: #d8d0c2;
      --text: #1c1914;
      --muted: #6e665a;
      --soft: #efeae1;
      --assistant: #f7f4ee;
      --accent: #1c7a54;
      --accent-soft: #e3efe8;
      --danger: #b42318;
      --danger-soft: #fbeeec;
      --warning: #b54708;
      --warning-soft: #f9f0e0;
      --focus: #1c7a54;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    html, body { height: 100%; }
    body { background: var(--bg); color: var(--text); margin: 0; }
    button, input, textarea, select { font: inherit; }
    button { border: 0; cursor: pointer; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible {
      outline: 2px solid var(--focus);
      outline-offset: 2px;
    }
    .fold > summary:focus-visible { outline-offset: -2px; }
    .sr-only {
      clip-path: inset(50%);
      height: 1px;
      margin: -1px;
      overflow: hidden;
      padding: 0;
      position: absolute;
      width: 1px;
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; scroll-behavior: auto !important; transition: none !important; }
    }
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
      background: #1c1914;
      border-radius: 50%;
      color: white;
      display: inline-flex;
      font-weight: 700;
      height: 38px;
      justify-content: center;
      width: 38px;
    }
    h1 { font-size: 28px; letter-spacing: -0.01em; line-height: 1.15; margin: 0; }
    p { margin: 0; }
    .muted { color: var(--muted); line-height: 1.55; }
    .login-form { display: grid; gap: 12px; }
    input, textarea, select {
      background: var(--surface);
      border: 1px solid var(--line-strong);
      border-radius: 10px;
      color: var(--text);
      outline: 0;
      padding: 12px 13px;
      width: 100%;
    }
    input:focus, textarea:focus, select:focus { border-color: var(--accent); }
    .primary {
      align-items: center;
      background: #1c1914;
      border-radius: 10px;
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
      border-radius: 10px;
      color: var(--text);
      display: inline-flex;
      flex: none;
      font-size: 16px;
      height: 40px;
      justify-content: center;
      width: 40px;
    }
    .icon-btn:hover, .thread:hover, .pill:hover, .new-chat:hover, .drawer-action:hover { background: var(--soft); }
    #app {
      display: grid;
      grid-template-columns: 272px minmax(0, 1fr);
      height: 100vh;
      height: 100dvh;
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
    .brand { align-items: center; display: flex; gap: 10px; font-weight: 700; min-width: 0; }
    .brand > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .new-chat {
      background: transparent;
      border-radius: 10px;
      color: var(--text);
      font-size: 14px;
      margin-top: 6px;
      min-height: 44px;
      padding: 0 10px;
      text-align: left;
      width: 100%;
    }
    .threads { align-content: start; display: grid; gap: 4px; margin-top: 14px; overflow: auto; }
    .threads-empty { color: var(--muted); font-size: 13px; padding: 6px 10px; }
    .thread {
      background: transparent;
      border-radius: 10px;
      color: var(--text);
      display: grid;
      gap: 3px;
      min-height: 44px;
      min-width: 0;
      padding: 8px 10px;
      text-align: left;
      width: 100%;
    }
    .thread[aria-current="true"] { background: var(--surface); box-shadow: inset 0 0 0 1px var(--line-strong); }
    .thread strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .thread span { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .side-bottom { color: var(--muted); font-size: 13px; padding-top: 12px; }
    .chat {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      height: 100vh;
      height: 100dvh;
      min-width: 0;
    }
    .chat-top {
      align-items: center;
      border-bottom: 1px solid var(--line);
      display: flex;
      flex-wrap: wrap;
      gap: 6px 12px;
      padding: 8px 14px;
    }
    .chat-title { align-items: center; display: flex; flex: 1 1 auto; gap: 8px; min-width: 0; }
    .chat-title strong { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status-row { align-items: center; display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
    .menu-btn { display: none; }
    .pill {
      align-items: center;
      background: transparent;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      display: inline-flex;
      font-size: 13px;
      gap: 6px;
      min-height: 32px;
      padding: 0 12px;
    }
    button.pill { min-height: 40px; }
    .pill.ok { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
    .messages {
      min-width: 0;
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
      flex: none;
      font-size: 13px;
      font-weight: 700;
      height: 32px;
      justify-content: center;
      width: 32px;
    }
    .user .avatar { background: #1c1914; color: white; }
    .assistant .avatar { background: var(--accent); color: white; }
    .bubble { line-height: 1.62; min-width: 0; padding-top: 3px; }
    .bubble h2 { font-size: 15px; margin: 0 0 6px; }
    .bubble p { overflow-wrap: anywhere; white-space: pre-wrap; }
    .assistant-block {
      background: var(--assistant);
      border: 1px solid var(--line);
      border-radius: 12px;
      margin-top: 10px;
      min-width: 0;
      overflow: hidden;
    }
    .block-head {
      align-items: center;
      border-bottom: 1px solid var(--line);
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: space-between;
      padding: 9px 12px;
    }
    .block-head > span { min-width: 0; overflow-wrap: anywhere; }
    .status {
      border-radius: 999px;
      color: var(--muted);
      flex: none;
      font-size: 12px;
      padding: 4px 8px;
    }
    .approval_required { color: var(--warning); }
    .running { color: #0969da; }
    .done { color: var(--accent); }
    .failed { color: var(--danger); }
    .result-text {
      font-size: 14px;
      line-height: 1.7;
      min-width: 0;
      overflow-wrap: anywhere;
      padding: 14px;
      white-space: pre-wrap;
    }
    .result-meta { color: var(--muted); font-size: 13px; padding: 12px 14px; }
    .audit-view { display: grid; gap: 14px; min-width: 0; padding: 14px; }
    .audit-metrics { display: grid; gap: 10px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .metric {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 12px;
      display: grid;
      gap: 2px;
      min-width: 0;
      padding: 12px;
    }
    .metric strong { font-size: 24px; font-weight: 700; line-height: 1.1; }
    .metric span { color: var(--muted); font-size: 12px; }
    .audit-prio { align-items: center; color: var(--muted); display: flex; flex-wrap: wrap; font-size: 13px; gap: 6px; }
    .chip {
      background: var(--soft);
      border-radius: 999px;
      color: var(--muted);
      font-size: 12px;
      padding: 4px 10px;
      white-space: nowrap;
    }
    .chip.prio-high { background: var(--danger-soft); color: var(--danger); }
    .chip.prio-medium { background: var(--warning-soft); color: var(--warning); }
    .chip.prio-low { background: var(--soft); color: var(--muted); }
    .audit-lead { font-size: 14px; font-weight: 600; }
    .audit-items { display: grid; gap: 8px; min-width: 0; }
    .audit-item { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; min-width: 0; overflow: hidden; }
    .audit-item > summary {
      align-items: center;
      cursor: pointer;
      display: flex;
      gap: 8px;
      justify-content: space-between;
      list-style: none;
      min-height: 44px;
      padding: 10px 12px;
    }
    .audit-item > summary::-webkit-details-marker { display: none; }
    .audit-item > summary::after { color: var(--muted); content: "▸"; flex: none; font-size: 11px; }
    .audit-item[open] > summary::after { content: "▾"; }
    .audit-name { font-size: 14px; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
    .audit-badge { border-radius: 999px; flex: none; font-size: 11px; padding: 3px 9px; white-space: nowrap; }
    .audit-badge.high { background: var(--danger-soft); color: var(--danger); }
    .audit-badge.medium { background: var(--warning-soft); color: var(--warning); }
    .audit-badge.low { background: var(--soft); color: var(--muted); }
    .audit-body { border-top: 1px solid var(--line); display: grid; gap: 10px; padding: 10px 12px 12px; }
    .audit-chips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
    .audit-chips .chip { background: var(--soft); color: var(--text); }
    .audit-actions { display: grid; gap: 4px; margin: 0; padding-left: 18px; }
    .audit-actions li { font-size: 13px; line-height: 1.5; }
    .audit-more { color: var(--muted); font-size: 13px; }
    .composer-wrap {
      background: linear-gradient(180deg, rgb(250 248 244 / 0), var(--bg) 30%);
      bottom: 0;
      left: 272px;
      padding: 30px 16px 14px;
      position: fixed;
      right: 0;
    }
    .composer {
      background: var(--surface);
      border: 1px solid var(--line-strong);
      border-radius: 16px;
      box-shadow: 0 10px 30px rgb(28 25 20 / 8%);
      margin: 0 auto;
      max-width: 780px;
      overflow: hidden;
    }
    .composer textarea {
      border: 0;
      border-radius: 0;
      display: block;
      max-height: 200px;
      min-height: 56px;
      resize: none;
    }
    .composer-controls { align-items: flex-end; display: flex; gap: 10px; padding: 10px 10px 4px; }
    .composer-fields { display: flex; flex: 1; flex-wrap: wrap; gap: 8px; min-width: 0; }
    .field { display: grid; flex: 1 1 160px; gap: 3px; min-width: 0; }
    .field > span { color: var(--muted); font-size: 11px; font-weight: 650; padding-left: 2px; }
    .composer select {
      border-radius: 10px;
      color: var(--text);
      font-size: 14px;
      min-width: 0;
      padding: 10px 12px;
      width: 100%;
    }
    .send {
      align-items: center;
      background: #1c1914;
      border-radius: 50%;
      color: white;
      display: inline-flex;
      flex: none;
      font-size: 17px;
      height: 44px;
      justify-content: center;
      width: 44px;
    }
    .scope-line { color: var(--muted); font-size: 12px; min-height: 16px; padding: 0 12px 10px; }
    .error { color: var(--danger); font-size: 13px; margin: 6px auto 0; max-width: 780px; min-height: 18px; padding: 0 4px; }
    .error[data-guide="1"] { color: var(--muted); }
    .progress-copy { color: var(--muted); font-size: 13px; padding: 10px 12px 0; }
    .fold { border-top: 1px solid var(--line); }
    .fold > summary {
      align-items: center;
      cursor: pointer;
      display: flex;
      gap: 8px;
      justify-content: space-between;
      list-style: none;
      min-height: 40px;
      padding: 8px 12px;
    }
    .fold > summary::-webkit-details-marker { display: none; }
    .fold > summary::after { color: var(--muted); content: "▸"; flex: none; font-size: 11px; }
    .fold[open] > summary::after { content: "▾"; }
    .events-fold > summary { color: var(--muted); font-size: 12px; }
    .event-list { display: grid; gap: 6px; padding: 0 12px 12px; }
    .event { color: var(--muted); display: grid; font-size: 12px; gap: 2px; grid-template-columns: 82px minmax(0, 1fr); }
    .event strong { color: var(--text); font-weight: 600; overflow-wrap: anywhere; }
    .home { margin: 0 auto; max-width: 720px; min-width: 0; padding: 7vh 18px 40px; }
    .home-eyebrow { color: var(--muted); font-size: 12px; font-weight: 650; letter-spacing: 0.05em; margin-bottom: 14px; }
    .home h1 { font-size: clamp(25px, 6vw, 33px); line-height: 1.2; margin-bottom: 10px; }
    .home-state { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
    .state-chip {
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      font-size: 12px;
      padding: 5px 12px;
      white-space: nowrap;
    }
    .state-chip.ok { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
    .state-chip.warn { background: var(--warning-soft); border-color: transparent; color: var(--warning); }
    .state-chip.down { background: var(--danger-soft); border-color: transparent; color: var(--danger); }
    .action-groups { display: grid; gap: 20px; margin-top: 30px; }
    .action-group h3 { font-size: 13px; font-weight: 650; margin: 0; }
    .group-note { color: var(--muted); font-size: 12px; margin: 2px 0 8px; }
    .preset-grid { display: flex; flex-wrap: wrap; gap: 8px; }
    .preset {
      background: var(--surface);
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      color: var(--text);
      font-size: 13px;
      min-height: 44px;
      padding: 0 16px;
    }
    .preset:hover { background: var(--soft); }
    .preset-scope { color: var(--muted); font-size: 12px; line-height: 1.6; margin-top: 22px; }
    .pill.offline { background: var(--danger-soft); border-color: transparent; color: var(--danger); }
    .pill.biz-stale { background: var(--warning-soft); border-color: transparent; color: var(--warning); }
    .pill.biz-down { background: var(--danger-soft); border-color: transparent; color: var(--danger); }
    .s1-body { display: grid; gap: 6px; padding: 0 12px 10px; }
    .s1-head { color: var(--muted); font-size: 12px; }
    .s1-title { font-weight: 650; }
    .s1-badge { border: 1px solid var(--line); border-radius: 999px; font-size: 11px; padding: 2px 8px; white-space: nowrap; }
    .s1-row { color: var(--muted); display: flex; font-size: 12px; gap: 12px; justify-content: space-between; }
    .s1-row strong { color: var(--text); font-weight: 600; }
    .drawer-scrim { background: rgb(28 25 20 / 42%); inset: 0; position: fixed; z-index: 40; }
    .drawer {
      background: var(--sidebar);
      bottom: 0;
      box-shadow: 8px 0 30px rgb(0 0 0 / 14%);
      display: grid;
      grid-template-rows: auto auto auto minmax(0, 1fr) auto;
      left: 0;
      max-width: 86vw;
      padding: 14px;
      position: fixed;
      top: 0;
      width: 300px;
      z-index: 50;
    }
    .drawer-head { align-items: center; display: flex; gap: 8px; justify-content: space-between; min-width: 0; }
    .drawer-action {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 10px;
      color: var(--text);
      font-size: 14px;
      font-weight: 600;
      margin-top: 10px;
      min-height: 44px;
      padding: 0 14px;
      text-align: left;
      width: 100%;
    }
    .drawer-threads { margin-top: 12px; min-height: 0; }
    .drawer-bottom { align-items: center; display: flex; gap: 8px; justify-content: space-between; padding-top: 12px; }
    @media (max-width: 760px) {
      #app { grid-template-columns: minmax(0, 1fr); }
      .sidebar { display: none; }
      .menu-btn { display: inline-flex; }
      .chat-top { padding: 8px 12px; }
      .composer-wrap { left: 0; padding: 24px 12px 12px; }
      .message { grid-template-columns: 28px minmax(0, 1fr); justify-content: stretch; }
      .messages { padding: 18px 14px 110px; }
      .field { flex-basis: 45%; }
      .audit-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 420px) {
      .field { flex-basis: 100%; }
      .chat-title strong { font-size: 14px; }
    }
  </style>
</head>
<body>
  <main id="login">
    <section class="login-card">
      <span class="mark">H</span>
      <div>
        <h1>Hyphen Studio Agent</h1>
        <p class="muted">Hyphen Studio 프로젝트를 Mac Studio에서 실행하고 확인하는 내부 에이전트입니다.</p>
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
          <div class="brand"><span class="mark">H</span><span>Hyphen Studio Agent</span></div>
          <button id="refresh" class="icon-btn" type="button" title="새로고침" aria-label="새로고침">↻</button>
        </div>
        <button id="homeBtn" class="new-chat" type="button">홈 · 빠른 작업</button>
        <button id="newChat" class="new-chat" type="button">+ 새 요청</button>
        <nav id="threads" class="threads" aria-label="지난 요청"></nav>
      </div>
      <div class="side-bottom">
        <span>Mac Studio · Hermes</span>
        <button id="logout" class="icon-btn" type="button" title="로그아웃" aria-label="로그아웃">⌁</button>
      </div>
    </aside>
    <section class="chat">
      <header class="chat-top">
        <div class="chat-title">
          <button id="menuBtn" class="icon-btn menu-btn" type="button" aria-label="기록 메뉴 열기" aria-expanded="false" aria-controls="drawer">☰</button>
          <strong>Hyphen Studio Agent</strong>
        </div>
        <div class="status-row"><span id="conn" class="pill">연결 확인 중</span><span id="biz" class="pill" hidden></span><span id="evidence" class="pill" hidden></span><button id="refreshTop" class="pill" type="button">새로고침</button></div>
      </header>
      <div id="messages" class="messages"></div>
      <form id="requestForm" class="composer-wrap">
        <div class="composer">
          <label class="sr-only" for="body">요청 내용</label>
          <textarea id="body" placeholder="프로젝트 요청을 자연스럽게 적어주세요" rows="2"></textarea>
          <div class="composer-controls">
            <div class="composer-fields">
              <label class="field"><span>프로젝트</span><select id="project" class="project"></select></label>
              <label class="field"><span>작업 종류</span><select id="type">
                <option value="auto">자동 판단</option>
                <option value="studio_overview">전체 Studio 브리핑</option>
                <option value="studio_priorities">전체 Studio 우선순위</option>
                <option value="studio_blockers">전체 Studio 막힌 프로젝트</option>
                <option value="studio_evidence_audit">사업 현황 갱신 점검</option>
                <option value="hermes_chat">Hermes 4.3 대화</option>
                <option value="mac_status">Mac 상태</option>
                <option value="deployment_status">배포 상태</option>
                <option value="project_inspect">프로젝트 점검</option>
                <option value="redeploy">재배포</option>
                <option value="development">Codex 개발 요청</option>
                <option value="file_cleanup">파일 정리</option>
                <option value="hermes_ops">Hermes 운영 요청</option>
              </select></label>
            </div>
            <button class="send" type="submit" title="보내기" aria-label="보내기">↑</button>
          </div>
          <p id="scopeLine" class="scope-line" aria-live="polite"></p>
        </div>
        <p id="formStatus" class="error" role="status"></p>
      </form>
    </section>
    <div id="drawerScrim" class="drawer-scrim" hidden></div>
    <nav id="drawer" class="drawer" hidden aria-label="요청 기록" role="dialog" aria-modal="true">
      <div class="drawer-head">
        <div class="brand"><span class="mark">H</span><span>Hyphen Studio Agent</span></div>
        <button id="drawerClose" class="icon-btn" type="button" aria-label="기록 닫기">✕</button>
      </div>
      <button id="drawerHome" class="drawer-action" type="button">홈 · 빠른 작업</button>
      <button id="drawerNew" class="drawer-action" type="button">+ 새 요청</button>
      <div id="drawerThreads" class="threads drawer-threads" aria-label="지난 요청"></div>
      <div class="drawer-bottom">
        <button id="drawerRefresh" class="pill" type="button">새로고침</button>
        <button id="drawerLogout" class="pill" type="button">로그아웃</button>
      </div>
    </nav>
  </section>
  <script>window.__HERMES_PREFILL__ = __PREFILL_JSON__;</script>
  <script>
    const $ = (id) => document.getElementById(id);
    const labels = { auto: "자동 판단", studio_overview: "전체 Studio 브리핑", studio_priorities: "전체 Studio 우선순위", studio_blockers: "전체 Studio 막힌 프로젝트", studio_evidence_audit: "사업 현황 갱신 점검", hermes_chat: "Hermes 4.3 대화", hermes_ops: "Hermes 운영 요청", mac_status: "Mac 상태", deployment_status: "배포 상태", project_inspect: "프로젝트 점검", redeploy: "재배포", file_cleanup: "파일 정리", development: "Codex 개발 요청", custom: "Hermes 4.3 대화" };
    const studioScopeTypes = new Set(["studio_priorities", "studio_blockers", "studio_overview", "studio_evidence_audit"]);
    const statusLabels = { queued: "대기 중", approval_required: "승인 필요", running: "실행 중", done: "완료", failed: "실패", canceled: "취소됨" };
    const routeLabels = { NO_ACTION: "조치 불필요", LOCAL_SCRIPT: "로컬 점검", LOCAL_LLM: "로컬 모델", GPT: "외부 모델", CODEX: "Codex 개발", DEVIN: "Devin", REQUIRE_OWNER: "소유자 확인 필요" };
    const verdictLabels = { allow: "허용", warn: "주의", block: "차단" };
    const presets = [
      { id: "briefing", label: "오늘 브리핑", group: "business", body: "전체 Hyphen Studio의 오늘 브리핑을 보여줘", type: "studio_overview" },
      { id: "priorities", label: "오늘 우선순위", group: "business", body: "전체 Hyphen Studio 프로젝트의 오늘 우선순위를 정리해줘", type: "studio_priorities" },
      { id: "blocked", label: "막힌 프로젝트", group: "business", body: "전체 Hyphen Studio에서 지금 막힌 프로젝트를 알려줘", type: "studio_blockers" },
      { id: "audit", label: "사업 현황 갱신 점검", group: "business", body: "전체 Hyphen Studio 사업 현황에서 갱신이 필요한 항목을 점검해줘", type: "studio_evidence_audit" },
      { id: "mac", label: "Mac 상태 점검", group: "ops", body: "Mac 상태를 점검해줘", type: "mac_status" },
      { id: "deploy", label: "배포 상태 확인", group: "ops", body: "배포 상태를 확인해줘", type: "deployment_status" },
      { id: "inspect", label: "프로젝트 점검", group: "dev", body: "선택한 프로젝트의 저장소 상태를 점검하고 이상을 보고해줘", type: "project_inspect" },
      { id: "dev", label: "개발 요청", group: "dev", body: "선택한 프로젝트에 개선 작업을 요청해줘: ", type: "development" },
    ];
    const presetGroups = [
      { id: "business", title: "사업", note: "전체 Hyphen Studio 기준 · 읽기 전용" },
      { id: "ops", title: "운영", note: "선택한 프로젝트 기준" },
      { id: "dev", title: "개발", note: "선택한 프로젝트 기준 · 승인 후 실행" },
    ];
    const auditFieldLabels = { status: "상태", lifecycle: "사업 단계", businessType: "사업 유형", owner: "담당자", evidenceStatus: "근거", repositories: "저장소", deploys: "배포", dataStores: "데이터 저장소", kpis: "지표", revenue: "매출" };
    const auditPriorityLabels = { high: "높음", medium: "보통", low: "낮음" };
    const capabilityGuidance = {
      project_inspect: "선택한 프로젝트에는 저장소 점검 연결이 없습니다. 저장소가 연결된 프로젝트를 선택해주세요.",
      development: "선택한 프로젝트에는 저장소 개발 연결이 없습니다. 저장소가 연결된 프로젝트를 선택해주세요.",
      redeploy: "선택한 프로젝트에는 재배포 연결이 없습니다. 재배포할 수 있는 프로젝트를 선택해주세요.",
      deployment_status: "선택한 프로젝트에는 배포 상태 연결이 없습니다. 배포 상태를 확인할 수 있는 프로젝트를 선택해주세요.",
    };
    const capabilityGuidanceFallback = "선택한 프로젝트에는 이 작업이 연결되어 있지 않습니다. 이 작업을 지원하는 프로젝트를 선택해주세요.";
    const capabilityGatedTypes = ["deployment_status", "project_inspect", "redeploy", "development"];
    let current = null;
    let composingNew = false;
    let pollTimer = null;
    let projectNames = {};
    let projectCapabilities = {};
    let prefillApplied = false;
    let connState = null;
    let bizState = null;
    let s1Summary = null;
    async function api(path, init) {
      const res = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...init });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const error = new Error(data.error || data.detail || res.statusText);
        error.status = res.status;
        throw error;
      }
      return data;
    }
    function setConn(connected) {
      connState = connected;
      const el = $("conn");
      el.textContent = connected ? "연결됨" : "연결 끊김 · 재시도 중";
      el.classList.toggle("offline", !connected);
      el.classList.toggle("ok", connected);
    }
    function renderBusinessStatus(data) {
      bizState = data || null;
      const el = $("biz");
      if (!data || !data.state) { el.hidden = true; return; }
      const basis = data.registryUpdatedAt ? " · 기준 " + data.registryUpdatedAt : "";
      if (data.state === "fresh") {
        el.textContent = "사업 데이터 최신" + basis;
        el.className = "pill";
      } else if (data.state === "stale") {
        el.textContent = "사업 데이터 지연" + basis;
        el.className = "pill biz-stale";
      } else {
        el.textContent = "사업 데이터 사용 불가";
        el.className = "pill biz-down";
      }
      el.hidden = false;
    }
    function renderEvidence(summary) {
      s1Summary = summary || null;
      const el = $("evidence");
      const observed = summary ? summary.observedOk + summary.observedError : 0;
      if (summary && observed > 0) {
        el.textContent = "빠른 판단 " + observed + "/" + summary.totalEligibleRequests + "건 관찰" + (summary.abstained > 0 ? " · 소유자 확인 " + summary.abstained + "건" : "");
        el.hidden = false;
      } else {
        el.hidden = true;
      }
    }
    async function load() {
      try {
        const [{ requests }, { projects }] = await Promise.all([api("/api/requests"), api("/api/projects")]);
        $("login").hidden = true; $("app").hidden = false;
        document.body.classList.add("authed");
        setConn(true);
        projectNames = Object.fromEntries(projects.map((project) => [project.id, project.name]));
        projectCapabilities = Object.fromEntries(projects.map((project) => [project.id, project.capabilities || []]));
        const selectedProject = $("project").value;
        $("project").innerHTML = projects.map((project) => '<option value="' + esc(project.id) + '">' + esc(project.name) + '</option>').join("");
        if (projects.some((project) => project.id === selectedProject)) $("project").value = selectedProject;
        refreshPresetGuidance();
        applyHandoffPrefill();
        render(requests);
        api("/api/system1/summary").then(renderEvidence).catch(() => renderEvidence(null));
        api("/api/business/status").then(renderBusinessStatus).catch(() => { $("biz").hidden = true; });
        clearTimeout(pollTimer);
        const busy = requests.some((request) => ["queued", "running"].includes(request.status));
        pollTimer = setTimeout(load, busy ? 2000 : 8000);
      } catch (error) {
        clearTimeout(pollTimer);
        if (error && error.status === 401) {
          $("login").hidden = false; $("app").hidden = true;
          document.body.classList.remove("authed");
          return;
        }
        setConn(false);
        pollTimer = setTimeout(load, 5000);
      }
    }
    function esc(v) { return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
    function titleFrom(text) { return String(text || "새 요청").trim().replace(/\\s+/g, " ").slice(0, 56) || "새 요청"; }
    function assistantText(r) {
      if (studioScopeTypes.has(r.resolved_type || r.type)) {
        if (r.status === "failed") return "사업 레지스트리를 지금 읽을 수 없습니다. 잠시 후 다시 시도해주세요.";
        return (r.resolved_type || r.type) === "studio_evidence_audit"
          ? "전체 Hyphen Studio 사업 레지스트리의 읽기 전용 갱신 점검표를 만들었습니다."
          : "전체 Hyphen Studio 사업 레지스트리에서 읽기 전용 브리핑을 만들었습니다.";
      }
      if (r.status === "approval_required") return "변경이 필요한 작업으로 판단했습니다. 승인하기 전에는 아무것도 실행되지 않습니다.";
      if (r.status === "queued") return "요청을 큐에 넣었습니다. Mac Studio 워커가 곧 가져갑니다.";
      if (r.status === "running") return "Mac Studio에서 실행 중입니다.";
      if (r.status === "failed") return "처리 중 오류가 발생했습니다.";
      if (r.status === "canceled") return "요청이 실행 전에 취소되었습니다.";
      return "처리가 완료되었습니다.";
    }
    function approvalText(r) {
      const type = r.resolved_type || r.type;
      if (type === "development") return "승인하면 선택한 프로젝트 저장소에서 Codex가 코드를 수정하고, 확인 명령을 실행한 뒤 커밋·재배포와 상태 점검까지 이어집니다.";
      if (type === "redeploy") return "승인하면 선택한 프로젝트를 Mac Studio 배포 서비스로 다시 배포합니다.";
      if (type === "file_cleanup") return "승인하면 Mac Studio에서 파일 정리 작업을 실행합니다.";
      if (type === "hermes_ops") return "승인하면 Hermes가 검증된 운영 명령 하나를 골라 Mac Studio에서 실행합니다.";
      return "승인하면 Mac Studio 워커가 이 요청을 실행합니다.";
    }
    function homeStateHtml() {
      const chips = [];
      if (connState === true) chips.push('<span class="state-chip ok">연결됨</span>');
      else if (connState === false) chips.push('<span class="state-chip down">연결 끊김 · 재시도 중</span>');
      if (bizState && bizState.state === "fresh") chips.push('<span class="state-chip ok">사업 데이터 최신</span>');
      else if (bizState && bizState.state === "stale") chips.push('<span class="state-chip warn">사업 데이터 지연</span>');
      else if (bizState && bizState.state) chips.push('<span class="state-chip down">사업 데이터 사용 불가</span>');
      if (s1Summary && s1Summary.observedOk + s1Summary.observedError > 0) {
        chips.push('<span class="state-chip">빠른 판단 ' + (s1Summary.observedOk + s1Summary.observedError) + '/' + s1Summary.totalEligibleRequests + '건 관찰</span>');
      }
      return chips.length ? '<div class="home-state">' + chips.join("") + '</div>' : "";
    }
    function homeHtml() {
      const groups = presetGroups.map((group) =>
        '<section class="action-group"><h3>' + esc(group.title) + '</h3><p class="group-note">' + esc(group.note) + '</p><div class="preset-grid">' +
        presets.filter((preset) => preset.group === group.id).map((preset) =>
          '<button type="button" class="preset" data-preset="' + esc(preset.id) + '">' + esc(preset.label) + '</button>').join("") +
        '</div></section>').join("");
      return '<div class="home">' +
        '<p class="home-eyebrow">Mac Studio · Hermes</p>' +
        '<h1>안녕하세요. 무엇을 확인할까요?</h1>' +
        '<p class="muted">아래에서 자주 쓰는 작업을 고르거나, 자연스럽게 요청을 적어주세요.</p>' +
        homeStateHtml() +
        '<div class="action-groups">' + groups + '</div>' +
        '<p class="preset-scope">사업 작업은 전체 Hyphen Studio 기준으로 읽기만 합니다. 운영·개발 작업은 위에서 선택한 프로젝트에 적용됩니다. 빠른 작업은 내용만 채워주고, 실행은 항상 직접 보내야 시작됩니다.</p>' +
        '</div>';
    }
    function auditMetric(value, label) {
      return '<div class="metric"><strong>' + esc(value) + '</strong><span>' + esc(label) + '</span></div>';
    }
    function auditView(audit) {
      const prio = audit.summary.byPriority;
      const items = audit.items.map((item) =>
        '<details class="audit-item"><summary><span class="audit-name">' + esc(item.projectName) + '</span><span class="audit-badge ' + esc(item.priority) + '">' + esc(auditPriorityLabels[item.priority] || item.priority) + '</span></summary>' +
        '<div class="audit-body"><div class="audit-chips">' + item.missingFields.map((field) => '<span class="chip">' + esc(auditFieldLabels[field] || field) + '</span>').join("") + '</div>' +
        '<ul class="audit-actions">' + item.actions.map((action) => '<li>' + esc(action) + '</li>').join("") + '</ul></div></details>').join("");
      return '<div class="audit-view">' +
        '<div class="audit-metrics">' +
        auditMetric(audit.coverage.hyphenCore, "검토 범위") +
        auditMetric(audit.coverage.statusUnknown, "상태 미상") +
        auditMetric(audit.coverage.evidenceUnverified, "근거 미충족") +
        auditMetric(audit.coverage.ownerMissing, "담당자 미지정") +
        '</div>' +
        '<p class="audit-lead">갱신 검토 대상 ' + esc(audit.summary.projectsNeedingReview) + '개 · 대기 중인 확인 요청 ' + esc(audit.summary.pendingEvidence) + '건</p>' +
        '<div class="audit-prio">우선순위 <span class="chip prio-high">높음 ' + esc(prio.high) + '</span><span class="chip prio-medium">보통 ' + esc(prio.medium) + '</span><span class="chip prio-low">낮음 ' + esc(prio.low) + '</span></div>' +
        (items ? '<div class="audit-items">' + items + '</div>' : '<p class="muted">모든 항목이 검증 완료 — 갱신이 필요한 프로젝트가 없습니다.</p>') +
        (audit.remaining > 0 ? '<p class="audit-more">… 외 ' + esc(audit.remaining) + '개 프로젝트가 더 있습니다.</p>' : '') +
        '</div>';
    }
    function resultHtml(active) {
      const audit = active.briefing && active.briefing.audit;
      if (active.status === "done" && audit && audit.kind === "audit-v1" && audit.coverage && audit.summary && Array.isArray(audit.items)) return auditView(audit);
      if (active.result) return '<div class="result-text">' + esc(active.result) + '</div>';
      return '<div class="result-meta">' + esc(new Date(active.updated_at).toLocaleString()) + '</div>';
    }
    function shadowPanel(shadow) {
      if (!shadow || shadow.kind !== "hermes.system1.shadow") return "";
      const head = '<summary class="s1-head"><span class="s1-title">빠른 판단</span><span class="s1-badge">관찰 전용 · 실행에 영향 없음</span></summary>';
      if (shadow.status !== "ok") return '<details class="fold s1">' + head + '<div class="s1-body"><div class="s1-row"><span>관찰 결과를 사용할 수 없습니다</span></div></div></details>';
      const confidence = typeof shadow.confidence === "number" && shadow.confidence >= 0 && shadow.confidence <= 1 ? Math.round(shadow.confidence * 100) + "%" : "-";
      return '<details class="fold s1">' + head + '<div class="s1-body">' +
        '<div class="s1-row"><span>예상 경로</span><strong>' + esc(routeLabels[shadow.route] || "확인 필요") + '</strong></div>' +
        '<div class="s1-row"><span>정책 판정</span><strong>' + esc(verdictLabels[shadow.policyVerdict] || "확인 필요") + '</strong></div>' +
        '<div class="s1-row"><span>확신도</span><strong>' + confidence + '</strong></div></div></details>';
    }
    function refreshPresetGuidance() {
      const el = $("formStatus");
      const type = $("type").value;
      const project = $("project").value;
      const capabilities = projectCapabilities[project] || [];
      const scopeEl = $("scopeLine");
      if (scopeEl) {
        scopeEl.textContent = studioScopeTypes.has(type)
          ? "범위: 전체 Hyphen Studio"
          : "프로젝트: " + (projectNames[project] || "선택 없음");
      }
      if (capabilityGatedTypes.includes(type) && project && !capabilities.includes(type)) {
        el.textContent = capabilityGuidance[type] || capabilityGuidanceFallback;
        el.dataset.guide = "1";
      } else if (studioScopeTypes.has(type)) {
        el.textContent = "범위: 전체 Hyphen Studio · 읽기 전용 브리핑";
        el.dataset.guide = "1";
      } else if (el.dataset.guide === "1") {
        el.textContent = "";
        delete el.dataset.guide;
      }
    }
    function applyPreset(id) {
      const preset = presets.find((item) => item.id === id);
      if (!preset) return;
      $("body").value = preset.body;
      $("type").value = preset.type;
      if (preset.project && [...$("project").options].some((option) => option.value === preset.project)) $("project").value = preset.project;
      refreshPresetGuidance();
      $("body").focus();
    }
    // Studio handoff: the server already validated every prefill field against
    // the registry and type allowlists. This only fills the editable composer —
    // it never submits, never approves, and runs once per page load. Clearing
    // the value and the query string keeps refreshes from reapplying it.
    function applyHandoffPrefill() {
      if (prefillApplied) return;
      const prefill = window.__HERMES_PREFILL__;
      if (!prefill || typeof prefill !== "object") return;
      prefillApplied = true;
      window.__HERMES_PREFILL__ = null;
      try { history.replaceState(null, "", location.pathname); } catch { /* keep the URL if replace fails */ }
      if (prefill.project && [...$("project").options].some((option) => option.value === prefill.project)) $("project").value = prefill.project;
      if (prefill.type && [...$("type").options].some((option) => option.value === prefill.type)) $("type").value = prefill.type;
      $("body").value = typeof prefill.prompt === "string" ? prefill.prompt : "";
      current = null;
      composingNew = true;
      refreshPresetGuidance();
      $("formStatus").textContent = "Studio에서 넘겨받은 초안입니다. 내용을 확인하고 직접 보내야 실행됩니다.";
      $("formStatus").dataset.guide = "1";
      $("body").focus();
    }
    function render(requests) {
      const sorted = [...requests].sort((a, b) => b.created_at - a.created_at);
      if (!current && !composingNew && sorted[0]) current = sorted[0].id;
      const threadHtml = sorted.map((r) =>
        '<button class="thread" type="button" data-thread="' + r.id + '"' + (r.id === current ? ' aria-current="true"' : "") + '><strong>' + esc(r.title) + '</strong><span>' + esc(statusLabels[r.status] || r.status) + ' · ' + esc(labels[r.resolved_type || r.type] || r.resolved_type || r.type) + '</span></button>').join("")
        || '<p class="threads-empty">아직 요청이 없습니다.</p>';
      $("threads").innerHTML = threadHtml;
      $("drawerThreads").innerHTML = threadHtml;
      const active = current ? sorted.find((r) => r.id === current) : null;
      if (!active) {
        $("messages").innerHTML = homeHtml();
        return;
      }
      const events = (active.events || []).slice(-6).reverse().map((event) => '<div class="event"><span>' + esc(new Date(event.at).toLocaleTimeString()) + '</span><strong>' + esc(event.message) + '</strong></div>').join("");
      const eventCount = (active.events || []).length;
      const activeType = active.resolved_type || active.type;
      const scope = studioScopeTypes.has(activeType) ? "전체 Hyphen Studio" : (projectNames[active.target_project] || active.target_project || "");
      $("messages").innerHTML = '<article class="message user"><div class="avatar">나</div><div class="bubble"><h2>' + esc(active.title) + '</h2><p>' + esc(active.body) + '</p></div></article>' +
        '<article class="message assistant"><div class="avatar">H</div><div class="bubble"><h2>Hyphen Studio Agent</h2><p>' + esc(assistantText(active)) + '</p><div class="assistant-block"><div class="block-head"><span>' + esc(labels[activeType] || activeType) + (scope ? ' · ' + esc(scope) : '') + '</span><span class="status ' + active.status + '">' + esc(statusLabels[active.status] || active.status) + '</span></div>' +
        shadowPanel(active.system1_shadow) +
        (active.plan ? '<p class="progress-copy"><strong>판단:</strong> ' + esc(active.plan) + '</p>' : '') +
        (active.briefing && active.briefing.updatedAt ? '<p class="progress-copy">소스 ' + esc(active.briefing.sourceLabel) + ' · 업데이트 ' + esc(active.briefing.updatedAt) + '</p>' : '') +
        (active.progress ? '<p class="progress-copy">' + esc(active.progress) + '</p>' : '') +
        (active.status === 'approval_required' ? '<p class="progress-copy">' + esc(approvalText(active)) + '</p>' : '') +
        resultHtml(active) +
        (events ? '<details class="fold events-fold"><summary>최근 기록 ' + esc(eventCount) + '건</summary><div class="event-list">' + events + '</div></details>' : '') +
        (active.status === 'approval_required' ? '<div class="block-head"><button class="primary" type="button" data-approve="' + active.id + '">실행 승인</button><button class="pill" type="button" data-cancel="' + active.id + '">취소</button></div>' : '') +
        (active.status === 'queued' ? '<div class="block-head"><button class="pill" type="button" data-cancel="' + active.id + '">취소</button></div>' : '') +
        (['failed', 'canceled'].includes(active.status) ? '<div class="block-head"><button class="primary" type="button" data-retry="' + active.id + '">다시 실행</button></div>' : '') +
        '</div></div></article>';
      $("messages").scrollTop = $("messages").scrollHeight;
    }
    $("loginForm").onsubmit = async (event) => { event.preventDefault(); try { const password = $("password").value; if (!password) { $("loginError").textContent = "비밀번호를 입력해주세요."; return; } await api("/api/login", { method: "POST", body: JSON.stringify({ password }) }); await load(); } catch (e) { $("loginError").textContent = "비밀번호가 맞지 않습니다."; } };
    $("requestForm").onsubmit = async (event) => { event.preventDefault(); $("formStatus").textContent = ""; delete $("formStatus").dataset.guide; const body = $("body").value.trim(); if (!body) return; try { const created = await api("/api/requests", { method: "POST", body: JSON.stringify({ type: $("type").value, title: titleFrom(body), body, target_project: $("project").value || "hermes-mac-ops" }) }); current = created.request.id; composingNew = false; $("body").value = ""; await load(); } catch (error) { if (error.message === "project_capability_not_enabled") { $("formStatus").textContent = capabilityGuidance[$("type").value] || capabilityGuidanceFallback; $("formStatus").dataset.guide = "1"; } else { $("formStatus").textContent = error.message || "요청을 보내지 못했습니다."; } } };
    $("threads").onclick = async (event) => { const id = event.target?.closest?.("[data-thread]")?.dataset?.thread; if (id) { current = id; composingNew = false; await load(); } };
    $("messages").onclick = async (event) => { const presetId = event.target?.closest?.("[data-preset]")?.dataset?.preset; if (presetId) { applyPreset(presetId); return; } const approveId = event.target?.dataset?.approve; const cancelId = event.target?.dataset?.cancel; const retryId = event.target?.dataset?.retry; if (approveId) await api("/api/requests/" + approveId + "/approve", { method: "POST", body: "{}" }); if (cancelId) await api("/api/requests/" + cancelId + "/cancel", { method: "POST", body: "{}" }); if (retryId) await api("/api/requests/" + retryId + "/retry", { method: "POST", body: "{}" }); if (approveId || cancelId || retryId) await load(); };
    function goHome() { current = null; composingNew = true; void load(); }
    function newRequest() { current = null; composingNew = true; $("body").focus(); void load(); }
    async function logout() { await api("/api/logout", { method: "POST", body: "{}" }); await load(); }
    function openDrawer() {
      $("drawer").hidden = false;
      $("drawerScrim").hidden = false;
      $("menuBtn").setAttribute("aria-expanded", "true");
      $("drawerClose").focus();
    }
    function closeDrawer(restoreFocus) {
      $("drawer").hidden = true;
      $("drawerScrim").hidden = true;
      $("menuBtn").setAttribute("aria-expanded", "false");
      if (restoreFocus) $("menuBtn").focus();
    }
    $("menuBtn").onclick = () => openDrawer();
    $("drawerClose").onclick = () => closeDrawer(true);
    $("drawerScrim").onclick = () => closeDrawer(false);
    $("drawerHome").onclick = () => { closeDrawer(false); goHome(); };
    $("drawerNew").onclick = () => { closeDrawer(false); newRequest(); };
    $("drawerRefresh").onclick = () => { closeDrawer(false); void load(); };
    $("drawerLogout").onclick = logout;
    $("drawerThreads").onclick = async (event) => { const id = event.target?.closest?.("[data-thread]")?.dataset?.thread; if (id) { closeDrawer(false); current = id; composingNew = false; await load(); } };
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("drawer").hidden) closeDrawer(true); });
    $("homeBtn").onclick = goHome;
    $("newChat").onclick = newRequest;
    $("refresh").onclick = load;
    $("refreshTop").onclick = load;
    $("project").onchange = refreshPresetGuidance;
    $("type").onchange = refreshPresetGuidance;
    $("logout").onclick = logout;
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
const system1SummaryKind = "hermes.system1.shadow-summary";
const system1SummaryRoutes = ["NO_ACTION", "LOCAL_SCRIPT", "LOCAL_LLM", "GPT", "CODEX", "DEVIN", "REQUIRE_OWNER"];
const system1SummaryVerdicts = ["allow", "warn", "block"];
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

let businessRegistryModule = null;
let businessRegistryModuleFailed = false;

async function loadBusinessRegistryModule() {
  if (businessRegistryModule || businessRegistryModuleFailed) return businessRegistryModule;
  try {
    businessRegistryModule = await import("./scripts/hermes-business-registry.mjs");
  } catch {
    businessRegistryModuleFailed = true;
  }
  return businessRegistryModule;
}

const studioResultMaxItems = 8;
const studioResultMaxBlockers = 3;
const studioResultMaxChars = 4000;
const studioSourceLabel = "전체 Studio 사업 레지스트리";
const studioUnavailableMessage = "지금은 전체 Studio 사업 브리핑을 불러올 수 없습니다. 잠시 후 다시 시도해주세요.";
const studioErrorCodes = new Set([
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
]);

// Internal-only allowlisted failure code — never loader messages or paths.
function studioErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "registry_error";
  return studioErrorCodes.has(code) ? code : "registry_error";
}

// Reads the sync-status document written by hermes-registry-sync.mjs. Same
// fail-closed posture as the registry itself: symlinked, oversized, or
// malformed status files are treated as absent — the endpoint then reports
// staleness rather than trusting a suspicious file.
async function readBusinessSyncStatus(registryLib) {
  try {
    const info = await lstat(businessRegistryStatusFile);
    if (info.isSymbolicLink() || !info.isFile() || info.size > registryLib.SYNC_STATUS_MAX_BYTES) {
      return null;
    }
    return registryLib.parseSyncStatusDocument(await readFile(businessRegistryStatusFile, "utf8"));
  } catch {
    return null;
  }
}

// Authenticated read-only freshness answer for the UI pill. The payload is a
// fixed allowlist — state, timestamps, project count, and a bounded errorCode.
// Registry contents, local paths, source hashes, and loader messages can never
// reach this response, and nothing here touches the request queue, approvals,
// or the worker.
async function businessRegistryStatus() {
  const empty = { state: "unavailable", checkedAt: null, syncedAt: null, registryUpdatedAt: null, projectCount: null, errorCode: null };
  const registryLib = await loadBusinessRegistryModule();
  if (!registryLib) return empty;
  let registry = null;
  try {
    ({ registry } = await registryLib.loadBusinessRegistry(businessRegistryFile, {
      expectedHash: businessRegistryExpectedHash || undefined,
    }));
  } catch {
    registry = null;
  }
  const status = await readBusinessSyncStatus(registryLib);
  return {
    state: registryLib.businessRegistryFreshness({
      registry,
      status,
      now: Date.now(),
      staleMs: businessRegistryStaleMs,
    }),
    checkedAt: status?.checkedAt ?? null,
    syncedAt: status?.syncedAt ?? null,
    registryUpdatedAt: registry?.updatedAt ?? status?.registryUpdatedAt ?? null,
    projectCount: Array.isArray(registry?.projects) ? registry.projects.length : (status?.projectCount ?? null),
    errorCode: status?.status === "error" ? status.errorCode : null,
  };
}

const studioOverviewMaxItems = 5;
const studioOverviewSectionMaxChars = 620;
const studioViewBodyMaxChars = 3400;
const studioNameMaxChars = 60;
const studioSummaryMaxChars = 200;
const studioBlockerMaxChars = 140;
const studioSinceMaxChars = 24;
const studioViewTitles = { priorities: "오늘 우선순위", blockers: "막힌 프로젝트", overview: "오늘 브리핑" };
const studioOverviewSections = [
  ["오늘의 상위 우선순위", "topPriorities"],
  ["막힌 일", "blocked"],
  ["매출·고객 신호", "revenueSignals"],
  ["시스템 이상", "systemAnomalies"],
  ["소유자 승인이 필요한 일", "ownerApprovals"],
];

// Registry strings are unbounded: flatten every display field to a single
// line and cap it so no value can consume the result budget or inject extra
// section/header lines.
function studioText(value, maxChars) {
  const flat = String(value ?? "").replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

function pushStudioItems(lines, items, { showBlockers = false, maxItems = studioResultMaxItems } = {}) {
  if (items.length === 0) {
    lines.push("근거 없음 — 입력 레지스트리에 해당 신호가 없습니다. 확인 필요.");
    return;
  }
  for (const [index, item] of items.slice(0, maxItems).entries()) {
    lines.push(
      `${index + 1}. ${studioText(item.projectName, studioNameMaxChars)} — ${studioText(item.summary, studioSummaryMaxChars)} · ${item.verified ? "근거 있음" : "확인 필요"}`,
    );
    if (showBlockers) {
      for (const blocker of (item.details?.blockers || []).slice(0, studioResultMaxBlockers)) {
        const description = studioText(blocker.description, studioBlockerMaxChars);
        const since = studioText(blocker.since, studioSinceMaxChars);
        lines.push(`   - ${description}${since ? ` (${since}~)` : ""}`);
      }
    }
  }
  if (items.length > maxItems) lines.push(`… 외 ${items.length - maxItems}개`);
}

// Deterministic per-section character budget: every overview section header
// and the final coverage line are guaranteed to survive the 4000-char cap.
function pushStudioSection(lines, items, options) {
  const sectionLines = [];
  pushStudioItems(sectionLines, items, options);
  const text = sectionLines.join("\n");
  lines.push(text.length <= options.budget ? text : `${text.slice(0, options.budget)}…`);
}

// Bounded owner-facing rendering of briefing sections. Only registry-derived
// Korean summaries, blocker descriptions, verification flags, coverage counts,
// and safe source metadata — never raw registry JSON, evidence refs,
// owner/contact names, paths, source filenames, or any source-hash material.
function renderStudioView(view, briefing) {
  const lines = [
    `전체 Hyphen Studio · ${studioViewTitles[view] || "브리핑"}`,
    `소스: ${studioSourceLabel} · 업데이트 ${briefing.source.updatedAt}`,
    `범위: hyphen 코어 ${briefing.coverage.hyphenCore}개 프로젝트 (제외 ${briefing.coverage.excluded}개)`,
    "",
  ];
  if (view === "overview") {
    for (const [title, key] of studioOverviewSections) {
      lines.push(`■ ${title}`);
      pushStudioSection(lines, briefing.sections[key], {
        showBlockers: key === "blocked",
        maxItems: studioOverviewMaxItems,
        budget: studioOverviewSectionMaxChars,
      });
      lines.push("");
    }
  } else {
    const items = view === "blockers" ? briefing.sections.blocked : briefing.sections.topPriorities;
    pushStudioSection(lines, items, { showBlockers: view === "blockers", budget: studioViewBodyMaxChars });
    lines.push("");
  }
  lines.push(
    `미검증 현황: 상태 미상 ${briefing.coverage.statusUnknown}개 · 근거 미충족 ${briefing.coverage.evidenceUnverified}개 · 담당자 미지정 ${briefing.coverage.ownerMissing}개`,
  );
  return lines.join("\n").slice(0, studioResultMaxChars);
}

// Deterministic read-only Studio briefing, generated synchronously in the
// server from the mounted business registry — never queued for the worker,
// never needs approval, and stores only the bounded result plus safe metadata.
async function runStudioBriefing(request) {
  const view = studioViewByType[request.type] || "priorities";
  const now = Date.now();
  const finish = (status, result, briefing = null) => {
    request.status = status;
    request.result = result;
    request.briefing = briefing;
    request.progress = status === "done" ? "읽기 전용 Studio 브리핑을 만들었습니다." : "브리핑을 만들지 못했습니다.";
    request.progress_step = status;
    request.completed_at = now;
    request.updated_at = now;
  };
  try {
    const registryLib = await loadBusinessRegistryModule();
    if (!registryLib) {
      finish("failed", studioUnavailableMessage, { view, error: "registry_module_missing" });
      addEvent(request, "브리핑 생성 실패");
      return;
    }
    const { registry } = await registryLib.loadBusinessRegistry(businessRegistryFile, {
      expectedHash: businessRegistryExpectedHash || undefined,
    });
    const briefing = registryLib.buildBusinessBriefing(registry);
    const itemCount =
      view === "overview"
        ? studioOverviewSections.reduce((total, [, key]) => total + briefing.sections[key].length, 0)
        : (view === "blockers" ? briefing.sections.blocked : briefing.sections.topPriorities).length;
    finish("done", renderStudioView(view, briefing), {
      view,
      sourceLabel: studioSourceLabel,
      updatedAt: briefing.source.updatedAt,
      itemCount,
    });
    addEvent(request, "Studio 브리핑 생성");
  } catch (error) {
    finish("failed", studioUnavailableMessage, { view, error: studioErrorCode(error) });
    addEvent(request, "브리핑 생성 실패");
  }
}

const studioAuditUnavailableMessage = "지금은 사업 현황 갱신 점검을 불러올 수 없습니다. 잠시 후 다시 시도해주세요.";
const studioAuditTopItems = 10;
const studioAuditFieldLabels = {
  status: "상태",
  lifecycle: "단계",
  businessType: "사업 유형",
  owner: "담당자",
  evidenceStatus: "근거",
  repositories: "저장소",
  deploys: "배포",
  dataStores: "데이터 저장소",
  kpis: "지표",
  revenue: "매출",
};
const studioAuditPriorityLabels = { high: "높음", medium: "보통", low: "낮음" };

// Bounded owner-facing rendering of the evidence audit. Same rules as the
// briefing renderer: registry-derived Korean summaries and fixed field labels
// only — never raw JSON, evidence refs, paths, or hash material.
function renderEvidenceAudit(audit) {
  const lines = [
    `사업 현황 갱신 점검 · 전체 Hyphen Studio`,
    `소스: ${studioSourceLabel} · 업데이트 ${audit.source.updatedAt}`,
    `범위: hyphen 코어 ${audit.coverage.hyphenCore}개 프로젝트 (제외 ${audit.coverage.excluded}개)`,
    "",
    `공백 집계: 상태 미상 ${audit.coverage.statusUnknown}개 · 근거 미충족 ${audit.coverage.evidenceUnverified}개 · 담당자 미지정 ${audit.coverage.ownerMissing}개`,
    `갱신 검토 대상 ${audit.summary.projectsNeedingReview}개 · 대기 중인 확인 요청 ${audit.summary.pendingEvidence}건`,
    `우선순위: 높음 ${audit.summary.byPriority.high}개 · 보통 ${audit.summary.byPriority.medium}개 · 낮음 ${audit.summary.byPriority.low}개`,
    "",
  ];
  if (audit.items.length === 0) {
    lines.push("모든 항목이 검증 완료 — 갱신이 필요한 프로젝트가 없습니다.");
  } else {
    lines.push(`■ 우선 갱신 작업 (상위 ${Math.min(studioAuditTopItems, audit.items.length)}개)`);
    for (const [index, item] of audit.items.slice(0, studioAuditTopItems).entries()) {
      const missing = item.missingFields.map((field) => studioAuditFieldLabels[field] || field).join(", ");
      lines.push(
        `${index + 1}. ${studioText(item.projectName, studioNameMaxChars)} — ${studioAuditPriorityLabels[item.priority] || item.priority} · 누락: ${missing}`,
      );
      for (const action of item.actions.slice(0, 4)) {
        lines.push(`   - ${studioText(action, studioSummaryMaxChars)}`);
      }
    }
    if (audit.items.length > studioAuditTopItems) lines.push(`… 외 ${audit.items.length - studioAuditTopItems}개`);
  }
  return lines.join("\n").slice(0, studioResultMaxChars);
}

// Bounded structured view of the audit for the console renderer. Every field
// is already allowlisted by buildEvidenceAudit — names capped, missingFields a
// fixed enum, actions fixed Korean phrases — so this only re-slices; no raw
// registry text, evidence refs, paths, or source hash ever crosses.
function auditViewModel(audit) {
  const items = audit.items.slice(0, studioAuditTopItems).map((item) => ({
    projectId: item.projectId,
    projectName: item.projectName,
    businessGroup: item.businessGroup,
    priority: item.priority,
    missingFields: [...item.missingFields],
    actions: item.actions.slice(0, 4),
  }));
  return {
    kind: "audit-v1",
    coverage: {
      hyphenCore: audit.coverage.hyphenCore,
      excluded: audit.coverage.excluded,
      statusUnknown: audit.coverage.statusUnknown,
      evidenceUnverified: audit.coverage.evidenceUnverified,
      ownerMissing: audit.coverage.ownerMissing,
    },
    summary: {
      projectsNeedingReview: audit.summary.projectsNeedingReview,
      pendingEvidence: audit.summary.pendingEvidence,
      byPriority: {
        high: audit.summary.byPriority.high,
        medium: audit.summary.byPriority.medium,
        low: audit.summary.byPriority.low,
      },
    },
    items,
    remaining: Math.max(0, audit.items.length - items.length),
  };
}

// Deterministic read-only evidence audit, generated synchronously in the
// server — never queued for the worker, never needs approval.
async function runStudioEvidenceAudit(request) {
  const now = Date.now();
  const finish = (status, result, briefing = null) => {
    request.status = status;
    request.result = result;
    request.briefing = briefing;
    request.progress = status === "done" ? "읽기 전용 갱신 점검표를 만들었습니다." : "갱신 점검표를 만들지 못했습니다.";
    request.progress_step = status;
    request.completed_at = now;
    request.updated_at = now;
  };
  try {
    const registryLib = await loadBusinessRegistryModule();
    if (!registryLib) {
      finish("failed", studioAuditUnavailableMessage, { view: "evidence_audit", error: "registry_module_missing" });
      addEvent(request, "갱신 점검 생성 실패");
      return;
    }
    const { registry } = await registryLib.loadBusinessRegistry(businessRegistryFile, {
      expectedHash: businessRegistryExpectedHash || undefined,
    });
    const audit = registryLib.buildEvidenceAudit(registry);
    finish("done", renderEvidenceAudit(audit), {
      view: "evidence_audit",
      sourceLabel: studioSourceLabel,
      updatedAt: audit.source.updatedAt,
      itemCount: audit.summary.projectsNeedingReview,
      audit: auditViewModel(audit),
    });
    addEvent(request, "갱신 점검표 생성");
  } catch (error) {
    finish("failed", studioAuditUnavailableMessage, { view: "evidence_audit", error: studioErrorCode(error) });
    addEvent(request, "갱신 점검 생성 실패");
  }
}

// Authenticated read-only audit payload for API consumers. Same registry
// loading and fail-closed posture as businessRegistryStatus: on any load
// failure the response degrades to state unavailable instead of leaking the
// reason. The audit document itself is allowlisted by construction.
async function businessEvidenceAudit() {
  const registryLib = await loadBusinessRegistryModule();
  if (!registryLib) return { state: "unavailable", audit: null };
  try {
    const { registry } = await registryLib.loadBusinessRegistry(businessRegistryFile, {
      expectedHash: businessRegistryExpectedHash || undefined,
    });
    return { state: "ok", audit: registryLib.buildEvidenceAudit(registry) };
  } catch {
    return { state: "unavailable", audit: null };
  }
}

// Read-only traffic-coverage aggregate. totalEligibleRequests counts every
// valid stored request; observedOk/observedError count requests carrying the
// bounded system1_shadow marker (an error marker still counts as observed).
// Only status "ok"/"error" are valid observations — a kind/schema-matching
// record with any other status is ignored entirely. coverageRate = observed /
// totalEligibleRequests. Route/policy/abstained aggregates use status=ok
// records only. The response is a strict count
// allowlist: no request ids, titles, bodies, results, events, timestamps,
// features, or paths, and no external calls.
function summarizeSystem1Shadow(requests) {
  const summary = {
    kind: system1SummaryKind,
    schemaVersion: 1,
    totalEligibleRequests: 0,
    observedOk: 0,
    observedError: 0,
    routes: Object.fromEntries(system1SummaryRoutes.map((route) => [route, 0])),
    policyVerdicts: Object.fromEntries(system1SummaryVerdicts.map((verdict) => [verdict, 0])),
    abstained: 0,
    coverageRate: 0,
  };
  for (const request of Array.isArray(requests) ? requests : []) {
    if (!request || typeof request !== "object" || typeof request.id !== "string") continue;
    summary.totalEligibleRequests += 1;
    const shadow = request.system1_shadow;
    if (!shadow || shadow.kind !== system1ShadowKind || shadow.schemaVersion !== 1) continue;
    if (shadow.status === "error") {
      summary.observedError += 1;
      continue;
    }
    if (shadow.status !== "ok") continue;
    summary.observedOk += 1;
    if (Object.hasOwn(summary.routes, shadow.route)) summary.routes[shadow.route] += 1;
    if (Object.hasOwn(summary.policyVerdicts, shadow.policyVerdict)) summary.policyVerdicts[shadow.policyVerdict] += 1;
    if (shadow.abstained === true) summary.abstained += 1;
  }
  const observed = summary.observedOk + summary.observedError;
  summary.coverageRate =
    summary.totalEligibleRequests > 0 ? Math.round((observed / summary.totalEligibleRequests) * 10000) / 10000 : 0;
  return summary;
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
    if (url.pathname === "/") {
      // Studio handoff prefill: every query value is validated against the
      // registry and type allowlists before it reaches the page; failures fall
      // back to neutral defaults inside a {project, type, prompt}-only object.
      const projects = await readProjects().catch(() => []);
      const prefill = parseHandoffPrefill(url.searchParams, projects);
      return send(res, 200, html.replace("__PREFILL_JSON__", () => serializePrefillForHtml(prefill)));
    }
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
    if (url.pathname === "/api/system1/summary" && req.method === "GET") {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      const store = await readStore();
      return send(res, 200, summarizeSystem1Shadow(store.requests));
    }
    if (url.pathname === "/api/business/status" && req.method === "GET") {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      return send(res, 200, await businessRegistryStatus());
    }
    if (url.pathname === "/api/business/audit" && req.method === "GET") {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      return send(res, 200, await businessEvidenceAudit());
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
      if (studioBriefingTypes.has(type)) {
        await runStudioBriefing(request);
      } else if (studioAuditTypes.has(type)) {
        await runStudioEvidenceAudit(request);
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
      const retried = await mutateStore(async (store) => {
        const item = store.requests.find(
          (request) => request.id === retryMatch[1] && ["failed", "canceled"].includes(request.status),
        );
        if (!item) return false;
        if (studioBriefingTypes.has(item.type)) {
          // Studio briefings regenerate synchronously in the server — they are
          // never queued for the worker.
          addEvent(item, "브리핑 재생성");
          await runStudioBriefing(item);
          return true;
        }
        if (studioAuditTypes.has(item.type)) {
          // Evidence audits regenerate synchronously in the server too —
          // same read-only, no-worker contract as briefings.
          addEvent(item, "갱신 점검 재생성");
          await runStudioEvidenceAudit(item);
          return true;
        }
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
        // Studio briefings are generated in-server and must never reach a
        // worker — exclude them explicitly even if a stale/corrupted record
        // ever carries status "queued".
        const next = store.requests
          .filter((request) => request.status === "queued" && !studioBriefingTypes.has(request.type))
          .sort((a, b) => a.created_at - b.created_at)[0];
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
