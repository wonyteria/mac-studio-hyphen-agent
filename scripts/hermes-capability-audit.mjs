#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KNOWN_CAPABILITIES,
  REMOVE_FIELD,
  applyRegistryUpsert,
  collectRepoIndex,
  gitBranchExists,
  normalizeGitUrl,
  remoteNameForUrl,
  repoPathStatus,
  repoSearchRoots,
  sourceRegistryPath,
} from "./hermes-project-registry.mjs";

// Deterministic capability audit for hermes-projects.json. Every project is
// re-verified against the local filesystem and its git remote; only projects
// whose repo path, github-matching remote, and branch are all proven keep
// inspect/development/redeploy capabilities. Anything unverifiable degrades to
// status-only with an explicit machine-readable reason — never a guess.
// Dry-run by default; --apply rewrites the registry surgically (backup first).

export const CAPABILITY_REASON_CODES = new Set([
  "repo_unset",
  "repo_unresolved",
  "repo_not_git",
  "remote_missing",
  "branch_unset",
  "branch_missing",
  "remote_unreachable",
  "branch_remote_missing",
]);

export const CAPABILITY_REASON_LABELS = {
  repo_unset: "로컬 저장소가 등록되지 않았고 검색 루트에서도 찾지 못함",
  repo_unresolved: "등록된 저장소 경로가 없고 github 일치 저장소도 없음",
  repo_not_git: "저장소 경로는 있지만 Git 저장소가 아님",
  remote_missing: "github URL과 일치하는 리모트가 저장소에 없음",
  branch_unset: "배포 브랜치가 등록되지 않음",
  branch_missing: "로컬 ref에서 등록된 브랜치를 찾지 못함",
  remote_unreachable: "git ls-remote 확인 실패 (네트워크 또는 인증)",
  branch_remote_missing: "리모트에 등록된 브랜치가 없음",
};

const FULL_CAPABILITIES = KNOWN_CAPABILITIES;
const STATUS_ONLY_CAPABILITIES = ["deployment_status"];
const REMOTE_CHECK_TIMEOUT_MS = 15_000;

export function execFileRunner() {
  return (command, args, options = {}) =>
    new Promise((resolvePromise) => {
      execFile(
        command,
        args,
        { timeout: options.timeoutMs ?? REMOTE_CHECK_TIMEOUT_MS, env: options.env },
        (error, stdout, stderr) => {
          resolvePromise({
            ok: !error,
            code: typeof error?.code === "number" ? error.code : null,
            signal: error?.signal || null,
            killed: Boolean(error?.killed),
            stdout: String(stdout || ""),
            stderr: String(stderr || ""),
          });
        },
      );
    });
}

// Proves the registered branch exists on the registered remote. Never hangs on
// credential prompts (GIT_TERMINAL_PROMPT=0) and is hard-bounded by a timeout —
// an unreachable remote is an explicit check failure, not a silent pass.
export async function remoteBranchExists(repoPath, remoteName, branch, { run = execFileRunner() } = {}) {
  const outcome = await run("git", ["-C", repoPath, "ls-remote", "--heads", remoteName, "--", branch], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeoutMs: REMOTE_CHECK_TIMEOUT_MS,
  });
  if (!outcome.ok) {
    return { checked: false, exists: false, reason: outcome.killed ? "timeout" : `exit ${outcome.code ?? "error"}` };
  }
  return { checked: true, exists: outcome.stdout.trim().length > 0 };
}

// Resolves the effective repo for one project: declared path first, then a
// github-URL remote match in the prebuilt search-root index.
async function resolveRepo(project, index) {
  const declared = await repoPathStatus(project);
  if (declared.status === "ok") {
    return { status: "declared", path: declared.declared, remotes: declared.info.remotes };
  }
  const wanted = normalizeGitUrl(project?.github);
  const matches = wanted ? index.get(wanted) || [] : [];
  if (matches.length) {
    return { status: "resolved", path: matches[0].path, remotes: matches[0].remotes, declared };
  }
  return { status: "unresolved", declared };
}

// Audits one project and returns a deterministic verdict plus the registry
// edits needed to make capabilities match verified reality.
export async function auditProject(project, index, { remote = true, run = execFileRunner() } = {}) {
  const id = String(project?.id || "");
  const name = String(project?.name || id || "unknown");
  const checks = [];
  const record = (code, ok, message) => checks.push({ code, ok, message });
  const resolution = await resolveRepo(project, index);

  let reason = null;
  let repoPath = null;
  let remoteName = null;

  if (resolution.status === "unresolved") {
    reason = project?.repo ? "repo_unresolved" : "repo_unset";
    record("repo", false, CAPABILITY_REASON_LABELS[reason]);
  } else {
    repoPath = resolution.path;
    record("repo", true, `${resolution.status === "resolved" ? "검색으로 확인" : "등록 경로 확인"}: ${repoPath}`);
    remoteName = remoteNameForUrl(resolution.remotes, project?.github);
    if (!remoteName) {
      reason = "remote_missing";
      record("remote", false, CAPABILITY_REASON_LABELS.remote_missing);
    } else {
      record("remote", true, `리모트 '${remoteName}'이 github URL과 일치`);
    }
  }

  const branch = String(project?.branch || "").trim();
  if (!reason && !branch) {
    reason = "branch_unset";
    record("branch", false, CAPABILITY_REASON_LABELS.branch_unset);
  } else if (!reason && repoPath) {
    const localExists = await gitBranchExists(repoPath, branch, remoteName);
    if (!localExists && !remote) {
      reason = "branch_missing";
      record("branch", false, CAPABILITY_REASON_LABELS.branch_missing);
    } else if (remote) {
      const remoteCheck = await remoteBranchExists(repoPath, remoteName, branch, { run });
      if (!remoteCheck.checked) {
        reason = "remote_unreachable";
        record("branch", false, `${CAPABILITY_REASON_LABELS.remote_unreachable} (${remoteCheck.reason})`);
      } else if (!remoteCheck.exists) {
        reason = "branch_remote_missing";
        record("branch", false, CAPABILITY_REASON_LABELS.branch_remote_missing);
      } else {
        record("branch", true, `리모트에 브랜치 '${branch}' 존재`);
      }
    } else {
      record("branch", true, `로컬 ref에 브랜치 '${branch}' 존재 (리모트 확인 생략)`);
    }
  }

  const verified = reason === null;
  const capabilities = verified ? [...FULL_CAPABILITIES] : [...STATUS_ONLY_CAPABILITIES];
  const edits = { capabilities };
  if (verified) {
    if (resolution.status === "resolved") edits.repo = repoPath;
    if (remoteName && remoteName !== project?.gitRemote) edits.gitRemote = remoteName;
    edits.capabilityReason = REMOVE_FIELD;
  } else {
    edits.capabilityReason = reason;
  }
  const changed =
    JSON.stringify(project?.capabilities || []) !== JSON.stringify(capabilities) ||
    edits.repo !== undefined ||
    edits.gitRemote !== undefined ||
    (verified && project?.capabilityReason !== undefined) ||
    (!verified && project?.capabilityReason !== reason);
  return { id, name, verdict: verified ? "verified" : "status-only", reason, checks, edits, changed };
}

export async function auditRegistry(projects, { roots, remote = true, run } = {}) {
  const index = await collectRepoIndex(roots ?? repoSearchRoots());
  const results = [];
  for (const project of projects) {
    results.push(await auditProject(project, index, { remote, run }));
  }
  return {
    kind: "hermes-capability-audit",
    schemaVersion: 1,
    remoteCheck: remote,
    projects: results,
    summary: {
      total: results.length,
      verified: results.filter((item) => item.verdict === "verified").length,
      statusOnly: results.filter((item) => item.verdict === "status-only").length,
      changed: results.filter((item) => item.changed).length,
    },
  };
}

export function renderAuditHuman(report) {
  const lines = ["프로젝트 capability 감사"];
  for (const project of report.projects) {
    if (project.verdict === "verified") {
      lines.push(`  [검증됨] ${project.name}`);
    } else {
      const label = CAPABILITY_REASON_LABELS[project.reason] || project.reason;
      lines.push(`  [상태 조회만] ${project.name} — ${label}`);
    }
  }
  lines.push(
    `합계: ${report.summary.total}개 · 검증됨 ${report.summary.verified} · 상태 조회만 ${report.summary.statusOnly} · 변경 필요 ${report.summary.changed}`,
  );
  return `${lines.join("\n")}\n`;
}

const usage = `Hermes 프로젝트 capability 감사 (dry-run 기본)

hermes-projects.json의 모든 프로젝트를 로컬 파일시스템과 git remote로
재검증한다. repo 경로·github 일치 리모트·브랜치가 모두 확인된 프로젝트만
project_inspect/redeploy/development 능력을 유지하고, 확인할 수 없는
프로젝트는 deployment_status(상태 조회)만 남기며 capabilityReason을 기록한다.
어떤 능력도 추측으로 부여하지 않는다.

사용법:
  node scripts/hermes-capability-audit.mjs [옵션]

옵션:
  --registry <path>   감사할 레지스트리 (기본: 저장소의 hermes-projects.json)
  --roots <a:b:c>     저장소 검색 루트 (기본: HERMES_REPO_ROOTS, 없으면 canonical 루트)
  --no-remote         git ls-remote 확인을 생략 (오프라인 검증)
  --apply             계획을 레지스트리에 적용 (기존 파일은 .bak-<ts>로 백업)
  --format <fmt>      human(기본) | json
  --help              이 도움말

종료 코드: 0 완료 · 1 적용 결과 일부 프로젝트가 여전히 status-only · 2 인자/레지스트리 오류
`;

function parseArgs(argv) {
  const options = { format: "human", remote: true };
  const takeValue = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("-")) {
      throw new Error(`${flag} 옵션에는 값이 필요합니다.`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--registry") options.registry = takeValue(arg, index++);
    else if (arg === "--roots") options.roots = takeValue(arg, index++).split(":").filter(Boolean);
    else if (arg === "--no-remote") options.remote = false;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--format") options.format = takeValue(arg, index++);
    else throw new Error(`알 수 없는 인자입니다: ${arg}`);
  }
  if (!["human", "json"].includes(options.format)) {
    throw new Error(`--format은 human 또는 json이어야 합니다: ${options.format}`);
  }
  return options;
}

export async function applyAuditPlan(registryPath, report) {
  const raw = await readFile(registryPath, "utf8");
  let next = raw;
  for (const project of report.projects) {
    next = applyRegistryUpsert(next, project.id, project.edits);
  }
  const parsed = JSON.parse(next);
  const count = Array.isArray(parsed.projects) ? parsed.projects.length : 0;
  if (count !== report.projects.length) {
    throw new Error(`적용 결과 프로젝트 수가 다릅니다 (${count} ≠ ${report.projects.length}) — 쓰기를 중단했습니다.`);
  }
  if (next === raw) return { changed: false };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFile(`${registryPath}.bak-${stamp}`, raw, "utf8");
  const temp = `${registryPath}.${process.pid}.tmp`;
  await writeFile(temp, next, "utf8");
  await rename(temp, registryPath);
  return { changed: true, backup: `${registryPath}.bak-${stamp}` };
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
  const registryPath = options.registry || sourceRegistryPath();
  let projects;
  try {
    const info = await stat(registryPath);
    if (!info.isFile()) throw new Error("레지스트리가 일반 파일이 아닙니다.");
    const parsed = JSON.parse(await readFile(registryPath, "utf8"));
    projects = Array.isArray(parsed.projects) ? parsed.projects : [];
  } catch (error) {
    console.error(`레지스트리를 읽지 못했습니다: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
    return;
  }
  const report = await auditRegistry(projects, { roots: options.roots, remote: options.remote });
  let applied = null;
  if (options.apply) {
    try {
      applied = await applyAuditPlan(registryPath, report);
    } catch (error) {
      console.error(`레지스트리 적용 실패: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 2;
      return;
    }
  }
  const output = { ...report, applied: applied ? { changed: applied.changed } : { requested: false } };
  if (options.format === "json") {
    console.log(JSON.stringify(output, null, 2));
  } else {
    process.stdout.write(renderAuditHuman(report));
    if (applied) console.log(applied.changed ? "레지스트리를 갱신했습니다 (원본 백업됨)." : "변경 사항이 없습니다.");
    if (!options.apply) console.log("dry-run — 적용하려면 --apply를 실행하세요.");
  }
  if (report.summary.statusOnly > 0) process.exitCode = 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main();
