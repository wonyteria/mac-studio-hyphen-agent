import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KNOWN_CAPABILITIES = [
  "deployment_status",
  "project_inspect",
  "redeploy",
  "development",
];
export const REPO_REQUIRED_CAPABILITIES = ["project_inspect", "development"];
const MAX_REPO_SCAN_DEPTH = 3;
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".next", ".vinext", "dist", "build"]);

export function runtimeRoot(env = process.env) {
  return env.HERMES_RUNTIME_DIR || join(homedir(), ".local", "share", "hermes-ops");
}

export function sourceRegistryPath() {
  return fileURLToPath(new URL("../hermes-projects.json", import.meta.url));
}

export function registryCandidates(env = process.env) {
  const candidates = [];
  if (env.HERMES_PROJECT_REGISTRY) candidates.push(env.HERMES_PROJECT_REGISTRY);
  candidates.push(join(runtimeRoot(env), "hermes-projects.json"));
  candidates.push(sourceRegistryPath());
  return candidates;
}

export async function defaultRegistryPath(env = process.env) {
  for (const candidate of registryCandidates(env)) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return registryCandidates(env)[0];
}

export function repoSearchRoots(env = process.env) {
  if (env.HERMES_REPO_ROOTS) {
    return env.HERMES_REPO_ROOTS.split(":").map((item) => item.trim()).filter(Boolean);
  }
  const home = homedir();
  return [
    join(home, "Documents", "Hyphen Source Repositories"),
    join(home, "Documents", "Codex", "projects"),
    join(home, "Desktop", "hyphen"),
  ];
}

export function normalizeGitUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let normalized = text.replace(/^git@([^:]+):/, "https://$1/");
  try {
    const url = new URL(normalized);
    normalized = `${url.hostname}${url.pathname}`;
  } catch {
    normalized = normalized.replace(/^https?:\/\//i, "");
  }
  return normalized.replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
}

export function isLegacyPath(path, home = homedir()) {
  const value = String(path || "").trim();
  if (!isAbsolute(value)) return false;
  const match = value.match(/^\/Users\/([^/]+)(\/|$)/);
  if (!match || match[1] === "Shared") return false;
  return value !== home && !value.startsWith(`${home}/`);
}

async function gitDirectory(repoPath) {
  const marker = join(repoPath, ".git");
  let markerStat;
  try {
    markerStat = await lstat(marker);
  } catch {
    return null;
  }
  let gitDir = marker;
  if (!markerStat.isDirectory()) {
    const raw = await readFile(marker, "utf8").catch(() => "");
    const target = raw.match(/gitdir:\s*(.+)/)?.[1]?.trim();
    if (!target) return null;
    gitDir = resolve(repoPath, target);
  }
  let commonDir = gitDir;
  const common = await readFile(join(gitDir, "commondir"), "utf8").catch(() => "");
  if (common.trim()) commonDir = resolve(gitDir, common.trim());
  return { gitDir, commonDir };
}

function parseRemoteConfig(text) {
  const remotes = {};
  for (const section of String(text || "").matchAll(/\[remote "([^"]+)"\]([\s\S]*?)(?=\n\[|$)/g)) {
    const url = section[2].match(/^\s*url\s*=\s*(.+?)\s*$/m)?.[1];
    if (url) remotes[section[1]] = url.trim();
  }
  return remotes;
}

export async function inspectRepo(repoPath) {
  const result = { exists: false, isDir: false, isGit: false, brokenSymlink: false, remotes: {} };
  try {
    const info = await stat(repoPath);
    result.exists = true;
    result.isDir = info.isDirectory();
  } catch {
    const link = await lstat(repoPath).catch(() => null);
    result.brokenSymlink = Boolean(link?.isSymbolicLink());
    return result;
  }
  if (!result.isDir) return result;
  const git = await gitDirectory(repoPath);
  if (!git) return result;
  result.isGit = true;
  const config = await readFile(join(git.commonDir, "config"), "utf8").catch(() => "");
  result.remotes = parseRemoteConfig(config);
  return result;
}

async function packedRefs(commonDir) {
  const text = await readFile(join(commonDir, "packed-refs"), "utf8").catch(() => "");
  return new Set(
    text
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("^"))
      .map((line) => line.split(/\s+/)[1])
      .filter(Boolean),
  );
}

export async function gitRefExists(repoPath, ref) {
  const git = await gitDirectory(repoPath);
  if (!git) return false;
  try {
    await stat(join(git.commonDir, ref));
    return true;
  } catch {
    // Fall through to packed refs.
  }
  return (await packedRefs(git.commonDir)).has(ref);
}

export async function gitBranchExists(repoPath, branch, remoteName) {
  const candidates = [`refs/heads/${branch}`];
  if (remoteName) candidates.push(`refs/remotes/${remoteName}/${branch}`);
  for (const ref of candidates) {
    if (await gitRefExists(repoPath, ref)) return true;
  }
  return false;
}

export function remoteNameForUrl(remotes, githubUrl) {
  const wanted = normalizeGitUrl(githubUrl);
  if (!wanted) return null;
  const names = Object.keys(remotes || {}).sort();
  return names.find((name) => normalizeGitUrl(remotes[name]) === wanted) || null;
}

export async function findReposByRemote(githubUrl, roots, { maxDepth = MAX_REPO_SCAN_DEPTH } = {}) {
  const wanted = normalizeGitUrl(githubUrl);
  if (!wanted) return [];
  const matches = [];
  const seen = new Set();
  async function walk(dir, depth, rootIndex) {
    if (depth > maxDepth || seen.has(dir)) return;
    seen.add(dir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === ".git")) {
      const info = await inspectRepo(dir);
      if (remoteNameForUrl(info.remotes, githubUrl)) {
        matches.push({ path: dir, remotes: info.remotes, rootIndex });
      }
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) continue;
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        isDir = Boolean(await stat(join(dir, entry.name)).then((s) => s.isDirectory()).catch(() => false));
      }
      if (isDir) await walk(join(dir, entry.name), depth + 1, rootIndex);
    }
  }
  for (let index = 0; index < (roots || []).length; index += 1) {
    await walk(roots[index], 0, index);
  }
  return matches.sort((a, b) => a.rootIndex - b.rootIndex || a.path.localeCompare(b.path));
}

export function projectNeedsRepo(project) {
  const capabilities = Array.isArray(project?.capabilities) ? project.capabilities : [];
  return capabilities.some((capability) => REPO_REQUIRED_CAPABILITIES.includes(capability));
}

export async function repoPathStatus(project) {
  const declared = String(project?.repo || "").trim();
  if (!declared) return { status: "unset", declared: "" };
  const legacy = isLegacyPath(declared);
  const info = await inspectRepo(declared);
  if (info.exists && info.isDir && info.isGit) {
    return { status: legacy ? "legacy" : "ok", declared, info };
  }
  if (!info.exists) {
    return {
      status: info.brokenSymlink ? "broken_symlink" : legacy ? "legacy" : "missing",
      declared,
      info,
    };
  }
  return { status: "not_git", declared, info };
}

export async function resolveProjectRepo(project, { roots } = {}) {
  const searchRoots = roots || repoSearchRoots();
  const declared = await repoPathStatus(project);
  if (declared.status === "ok") {
    return { status: "ok", path: declared.declared, remotes: declared.info.remotes, declared };
  }
  const matches = await findReposByRemote(project?.github, searchRoots);
  if (matches.length) {
    return {
      status: "resolved",
      path: matches[0].path,
      matchedBy: "github-url",
      remotes: matches[0].remotes,
      alternates: matches.slice(1).map((match) => match.path),
      declared,
    };
  }
  return { status: "unresolved", declared };
}

function finding(level, code, message, action = "") {
  return { level, code, message, action };
}

export async function validateProject(project, { roots, checkGit = true } = {}) {
  const checks = [];
  const id = String(project?.id || "");
  const name = String(project?.name || id || "unknown");
  const capabilities = Array.isArray(project?.capabilities) ? project.capabilities : null;
  const migrateHint = "node scripts/hermes-registry-migrate.mjs 실행(dry-run 기본)으로 이관 여부를 확인하세요.";

  if (!id) checks.push(finding("error", "missing_id", "프로젝트 id가 없습니다."));
  if (!capabilities || !capabilities.length) {
    checks.push(finding("error", "missing_capabilities", "capabilities 목록이 없거나 비어 있습니다."));
  } else {
    const unknown = capabilities.filter((capability) => !KNOWN_CAPABILITIES.includes(capability));
    if (unknown.length) {
      checks.push(
        finding("warning", "unknown_capability", `알 수 없는 capability: ${unknown.join(", ")}`),
      );
    }
  }
  if (capabilities?.length && !project?.miniVercelProjectId) {
    checks.push(
      finding(
        "error",
        "missing_mini_vercel_id",
        "miniVercelProjectId가 없어 mini deploy 상태 조회를 포함한 모든 capability가 실패합니다.",
        "mini deploy 프로젝트 ID를 레지스트리에 등록하세요.",
      ),
    );
  }

  const needsRepo = projectNeedsRepo(project);
  const declared = await repoPathStatus(project);
  const resolution = declared.status === "ok" ? null : await resolveProjectRepo(project, { roots });
  const suggestion =
    resolution?.status === "resolved"
      ? `발견된 canonical 저장소: ${resolution.path} (${resolution.matchedBy})${resolution.alternates?.length ? `, 다른 후보: ${resolution.alternates.join(", ")}` : ""}.`
      : "등록된 github URL과 일치하는 로컬 저장소를 검색 루트에서 찾지 못했습니다. 저장소 위치를 확인하고 수동 등록하세요.";
  const repoAction = resolution?.status === "resolved" ? `${suggestion} ${migrateHint}` : suggestion;
  const repoLevel = needsRepo ? "error" : "warning";

  if (needsRepo && (!project.repo || !project.branch || !project.gitRemote)) {
    checks.push(
      finding(
        "error",
        "incomplete_repo_config",
        "project_inspect/development capability에 필요한 repo, branch, gitRemote 중 일부가 없습니다.",
        "레지스트리 항목에 repo, branch, gitRemote를 모두 등록하세요.",
      ),
    );
  }

  if (declared.status === "legacy") {
    checks.push(
      finding(
        repoLevel,
        "legacy_repo_path",
        `repo가 이전 사용자 경로를 가리킵니다: ${declared.declared}`,
        repoAction,
      ),
    );
  } else if (declared.status === "broken_symlink") {
    checks.push(
      finding(
        repoLevel,
        "broken_symlink",
        `repo가 끊어진 심볼릭 링크입니다: ${declared.declared}`,
        repoAction,
      ),
    );
  } else if (declared.status === "missing") {
    checks.push(
      finding(repoLevel, "missing_repo_path", `repo 경로가 존재하지 않습니다: ${declared.declared}`, repoAction),
    );
  } else if (declared.status === "not_git") {
    checks.push(
      finding(
        repoLevel,
        "repo_not_git",
        `repo 경로가 Git 저장소가 아닙니다: ${declared.declared}`,
        repoAction,
      ),
    );
  }

  const effectiveRepo =
    declared.status === "ok"
      ? { path: declared.declared, remotes: declared.info.remotes }
      : resolution?.status === "resolved"
        ? { path: resolution.path, remotes: resolution.remotes }
        : null;

  if (checkGit && effectiveRepo && project?.gitRemote) {
    const remoteUrl = effectiveRepo.remotes[project.gitRemote];
    if (!remoteUrl) {
      const replacement = remoteNameForUrl(effectiveRepo.remotes, project.github);
      checks.push(
        finding(
          "error",
          "remote_missing",
          `${effectiveRepo.path}에 '${project.gitRemote}' 리모트가 없어 fetch/push가 실패합니다.`,
          replacement
            ? `github URL과 일치하는 리모트 '${replacement}'이 있습니다. ${migrateHint}`
            : "저장소에 등록된 리모트를 확인하고 gitRemote 값을 수정하세요.",
        ),
      );
    } else if (project.github && normalizeGitUrl(remoteUrl) !== normalizeGitUrl(project.github)) {
      checks.push(
        finding(
          "warning",
          "remote_url_mismatch",
          `${project.gitRemote} 리모트 URL(${remoteUrl})이 github 필드와 다릅니다.`,
          "github 필드 또는 리모트 URL을 확인하세요.",
        ),
      );
    }
    if (project.branch && !(await gitBranchExists(effectiveRepo.path, project.branch, project.gitRemote))) {
      checks.push(
        finding(
          "warning",
          "branch_not_found",
          `브랜치 '${project.branch}'를 ${effectiveRepo.path}의 로컬 ref에서 찾지 못했습니다.`,
          "git fetch로 리모트 ref를 갱신하거나 등록된 branch 값을 확인하세요.",
        ),
      );
    }
  }

  if (!checks.length) {
    checks.push(finding("ok", "ok", "등록된 경로와 capability가 일치합니다."));
  }
  return { id, name, checks, resolution, needsRepo };
}

export async function validateRegistry(projects, options = {}) {
  const results = [];
  for (const project of projects) {
    results.push(await validateProject(project, options));
  }
  const summary = { projects: results.length, errors: 0, warnings: 0, ok: 0 };
  for (const result of results) {
    for (const check of result.checks) {
      if (check.level === "error") summary.errors += 1;
      else if (check.level === "warning") summary.warnings += 1;
      else summary.ok += 1;
    }
  }
  return { results, summary };
}

function projectObjectSpan(raw, projectId) {
  const idNeedle = new RegExp(`"id"\\s*:\\s*"${projectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
  const idMatch = idNeedle.exec(raw);
  if (!idMatch) return null;
  const nextId = raw.slice(idMatch.index + idMatch[0].length).search(/"id"\s*:/);
  const end = nextId === -1 ? raw.length : idMatch.index + idMatch[0].length + nextId;
  const start = raw.lastIndexOf("{", idMatch.index);
  if (start === -1) return null;
  return { start, end };
}

export function applyRegistryEdits(raw, edits) {
  let next = raw;
  const ordered = [...edits].sort((a, b) => a.projectId.localeCompare(b.projectId) || a.field.localeCompare(b.field));
  for (const edit of ordered) {
    const span = projectObjectSpan(next, edit.projectId);
    if (!span) throw new Error(`레지스트리에서 프로젝트를 찾지 못했습니다: ${edit.projectId}`);
    const segment = next.slice(span.start, span.end);
    const fieldPattern = new RegExp(`("${edit.field}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`);
    const replaced = segment.replace(
      fieldPattern,
      (match, prefix) => `${prefix}${JSON.stringify(edit.to)}`,
    );
    if (replaced === segment) {
      throw new Error(`프로젝트 ${edit.projectId}에서 ${edit.field} 필드를 찾지 못했습니다.`);
    }
    next = next.slice(0, span.start) + replaced + next.slice(span.end);
  }
  return next;
}

export async function planMigration(projects, { roots } = {}) {
  const changes = [];
  const skipped = [];
  for (const project of projects) {
    const id = String(project?.id || "");
    const declared = await repoPathStatus(project);
    let effective = null;
    if (declared.status === "ok") {
      effective = { path: declared.declared, remotes: declared.info.remotes };
    } else if (project?.repo) {
      const resolution = await resolveProjectRepo(project, { roots });
      if (resolution.status === "resolved") {
        changes.push({
          projectId: id,
          field: "repo",
          from: declared.declared,
          to: resolution.path,
          reason:
            declared.status === "legacy"
              ? "이전 사용자 경로를 canonical 저장소로 이관"
              : `repo 경로 ${declared.status} — github URL 일치 저장소로 이관`,
        });
        effective = { path: resolution.path, remotes: resolution.remotes };
      } else {
        skipped.push({
          projectId: id,
          declared: declared.declared,
          status: `미해결(${resolution.status}) — 수동 등록 필요`,
        });
      }
    }
    if (effective && project?.gitRemote && !effective.remotes[project.gitRemote]) {
      const replacement = remoteNameForUrl(effective.remotes, project.github);
      if (replacement) {
        changes.push({
          projectId: id,
          field: "gitRemote",
          from: project.gitRemote,
          to: replacement,
          reason: `등록된 리모트가 저장소에 없고 '${replacement}' 리모트가 github URL과 일치`,
        });
      } else {
        skipped.push({
          projectId: id,
          declared: `${effective.path} (gitRemote: ${project.gitRemote})`,
          status: "리모트 미존재 — github URL과 일치하는 리모트 없음, 수동 확인 필요",
        });
      }
    }
  }
  return { changes, skipped };
}
