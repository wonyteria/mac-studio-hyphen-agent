#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_REGISTRY_BYTES,
  SHA256_PATTERN,
  SYNC_STATUS_FILENAME,
  buildSyncStatus,
  loadBusinessRegistry,
  parseSyncStatusDocument,
  syncErrorCode,
  validateBusinessRegistry,
} from "./hermes-business-registry.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const plistLabel = "com.hyphen.hermes-registry-sync";
const plistFileName = `${plistLabel}.plist`;
const syncIntervalSeconds = 300;
const lockFileName = "registry-sync.lock";
const lockStaleMs = 30 * 60 * 1000;
// The LaunchAgent cannot touch TCC-protected directories: an open() under
// ~/Documents (etc.) suspends in the kernel forever instead of failing.
// install therefore stages a copy of the tool into Application Support and
// bakes only stage/mirror paths into the plist.
const stagedToolFiles = ["hermes-registry-sync.mjs", "hermes-business-registry.mjs"];
const syncConfigDir = join("Library", "Application Support", "Hyphen", "hermes-registry-sync");
const syncConfigName = "sync-paths.json";
const defaultStageDir = join(syncConfigDir, "tool");
const defaultSyncTimeoutMs = 60 * 1000;
const statusWriteTimeoutMs = 5 * 1000;

const usage = `Hermes 사업 레지스트리 동기화 도구

Hyphen Studio의 비공개 사업 레지스트리(registry.private.json)를 검증한 뒤
Hermes 영구 데이터 경로로 원자적으로 복사하고, 결과를 제한된 status JSON에
기록합니다. 기존 대상 파일은 새 소스가 검증을 통과할 때만 교체되므로
실패해도 마지막 정상본이 그대로 보존됩니다.

사용법:
  node scripts/hermes-registry-sync.mjs [command] [옵션]

command:
  sync (기본)   소스 검증 → 대상 원자 복사 → status JSON 기록
  install       도구를 Application Support에 스테이징한 뒤 macOS LaunchAgent
                plist 구성 + 로드 (명시 실행 시에만 시스템 변경)
  uninstall     LaunchAgent unload + plist + 스테이징된 도구 제거
  status        마지막 동기화 상태 + LaunchAgent/스테이징 확인 (읽기 전용)

필수 경로 (CLI 또는 전용 환경 변수 — 기본값 없음, 누락 시 usage 오류):
  --source <path>        동기화할 Studio export
                         (환경 변수: HERMES_REGISTRY_SYNC_SOURCE)
  --destination <path>   Hermes 영구 데이터 대상 파일
                         (환경 변수: HERMES_REGISTRY_SYNC_DESTINATION)

선택 경로:
  --status <path>        status JSON 경로
                         (환경 변수: HERMES_REGISTRY_SYNC_STATUS,
                          기본: destination과 같은 디렉터리의 ${SYNC_STATUS_FILENAME})

옵션:
  --max-bytes <n>        허용 최대 파일 크기 (기본: ${DEFAULT_MAX_REGISTRY_BYTES})
  --expect-hash <sha>    소스 sourceHash 고정값 (기본: HERMES_REGISTRY_SYNC_EXPECTED_HASH)
  --stage-dir <path>     install 시 도구를 복사할 스테이징 디렉터리
                         (환경 변수: HERMES_REGISTRY_SYNC_STAGE_DIR,
                          기본: ~/Library/Application Support/Hyphen/hermes-registry-sync/tool)
  --allow-protected-paths  install 시 보호 디렉터리 검사를 명시적으로 우회
  --dry-run              sync/install/uninstall을 변경 없이 계획만 출력
  --no-load              install 시 plist만 기록하고 launchctl은 실행하지 않음
  --json                 sync 결과를 JSON으로 출력
  --help                 이 도움말

환경 변수:
  HERMES_REGISTRY_SYNC_LAUNCHCTL   launchctl 실행 파일 (테스트/샌드박스용)
  HERMES_REGISTRY_SYNC_TIMEOUT_MS  sync 전체 실행 제한 시간
                                   (기본 ${defaultSyncTimeoutMs}ms, 초과 시 sync_timeout)

launchd 경계 (중요):
  LaunchAgent는 TCC 보호 디렉터리의 파일을 열 수 없습니다 — open()이 오류
  없이 무기한 정지합니다. install은 이 도구(스크립트+계약 모듈)를 스테이징
  디렉터리에 복사하고 plist에는 스테이징된 경로만 고정합니다. source/
  destination/status/stage-dir 중 하나라도 보호 경로(Documents, Desktop,
  Downloads, Library/Mobile Documents, Library/CloudStorage) 아래에 있으면
  install을 거부합니다. Studio export가 sync-paths.json 설정(또는
  --mirror 인자)으로 자동 갱신하는 미러 파일을 source로 사용하세요.

동작 규칙:
  - 소스/대상 모두 symlink를 거부하고, 크기·스키마·sourceHash를 검증합니다.
  - 대상은 같은 디렉터리의 temp 파일 + fsync + rename으로만 교체합니다 (0600).
  - 내용이 같으면 복사를 건너뛰고 status를 unchanged로 갱신합니다.
  - status JSON에는 status/checkedAt/syncedAt/registryUpdatedAt/projectCount/
    errorCode만 들어갑니다. 사업 내용·경로·에러 원문은 절대 기록하지 않습니다.
  - ${lockFileName} 잠금으로 동시 실행을 막습니다 (30분 초과 잠금은 폐기).
  - sync 출력에는 경로를 포함하지 않습니다 (launchd 로그에 남지 않도록).
    install/uninstall/status/dry-run 출력은 운영자 확인용으로 경로를 표시합니다.
  - sync 전체 실행이 제한 시간을 넘기면 sync_timeout으로 기록하고 종료합니다.

종료 코드:
  0  sync 성공/변경 없음/다른 실행 중이라 건너뜀 · install/uninstall 성공 · status 정상
  1  sync 입력 거부/쓰기 실패 (error status 기록됨) · status에서 마지막 실행 실패/기록 없음
  2  인자/경로 오류, status 기록 실패, launchctl/plist 오류
`;

class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const options = { command: "sync", dryRun: false, json: false, noLoad: false, allowProtectedPaths: false };
  const commands = new Set(["sync", "install", "uninstall", "status"]);
  const takeValue = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("-")) {
      throw new Error(`${flag} 옵션에는 값이 필요합니다.`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (commands.has(arg) && index === 0) options.command = arg;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--source") options.source = takeValue(arg, index++);
    else if (arg === "--destination") options.destination = takeValue(arg, index++);
    else if (arg === "--status") options.statusPath = takeValue(arg, index++);
    else if (arg === "--stage-dir") options.stageDir = takeValue(arg, index++);
    else if (arg === "--allow-protected-paths") options.allowProtectedPaths = true;
    else if (arg === "--max-bytes") options.maxBytes = Number(takeValue(arg, index++));
    else if (arg === "--expect-hash") options.expectHash = takeValue(arg, index++);
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-load") options.noLoad = true;
    else if (arg === "--json") options.json = true;
    else throw new Error(`알 수 없는 옵션입니다: ${arg}`);
  }
  if (options.maxBytes !== undefined && (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0)) {
    throw new Error("--max-bytes는 양의 정수여야 합니다.");
  }
  if (options.expectHash !== undefined && !SHA256_PATTERN.test(options.expectHash)) {
    throw new Error("--expect-hash는 소문자 64자리 sha256 hex여야 합니다.");
  }
  return options;
}

// Resolves the sync path contract. source/destination are explicit-only:
// CLI flag, then dedicated env var, then usage failure — never inferred from
// the deployment registry and never defaulted to an account-specific path.
function resolveSyncPaths(options, env = process.env, { requirePaths = true } = {}) {
  const source = options.source || env.HERMES_REGISTRY_SYNC_SOURCE || "";
  const destination = options.destination || env.HERMES_REGISTRY_SYNC_DESTINATION || "";
  if (requirePaths) {
    if (!source) throw new SyncError("usage", "--source 또는 HERMES_REGISTRY_SYNC_SOURCE가 필요합니다.");
    if (!destination) {
      throw new SyncError("usage", "--destination 또는 HERMES_REGISTRY_SYNC_DESTINATION이 필요합니다.");
    }
  }
  const resolved = {
    source: source ? resolve(source) : null,
    destination: destination ? resolve(destination) : null,
    statusPath: null,
    lockPath: null,
  };
  const statusArg = options.statusPath || env.HERMES_REGISTRY_SYNC_STATUS || "";
  if (statusArg) resolved.statusPath = resolve(statusArg);
  else if (resolved.destination) resolved.statusPath = join(dirname(resolved.destination), SYNC_STATUS_FILENAME);
  if (resolved.destination) resolved.lockPath = join(dirname(resolved.destination), lockFileName);
  return resolved;
}

// Second-precision ISO timestamp — the registry contract's ISO_DATETIME has
// no fractional seconds, and the status parser validates against it.
function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Directories a launchd child cannot open() without the syscall suspending
// indefinitely: TCC-protected user folders plus cloud-backed trees whose
// dataless files stall on fileproviderd. Detection is prefix-based because
// the kernel-level hang cannot be probed safely.
function protectedPathPrefixes(home = homedir()) {
  return [
    join(home, "Documents"),
    join(home, "Desktop"),
    join(home, "Downloads"),
    join(home, "Library", "Mobile Documents"),
    join(home, "Library", "CloudStorage"),
  ];
}

// Returns the protected prefix containing `path`, or null. Exact-prefix and
// descendant matches both count; sibling dirs with similar names do not.
function protectedPrefixFor(path, home = homedir()) {
  const resolved = resolve(path);
  for (const prefix of protectedPathPrefixes(home)) {
    if (resolved === prefix || resolved.startsWith(`${prefix}${sep}`)) return prefix;
  }
  return null;
}

// Where install stages the runnable tool copy. HOME-derived at install time —
// never inferred from a registry or hardcoded to an account path.
function resolveStageDir(options, env = process.env) {
  return resolve(options.stageDir || env.HERMES_REGISTRY_SYNC_STAGE_DIR || join(homedir(), defaultStageDir));
}

function stagedToolPaths(stageDir) {
  return stagedToolFiles.map((name) => ({
    source: join(dirname(scriptPath), name),
    staged: join(stageDir, name),
  }));
}

// The explicit paths the operator installed with, persisted so the Studio
// export side can discover the mirror target without re-entering them. The
// file lives outside every repository (0600), so the contract is local-only
// and can never be committed or read back into a public surface.
function syncConfigPath(home = homedir()) {
  return join(home, syncConfigDir, syncConfigName);
}

function buildSyncConfig(paths, stageDir) {
  return {
    kind: "hermes-registry-sync-paths",
    schemaVersion: 1,
    source: paths.source,
    destination: paths.destination,
    statusPath: paths.statusPath,
    stageDir,
    savedAt: isoNow(),
  };
}

// Overall bound for a sync run. A wedged open() (protected path, dataless
// cloud file, dead mount) must degrade to a bounded error, not a zombie
// process that also blocks the next launchd interval.
function syncTimeoutMs(env = process.env) {
  const value = Number(env.HERMES_REGISTRY_SYNC_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultSyncTimeoutMs;
}

// A reject-after-delay that never keeps the process alive: the timer is
// unref'd and callers cancel it when the race settles, so a finished CLI
// exits immediately instead of waiting out the watchdog.
function timeoutAfter(ms) {
  let timer = null;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SyncError("sync_timeout", "동기화가 제한 시간을 초과했습니다.")), ms);
    timer.unref();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

// Races `promise` against a bounded sync_timeout rejection, cancelling the
// timer on settle so no watchdog residue survives a fast run.
async function bounded(promise, ms) {
  const bound = timeoutAfter(ms);
  try {
    return await Promise.race([promise, bound.promise]);
  } finally {
    bound.cancel();
  }
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

// Missing is the only benign answer — permission and other I/O errors must
// fail closed rather than masquerade as "file absent".
async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// The previous status document is a hint, never authoritative — any problem
// reading it (absent, symlinked, unreadable, malformed) degrades to null and
// the run simply records fresh status at the end.
async function readStatusFile(statusPath) {
  if (!statusPath) return null;
  try {
    const info = await lstatOrNull(statusPath);
    if (!info || info.isSymbolicLink() || !info.isFile()) return null;
    return parseSyncStatusDocument(await readFile(statusPath, "utf8"));
  } catch {
    return null;
  }
}

// Atomic write: temp file in the target directory, fsync, then rename so a
// reader never sees a partial document. Mode is applied to the temp file
// before the rename lands; any failure removes the temp file best-effort so
// no mode-0600 fragment is left behind.
async function writeAtomicMode(filePath, contents, mode = 0o600) {
  const temporary = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    const handle = await open(temporary, "w", mode);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  // Best-effort directory fsync so the rename itself is durable.
  let dir = null;
  try {
    dir = await open(dirname(filePath), "r");
    await dir.sync();
  } catch {
    // Some filesystems cannot fsync directories; the rename already landed.
  } finally {
    if (dir) await dir.close().catch(() => {});
  }
}

// Duplicate-run guard for the 5-minute launchd interval. An exclusive-create
// lock file records pid + start time; a live owner with a fresh lock means
// skip, while a dead owner or a lock older than lockStaleMs is taken over.
async function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: isoNow() }));
      await handle.close();
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstatOrNull(lockPath);
    const staleByAge = !info || Date.now() - info.mtimeMs > lockStaleMs;
    let ownerAlive = false;
    try {
      const owner = JSON.parse(await readFile(lockPath, "utf8"));
      if (Number.isInteger(owner?.pid)) {
        try {
          process.kill(owner.pid, 0);
          ownerAlive = true;
        } catch (killError) {
          ownerAlive = killError?.code === "EPERM";
        }
      }
    } catch {
      ownerAlive = false;
    }
    if (ownerAlive && !staleByAge) return false;
    await rm(lockPath, { force: true });
  }
  return false;
}

// Removes the lock only when it is ours. After a sync_timeout the detached
// pass may finish late — removing a lock a newer run owns would break mutual
// exclusion, so a lock owned by a different pid is left untouched.
async function releaseLock(lockPath) {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8"));
    if (owner?.pid !== undefined && owner?.pid !== process.pid) return;
  } catch {
    // Unreadable or corrupt lock cannot prove foreign ownership — it is most
    // likely our own and the takeover path rewrites it anyway.
  }
  await rm(lockPath, { force: true }).catch(() => {});
}

async function ensureDestinationDir(destination, { create = true } = {}) {
  const parent = dirname(destination);
  let info;
  try {
    info = await lstatOrNull(parent);
  } catch {
    throw new SyncError("destination_dir_unusable", "대상 디렉터리 상태를 확인할 수 없습니다.");
  }
  if (info && (info.isSymbolicLink() || !info.isDirectory())) {
    throw new SyncError("destination_dir_unusable", "대상 디렉터리가 일반 디렉터리가 아닙니다.");
  }
  if (!info && create) await mkdir(parent, { recursive: true });
}

async function loadSourceRegistry(paths, options) {
  const expectedHash = options.expectHash || process.env.HERMES_REGISTRY_SYNC_EXPECTED_HASH || undefined;
  await loadBusinessRegistry(paths.source, {
    maxBytes: options.maxBytes,
    expectedHash,
  });
  // Copy exactly the bytes that pass validation: re-read and re-validate the
  // payload so a source swapped between the loader's read and ours can never
  // skip the schema gate.
  const raw = await readFile(paths.source, "utf8");
  if (Buffer.byteLength(raw, "utf8") > (options.maxBytes || DEFAULT_MAX_REGISTRY_BYTES)) {
    throw new SyncError("registry_too_large", "소스 파일이 허용 크기를 초과합니다.");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SyncError("registry_parse_error", "소스 파일이 유효한 JSON이 아닙니다.");
  }
  const issues = validateBusinessRegistry(parsed);
  if (issues.length > 0) {
    throw new SyncError("schema_mismatch", `소스 파일이 스키마 검증에 실패했습니다 (${issues.length}건).`);
  }
  return { registry: parsed, raw };
}

async function destinationNeedsUpdate(paths, raw) {
  let info;
  try {
    info = await lstatOrNull(paths.destination);
  } catch {
    throw new SyncError("destination_unreadable", "대상 파일 상태를 확인할 수 없습니다.");
  }
  if (!info) return { write: true, reason: "missing" };
  if (info.isSymbolicLink()) {
    throw new SyncError("destination_symlink", "대상이 symlink입니다. 자동 교체하지 않습니다.");
  }
  if (!info.isFile()) {
    throw new SyncError("destination_not_regular", "대상이 일반 파일이 아닙니다.");
  }
  // An unreadable destination is never treated as "changed": overwriting a
  // file we cannot inspect would destroy data we failed to verify.
  let current;
  try {
    current = await readFile(paths.destination, "utf8");
  } catch {
    throw new SyncError("destination_unreadable", "대상 파일을 읽을 수 없습니다.");
  }
  if (sha256(current) === sha256(raw)) return { write: false, reason: "identical" };
  return { write: true, reason: "changed" };
}

async function writeStatus(paths, doc) {
  await writeAtomicMode(paths.statusPath, `${JSON.stringify(doc, null, 2)}\n`, 0o600);
}

// Core sync pass. Throws SyncError/BusinessRegistryError on any rejection;
// callers translate that into an error status record.
async function syncPass(paths, options) {
  const { registry, raw } = await loadSourceRegistry(paths, options);
  await ensureDestinationDir(paths.destination, { create: !options.dryRun });
  const decision = await destinationNeedsUpdate(paths, raw);
  const previous = await readStatusFile(paths.statusPath);
  const checkedAt = isoNow();
  const base = {
    checkedAt,
    registryUpdatedAt: registry.updatedAt,
    projectCount: registry.projects.length,
    errorCode: null,
  };
  if (!decision.write) {
    return buildSyncStatus({
      status: "unchanged",
      syncedAt: previous?.syncedAt ?? checkedAt,
      ...base,
    });
  }
  if (!options.dryRun) {
    await writeAtomicMode(paths.destination, raw, 0o600).catch((error) => {
      throw new SyncError("write_failed", `대상 쓰기에 실패했습니다 [${String(error?.code || "io_error")}]`);
    });
    await chmod(paths.destination, 0o600).catch(() => {});
  }
  return buildSyncStatus({ status: options.dryRun ? "unchanged" : "synced", syncedAt: checkedAt, ...base });
}

function statusKorean(status) {
  return { synced: "완료", unchanged: "변경 없음", error: "실패" }[status] || status;
}

async function runSyncCommand(paths, options) {
  const dry = Boolean(options.dryRun);
  let locked = false;
  let timedOut = false;
  let doc = null;
  let failed = null;
  try {
    const work = (async () => {
      if (!dry) {
        // The lock lives next to the destination, so the directory must
        // exist first. Every failure lands in the same bounded error path —
        // sync output never carries paths or raw error messages.
        await ensureDestinationDir(paths.destination);
        locked = await acquireLock(paths.lockPath);
        if (!locked) return { skipped: true };
      }
      return { doc: await syncPass(paths, options) };
    })();
    // The watchdog bounds the whole pass: a wedged fs call (protected path,
    // dataless cloud file, dead mount) rejects here instead of hanging the
    // launchd job forever. The detached work may finish later — its late
    // lock release is pid-guarded so it cannot steal a newer run's lock.
    work.catch(() => {});
    const result = await bounded(work, syncTimeoutMs());
    if (result?.skipped) {
      console.log("다른 동기화 실행이 진행 중입니다 — 이번 실행은 건너뜁니다.");
      return 0;
    }
    doc = result.doc;
  } catch (error) {
    failed = error;
    timedOut = error?.code === "sync_timeout";
    const previous = await bounded(readStatusFile(paths.statusPath), statusWriteTimeoutMs).catch(() => null);
    doc = buildSyncStatus({
      status: "error",
      checkedAt: isoNow(),
      syncedAt: previous?.syncedAt ?? null,
      registryUpdatedAt: previous?.registryUpdatedAt ?? null,
      projectCount: previous?.projectCount ?? null,
      errorCode: syncErrorCode(error),
    });
  } finally {
    if (locked) await bounded(releaseLock(paths.lockPath), statusWriteTimeoutMs).catch(() => {});
  }

  // A timed-out run leaves the wedged fs work pending on the threadpool —
  // and even process.exit() cannot unwind it: libuv's exit path joins all
  // threadpool threads, so a dead open() makes exit() hang too. The bounded
  // reporting above already landed; SIGKILL is the only guaranteed exit.
  const finish = (code) => {
    if (timedOut) process.kill(process.pid, "SIGKILL");
    return code;
  };

  if (dry) {
    if (failed) {
      console.error(`[dry-run] 검증 실패 [${doc.errorCode}] — 대상은 그대로 유지됩니다.`);
      return finish(1);
    }
    console.log(`[dry-run] 검증 통과: 프로젝트 ${doc.projectCount}개, 기준일 ${doc.registryUpdatedAt}`);
    console.log(`[dry-run] 소스: ${paths.source}`);
    console.log(`[dry-run] 대상: ${paths.destination}`);
    console.log(`[dry-run] 상태 파일: ${paths.statusPath}`);
    console.log("[dry-run] 파일을 변경하지 않았습니다.");
    return finish(0);
  }

  // The error record itself is part of the contract: try hard to persist it.
  // Reporting stays bounded — a status write failure is still only a code.
  // On timeout the status write itself gets a short bound so the process
  // still exits even if the status directory is the wedged filesystem.
  let statusError = null;
  await bounded(writeStatus(paths, doc), statusWriteTimeoutMs).catch((error) => {
    statusError = error;
  });
  if (statusError) {
    console.error(`status 기록에 실패했습니다 [${syncErrorCode(statusError)}]`);
    if (failed) console.error(`동기화를 거부했습니다 [${doc.errorCode}]`);
    return finish(2);
  }
  if (failed) {
    console.error(`동기화를 거부했습니다 [${doc.errorCode}]`);
    return finish(1);
  }
  if (options.json) {
    console.log(JSON.stringify({ outcome: doc.status, status: doc }));
  } else {
    console.log(
      `동기화 ${statusKorean(doc.status)} · 프로젝트 ${doc.projectCount}개 · 레지스트리 기준일 ${doc.registryUpdatedAt}`,
    );
  }
  return finish(0);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// LaunchAgent template. install resolves only the operator's HOME and the
// current Node executable; the script is the staged copy and every data
// path is the explicit --source / --destination / --status value baked in
// verbatim — nothing under a TCC-protected prefix may reach this plist.
function launchdPlist({ script, source, destination, statusPath }) {
  const logs = join(homedir(), "Library", "Logs");
  const args = [
    process.execPath,
    script,
    "sync",
    "--source",
    source,
    "--destination",
    destination,
    "--status",
    statusPath,
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistLabel}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${syncIntervalSeconds}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logs, "hermes-registry-sync.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logs, "hermes-registry-sync.error.log"))}</string>
</dict>
</plist>
`;
}

function plistTargetPath() {
  return join(homedir(), "Library", "LaunchAgents", plistFileName);
}

// launchctl is invoked only from the explicit install/uninstall/status
// commands; the binary can be overridden for sandboxed testing.
const launchctlBin = process.env.HERMES_REGISTRY_SYNC_LAUNCHCTL || "launchctl";

function launchctl(args) {
  return spawnSync(launchctlBin, args, { encoding: "utf8" });
}

function guiDomain() {
  return `gui/${process.getuid()}`;
}

function agentLoaded() {
  const result = launchctl(["print", `${guiDomain()}/${plistLabel}`]);
  return result.status === 0;
}

async function runInstall(paths, options) {
  const stageDir = resolveStageDir(options);
  // Every path the launchd job will touch must sit outside TCC-protected and
  // cloud-backed directories: a blocked open() suspends the job forever
  // instead of failing. Refuse by default; an explicit flag keeps an
  // operator with MDM-granted access in charge.
  const guarded = [
    ["source", paths.source],
    ["destination", paths.destination],
    ["status", paths.statusPath],
    ["stage-dir", stageDir],
  ];
  const blocked = guarded.filter(([, value]) => value && protectedPrefixFor(value));
  if (blocked.length > 0 && !options.allowProtectedPaths) {
    const listed = blocked.map(([label, value]) => `${label}=${value}`).join(", ");
    throw new SyncError(
      "protected_path",
      `launchd가 접근할 수 없는 보호 경로가 포함되어 있습니다: ${listed}\n` +
        "Documents/Desktop/Downloads/iCloud/CloudStorage 아래 경로에서 LaunchAgent의 open()은 무기한 정지합니다.\n" +
        "Application Support 아래 스테이징/미러 경로를 사용하거나, 명시적으로 --allow-protected-paths를 지정하세요.",
    );
  }
  if (blocked.length > 0) {
    console.error(
      `경고: 보호 경로를 명시적으로 허용했습니다 — launchd 실행이 정지할 수 있습니다: ` +
        blocked.map(([label, value]) => `${label}=${value}`).join(", "),
    );
  }
  const staged = stagedToolPaths(stageDir);
  const plist = launchdPlist({
    script: staged.find((entry) => entry.staged.endsWith("hermes-registry-sync.mjs")).staged,
    source: paths.source,
    destination: paths.destination,
    statusPath: paths.statusPath,
  });
  const target = plistTargetPath();
  if (options.dryRun) {
    console.log("[dry-run] 스테이징될 도구 파일:");
    for (const entry of staged) console.log(`  ${entry.source} -> ${entry.staged}`);
    console.log("[dry-run] 구성될 plist:");
    console.log(plist);
    console.log(`[dry-run] plist 대상: ${target}`);
    console.log(`[dry-run] 동기화 경로 설정: ${syncConfigPath()}`);
    if (!options.noLoad) {
      console.log(`[dry-run] 로드 명령: launchctl bootstrap ${guiDomain()} ${target}`);
    }
    return 0;
  }
  // Stage the runnable copy first so the plist never references a script the
  // agent cannot open.
  await mkdir(stageDir, { recursive: true, mode: 0o700 });
  await chmod(stageDir, 0o700).catch(() => {});
  for (const entry of staged) {
    const contents = await readFile(entry.source, "utf8").catch(() => {
      throw new SyncError("stage_source_unreadable", `도구 파일을 읽을 수 없습니다: ${entry.source}`);
    });
    await writeAtomicMode(entry.staged, contents, 0o600).catch(() => {
      throw new SyncError("stage_write_failed", `도구를 스테이징할 수 없습니다: ${entry.staged}`);
    });
    console.log(`도구를 스테이징했습니다: ${entry.staged}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeAtomicMode(target, plist, 0o644);
  console.log(`plist를 기록했습니다: ${target}`);
  // Persist the explicit path contract where the Studio export can discover
  // the mirror target — the config is written even with --no-load because
  // the agreed paths are already decided.
  const configPath = syncConfigPath();
  await writeAtomicMode(configPath, `${JSON.stringify(buildSyncConfig(paths, stageDir), null, 2)}\n`, 0o600).catch(() => {
    throw new SyncError("config_write_failed", `동기화 경로 설정을 기록할 수 없습니다: ${configPath}`);
  });
  console.log(`동기화 경로 설정을 기록했습니다: ${configPath}`);
  if (options.noLoad) {
    console.log("로드는 건너뛰었습니다 (--no-load). 적용하려면:");
    console.log(`  launchctl bootstrap ${guiDomain()} "${target}"`);
    return 0;
  }
  if (agentLoaded()) {
    const out = launchctl(["bootout", `${guiDomain()}/${plistLabel}`]);
    if (out.status !== 0) throw new SyncError("launchctl", `기존 에이전트 해제 실패: ${out.stderr?.trim() || out.status}`);
  }
  const boot = launchctl(["bootstrap", guiDomain(), target]);
  if (boot.status !== 0) {
    throw new SyncError("launchctl", `LaunchAgent 로드 실패: ${boot.stderr?.trim() || boot.status}`);
  }
  console.log(`LaunchAgent를 로드했습니다: ${plistLabel} (RunAtLoad + ${syncIntervalSeconds}초 간격)`);
  return 0;
}

async function runUninstall(options) {
  const target = plistTargetPath();
  const stageDir = resolveStageDir(options);
  if (options.dryRun) {
    console.log(`[dry-run] ${agentLoaded() ? "bootout 후 " : ""}plist를 제거합니다: ${target}`);
    console.log(`[dry-run] 스테이징된 도구를 제거합니다: ${stageDir}`);
    console.log(`[dry-run] 동기화 경로 설정을 제거합니다: ${syncConfigPath()}`);
    return 0;
  }
  if (agentLoaded()) {
    const out = launchctl(["bootout", `${guiDomain()}/${plistLabel}`]);
    if (out.status !== 0) {
      throw new SyncError("launchctl", `LaunchAgent 해제 실패: ${out.stderr?.trim() || out.status}`);
    }
    console.log("LaunchAgent를 해제했습니다.");
  }
  const existed = Boolean(await lstatOrNull(target));
  if (existed) await rm(target, { force: true });
  console.log(existed ? `plist를 제거했습니다: ${target}` : `plist가 없습니다: ${target}`);
  const stagedExisted = Boolean(await lstatOrNull(stageDir));
  if (stagedExisted) await rm(stageDir, { force: true, recursive: true });
  console.log(stagedExisted ? `스테이징된 도구를 제거했습니다: ${stageDir}` : `스테이징된 도구가 없습니다: ${stageDir}`);
  const configPath = syncConfigPath();
  const configExisted = Boolean(await lstatOrNull(configPath));
  if (configExisted) await rm(configPath, { force: true });
  console.log(configExisted ? `동기화 경로 설정을 제거했습니다: ${configPath}` : `동기화 경로 설정이 없습니다: ${configPath}`);
  return 0;
}

async function runStatus(paths, options) {
  console.log(`LaunchAgent ${plistLabel}: ${agentLoaded() ? "로드됨" : "로드되지 않음"}`);
  const plistExists = Boolean(await lstatOrNull(plistTargetPath()));
  console.log(`plist: ${plistExists ? "설치됨" : "없음"} (${plistTargetPath()})`);
  const stageDir = resolveStageDir(options);
  const stagedInfo = await lstatOrNull(join(stageDir, "hermes-registry-sync.mjs")).catch(() => null);
  console.log(`스테이징된 도구: ${stagedInfo ? "설치됨" : "없음"} (${stageDir})`);
  const configInfo = await lstatOrNull(syncConfigPath()).catch(() => null);
  console.log(`동기화 경로 설정: ${configInfo ? "기록됨" : "없음"} (${syncConfigPath()})`);
  if (!paths.statusPath) {
    console.log("상태 파일 경로를 확인할 수 없습니다 (--status 또는 --destination 필요).");
    return 1;
  }
  const doc = await readStatusFile(paths.statusPath);
  if (!doc) {
    console.log(`상태 파일을 읽을 수 없습니다: ${paths.statusPath}`);
    console.log("아직 동기화가 실행되지 않았거나 상태 파일이 손상됐습니다.");
    return 1;
  }
  console.log(`마지막 동기화: ${statusKorean(doc.status)}`);
  console.log(`  확인 시각: ${doc.checkedAt}`);
  console.log(`  동기화 시각: ${doc.syncedAt ?? "기록 없음"}`);
  console.log(`  레지스트리 기준일: ${doc.registryUpdatedAt ?? "알 수 없음"}`);
  console.log(`  프로젝트 수: ${doc.projectCount ?? "알 수 없음"}`);
  if (doc.errorCode) console.log(`  오류 코드: ${doc.errorCode}`);
  return doc.status === "error" ? 1 : 0;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage);
    return;
  }
  const needsPaths = options.command === "sync" || options.command === "install";
  let paths;
  try {
    paths = resolveSyncPaths(options, process.env, { requirePaths: needsPaths });
  } catch (error) {
    console.error(error.message);
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  try {
    if (options.command === "sync") {
      process.exitCode = await runSyncCommand(paths, options);
    } else if (options.command === "install") {
      process.exitCode = await runInstall(
        { source: paths.source, destination: paths.destination, statusPath: paths.statusPath },
        options,
      );
    } else if (options.command === "uninstall") {
      process.exitCode = await runUninstall(options);
    } else {
      process.exitCode = await runStatus(paths, options);
    }
  } catch (error) {
    if (options.command === "sync") {
      // sync must never leak paths or raw messages into launchd logs.
      console.error(`동기화를 거부했습니다 [${syncErrorCode(error)}]`);
    } else {
      console.error(`실패 [${syncErrorCode(error)}]: ${error instanceof Error ? error.message : error}`);
    }
    process.exitCode = 2;
  }
}

// Only run the CLI when this file is the entry point — helpers are exported
// for reuse/tests and must not parse a host process's argv.
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  void main();
}

export {
  acquireLock,
  buildSyncStatus,
  launchdPlist,
  parseArgs,
  resolveSyncPaths,
  runSyncCommand,
  writeAtomicMode,
};
