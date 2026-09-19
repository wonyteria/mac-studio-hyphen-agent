#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const preflightScript = join(repoRoot, "scripts", "hermes-registry-preflight.mjs");
const plistName = "com.hyphen.hermes-ops-worker.plist";
const manifestName = "hermes-runtime-manifest.json";
const journalName = "hermes-runtime-journal.json";
const runtimeDirs = ["requests", "locks", "worktrees", "persistence"];
const managedNames = new Set(["hermes-local-worker.mjs", "hermes-projects.json", plistName]);
const workerExports = [
  "runCommand",
  "trimOutput",
  "isProtectedPath",
  "isSafePersistentPath",
  "parseCodexOutput",
  "parseHermesDecision",
  "classifyObviousRequest",
  "main",
];
const relativeImportPattern = /(from\s+["']\.{1,2}\/|import\s*\(\s*["']\.{1,2}\/|require\s*\(\s*["']\.{1,2}\/)/;

const usage = `Hermes 런타임 설치 도구

소스 저장소의 worker와 프로젝트 레지스트리를 런타임 디렉터리에 안전하게
설치/갱신/검증/롤백합니다. 기본은 dry-run plan이며 파일을 변경하지 않습니다.
런타임의 .env는 절대 읽거나 출력하거나 덮어쓰지 않습니다.

이 도구는 LaunchAgent를 load하거나 서비스를 재시작하지 않습니다.
생성된 plist는 런타임 디렉터리에만 기록되며, 실제 적용은 운영자가 수행합니다.

사용법:
  node scripts/hermes-runtime-install.mjs [옵션]

모드 (기본: plan):
  --apply              설치/갱신 실행 (트랜잭션 기록, 백업 후 원자적 교체)
  --verify             설치 상태 검증 (체크섬, 구문, 모듈 로드, 저널/manifest 일치)
  --rollback           가장 최근 apply 트랜잭션을 적용 전 상태로 복원

옵션:
  --runtime <dir>      런타임 디렉터리 (기본: HERMES_RUNTIME_DIR 또는
                       ~/.local/share/hermes-ops)
  --worker <path>      worker 소스 (기본: scripts/hermes-local-worker.mjs)
  --registry <path>    레지스트리 소스 (기본: hermes-projects.json)
  --preflight          --verify 시 레지스트리 preflight도 실행
  --strict             --verify 시 warning도 실패로 처리
  --force              --rollback 시 apply 이후 변경된 파일도 강제 복원/제거
  --json               결과를 JSON으로 출력
  --help               이 도움말

트랜잭션/롤백 규칙:
  - 각 --apply는 ${journalName}에 대상별 existedBefore,
    action(install/update/unchanged), backup 경로를 기록합니다.
  - --rollback은 최근 applied 트랜잭션을 되돌립니다: update는 백업 복구,
    최초 install은 파일 제거, apply가 만든 빈 디렉터리도 제거합니다.
  - apply 이후 대상 파일이 변경됐으면 기본은 건너뛰고 경고합니다 (--force로 강제).
  - apply 중간 실패 시 이미 적용된 managed file은 트랜잭션으로 자동 복구되고,
    복구가 실패하면 트랜잭션이 in-progress로 남아 --rollback이 마저 되돌립니다.
  - .env와 requests/locks/worktrees/persistence 내용 등 비관리 파일은 절대
    변경하지 않습니다.

설치 대상:
  hermes-local-worker.mjs          worker 단일 파일 (mode 0755)
  hermes-projects.json             프로젝트 레지스트리 (mode 0644)
  ${plistName}   LaunchAgent 템플릿 (load하지 않음)
  ${manifestName}      현재 상태 증거 (sha256, 트랜잭션, 시각)
  ${journalName}      apply 트랜잭션 감사 로그
  requests/ locks/ worktrees/ persistence/   worker 하위 디렉터리

종료 코드:
  0  plan 완료 / apply 성공 / verify 통과 / rollback 복구 성공
  1  verify에서 error 발견 (--strict이면 warning 포함), rollback할 트랜잭션 없음,
     또는 rollback 일부 항목을 건너뜀
  2  인자 오류, 저널 손상, 또는 파일 입출력 실패
`;

function parseArgs(argv) {
  const options = { mode: "plan", preflight: false, json: false, strict: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.mode = "apply";
    else if (arg === "--verify") options.mode = "verify";
    else if (arg === "--rollback") options.mode = "rollback";
    else if (arg === "--preflight") options.preflight = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--runtime") options.runtime = argv[++index];
    else if (arg === "--worker") options.workerSource = argv[++index];
    else if (arg === "--registry") options.registrySource = argv[++index];
    else throw new Error(`알 수 없는 옵션입니다: ${arg}`);
  }
  return options;
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function readOrNull(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function writeAtomic(filePath, contents) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, filePath);
}

async function restoreFromFile(backup, target) {
  const temporary = `${target}.restore-tmp-${process.pid}`;
  await copyFile(backup, temporary);
  await rename(temporary, target);
}

async function removeEmptyDir(dir) {
  const entries = await readdir(dir);
  if (entries.length) throw new Error(`not empty: ${dir}`);
  await rm(dir, { recursive: true });
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function launchdPlist(runtimeDir) {
  const node = process.execPath;
  const logs = join(homedir(), "Library", "Logs");
  const command = [
    `set -a`,
    `source "${runtimeDir}/.env"`,
    `set +a`,
    `exec "${node}" "${runtimeDir}/hermes-local-worker.mjs"`,
  ].join("; ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hyphen.hermes-ops-worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-c</string>
    <string>${escapeXml(command)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(runtimeDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logs, "hermes-ops-worker.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logs, "hermes-ops-worker.error.log"))}</string>
</dict>
</plist>
`;
}

function managedFiles(options) {
  return [
    {
      key: "worker",
      name: "hermes-local-worker.mjs",
      source: resolve(options.workerSource || join(repoRoot, "scripts", "hermes-local-worker.mjs")),
      mode: 0o755,
    },
    {
      key: "registry",
      name: "hermes-projects.json",
      source: resolve(options.registrySource || join(repoRoot, "hermes-projects.json")),
      mode: 0o644,
    },
  ];
}

async function fileAction(file, runtimeDir) {
  const target = join(runtimeDir, file.name);
  const sourceContents = await readFile(file.source, "utf8");
  const targetContents = await readOrNull(target);
  const targetStat = await statOrNull(target);
  const status =
    targetContents === null
      ? "install"
      : sha256(targetContents) === sha256(sourceContents)
        ? "unchanged"
        : "update";
  return {
    ...file,
    target,
    sourceContents,
    status,
    targetIsDirectory: Boolean(targetStat?.isDirectory()),
  };
}

async function sourceRevision() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function readJournal(runtimeDir) {
  const journalPath = join(runtimeDir, journalName);
  const raw = await readOrNull(journalPath);
  if (raw === null) return { journalPath, journal: { transactions: [] }, exists: false, corrupt: false };
  try {
    const journal = JSON.parse(raw);
    if (!journal || !Array.isArray(journal.transactions)) throw new Error("transactions 배열이 없습니다.");
    return { journalPath, journal, exists: true, corrupt: false };
  } catch {
    return { journalPath, journal: null, exists: true, corrupt: true };
  }
}

async function writeJournal(journalPath, journal) {
  await writeAtomic(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
}

async function buildPlan(options) {
  const runtimeDir = resolve(
    options.runtime || process.env.HERMES_RUNTIME_DIR || join(homedir(), ".local", "share", "hermes-ops"),
  );
  const files = [];
  for (const file of managedFiles(options)) {
    files.push(await fileAction(file, runtimeDir));
  }
  const plistTarget = join(runtimeDir, plistName);
  const plistContents = launchdPlist(runtimeDir);
  const plistStat = await statOrNull(plistTarget);
  files.push({
    key: "plist",
    name: plistName,
    source: "(generated)",
    target: plistTarget,
    sourceContents: plistContents,
    status: !plistStat
      ? "install"
      : (await readOrNull(plistTarget)) === plistContents
        ? "unchanged"
        : "update",
    targetIsDirectory: Boolean(plistStat?.isDirectory()),
    mode: 0o644,
  });
  const envExists = Boolean(await statOrNull(join(runtimeDir, ".env")));
  const missingDirs = [];
  for (const name of runtimeDirs) {
    const info = await statOrNull(join(runtimeDir, name));
    if (!info?.isDirectory()) missingDirs.push(name);
  }
  const journalInfo = await readJournal(runtimeDir);
  return { runtimeDir, files, envExists, missingDirs, journalInfo };
}

function latestTransaction(journalInfo) {
  if (!journalInfo.journal) return null;
  const transactions = journalInfo.journal.transactions;
  return transactions.length ? transactions[transactions.length - 1] : null;
}

function printJournalLine(journalInfo) {
  if (journalInfo.corrupt) {
    console.log(`저널: ${journalName}이(가) 손상됐습니다 — apply/rollback 전에 수동 확인이 필요합니다.`);
    return;
  }
  const tx = latestTransaction(journalInfo);
  if (!tx) {
    console.log("저널: 기록된 트랜잭션이 없습니다.");
    return;
  }
  console.log(`저널: 최근 트랜잭션 ${tx.id} (상태: ${tx.status})`);
  if (tx.status === "in-progress") {
    console.log("    중단된 apply입니다. --rollback으로 적용 전 상태를 복원할 수 있습니다.");
  }
}

function printPlan(plan) {
  console.log(`런타임 디렉터리: ${plan.runtimeDir}`);
  console.log(`모드: plan (dry-run, 파일 변경 없음)`);
  console.log("");
  for (const file of plan.files) {
    const label = { install: "신규 설치", update: "갱신 (백업 후 교체)", unchanged: "변경 없음" }[file.status];
    console.log(`[${file.status}] ${file.name}: ${label}`);
    console.log(`    소스: ${file.source}`);
    console.log(`    대상: ${file.target}`);
  }
  console.log("");
  console.log(
    plan.missingDirs.length
      ? `생성할 디렉터리: ${plan.missingDirs.join(", ")}`
      : "런타임 하위 디렉터리가 모두 존재합니다.",
  );
  console.log(
    plan.envExists
      ? ".env: 존재합니다 — 읽거나 변경하지 않고 그대로 보존합니다."
      : ".env: 없습니다 — worker 시작 전에 운영자가 HERMES_OPS_URL, HERMES_WORKER_TOKEN 등을 채워야 합니다. (.env.example 참조)",
  );
  printJournalLine(plan.journalInfo);
  console.log("");
  console.log("실제 적용하려면 --apply를 추가해 다시 실행하세요.");
}

async function compensate(appliedEntries, createdDirs) {
  const errors = [];
  for (const entry of [...appliedEntries].reverse()) {
    try {
      if (entry.action === "install") {
        await rm(entry.target, { force: true });
      } else if (entry.action === "update" && entry.backup) {
        await restoreFromFile(entry.backup, entry.target);
      }
    } catch (error) {
      errors.push({ name: entry.name, error: String(error?.message || error) });
    }
  }
  for (const dir of createdDirs.reverse()) {
    try {
      await removeEmptyDir(dir);
    } catch {
      // Directory is not empty or already gone; leave it.
    }
  }
  return errors;
}

async function manifestForState(plan, { state, transaction, rolledBackFrom }) {
  const files = {};
  for (const file of plan.files) {
    const contents = await readOrNull(file.target);
    if (contents === null) continue;
    files[file.name] = {
      sha256: sha256(contents),
      bytes: Buffer.byteLength(contents),
      matchesSource: sha256(contents) === sha256(file.sourceContents),
    };
  }
  return {
    state,
    updatedAt: new Date().toISOString(),
    transaction: transaction || null,
    rolledBackFrom: rolledBackFrom || null,
    runtimeDir: plan.runtimeDir,
    sourceRepo: repoRoot,
    sourceRevision: await sourceRevision(),
    files,
  };
}

async function writeManifest(plan, manifest) {
  const manifestPath = join(plan.runtimeDir, manifestName);
  if (!Object.keys(manifest.files).length) {
    await rm(manifestPath, { force: true });
    return null;
  }
  await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

async function runApply(plan) {
  if (plan.journalInfo.corrupt) {
    throw new Error(`${journalName}이(가) 손상됐습니다. 수동으로 정리한 뒤 다시 실행하세요.`);
  }
  const blocked = plan.files.find((file) => file.targetIsDirectory);
  if (blocked) {
    throw new Error(`대상이 디렉터리라 덮어쓸 수 없습니다: ${blocked.target}`);
  }

  const txId = stamp();
  const tx = {
    id: txId,
    startedAt: new Date().toISOString(),
    appliedAt: null,
    status: "in-progress",
    runtimeDir: plan.runtimeDir,
    sourceRevision: await sourceRevision(),
    createdDirs: plan.missingDirs.map((name) => join(plan.runtimeDir, name)),
    entries: plan.files.map((file) => ({
      name: file.name,
      target: file.target,
      action: file.status,
      existedBefore: file.status !== "install",
      backup: file.status === "update" ? `${file.target}.backup-${txId}` : null,
      afterSha256: sha256(file.sourceContents),
    })),
  };

  await mkdir(plan.runtimeDir, { recursive: true });
  const journal = plan.journalInfo.journal;
  journal.transactions.push(tx);
  await writeJournal(plan.journalInfo.journalPath, journal);

  const applied = [];
  const dirsCreated = [];
  try {
    for (const file of plan.files) {
      if (file.status === "unchanged") continue;
      const entry = tx.entries.find((item) => item.name === file.name);
      if (entry.backup) await copyFile(file.target, entry.backup);
      await writeAtomic(file.target, file.sourceContents);
      applied.push(entry);
      await chmod(file.target, file.mode);
    }
    for (const name of plan.missingDirs) {
      const dir = join(plan.runtimeDir, name);
      await mkdir(dir, { recursive: true });
      dirsCreated.push(dir);
    }
  } catch (error) {
    const compensationErrors = await compensate(applied, dirsCreated);
    tx.status = compensationErrors.length ? "in-progress" : "failed";
    tx.error = String(error?.message || error);
    if (compensationErrors.length) tx.compensationErrors = compensationErrors;
    await writeJournal(plan.journalInfo.journalPath, journal).catch(() => {});
    const detail = compensationErrors.length
      ? `자동 복구도 실패했습니다 (${compensationErrors.map((item) => item.name).join(", ")}). 트랜잭션 ${tx.id}가 in-progress로 남아 있으니 --rollback으로 복구하세요.`
      : `변경된 managed file ${applied.length}건을 트랜잭션 ${tx.id} 기준으로 모두 복구했습니다.`;
    const wrapped = new Error(`적용에 실패했습니다: ${error.message}\n${detail}`);
    wrapped.cause = error;
    throw wrapped;
  }

  tx.status = "applied";
  tx.appliedAt = new Date().toISOString();
  await writeJournal(plan.journalInfo.journalPath, journal);
  const manifest = await manifestForState(plan, { state: "installed", transaction: tx.id });
  await writeManifest(plan, manifest);
  return { tx, manifest };
}

function printApply(plan, result) {
  console.log(`런타임 디렉터리: ${plan.runtimeDir}`);
  console.log(`모드: apply (트랜잭션 ${result.tx.id})`);
  console.log("");
  for (const entry of result.tx.entries) {
    const label = { install: "신규 설치", update: "갱신", unchanged: "변경 없음" }[entry.action];
    console.log(`[${entry.action}] ${entry.name}: ${label}${entry.backup ? `  (백업: ${entry.backup})` : ""}`);
  }
  console.log(`[journal] ${journalName}에 트랜잭션을 기록했습니다.`);
  console.log(`[install] ${manifestName}`);
  console.log("");
  console.log(
    plan.envExists
      ? ".env: 기존 파일을 그대로 보존했습니다 (읽지 않음)."
      : ".env: 없습니다 — worker 시작 전에 운영자가 채워야 합니다. (.env.example 참조)",
  );
  console.log("");
  console.log(`검증: node scripts/hermes-runtime-install.mjs --verify --runtime "${plan.runtimeDir}" --preflight`);
  console.log(`롤백: node scripts/hermes-runtime-install.mjs --rollback --runtime "${plan.runtimeDir}"`);
  console.log("LaunchAgent는 load하지 않았습니다. 적용 절차는 RUNTIME.md를 참조하세요.");
}

function rollbackTargets(journal) {
  const targets = new Set(["applied", "in-progress", "rolled-back-partial"]);
  for (let index = journal.transactions.length - 1; index >= 0; index -= 1) {
    if (targets.has(journal.transactions[index].status)) return journal.transactions[index];
  }
  return null;
}

async function runRollback(plan, options) {
  if (plan.journalInfo.corrupt) {
    throw new Error(`${journalName}이(가) 손상됐습니다. 수동으로 확인한 뒤 다시 실행하세요.`);
  }
  const journal = plan.journalInfo.journal;
  const tx = rollbackTargets(journal);
  if (!tx) {
    return { tx: null, restored: [], removed: [], skipped: [], missing: [], dirsRemoved: [] };
  }

  const restored = [];
  const removed = [];
  const skipped = [];
  const missing = [];
  for (const entry of [...tx.entries].reverse()) {
    if (entry.action === "unchanged" || !managedNames.has(entry.name)) continue;
    if (resolve(entry.target).indexOf(resolve(plan.runtimeDir) + sep) !== 0) {
      skipped.push({ name: entry.name, reason: "런타임 디렉터리 밖 대상" });
      continue;
    }
    const current = await readOrNull(entry.target);
    const info = await statOrNull(entry.target);
    if (entry.action === "install") {
      if (current === null && !info) {
        missing.push({ name: entry.name, reason: "이미 없음" });
        continue;
      }
      if (info?.isDirectory()) {
        skipped.push({ name: entry.name, reason: "디렉터리라 제거하지 않음" });
        continue;
      }
      if (!options.force && entry.afterSha256 && current !== null && sha256(current) !== entry.afterSha256) {
        skipped.push({ name: entry.name, reason: "apply 이후 내용이 변경됨 (--force로 강제 제거)" });
        continue;
      }
      await rm(entry.target, { force: true });
      removed.push(entry.name);
    } else if (entry.action === "update") {
      if (!entry.backup || !(await statOrNull(entry.backup))) {
        missing.push({ name: entry.name, reason: "백업 없음" });
        continue;
      }
      if (!options.force && entry.afterSha256 && current !== null && sha256(current) !== entry.afterSha256) {
        skipped.push({ name: entry.name, reason: "apply 이후 내용이 변경됨 (--force로 강제 복원)" });
        continue;
      }
      await restoreFromFile(entry.backup, entry.target);
      const mode = plan.files.find((file) => file.name === entry.name)?.mode;
      if (mode) await chmod(entry.target, mode);
      restored.push({ name: entry.name, backup: entry.backup });
    }
  }

  const dirsRemoved = [];
  for (const dir of (tx.createdDirs || []).slice().reverse()) {
    try {
      await removeEmptyDir(dir);
      dirsRemoved.push(dir);
    } catch {
      // Not empty or already removed; leave it.
    }
  }

  tx.status = skipped.length ? "rolled-back-partial" : "rolled-back";
  tx.rolledBackAt = new Date().toISOString();
  await writeJournal(plan.journalInfo.journalPath, journal);

  const manifest = await manifestForState(plan, {
    state: "rolled-back",
    transaction: null,
    rolledBackFrom: tx.id,
  });
  await writeManifest(plan, manifest);

  return { tx, restored, removed, skipped, missing, dirsRemoved };
}

function printRollback(plan, result) {
  console.log(`런타임 디렉터리: ${plan.runtimeDir}`);
  console.log(`모드: rollback${plan.options?.force ? " (--force)" : ""}`);
  console.log("");
  if (!result.tx) {
    console.log("롤백할 트랜잭션이 없습니다 (applied/in-progress 트랜잭션 없음).");
    return;
  }
  console.log(`트랜잭션: ${result.tx.id} → ${result.tx.status}`);
  for (const item of result.restored) {
    console.log(`[백업 복구] ${item.name} <- ${item.backup}`);
  }
  for (const name of result.removed) {
    console.log(`[제거] ${name} (최초 설치 파일)`);
  }
  for (const dir of result.dirsRemoved) {
    console.log(`[디렉터리 제거] ${dir}`);
  }
  for (const item of result.missing) {
    console.log(`[이미 없음] ${item.name}: ${item.reason}`);
  }
  for (const item of result.skipped) {
    console.log(`[건너뜀] ${item.name}: ${item.reason}`);
  }
  console.log("");
  console.log(`${manifestName}를 현재 상태 기준으로 다시 기록했습니다. --verify로 확인하세요.`);
  if (result.skipped.length) {
    console.log("일부 항목을 건너뛰어 완전 복원이 아닙니다. 확인 후 --force로 다시 실행할 수 있습니다.");
  }
}

async function verifyRuntime(plan, options) {
  const checks = [];
  const push = (level, code, message) => checks.push({ level, code, message });

  const runtimeInfo = await statOrNull(plan.runtimeDir);
  if (!runtimeInfo?.isDirectory()) {
    push("error", "runtime_missing", `런타임 디렉터리가 없습니다: ${plan.runtimeDir}`);
    return { checks, summary: summarize(checks) };
  }

  for (const name of runtimeDirs) {
    const info = await statOrNull(join(plan.runtimeDir, name));
    if (!info?.isDirectory()) push("error", "missing_dir", `런타임 하위 디렉터리가 없습니다: ${name}`);
  }

  const presentFiles = new Map();
  for (const file of plan.files) {
    const targetContents = await readOrNull(file.target);
    if (targetContents === null) {
      push("error", `${file.key}_missing`, `${file.name}이(가) 런타임에 없습니다: ${file.target}`);
      continue;
    }
    presentFiles.set(file.name, sha256(targetContents));
    if (sha256(targetContents) !== sha256(file.sourceContents)) {
      push(
        "error",
        `${file.key}_differs`,
        `${file.name}이(가) 소스와 다릅니다. --apply로 갱신하거나 --rollback으로 복구하세요.`,
      );
      continue;
    }
    if (file.key === "plist" && !targetContents.includes(plan.runtimeDir)) {
      push("error", "plist_outdated", `${plistName}이(가) 현재 런타임 경로를 가리키지 않습니다.`);
      continue;
    }
    push("ok", `${file.key}_ok`, `${file.name}이(가) 소스와 일치합니다.`);
  }

  const worker = plan.files.find((file) => file.key === "worker");
  if (worker && (await statOrNull(worker.target))) {
    const syntax = spawnSync(process.execPath, ["--check", worker.target], { encoding: "utf8" });
    if (syntax.status !== 0) {
      push("error", "worker_syntax", `worker 구문 검사 실패: ${(syntax.stderr || "").trim().split("\n")[0]}`);
    } else {
      push("ok", "worker_syntax", "worker 구문 검사를 통과했습니다.");
    }
    const workerSource = await readOrNull(worker.target);
    if (workerSource !== null && relativeImportPattern.test(workerSource)) {
      push(
        "error",
        "worker_relative_import",
        "worker가 상대 경로 모듈을 import합니다. 런타임에는 단일 파일만 배포해야 합니다.",
      );
    }
    const smoke = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(process.env.HERMES_SMOKE_TARGET); const need = ${JSON.stringify(workerExports)}; const missing = need.filter((k) => typeof m[k] !== "function"); if (missing.length) { console.error("missing exports: " + missing.join(",")); process.exit(1); }`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, HERMES_SMOKE_TARGET: pathToFileURL(worker.target).href },
      },
    );
    if (smoke.status !== 0) {
      push("error", "worker_smoke", `worker 모듈 로드 실패: ${(smoke.stderr || "").trim().split("\n")[0]}`);
    } else {
      push("ok", "worker_smoke", "worker 모듈이 main() 없이 로드되고 필수 export가 존재합니다.");
    }
  }

  const registry = plan.files.find((file) => file.key === "registry");
  if (registry && (await readOrNull(registry.target)) !== null) {
    try {
      const parsed = JSON.parse(await readFile(registry.target, "utf8"));
      const count = Array.isArray(parsed.projects) ? parsed.projects.length : 0;
      if (!count) throw new Error("projects 배열이 비어 있습니다.");
      push("ok", "registry_json", `레지스트리 JSON이 유효합니다 (프로젝트 ${count}개).`);
    } catch (error) {
      push("error", "registry_json", `레지스트리 JSON이 유효하지 않습니다: ${error.message}`);
    }
  }

  if (plan.envExists) {
    push("ok", "env_present", ".env가 존재합니다 (내용은 읽지 않음).");
  } else {
    push(
      "warning",
      "env_missing",
      ".env가 없습니다. worker 시작 전에 HERMES_OPS_URL, HERMES_WORKER_TOKEN 등을 채워야 합니다.",
    );
  }

  if (plan.journalInfo.corrupt) {
    push("warning", "journal_corrupt", `${journalName}이(가) 손상됐습니다. 수동 확인이 필요합니다.`);
  } else {
    const tx = latestTransaction(plan.journalInfo);
    if (tx?.status === "in-progress") {
      push(
        "warning",
        "journal_in_progress",
        `중단된 apply 트랜잭션 ${tx.id}이(가) 있습니다. --rollback으로 복원을 검토하세요.`,
      );
    } else if (tx) {
      push("ok", "journal_ok", `저널 최근 트랜잭션 ${tx.id} (상태: ${tx.status}).`);
    }
  }

  const manifestPath = join(plan.runtimeDir, manifestName);
  const manifestRaw = await readOrNull(manifestPath);
  if (manifestRaw === null) {
    if (presentFiles.size) {
      push("warning", "manifest_missing", `${manifestName}이(가) 없어 설치 증거를 확인할 수 없습니다.`);
    }
  } else {
    try {
      const manifest = JSON.parse(manifestRaw);
      const recorded = manifest.files || {};
      const mismatches = [];
      for (const [name, hash] of presentFiles) {
        if (recorded[name]?.sha256 !== hash) mismatches.push(name);
      }
      for (const name of Object.keys(recorded)) {
        if (!presentFiles.has(name)) mismatches.push(`${name} (기록만 존재)`);
      }
      if (mismatches.length) {
        push("warning", "manifest_stale", `manifest가 실제 상태와 다릅니다: ${mismatches.join(", ")}`);
      } else {
        push("ok", "manifest_ok", `manifest가 실제 상태와 일치합니다 (state: ${manifest.state || "unknown"}).`);
      }
    } catch {
      push("warning", "manifest_corrupt", `${manifestName}을(를) 해석할 수 없습니다.`);
    }
  }

  if (options.preflight && registry && (await statOrNull(registry.target))) {
    const preflight = spawnSync(
      process.execPath,
      [preflightScript, "--registry", registry.target],
      { encoding: "utf8" },
    );
    const lastLines = (preflight.stdout || "").trim().split("\n").slice(-2).join(" | ");
    if (preflight.status === 0) {
      push("ok", "preflight", `레지스트리 preflight 통과: ${lastLines}`);
    } else if (preflight.status === 1) {
      push("error", "preflight", `레지스트리 preflight 실패: ${lastLines}`);
    } else {
      push("error", "preflight", `레지스트리 preflight 실행 실패: ${(preflight.stderr || lastLines).trim()}`);
    }
  }

  return { checks, summary: summarize(checks) };
}

function summarize(checks) {
  const summary = { ok: 0, warnings: 0, errors: 0 };
  for (const check of checks) {
    if (check.level === "error") summary.errors += 1;
    else if (check.level === "warning") summary.warnings += 1;
    else summary.ok += 1;
  }
  return summary;
}

function printVerify(plan, report) {
  console.log(`런타임 디렉터리: ${plan.runtimeDir}`);
  console.log(`모드: verify (읽기 전용 검증)`);
  console.log("");
  for (const check of report.checks) {
    const label = { ok: "OK", warning: "WARN", error: "ERROR" }[check.level];
    console.log(`[${label}] ${check.code}: ${check.message}`);
  }
  console.log("");
  console.log(`요약: ok ${report.summary.ok}건, warning ${report.summary.warnings}건, error ${report.summary.errors}건`);
  if (report.summary.errors) {
    console.log("실패: error 항목을 해결한 뒤 다시 검증하세요.");
  } else if (report.summary.warnings) {
    console.log("통과(warning 있음): warning 항목을 확인하세요.");
  } else {
    console.log("통과: 런타임 설치 상태가 소스와 일치합니다.");
  }
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

  let plan;
  try {
    plan = await buildPlan(options);
  } catch (error) {
    console.error("설치 계획을 만들지 못했습니다. 소스 파일을 확인하세요.");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
    return;
  }

  if (options.mode === "plan") {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            runtimeDir: plan.runtimeDir,
            mode: "plan",
            files: plan.files.map((file) => ({
              name: file.name,
              source: file.source,
              target: file.target,
              status: file.status,
            })),
            envExists: plan.envExists,
            missingDirs: plan.missingDirs,
            latestTransaction: latestTransaction(plan.journalInfo),
            journalCorrupt: plan.journalInfo.corrupt,
          },
          null,
          2,
        ),
      );
    } else {
      printPlan(plan);
    }
    return;
  }

  if (options.mode === "apply") {
    try {
      const result = await runApply(plan);
      if (options.json) {
        console.log(JSON.stringify({ runtimeDir: plan.runtimeDir, mode: "apply", ...result }, null, 2));
      } else {
        printApply(plan, result);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 2;
    }
    return;
  }

  if (options.mode === "rollback") {
    try {
      plan.options = options;
      const result = await runRollback(plan, options);
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              runtimeDir: plan.runtimeDir,
              mode: "rollback",
              transaction: result.tx ? { id: result.tx.id, status: result.tx.status } : null,
              restored: result.restored,
              removed: result.removed,
              skipped: result.skipped,
              missing: result.missing,
              dirsRemoved: result.dirsRemoved,
            },
            null,
            2,
          ),
        );
      } else {
        printRollback(plan, result);
      }
      if (!result.tx || result.skipped.length) process.exitCode = 1;
    } catch (error) {
      console.error("롤백에 실패했습니다.");
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 2;
    }
    return;
  }

  const report = await verifyRuntime(plan, options);
  if (options.json) {
    console.log(JSON.stringify({ runtimeDir: plan.runtimeDir, mode: "verify", ...report }, null, 2));
  } else {
    printVerify(plan, report);
  }
  if (report.summary.errors > 0 || (options.strict && report.summary.warnings > 0)) {
    process.exitCode = 1;
  }
}

void main();
