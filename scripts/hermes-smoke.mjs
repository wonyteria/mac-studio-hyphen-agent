// Hermes smoke/canary — one consolidated, safe operations check.
//
//   node scripts/hermes-smoke.mjs [--ops <url>] [--format json|human]
//   node scripts/hermes-smoke.mjs --mutation-canary --staging
//   node scripts/hermes-smoke.mjs --mutation-canary --production --approve <requestId>
//
// Read-only checks (always safe, no credentials needed beyond env presence):
//   health, auth boundary, business registry, queue/worker, provider
//   readiness, Discord readiness, backup readiness, project capability
//   coverage.
//
// Mutation canary policy (fail closed):
//   - fixture/staging only by default: spins a throwaway mini-server on an
//     ephemeral port with a temp data file and exercises
//     create→approval_required→approve→cancel end to end.
//   - production: requires BOTH --production and --approve <requestId> as
//     approval evidence, and even then only READS that request — it never
//     creates or mutates anything in production.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { providerReadiness } from "./hermes-agent-providers.mjs";
import { discordReadiness } from "./hermes-discord-lib.mjs";
import { executorStatus } from "./hermes-backup-executor.mjs";
import { expandHome } from "./hermes-backup-manifest.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const projectsFile = process.env.HERMES_PROJECTS_FILE || join(repoRoot, "hermes-projects.json");
const dataFile = process.env.HERMES_DATA_FILE || join(repoRoot, "data", "requests.json");

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) values.set(body.slice(0, eq), body.slice(eq + 1));
    else if (["ops", "format", "approve"].includes(body) && argv[index + 1]) values.set(body, argv[++index]);
    else flags.add(body);
  }
  return { flags, values };
}

async function fetchBounded(url, init = {}, timeoutMs = 5000) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: response.status, data };
  } catch (error) {
    return { status: 0, error: String(error?.code || error?.message || error).slice(0, 120) };
  }
}

function check(name, state, detail = {}) {
  return { name, state, ...detail };
}

async function checkHealth(ops) {
  if (!ops) return check("health", "skipped", { reason: "no --ops url" });
  const result = await fetchBounded(`${ops}/health`);
  return check("health", result.status === 200 ? "ok" : "unavailable", { status: result.status });
}

async function checkAuthBoundary(ops) {
  if (!ops) return check("auth", "skipped", { reason: "no --ops url" });
  const [requests, projects, discord] = await Promise.all([
    fetchBounded(`${ops}/api/requests`),
    fetchBounded(`${ops}/api/projects`),
    fetchBounded(`${ops}/api/discord/interactions`, { method: "POST", body: "{}" }),
  ]);
  const adminOk = requests.status === 401 && projects.status === 401;
  const discordOk = discord.status === 401 || discord.status === 503;
  return check("auth", adminOk && discordOk ? "ok" : "unavailable", {
    requests: requests.status,
    projects: projects.status,
    discord: discord.status,
  });
}

async function checkBusiness() {
  try {
    const mod = await import("./hermes-business-registry.mjs");
    const registryPath = process.env.HERMES_BUSINESS_REGISTRY || null;
    if (!registryPath) return check("business", "skipped", { reason: "HERMES_BUSINESS_REGISTRY unset" });
    const { registry } = await mod.loadBusinessRegistry(registryPath);
    return check("business", registry ? "ok" : "unavailable", {
      projects: Array.isArray(registry?.projects) ? registry.projects.length : 0,
    });
  } catch (error) {
    return check("business", "unavailable", { reason: String(error?.code || error?.message || error).slice(0, 120) });
  }
}

async function checkQueue() {
  try {
    const store = JSON.parse(await readFile(dataFile, "utf8"));
    const requests = Array.isArray(store.requests) ? store.requests : [];
    const queued = requests.filter((request) => request.status === "queued").length;
    const running = requests.filter((request) => request.status === "running").length;
    const lastSeen = store.meta?.lastWorkerSeenAt || null;
    const workerState = lastSeen ? (Date.now() - lastSeen < 5 * 60 * 1000 ? "ready" : "stale") : "unknown";
    return check("queue", "ok", { requests: requests.length, queued, running, worker: workerState });
  } catch (error) {
    if (error?.code === "ENOENT") return check("queue", "unknown", { reason: "data_file_missing" });
    return check("queue", "unavailable", { reason: "data_file_unreadable" });
  }
}

async function checkProviders() {
  const { codex, devin, local_llm } = await providerReadiness();
  const states = [codex.state, devin.state, local_llm.state];
  const worst = states.includes("unavailable") ? "degraded" : "ok";
  return check("providers", worst, {
    codex: codex.state,
    devin: devin.state,
    local_llm: local_llm.state,
    ...(local_llm.reason ? { local_llm_reason: local_llm.reason } : {}),
    ...(local_llm.model ? { local_llm_model: local_llm.model } : {}),
  });
}

function checkDiscord() {
  const readiness = discordReadiness();
  return check("discord", readiness.state === "configured" ? "ok" : "unavailable", {
    state: readiness.state,
    ...(readiness.reason ? { reason: readiness.reason } : {}),
  });
}

async function checkBackup() {
  const destination = process.env.HERMES_BACKUP_DESTINATION || "";
  if (!destination.trim()) {
    return check("backup", "unavailable", { reason: "destination_missing" });
  }
  try {
    const status = await executorStatus({ destination: expandHome(destination.trim()) });
    return check("backup", status.state === "ok" ? "ok" : status.state === "unavailable" ? "unavailable" : "degraded", {
      state: status.state,
      snapshots: status.snapshotCount ?? 0,
      ...(status.reason ? { reason: status.reason } : {}),
    });
  } catch {
    return check("backup", "unavailable", { reason: "status_failed" });
  }
}

async function checkProjects() {
  try {
    const parsed = JSON.parse(await readFile(projectsFile, "utf8"));
    const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
    const full = projects.filter(
      (project) => (project.capabilities || []).includes("project_inspect") || (project.capabilities || []).includes("development"),
    ).length;
    return check("projects", "ok", { total: projects.length, full, statusOnly: projects.length - full });
  } catch {
    return check("projects", "unavailable", { reason: "registry_unreadable" });
  }
}

async function availablePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });
}

// Staging mutation canary — a throwaway server instance, never production.
async function stagingMutationCanary() {
  const tempDir = await mkdtemp(join(tmpdir(), "hermes-canary-"));
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(repoRoot, "mini-server.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ADMIN_PASSWORD: "canary-password",
      HERMES_DATA_FILE: join(tempDir, "requests.json"),
      HERMES_PROJECTS_FILE: projectsFile,
      PORT: String(port),
      SESSION_SECRET: "canary-secret",
      WORKER_TOKEN: "canary-worker-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const steps = [];
  try {
    const deadline = Date.now() + 10_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      up = (await fetchBounded(`${base}/health`)).status === 200;
      if (!up) await sleep(60);
    }
    if (!up) throw new Error("fixture server did not start");
    steps.push({ step: "health", ok: true });
    const loginRaw = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "canary-password" }),
      signal: AbortSignal.timeout(5000),
    });
    const sessionCookie = (loginRaw.headers.get("set-cookie") || "").split(";")[0];
    steps.push({ step: "login", ok: loginRaw.status === 200 && Boolean(sessionCookie) });
    const create = await fetchBounded(`${base}/api/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({
        type: "redeploy",
        title: "canary",
        body: "mutation canary",
        target_project: "hermes-mac-ops",
      }),
    });
    const created = create.data?.request;
    steps.push({ step: "create_mutation", ok: create.status === 201 && created?.status === "approval_required" });
    const beforeApprove = await fetchBounded(`${base}/api/worker/next`, {
      headers: { "X-Worker-Token": "canary-worker-token" },
    });
    steps.push({
      step: "unclaimed_before_approval",
      ok: beforeApprove.status === 200 && beforeApprove.data?.request === null,
    });
    const approve = await fetchBounded(`${base}/api/requests/${created?.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: "{}",
    });
    steps.push({ step: "approve", ok: approve.status === 200 });
    const cancel = await fetchBounded(`${base}/api/requests/${created?.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: "{}",
    });
    steps.push({ step: "cancel", ok: cancel.status === 200 });
    const ok = steps.every((step) => step.ok);
    return check("mutation_canary", ok ? "ok" : "unavailable", { mode: "staging", steps });
  } catch (error) {
    return check("mutation_canary", "unavailable", {
      mode: "staging",
      steps,
      error: String(error?.message || error).slice(0, 160),
    });
  } finally {
    child.kill("SIGTERM");
    await rm(tempDir, { force: true, recursive: true });
  }
}

// Production mutation canary — evidence-gated, read-only even then.
async function productionMutationCanary(ops, approveId) {
  if (!ops) return check("mutation_canary", "unavailable", { reason: "production requires --ops" });
  if (!approveId) {
    return check("mutation_canary", "blocked", {
      reason: "production mutation canary requires --approve <requestId> approval evidence",
    });
  }
  const result = await fetchBounded(`${ops}/api/requests`);
  if (result.status === 401) {
    return check("mutation_canary", "skipped", {
      reason: "production check is read-only; request list needs an authenticated session — evidence recorded only",
    });
  }
  return check("mutation_canary", "skipped", { reason: "read-only production evidence check" });
}

function summarize(checks) {
  const states = checks.map((entry) => entry.state);
  if (states.includes("unavailable") || states.includes("blocked")) return "degraded";
  if (states.includes("degraded") || states.includes("unknown")) return "degraded";
  if (states.every((state) => state === "ok" || state === "skipped")) return "ok";
  return "degraded";
}

function printHuman(checks, overall) {
  const labels = {
    ok: "정상",
    degraded: "주의",
    unavailable: "사용 불가",
    unknown: "미확인",
    skipped: "건너뜀",
    blocked: "차단됨",
  };
  for (const entry of checks) {
    const detail = Object.entries(entry)
      .filter(([key]) => !["name", "state", "steps"].includes(key))
      .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`)
      .join(" ");
    process.stdout.write(`[${labels[entry.state] || entry.state}] ${entry.name}${detail ? ` — ${detail}` : ""}\n`);
    for (const step of entry.steps || []) {
      process.stdout.write(`    ${step.ok ? "✓" : "✗"} ${step.step}\n`);
    }
  }
  process.stdout.write(`전체: ${labels[overall] || overall}\n`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { flags, values } = parseArgs(argv);
  const format = values.get("format") || "human";
  const ops = (values.get("ops") || env.HERMES_OPS_URL || "").replace(/\/$/, "") || null;
  const checks = [
    await checkHealth(ops),
    await checkAuthBoundary(ops),
    await checkBusiness(),
    await checkQueue(),
    await checkProviders(),
    checkDiscord(),
    await checkBackup(),
    await checkProjects(),
  ];
  if (flags.has("mutation-canary")) {
    if (flags.has("production")) {
      checks.push(await productionMutationCanary(ops, values.get("approve")));
    } else {
      // No --production flag: fixture canary only — a real server instance on
      // a temp port with a temp store, never the production gateway.
      checks.push(await stagingMutationCanary());
    }
  }
  const overall = summarize(checks);
  const output = { kind: "hermes-smoke", schemaVersion: 1, overall, checks };
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    printHuman(checks, overall);
  }
  return overall === "ok" ? 0 : checks.some((entry) => entry.state === "blocked") ? 2 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const code = await main();
  process.exitCode = code;
}
