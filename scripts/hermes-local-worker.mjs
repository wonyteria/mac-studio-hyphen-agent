#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const siteUrl = process.env.HERMES_OPS_URL;
const token = process.env.HERMES_WORKER_TOKEN;
const siteBypassToken = process.env.HERMES_SITE_BYPASS_TOKEN;
const runtimeRoot =
  process.env.HERMES_RUNTIME_DIR || join(homedir(), ".local", "share", "hermes-ops");
const codexQueue = process.env.CODEX_REQUEST_DIR || join(runtimeRoot, "requests");
const projectRegistryPath =
  process.env.HERMES_PROJECT_REGISTRY || join(runtimeRoot, "hermes-projects.json");
const lockRoot = process.env.HERMES_PROJECT_LOCK_DIR || join(runtimeRoot, "locks");
const worktreeRoot = process.env.HERMES_WORKTREE_DIR || join(runtimeRoot, "worktrees");
const miniVercelUrl = process.env.MINI_VERCEL_URL || "http://127.0.0.1:8765";
const miniVercelAppSupport = join(
  homedir(),
  "Library",
  "Application Support",
  "Hyphen",
  "mini-vercel",
);
const miniVercelEnvPath =
  process.env.MINI_VERCEL_ENV_PATH || join(miniVercelAppSupport, "app", ".env");
const miniVercelWorkspaceRoot =
  process.env.MINI_VERCEL_WORKSPACE_ROOT || join(miniVercelAppSupport, "runner-workspaces");
const persistenceBackupRoot =
  process.env.HERMES_PERSISTENCE_BACKUP_DIR || join(runtimeRoot, "persistence");
const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
// Default local model for routine low-risk chat/routing — must match a real
// `ollama list` entry on the Mac Studio (local-small/local-large/local-long).
const localModel = process.env.HERMES_LOCAL_MODEL || "local-small:latest";
const nodeCurrentBin = join(homedir(), ".local", "node-current", "bin");
const workerPath = [
  nodeCurrentBin,
  join(homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  process.env.PATH || "",
]
  .filter(Boolean)
  .join(":");
const commandPaths = {
  codex: process.env.CODEX_BIN || join(nodeCurrentBin, "codex"),
  df: "/bin/df",
  docker: process.env.DOCKER_BIN || "/usr/local/bin/docker",
  du: "/usr/bin/du",
  git: process.env.GIT_BIN || "/usr/bin/git",
  memoryPressure: "/usr/bin/memory_pressure",
  ollama: process.env.OLLAMA_BIN || "/opt/homebrew/bin/ollama",
  ps: "/bin/ps",
  shell: "/bin/zsh",
  sysctl: "/usr/sbin/sysctl",
  uptime: "/usr/bin/uptime",
  vmStat: "/usr/bin/vm_stat",
};

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

// Every spawned child gets a scrubbed environment: a launchd child inherits
// its LaunchAgent's EnvironmentVariables, so an inherited credential such as
// MINI_VERCEL_GITHUB_TOKEN would otherwise leak into git/codex/verify
// subprocesses. The worker process itself reads the few secrets it needs for
// its own API headers — children never need them. `extraAllow` re-adds a
// named variable for a specific call site only.
const INHERITED_SECRET_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|(^|_)KEY$|API_KEY|PRIVATE)/i;
export function childEnvironment(extraAllow = []) {
  const environment = { ...process.env, PATH: workerPath };
  const allowed = new Set(extraAllow);
  for (const key of Object.keys(environment)) {
    if (!allowed.has(key) && INHERITED_SECRET_PATTERN.test(key)) delete environment[key];
  }
  return environment;
}

async function api(path, init = {}) {
  if (!siteUrl || !token) throw new Error("HERMES_OPS_URL 또는 HERMES_WORKER_TOKEN이 없습니다.");
  const response = await fetch(new URL(path, siteUrl), {
    ...init,
    headers: {
      ...(siteBypassToken ? { Authorization: `Bearer ${siteBypassToken}` } : {}),
      "X-Worker-Token": token,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  return data;
}

export function runCommand(command, args = [], options = {}) {
  const {
    cwd,
    env = childEnvironment(),
    maxOutputBytes = 2 * 1024 * 1024,
    onStderr,
    onStdout,
    timeoutMs = 2 * 60 * 1000,
  } = options;
  return new Promise((resolvePromise) => {
    const executable = commandPaths[command] || command;
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const append = (current, chunk) => {
      const next = current + chunk;
      return next.length > maxOutputBytes ? next.slice(-maxOutputBytes) : next;
    };
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout = append(stdout, text);
      onStdout?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = append(stderr, text);
      onStderr?.(text);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    child.on("error", (error) => {
      finish({
        code: 127,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
        timedOut,
      });
    });
    child.on("close", (code, signal) => {
      finish({ code: code ?? 1, signal, stdout, stderr, timedOut });
    });
  });
}

async function command(commandName, args, options = {}) {
  const result = await runCommand(commandName, args, options);
  if (result.code !== 0) {
    const detail = trimOutput(result.stderr || result.stdout || "출력 없음", 8000);
    const timeout = result.timedOut ? " (시간 제한 초과)" : "";
    throw new Error(`${commandName} 실행 실패${timeout}: ${detail}`);
  }
  return result;
}

async function loadProjects() {
  const raw = await readFile(projectRegistryPath, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.projects) ? parsed.projects : [];
}

function projectSupports(project, capability) {
  return !capability || (Array.isArray(project.capabilities) && project.capabilities.includes(capability));
}

async function getProject(id = "hermes-mac-ops", capability = null) {
  const projects = await loadProjects();
  const project = projects.find((item) => item.id === id);
  if (!project) throw new Error(`허용되지 않은 프로젝트입니다: ${id}`);
  if (!project.miniVercelProjectId) {
    throw new Error(`프로젝트 레지스트리 설정이 불완전합니다: ${id}`);
  }
  if (!projectSupports(project, capability)) {
    throw new Error(`${project.name}에는 ${capability} 권한이 활성화되어 있지 않습니다.`);
  }
  if (["project_inspect", "development"].includes(capability) && (!project.repo || !project.branch || !project.gitRemote)) {
    throw new Error(`${project.name}의 로컬 저장소 연결이 불완전합니다.`);
  }
  return project;
}

async function miniVercelToken() {
  if (process.env.MINI_VERCEL_ADMIN_TOKEN) return process.env.MINI_VERCEL_ADMIN_TOKEN;
  const raw = await readFile(miniVercelEnvPath, "utf8");
  const line = raw.split(/\r?\n/).find((item) => item.startsWith("MINI_VERCEL_ADMIN_TOKEN="));
  const value = line?.split("=").slice(1).join("=").trim();
  if (!value) throw new Error("MINI_VERCEL_ADMIN_TOKEN을 찾지 못했습니다.");
  return value;
}

async function miniVercelApi(path, init = {}) {
  const adminToken = await miniVercelToken();
  const response = await fetch(new URL(path, miniVercelUrl), {
    ...init,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  return data;
}

export function trimOutput(value, limit = 6000) {
  const text = String(value || "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... ${text.length - limit}자 생략`;
}

function parseNullList(value) {
  return String(value || "")
    .split("\0")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isProtectedPath(path) {
  const normalized = String(path || "").replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  return segments.some(
    (name) => {
      const safeEnvTemplate = [".env.example", ".env.sample", ".env.template"].includes(name);
      return (
        name === ".git" ||
        name === ".ssh" ||
        name === ".dev.vars" ||
        name === "auth.json" ||
        name === ".env" ||
        (name.startsWith(".env.") && !safeEnvTemplate) ||
        /\.(key|pem|p12|pfx)$/.test(name) ||
        /(^|[-_.])(secrets?|credentials?)([-_.]|$)/.test(name)
      );
    },
  );
}

export function isSafePersistentPath(path) {
  const normalized = String(path || "").trim().replaceAll("\\", "/");
  if (!normalized || isAbsolute(normalized) || normalized.includes("\0")) return false;
  return normalized.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function deploymentWorkspacePath(deploymentId, relativePath) {
  if (!/^deployment_[a-zA-Z0-9]+$/.test(String(deploymentId || ""))) {
    throw new Error(`유효하지 않은 mini deploy 배포 ID입니다: ${deploymentId}`);
  }
  if (!isSafePersistentPath(relativePath)) {
    throw new Error(`유효하지 않은 영속 파일 경로입니다: ${relativePath}`);
  }
  const workspace = resolve(miniVercelWorkspaceRoot, deploymentId);
  const target = resolve(workspace, relativePath);
  if (!target.startsWith(`${workspace}${sep}`)) {
    throw new Error(`배포 작업공간 밖 경로가 감지되었습니다: ${relativePath}`);
  }
  return target;
}

function assertProjectPath(repo, path) {
  const root = resolve(repo);
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error(`프로젝트 밖 경로가 감지되었습니다: ${path}`);
  }
  if (isProtectedPath(path)) throw new Error(`보호 파일 변경이 감지되었습니다: ${path}`);
}

async function git(project, args, options = {}) {
  return command("git", ["-C", project.repo, ...args], options);
}

function sanitizedTitle(value, limit = 68) {
  return String(value || "Hermes request")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

async function acquireProjectLock(project, request) {
  await mkdir(lockRoot, { recursive: true });
  const lockPath = join(lockRoot, project.id);
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < 2 * 60 * 60 * 1000) {
      throw new Error(`다른 요청이 ${project.name}을 수정 중입니다.`);
    }
    await rm(lockPath, { force: true, recursive: true });
    await mkdir(lockPath);
  }
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({ requestId: request.id, acquiredAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
  return async () => rm(lockPath, { force: true, recursive: true });
}

function createProgressReporter(request) {
  let progress = "요청을 준비하고 있습니다.";
  let step = "starting";
  let workerLog = "";
  let pending = Promise.resolve();
  let leaseError = null;
  let heartbeatPaused = false;
  const sendHeartbeat = async (strict = false, leaseExtensionMs = 0) => {
    if (heartbeatPaused) return;
    const operation = pending.then(() =>
      api("/api/worker/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          id: request.id,
          claimToken: request.claim_token,
          progress,
          step,
          workerLog: trimOutput(workerLog, 10000),
          ...(leaseExtensionMs ? { leaseExtensionMs } : {}),
        }),
      }),
    );
    pending = operation.catch(() => {});
    try {
      await operation;
      leaseError = null;
    } catch (error) {
      if (String(error?.message || error).startsWith("409 ")) leaseError = error;
      console.error(`Heartbeat failed: ${error.message}`);
      if (strict) throw error;
    }
  };
  const timer = setInterval(() => void sendHeartbeat(false), 20_000);
  return {
    async assertLease() {
      if (leaseError) throw new Error(`요청 임대를 잃었습니다: ${leaseError.message}`);
      await sendHeartbeat(true);
    },
    async close() {
      clearInterval(timer);
      await pending;
    },
    appendLog(value) {
      workerLog = `${workerLog}\n${String(value || "")}`.slice(-12000);
    },
    async extendLease(milliseconds) {
      await sendHeartbeat(true, milliseconds);
    },
    pauseHeartbeat() {
      heartbeatPaused = true;
    },
    resumeHeartbeat() {
      heartbeatPaused = false;
    },
    async update(nextStep, message) {
      step = nextStep;
      progress = message;
      await sendHeartbeat(true);
    },
  };
}

function pageSizeFromVmStat(value) {
  const match = String(value).match(/page size of (\d+) bytes/);
  return Number(match?.[1] || 4096);
}

function vmPages(value, label) {
  const match = String(value).match(new RegExp(`^${label}:\\s+([0-9.]+)`, "m"));
  return Number(String(match?.[1] || "0").replaceAll(".", ""));
}

function gibibytes(value) {
  return `${(Number(value || 0) / 1024 ** 3).toFixed(1)} GB`;
}

async function macStatus() {
  const [total, pressure, vm, disk, uptime, processes, containers] = await Promise.all([
    runCommand("sysctl", ["-n", "hw.memsize"]),
    runCommand("memoryPressure", ["-Q"]),
    runCommand("vmStat", []),
    runCommand("df", ["-h", "/"]),
    runCommand("uptime", []),
    runCommand("ps", ["-axo", "pid,rss,%cpu,etime,comm", "-r"]),
    runCommand("docker", ["ps", "--format", "{{.Names}} | {{.Status}} | {{.Ports}}"]),
  ]);
  const pageSize = pageSizeFromVmStat(vm.stdout);
  const active = vmPages(vm.stdout, "Pages active") * pageSize;
  const wired = vmPages(vm.stdout, "Pages wired down") * pageSize;
  const compressed = vmPages(vm.stdout, "Pages occupied by compressor") * pageSize;
  const topProcesses = processes.stdout.split(/\r?\n/).slice(0, 9).join("\n");
  return [
    "Mac Studio 상태",
    `업타임: ${trimOutput(uptime.stdout)}`,
    `총 메모리: ${gibibytes(Number(total.stdout.trim()))}`,
    `활성/유선/압축 메모리: ${gibibytes(active)} / ${gibibytes(wired)} / ${gibibytes(compressed)}`,
    `메모리 여유: ${trimOutput(pressure.stdout || pressure.stderr || "확인 불가")}`,
    "",
    "시스템 디스크",
    trimOutput(disk.stdout || disk.stderr || "확인 불가"),
    "",
    "상위 프로세스",
    trimOutput(topProcesses || processes.stderr || "확인 불가"),
    "",
    "실행 컨테이너",
    trimOutput(containers.stdout || containers.stderr || "없음"),
  ].join("\n");
}

async function projectInspect(request) {
  const project = await getProject(request.target_project, "project_inspect");
  const [statusResult, log, docker] = await Promise.all([
    runCommand("git", ["-C", project.repo, "status", "--short", "--branch"]),
    runCommand("git", ["-C", project.repo, "log", "--oneline", "-5"]),
    runCommand("docker", [
      "ps",
      "--filter",
      `label=mini-vercel.project=${project.miniVercelProjectId}`,
      "--format",
      "{{.Names}} {{.Status}} {{.Ports}}",
    ]),
  ]);
  return [
    `프로젝트: ${project.name}`,
    `도메인: ${project.domain}`,
    `로컬 경로: ${project.repo}`,
    "",
    "Git 상태",
    trimOutput(statusResult.stdout || statusResult.stderr || "출력 없음"),
    "",
    "최근 커밋",
    trimOutput(log.stdout || log.stderr || "출력 없음"),
    "",
    "실행 컨테이너",
    trimOutput(docker.stdout || docker.stderr || "없음"),
  ].join("\n");
}

async function deploymentStatus(request) {
  const project = await getProject(request.target_project, "deployment_status");
  const deployment = await miniVercelApi(`/api/deployments/${project.miniVercelProjectId}`);
  const current = deployment.deployment || deployment;
  const docker = await runCommand("docker", [
    "ps",
    "--filter",
    `label=mini-vercel.project=${project.miniVercelProjectId}`,
    "--format",
    "{{.Names}} {{.Status}} {{.Ports}}",
  ]);
  return [
    `배포: ${project.name}`,
    `도메인: ${project.domain}`,
    `상태: ${current.status || "unknown"}`,
    `릴리즈: ${current.release_id || current.deployment_id || "unknown"}`,
    `Job: ${current.job_id || "unknown"}`,
    "",
    "컨테이너",
    trimOutput(docker.stdout || docker.stderr || "없음"),
  ].join("\n");
}

function miniJobStatus(data) {
  const job = data.job || data;
  return { job, status: String(job.status || "unknown").toLowerCase() };
}

async function waitForMiniJob(jobId, appendLog) {
  const deadline = Date.now() + 25 * 60 * 1000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const data = await miniVercelApi(`/api/jobs/${jobId}`);
    const { job, status } = miniJobStatus(data);
    if (status !== lastStatus) {
      lastStatus = status;
      appendLog?.(`mini deploy 작업 상태: ${status}`);
    }
    if (["succeeded", "success", "done", "completed"].includes(status)) return job;
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      throw new Error(`mini deploy 실패: ${job.error || job.last_error || JSON.stringify(job)}`);
    }
    await sleep(3000);
  }
  throw new Error(`mini deploy 시간 제한 초과: ${jobId}`);
}

function deploymentIdFrom(value) {
  const deployment = value?.deployment || value || {};
  return deployment.deployment_id || deployment.active_deployment_id || deployment.latest_deployment_id;
}

async function currentDeployment(project) {
  return miniVercelApi(`/api/deployments/${project.miniVercelProjectId}`);
}

async function snapshotPersistentFiles(project, deploymentId, requestId) {
  const snapshots = [];
  for (const relativePath of project.persistentFiles || []) {
    const source = deploymentWorkspacePath(deploymentId, relativePath);
    try {
      snapshots.push({ relativePath, contents: await readFile(source) });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (snapshots.length) {
    const backupDir = resolve(persistenceBackupRoot, project.id, requestId);
    await mkdir(backupDir, { recursive: true });
    for (const snapshot of snapshots) {
      const target = resolve(backupDir, snapshot.relativePath);
      if (!target.startsWith(`${backupDir}${sep}`)) {
        throw new Error(`영속 파일 백업 경로가 잘못되었습니다: ${snapshot.relativePath}`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, snapshot.contents);
    }
  }
  return snapshots;
}

async function restorePersistentFiles(deploymentId, snapshots) {
  for (const snapshot of snapshots) {
    const target = deploymentWorkspacePath(deploymentId, snapshot.relativePath);
    const temporary = `${target}.hermes-${process.pid}-${Date.now()}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temporary, snapshot.contents);
    await rename(temporary, target);
  }
}

async function waitForActiveDeployment(project, previousDeploymentId, job) {
  const jobDeploymentId = deploymentIdFrom(job);
  if (jobDeploymentId && jobDeploymentId !== previousDeploymentId) return jobDeploymentId;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = await currentDeployment(project);
    const deploymentId = deploymentIdFrom(current);
    if (deploymentId && deploymentId !== previousDeploymentId) return deploymentId;
    await sleep(1000);
  }
  throw new Error("재배포 후 활성 deployment ID가 바뀌지 않았습니다.");
}

async function verifyHealth(project) {
  if (!project.domain) return "도메인 미설정: mini deploy 작업 상태로 검증";
  const healthUrl = new URL(project.healthPath || "/health", project.domain).toString();
  let lastError = "응답 없음";
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const response = await fetch(healthUrl, { redirect: "follow" });
      if (response.ok) return healthUrl;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(3000);
  }
  throw new Error(`배포 헬스체크 실패: ${lastError}`);
}

async function redeployProject(request, reporter) {
  const project = await getProject(request.target_project, "redeploy");
  await reporter.update("deploy_start", `${project.name} 재배포를 시작합니다.`);
  await reporter.assertLease();
  const previousDeployment = await currentDeployment(project);
  const previousDeploymentId = deploymentIdFrom(previousDeployment);
  if (!previousDeploymentId) throw new Error("현재 mini deploy 배포 ID를 찾지 못했습니다.");
  const snapshots = await snapshotPersistentFiles(project, previousDeploymentId, request.id);
  let job;
  let jobId;
  await reporter.extendLease(30 * 60 * 1000);
  reporter.pauseHeartbeat();
  try {
    const response = await miniVercelApi(`/api/deployments/${project.miniVercelProjectId}/redeploy`, {
      method: "POST",
      headers: { "Idempotency-Key": `hermes-${request.id}` },
      body: JSON.stringify({ github_token: "", remember_github_token: false }),
    });
    jobId = response.job_id || response.id;
    if (!jobId) {
      throw new Error(`mini deploy가 Job ID를 반환하지 않았습니다: ${JSON.stringify(response)}`);
    }
    job = await waitForMiniJob(jobId, reporter.appendLog);
    const activeDeploymentId = await waitForActiveDeployment(project, previousDeploymentId, job);
    await restorePersistentFiles(activeDeploymentId, snapshots);
  } finally {
    reporter.resumeHeartbeat();
  }
  await reporter.update("healthcheck", `${project.domain} 헬스체크 중입니다.`);
  const healthUrl = await verifyHealth(project);
  return [
    `재배포 완료: ${project.name}`,
    `도메인: ${project.domain}`,
    `Job: ${jobId}`,
    `릴리즈: ${job.release_id || job.deployment_id || "완료"}`,
    `헬스체크: ${healthUrl}`,
  ].join("\n");
}

async function createCodexRequestArtifact(request, project) {
  await mkdir(codexQueue, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeTitle = basename(request.title)
    .replace(/[^a-zA-Z0-9가-힣_-]+/g, "-")
    .slice(0, 60);
  const path = join(codexQueue, `${stamp}-${safeTitle || "request"}.md`);
  const text = `# Hermes Development Request

## Title
${request.title}

## Request
${request.body}

## Execution
- Site request id: ${request.id}
- Target project: ${project.id}
- Repository: ${project.repo}
- Branch: ${project.branch}
- Created by Hermes Mac Ops
`;
  await writeFile(path, text, "utf8");
  return path;
}

export function parseCodexOutput(value) {
  const messages = [];
  let threadId = null;
  let usage = null;
  for (const line of String(value || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started") threadId = event.thread_id || null;
      if (event.type === "turn.completed") usage = event.usage || null;
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
        messages.push(event.item.text);
      }
      if (event.type === "turn.failed" || event.type === "error") {
        messages.push(event.error?.message || event.message || "Codex 실행 오류");
      }
    } catch {
      // Ignore non-JSON diagnostics from older CLI builds.
    }
  }
  return { finalMessage: messages.at(-1) || "", threadId, usage };
}

async function collectChangedFiles(project, baseline) {
  const [tracked, untracked] = await Promise.all([
    git(project, ["diff", "--name-only", "-z", baseline]),
    git(project, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const files = [...new Set([...parseNullList(tracked.stdout), ...parseNullList(untracked.stdout)])];
  if (files.length > 80) throw new Error(`변경 파일이 너무 많습니다: ${files.length}개`);
  for (const file of files) assertProjectPath(project.repo, file);
  return files;
}

function agentPrompt(request, project) {
  const verification =
    (project.verifyCommands || []).map((item) => `- ${item}`).join("\n") ||
    "- 저장소의 기존 검증 명령";
  return `당신은 Hermes Mac Ops의 승인된 개발 실행자다.

프로젝트: ${project.name}
요청 제목: ${request.title}
사용자 요청:
${request.body}

반드시 지킬 경계:
- 현재 저장소 안에서만 필요한 파일을 최소 범위로 수정한다.
- .env, .dev.vars, 키, 토큰, 인증 파일을 읽거나 수정하거나 출력하지 않는다.
- git commit, git push, 배포, 원격 서비스 변경은 하지 않는다. 후속 파이프라인이 담당한다.
- 사용자의 요청과 무관한 기존 변경을 되돌리지 않는다.
- 구현 뒤 아래 검증을 가능한 범위에서 실행한다.
${verification}
- 마지막 답변은 변경 파일, 검증 결과, 남은 위험을 한국어로 간결하게 보고한다.
`;
}

const codexPrompt = agentPrompt;

// --- Devin provider adapter (official v3 API only, no UI scraping) ---
// Service user API key (cog_ prefix) + organization id, per
// docs.devin.ai/api-reference. The worker holds the credential in env only.

const devinApiUrl = process.env.DEVIN_API_URL || "https://api.devin.ai";
const devinOrgId = process.env.DEVIN_ORG_ID || "";
const devinBranchPrefix = "hermes/devin-";

async function devinApi(path, init = {}) {
  const key = process.env.DEVIN_API_KEY;
  if (!key || !devinOrgId) {
    throw new Error("Devin 실행자가 설정되지 않았습니다 (DEVIN_API_KEY/DEVIN_ORG_ID 미설정).");
  }
  const response = await fetch(new URL(path, devinApiUrl), {
    method: init.method || "GET",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`Devin API 오류: ${response.status}`);
  return data;
}

function devinPrompt(request, project, branch) {
  return `${agentPrompt(request, project)}
추가 Devin 실행 계약:
- 저장소 ${project.github}의 ${project.branch} 브랜치를 기준으로 작업한다.
- 작업 결과를 origin 리모트의 '${branch}' 브랜치로 푸시한다.
- PR을 열지 않는다. 커밋 메시지와 브랜치 푸시 외의 원격 변경은 하지 않는다.
- 완료하면 변경 파일 목록과 검증 결과를 한국어로 요약 보고한다.
`;
}

function devinRepoName(github) {
  const match = String(github || "").match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

export function parseDevinSession(payload) {
  const structured = payload?.structured_output;
  return {
    id: String(payload?.session_id || ""),
    url: String(payload?.url || ""),
    status: String(payload?.status || "").toLowerCase(),
    statusDetail: String(payload?.status_detail || "").toLowerCase(),
    detail: String(structured?.result || "").slice(0, 4000),
    pullRequests: Array.isArray(payload?.pull_requests)
      ? payload.pull_requests.map((pr) => String(pr?.pr_url || pr?.url || "")).filter(Boolean).slice(0, 8)
      : [],
  };
}

const devinFailedDetails = new Set([
  "usage_limit_exceeded",
  "out_of_credits",
  "out_of_quota",
  "no_quota_allocation",
  "payment_declined",
  "org_usage_limit_exceeded",
  "user_usage_limit_exceeded",
  "total_session_limit_exceeded",
  "error",
]);

// Fail-closed v3 terminal mapping: 'exit' is success only with
// status_detail 'finished'; waiting_for_approval can never be satisfied by
// the worker (that approval is an operator decision); quota/billing details
// fail honestly; unknown enums keep polling under the deadline.
function devinTerminalStatus(session) {
  const { status, statusDetail } = session;
  if (status === "exit") return statusDetail === "finished" ? "finished" : "failed";
  if (status === "error" || status === "suspended") return "failed";
  if (devinFailedDetails.has(statusDetail)) return "failed";
  if (statusDetail === "waiting_for_approval") return "failed";
  if (status === "running" && statusDetail === "waiting_for_user") return "waiting";
  if (["new", "claimed", "running", "resuming"].includes(status)) return "running";
  return "running";
}

function devinLastAgentMessage(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
  const agentMessages = items.filter((item) => /devin|agent|assistant/i.test(String(item?.role || item?.type || "")));
  const last = agentMessages.at(-1) || items.at(-1);
  return String(last?.message || last?.content || last?.text || "").slice(0, 4000);
}

// Creates a v3 session and polls it to a terminal state. Bounded: 45 min
// deadline, 20 s poll interval, one bounded nudge when Devin waits for user
// input, status codes only in errors — never bodies, prompts, or credentials.
async function runDevinSession(request, project, devinBranch, reporter) {
  const base = `/v3/organizations/${devinOrgId}/sessions`;
  const repo = devinRepoName(project.github);
  const acu = Number(process.env.DEVIN_MAX_ACU || 0);
  const created = await devinApi(base, {
    method: "POST",
    body: {
      prompt: devinPrompt(request, project, devinBranch).slice(0, 8000),
      title: String(request.title || "Hermes 개발 요청").slice(0, 140),
      tags: ["hermes-ops", `hermes-${String(request.id).slice(0, 40)}`],
      resumable: false,
      structured_output_schema: {
        type: "object",
        properties: { result: { type: "string" } },
        required: ["result"],
      },
      ...(repo ? { repos: [repo] } : {}),
      ...(Number.isFinite(acu) && acu > 0 ? { max_acu_limit: Math.min(Math.floor(acu), 100) } : {}),
    },
  });
  const session = parseDevinSession(created);
  if (!session.id || !session.id.startsWith("devin-")) {
    throw new Error("Devin 세션 ID를 받지 못했습니다.");
  }
  await reporter.update("devin", `Devin 세션 실행 중: ${session.url || session.id}`);
  const deadline = Date.now() + 45 * 60 * 1000;
  let nudged = false;
  let current = session;
  while (Date.now() < deadline) {
    await sleep(20_000);
    current = parseDevinSession(await devinApi(`${base}/${session.id}`));
    const terminal = devinTerminalStatus(current);
    if (terminal === "finished") break;
    if (terminal === "failed") {
      throw new Error(
        `Devin 세션이 완료되지 못했습니다 (상태: ${current.status || "unknown"}${current.statusDetail ? `/${current.statusDetail}` : ""}).`,
      );
    }
    if (terminal === "waiting" && !nudged) {
      nudged = true;
      await devinApi(`${base}/${session.id}/messages`, {
        method: "POST",
        body: {
          message:
            "추가 입력 없이 계속 진행해주세요. 완료하면 변경을 약속된 브랜치에 푸시하고 한국어로 요약해주세요.",
        },
      }).catch(() => {});
    }
    await reporter.extendLease(30 * 60 * 1000);
  }
  if (Date.now() >= deadline) throw new Error("Devin 세션이 시간 제한(45분)을 초과했습니다.");
  if (!current.detail) {
    const messages = await devinApi(`${base}/${session.id}/messages`).catch(() => null);
    const lastMessage = messages ? devinLastAgentMessage(messages) : "";
    if (lastMessage) current = { ...current, detail: lastMessage };
  }
  return current;
}

// Fetches the branch Devin pushed and applies its diff inside the isolated
// worktree so the shared collect/verify/commit/push/deploy pipeline runs
// unchanged — the only difference is where the diff was produced.
async function applyDevinBranch(project, executionProject, baseline, request, reporter) {
  const devinBranch = `${devinBranchPrefix}${request.id}`;
  const localRef = `refs/hermes/devin-${request.id}`;
  const fetchResult = await runCommand(
    "git",
    ["-C", project.repo, "fetch", project.gitRemote, `${devinBranch}:${localRef}`],
    { timeoutMs: 3 * 60 * 1000 },
  );
  if (fetchResult.code !== 0) {
    throw new Error("Devin이 약속된 작업 브랜치를 리모트에 푸시하지 않았습니다.");
  }
  const diff = await git(project, ["diff", "--binary", `${baseline}..${localRef}`]);
  if (!diff.stdout.trim()) return { changed: false };
  const patchPath = join(worktreeRoot, `devin-${request.id}.patch`);
  await writeFile(patchPath, diff.stdout, "utf8");
  try {
    const apply = await runCommand("git", ["-C", executionProject.repo, "apply", "--whitespace=nowarn", patchPath], {
      timeoutMs: 60_000,
    });
    if (apply.code !== 0) {
      throw new Error(`Devin 변경을 worktree에 적용하지 못했습니다: ${trimOutput(apply.stderr || apply.stdout)}`);
    }
  } finally {
    await rm(patchPath, { force: true });
  }
  reporter.appendLog(`Devin 브랜치 적용: ${devinBranch}`);
  return { changed: true };
}

async function runDevinAgent(request, project, executionProject, baseline, reporter) {
  const devinBranch = `${devinBranchPrefix}${request.id}`;
  const session = await runDevinSession(request, project, devinBranch, reporter);
  const applied = await applyDevinBranch(project, executionProject, baseline, request, reporter);
  return { finalMessage: session.detail || "", hasChanges: applied.changed };
}

async function runCodexAgent(request, project, executionProject, reporter) {
  await reporter.update("codex", "Codex가 비밀 파일이 없는 격리 worktree에서 요청을 처리하고 있습니다.");
  const codexResult = await runCommand(
    "codex",
    [
      "exec",
      "--sandbox",
      "workspace-write",
      "--ephemeral",
      "--json",
      "-C",
      executionProject.repo,
      codexPrompt(request, project),
    ],
    {
      cwd: executionProject.repo,
      env: childEnvironment(),
      onStderr: (value) => reporter.appendLog(value),
      timeoutMs: 45 * 60 * 1000,
    },
  );
  const codex = parseCodexOutput(codexResult.stdout);
  if (codexResult.code !== 0) {
    throw new Error(`Codex 실행 실패: ${trimOutput(codexResult.stderr || codex.finalMessage, 8000)}`);
  }
  return { finalMessage: codex.finalMessage || "", hasChanges: null };
}

// Readiness report for the console integrations view — states only, never
// credential values. Posted once per worker start; bounded and best-effort.
export async function reportProviderReadiness() {
  try {
    const probe = await runCommand("codex", ["--version"], { timeoutMs: 5000 });
    const devinConfigured = Boolean(
      String(process.env.DEVIN_API_KEY || "").startsWith("cog_") && process.env.DEVIN_ORG_ID,
    );
    await api("/api/worker/providers", {
      method: "POST",
      body: JSON.stringify({
        codex: { state: probe.code === 0 ? "ready" : "unavailable" },
        devin: { state: devinConfigured ? "configured" : "unavailable" },
        local_llm: { state: (await localModelPresent()) ? "ready" : "unavailable" },
      }),
    });
  } catch {
    // Readiness reporting is best-effort — never blocks the worker loop.
  }
}

async function prepareRepository(project, reporter) {
  await reporter.update("git_preflight", `${project.name} 원격 브랜치와 격리 작업 공간을 준비합니다.`);
  const root = (await git(project, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const [actualRoot, registeredRoot] = await Promise.all([realpath(root), realpath(project.repo)]);
  if (actualRoot !== registeredRoot) throw new Error("프로젝트 레지스트리 경로와 Git 루트가 다릅니다.");
  await git(project, ["fetch", project.gitRemote, project.branch], { timeoutMs: 3 * 60 * 1000 });
  return (await git(project, ["rev-parse", `${project.gitRemote}/${project.branch}`])).stdout.trim();
}

async function createIsolatedWorktree(project, request, baseline) {
  await mkdir(worktreeRoot, { recursive: true });
  const path = join(worktreeRoot, `${project.id}-${request.id}`);
  await git(project, ["worktree", "add", "--detach", path, baseline], { timeoutMs: 3 * 60 * 1000 });
  const executionProject = { ...project, repo: path };
  const tracked = parseNullList((await git(executionProject, ["ls-files", "-z"])).stdout);
  const protectedFiles = tracked.filter(isProtectedPath);
  if (protectedFiles.length) {
    await removeIsolatedWorktree(project, executionProject);
    throw new Error(`저장소가 보호 파일을 추적하고 있어 자동 실행할 수 없습니다: ${protectedFiles.join(", ")}`);
  }
  return executionProject;
}

async function removeIsolatedWorktree(project, executionProject) {
  const result = await runCommand(
    "git",
    ["-C", project.repo, "worktree", "remove", executionProject.repo],
    { timeoutMs: 3 * 60 * 1000 },
  );
  if (result.code !== 0) {
    throw new Error(`완료 worktree 정리 실패: ${trimOutput(result.stderr || result.stdout)}`);
  }
}

async function runVerification(project, reporter) {
  const outputs = [];
  const commands = Array.isArray(project.verifyCommands) ? project.verifyCommands : [];
  for (let index = 0; index < commands.length; index += 1) {
    const verifyCommand = commands[index];
    await reporter.update("verify", `검증 중 (${index + 1}/${commands.length}): ${verifyCommand}`);
    const result = await command("shell", ["-lc", verifyCommand], {
      cwd: project.repo,
      env: childEnvironment(),
      timeoutMs: 15 * 60 * 1000,
    });
    outputs.push(`${verifyCommand}\n${trimOutput(result.stdout || result.stderr || "통과", 2500)}`);
  }
  return outputs;
}

async function commitAndPush(project, request, files, reporter) {
  await reporter.update("commit", `${files.length}개 변경 파일을 커밋합니다.`);
  await reporter.assertLease();
  await git(project, ["add", "--", ...files]);
  await git(project, ["diff", "--cached", "--check"]);
  const tested = (project.verifyCommands || []).join("; ") || "repository checks";
  const title = sanitizedTitle(request.title);
  await git(project, [
    "commit",
    "-m",
    `Honor approved Hermes request: ${title}`,
    "-m",
    [
      "Constraint: Approved remote request executed inside the registered repository",
      "Confidence: medium",
      "Scope-risk: moderate",
      "Directive: Keep remote development behind approval and the project allowlist",
      `Tested: ${tested}`,
      "Not-tested: Manual browser acceptance beyond the production health check",
    ].join("\n"),
  ]);
  const commit = (await git(project, ["rev-parse", "HEAD"])).stdout.trim();
  await reporter.update("push", `${project.gitRemote}/${project.branch}로 커밋을 전송합니다.`);
  await reporter.assertLease();
  await git(project, ["push", project.gitRemote, `HEAD:${project.branch}`], { timeoutMs: 5 * 60 * 1000 });
  return commit;
}

async function developmentPipeline(request, reporter) {
  const project = await getProject(request.target_project, "development");
  const releaseLock = await acquireProjectLock(project, request);
  let baseline = null;
  let executionProject = null;
  let pushedCommit = null;
  let completed = false;
  try {
    const artifact = await createCodexRequestArtifact(request, project);
    baseline = await prepareRepository(project, reporter);
    executionProject = await createIsolatedWorktree(project, request, baseline);
    const executor = request.executor === "devin" ? "devin" : "codex";
    const agentName = executor === "devin" ? "Devin" : "Codex";
    const agent =
      executor === "devin"
        ? await runDevinAgent(request, project, executionProject, baseline, reporter)
        : await runCodexAgent(request, project, executionProject, reporter);
    await reporter.assertLease();
    const currentHead = (await git(executionProject, ["rev-parse", "HEAD"])).stdout.trim();
    if (currentHead !== baseline) throw new Error(`${agentName}가 Git 커밋을 직접 변경해 자동 파이프라인을 중단했습니다.`);
    const files = await collectChangedFiles(executionProject, baseline);
    if (!files.length) {
      completed = true;
      return [
        `${agentName} 실행 완료: ${project.name}`,
        "변경할 파일이 없어서 커밋과 재배포는 생략했습니다.",
        `요청 기록: ${artifact}`,
        agent.finalMessage ? `\n${agentName} 보고\n${trimOutput(agent.finalMessage, 5000)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    const verification = await runVerification(executionProject, reporter);
    pushedCommit = await commitAndPush(executionProject, request, files, reporter);
    let deployment = "자동 배포 비활성";
    if (project.autoDeploy) deployment = await redeployProject(request, reporter);
    completed = true;
    return [
      `개발·배포 완료: ${project.name}`,
      `기준 커밋: ${baseline}`,
      `새 커밋: ${pushedCommit}`,
      `변경 파일 (${files.length}): ${files.join(", ")}`,
      `요청 기록: ${artifact}`,
      "",
      deployment,
      "",
      "검증",
      ...verification.map((value) => trimOutput(value, 3000)),
      agent.finalMessage ? `\n${agentName} 보고\n${trimOutput(agent.finalMessage, 5000)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  } catch (error) {
    const details = [error.message];
    if (pushedCommit) details.push(`Git에 전송된 커밋: ${pushedCommit}`);
    if (executionProject) details.push(`실패 worktree 보존: ${executionProject.repo}`);
    throw new Error(details.join("\n"));
  } finally {
    try {
      if (completed && executionProject) await removeIsolatedWorktree(project, executionProject);
    } finally {
      await releaseLock();
    }
  }
}

async function fileCleanupReport(request) {
  const requested = String(request.body || "").toLowerCase();
  const [downloads, caches, docker] = await Promise.all([
    runCommand("du", ["-sh", join(homedir(), "Downloads")]),
    runCommand("du", ["-sh", join(homedir(), "Library", "Caches")]),
    runCommand("docker", ["system", "df"]),
  ]);
  const lines = [
    "파일 정리 점검",
    `Downloads: ${trimOutput(downloads.stdout || downloads.stderr || "확인 불가")}`,
    `사용자 캐시: ${trimOutput(caches.stdout || caches.stderr || "확인 불가")}`,
    "",
    "Docker 사용량",
    trimOutput(docker.stdout || docker.stderr || "확인 불가"),
  ];
  if (requested.includes("docker") && /(캐시|cache|빌드|builder)/.test(requested)) {
    const prune = await command("docker", ["builder", "prune", "--force"], { timeoutMs: 10 * 60 * 1000 });
    lines.push("", "Docker 빌드 캐시 정리", trimOutput(prune.stdout || prune.stderr || "완료"));
  } else {
    lines.push(
      "",
      "일반 파일은 삭제하지 않았습니다. 요청에 'Docker 빌드 캐시 정리'를 명시하면 승인 후 정리됩니다.",
    );
  }
  return lines.join("\n");
}

async function ollamaAvailable() {
  try {
    const response = await fetch(new URL("/api/version", ollamaUrl), {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// The configured model must actually exist in the Ollama catalog — a running
// server with a missing model is a truthful failure, never silent readiness.
async function localModelPresent() {
  try {
    const response = await fetch(new URL("/api/tags", ollamaUrl), {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const tags = await response.json();
    const names = new Set(
      (Array.isArray(tags?.models) ? tags.models : [])
        .map((entry) => String(entry?.name || entry?.model || "").toLowerCase())
        .filter(Boolean),
    );
    const wanted = String(localModel).toLowerCase();
    return names.has(wanted) || names.has(`${wanted}:latest`);
  } catch {
    return false;
  }
}

async function ensureOllamaServer() {
  if (await ollamaAvailable()) return;
  await new Promise((resolvePromise, reject) => {
    const child = spawn(commandPaths.ollama, ["serve"], {
      detached: true,
      env: {
        ...childEnvironment(),
        OLLAMA_CONTEXT_LENGTH: "16384",
        OLLAMA_HOST: "127.0.0.1:11434",
        OLLAMA_KEEP_ALIVE: "2m",
        OLLAMA_MAX_LOADED_MODELS: "1",
        OLLAMA_NUM_PARALLEL: "1",
      },
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await ollamaAvailable()) return;
    await sleep(500);
  }
  throw new Error("Ollama 서버가 30초 안에 시작되지 않았습니다.");
}

// Server up + configured model present — the gate every local-LLM path uses.
async function ensureLocalModel() {
  await ensureOllamaServer();
  if (!(await localModelPresent())) {
    throw new Error(
      `로컬 LLM 모델(${localModel})이 Ollama에 없습니다. ollama list로 설치된 모델을 확인하고 HERMES_LOCAL_MODEL을 맞춰주세요.`,
    );
  }
}

async function ollamaCompletion(messages, options = {}) {
  const response = await fetch(new URL("/api/chat", ollamaUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: localModel,
      messages,
      ...(options.format ? { format: options.format } : {}),
      options: {
        num_ctx: 16384,
        num_predict: options.numPredict || 768,
        temperature: options.temperature ?? 0.1,
        top_p: 0.8,
      },
      keep_alive: "2m",
      stream: false,
    }),
    signal: AbortSignal.timeout(20 * 60 * 1000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`로컬 LLM(${localModel}) 응답 실패: ${response.status} ${text}`);
  const content = String(data.message?.content || "").trim();
  if (!content) throw new Error(`로컬 LLM(${localModel})이 빈 응답을 반환했습니다.`);
  return content;
}

async function hermesChat(request, reporter) {
  await reporter.update("hermes_start", `로컬 LLM(${localModel})을 준비하고 있습니다.`);
  await ensureLocalModel();
  await reporter.update("hermes_chat", "로컬 LLM이 한국어 답변을 작성하고 있습니다.");
  return ollamaCompletion([
    {
      role: "system",
      content:
        "너는 Mac Studio 운영 콘솔의 로컬 LLM 대화 계층이다. 한국어로 짧고 정확하게 답한다. 이 대화 모드에서는 실제 명령이나 파일 변경을 실행하지 않았다고 명확히 구분한다. 실행이 필요하면 사용자가 Mac 상태, 프로젝트 점검, 파일 정리, Hermes 운영 요청, Codex 개발 요청 중 맞는 요청 종류를 선택하도록 안내한다. 개발 구현은 Codex 개발 요청으로 위임한다.",
    },
    { role: "user", content: String(request.body || "").slice(0, 8000) },
  ]);
}

export function parseHermesDecision(value) {
  const cleaned = String(value || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  const objectCandidates = cleaned.match(/\{[^{}]*\}/g) || [];
  const candidates = [
    fenced,
    cleaned,
    firstBrace >= 0 && lastBrace > firstBrace ? cleaned.slice(firstBrace, lastBrace + 1) : null,
    ...objectCandidates,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      const actions = new Set([
        "mac_status",
        "deployment_status",
        "project_inspect",
        "redeploy",
        "file_cleanup",
        "development",
        "respond",
      ]);
      if (!actions.has(parsed.action)) continue;
      return {
        action: parsed.action,
        message: String(parsed.message || "").slice(0, 4000),
        reason: String(parsed.reason || "").slice(0, 500),
      };
    } catch {
      // Try the next JSON-shaped candidate.
    }
  }
  throw new Error("로컬 LLM 운영 판단을 안전한 JSON으로 해석하지 못했습니다.");
}

export function classifyObviousRequest(value) {
  const text = String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return null;
  const routes = [
    {
      action: "development",
      pattern: /(코드|기능|버그|오류|화면|ui|문구|readme|파일).*(수정|고쳐|개발|구현|추가|변경|만들)|(?:수정|고쳐|개발|구현|추가|변경).*(코드|기능|버그|오류|화면|ui|문구|readme|파일)/i,
      reason: "코드 또는 배포 파일 변경 요청",
    },
    {
      action: "redeploy",
      pattern: /(재배포|다시\s*배포|배포를?\s*다시)/i,
      reason: "기존 프로젝트 재배포 요청",
    },
    {
      action: "file_cleanup",
      pattern: /(docker|도커|빌드|파일|다운로드|캐시).*(정리|삭제|비워|prune)|(?:정리|삭제|비워|prune).*(docker|도커|빌드|파일|다운로드|캐시)/i,
      reason: "파일 또는 빌드 캐시 정리 요청",
    },
    {
      action: "mac_status",
      pattern: /(mac|맥|메모리|램|cpu|프로세스|디스크|컨테이너).*(상태|확인|알려|점검|사용량|여유)|(?:상태|확인|알려|점검).*(mac|맥|메모리|램|cpu|프로세스|디스크|컨테이너)/i,
      reason: "Mac Studio 자원 상태 조회",
    },
    {
      action: "deployment_status",
      pattern: /(배포|릴리즈|release|deployment).*(상태|확인|알려|점검)|(?:상태|확인|알려|점검).*(배포|릴리즈|release|deployment)/i,
      reason: "mini deploy 배포 상태 조회",
    },
    {
      action: "project_inspect",
      pattern: /(git|깃|커밋|저장소|프로젝트).*(상태|확인|알려|점검|로그)|(?:상태|확인|알려|점검).*(git|깃|커밋|저장소|프로젝트)/i,
      reason: "등록 프로젝트와 Git 상태 조회",
    },
  ];
  const route = routes.find((candidate) => candidate.pattern.test(text));
  return route ? { action: route.action, message: "", reason: route.reason } : null;
}

function requiredProjectCapability(action) {
  return ["deployment_status", "project_inspect", "redeploy", "development"].includes(action)
    ? action
    : null;
}

async function constrainDecisionToProject(decision, request) {
  const capability = requiredProjectCapability(decision.action);
  if (!capability) return decision;
  const project = await getProject(request.target_project);
  if (projectSupports(project, capability)) return decision;
  return {
    action: "respond",
    reason: `${project.name}은 현재 배포 상태 조회만 연결됨`,
    message: `${project.name}은 mini deploy 상태 조회에는 연결되어 있지만 ${capability} 권한과 로컬 저장소 검증 설정은 아직 활성화되어 있지 않습니다. 대상 프로젝트의 로컬 저장소와 검증 명령을 등록한 뒤 변경 요청을 실행할 수 있습니다.`,
  };
}

async function routeHermes(request, reporter, approved = false) {
  await reporter.update(
    "hermes_start",
    approved ? "승인된 Hermes 운영 에이전트를 준비하고 있습니다." : "Hermes 자동 판단을 준비하고 있습니다.",
  );
  await ensureLocalModel();
  await reporter.update("hermes_route", "로컬 LLM이 요청을 허용된 운영 작업으로 분류하고 있습니다.");
  const rawDecision = await ollamaCompletion(
    [
      {
        role: "system",
        content: `너는 Mac Studio 운영 요청 라우터다. 실제 도구를 호출하지 말고 JSON 하나만 출력한다.
형식: {"action":"ACTION","reason":"짧은 한국어 이유","message":"respond일 때만 답변"}. 정확히 하나의 JSON 객체와 하나의 가장 적합한 ACTION만 출력한다.
ACTION은 mac_status, deployment_status, project_inspect, redeploy, file_cleanup, development, respond 중 하나다.
코드/기능/버그/파일 수정은 development, 현재 Mac 메모리·프로세스·디스크·실행 컨테이너 확인은 mac_status, Git/프로젝트 상태는 project_inspect, mini deploy 배포 상태 조회는 deployment_status, 재배포는 redeploy, Docker 빌드 캐시나 파일 정리 점검은 file_cleanup이다. 허용 목록 밖의 서비스 제어, 임의 셸, 계정·보안 설정 변경은 실행하지 말고 respond로 불가 이유와 안전한 대안을 적는다.`,
      },
      { role: "user", content: String(request.body || "").slice(0, 8000) },
    ],
    { format: "json", numPredict: 320, temperature: 0 },
  );
  reporter.appendLog(`Hermes route output: ${trimOutput(rawDecision, 2000)}`);
  const decision = parseHermesDecision(rawDecision);
  return constrainDecisionToProject(decision, request);
}

async function executeHermesDecision(decision, request, reporter) {
  await reporter.update("hermes_execute", `Hermes 판단: ${decision.reason || decision.action}`);
  let result;
  if (decision.action === "mac_status") result = await macStatus();
  else if (decision.action === "deployment_status") result = await deploymentStatus(request);
  else if (decision.action === "project_inspect") result = await projectInspect(request);
  else if (decision.action === "redeploy") result = await redeployProject(request, reporter);
  else if (decision.action === "file_cleanup") result = await fileCleanupReport(request);
  else if (decision.action === "development") result = await developmentPipeline(request, reporter);
  else result = decision.message || "이 요청은 현재 Hermes 운영 허용 목록으로 실행할 수 없습니다.";
  return [`로컬 LLM 판단: ${decision.reason || decision.action}`, "", result].join("\n");
}

async function runHermes(request, reporter) {
  const decision = await routeHermes(request, reporter, true);
  return executeHermesDecision(decision, request, reporter);
}

async function runAuto(request, reporter) {
  if (request.resolved_type) {
    return executeHermesDecision(
      { action: request.resolved_type, reason: request.plan || request.resolved_type, message: "" },
      request,
      reporter,
    );
  }
  const fastDecision = classifyObviousRequest(request.body);
  const decision = fastDecision
    ? await constrainDecisionToProject(fastDecision, request)
    : await routeHermes(request, reporter, false);
  if (fastDecision) reporter.appendLog(`Fast route: ${fastDecision.action}`);
  const resolvedType = decision.action === "respond" ? "hermes_chat" : decision.action;
  const planned = await api("/api/worker/plan", {
    method: "POST",
    body: JSON.stringify({
      id: request.id,
      claimToken: request.claim_token,
      resolvedType,
      reason: decision.reason || decision.action,
    }),
  });
  if (planned.deferred) return { deferred: true };
  if (decision.action === "respond") {
    return [`로컬 LLM 판단: ${decision.reason || "대화 응답"}`, "", decision.message].join("\n");
  }
  return executeHermesDecision(decision, request, reporter);
}

async function handle(request, reporter) {
  if (request.type === "auto") return runAuto(request, reporter);
  if (["hermes_chat", "custom"].includes(request.type)) return hermesChat(request, reporter);
  if (request.type === "mac_status") return macStatus();
  if (request.type === "deployment_status") return deploymentStatus(request);
  if (request.type === "project_inspect") return projectInspect(request);
  if (request.type === "redeploy") return redeployProject(request, reporter);
  if (request.type === "development") return developmentPipeline(request, reporter);
  if (request.type === "file_cleanup") return fileCleanupReport(request);
  if (request.type === "hermes_ops") return runHermes(request, reporter);
  throw new Error(`지원하지 않는 요청 종류입니다: ${request.type}`);
}

async function reportFinalResult(request, outcome) {
  let attempt = 0;
  while (true) {
    try {
      await api("/api/worker/result", {
        method: "POST",
        body: JSON.stringify({
          id: request.id,
          claimToken: request.claim_token,
          status: outcome.status,
          result: outcome.result,
        }),
      });
      return;
    } catch (error) {
      if (String(error?.message || error).startsWith("409 ")) throw error;
      attempt += 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
      console.error(`Final result delivery failed; retrying in ${delay}ms: ${error.message}`);
      await sleep(delay);
    }
  }
}

async function runRequest(request) {
  const reporter = createProgressReporter(request);
  let outcome;
  try {
    const result = await handle(request, reporter);
    if (result?.deferred) return;
    outcome = { status: "done", result };
  } catch (error) {
    reporter.appendLog(error instanceof Error ? error.stack || error.message : String(error));
    outcome = {
      status: "failed",
      result: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await reporter.close();
  }
  await reportFinalResult(request, outcome);
}

export async function main() {
  if (!siteUrl || !token) {
    console.error("Set HERMES_OPS_URL and HERMES_WORKER_TOKEN before starting.");
    process.exitCode = 1;
    return;
  }
  console.log("Hermes local worker started.");
  await reportProviderReadiness();
  while (true) {
    try {
      const { request } = await api("/api/worker/next");
      if (!request) {
        await sleep(5000);
        continue;
      }
      console.log(`Running ${request.id}: ${request.title}`);
      await runRequest(request);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      await sleep(10000);
    }
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main();
