import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyRegistryEdits,
  isLegacyPath,
  normalizeGitUrl,
  planMigration,
  repoPathStatus,
  resolveProjectRepo,
  validateRegistry,
} from "../scripts/hermes-project-registry.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const preflightScript = join(repoRoot, "scripts", "hermes-registry-preflight.mjs");
const migrateScript = join(repoRoot, "scripts", "hermes-registry-migrate.mjs");
const hasGit = spawnSync("git", ["--version"]).status === 0;

let workDir;
let rootA;
let rootB;
let registryPath;

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} 실패: ${result.stderr}`);
}

async function makeRepo(dir, remoteUrl, { remote = "origin", branch = "main" } = {}) {
  await mkdir(dir, { recursive: true });
  git(["init", "-b", branch], dir);
  git(["remote", "add", remote, remoteUrl], dir);
  return dir;
}

function legacyProject(id, github, repo = "/Users/former-user/Documents/Codex/projects/card-private-repo") {
  return {
    id,
    name: id,
    domain: `https://${id}.hyphen.it.com`,
    repo,
    github,
    miniVercelProjectId: `mini_${id}`,
    gitRemote: "origin",
    branch: "main",
    autoDeploy: true,
    capabilities: ["deployment_status", "project_inspect", "redeploy", "development"],
    verifyCommands: ["npm run check"],
  };
}

async function writeRegistry(projects) {
  const file = join(workDir, "hermes-projects.json");
  await writeFile(
    file,
    `${JSON.stringify({ projects }, null, 2)}\n`,
    "utf8",
  );
  return file;
}

function runCli(script, args, env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "hermes-registry-test-"));
  rootA = join(workDir, "root-a");
  rootB = join(workDir, "root-b");
  if (!hasGit) return;
  await makeRepo(join(rootA, "Hyphen-Hermes-Ops"), "https://github.com/hyphen-studio/Hyphen-Hermes-Ops.git");
  await makeRepo(join(rootA, "29sfilm-card-studio"), "https://github.com/hyphen-festival29/29sfilm-card-studio.git");
  await makeRepo(
    join(rootB, "develop_source", "backend"),
    "https://github.com/hyphen-mako/Hyphen-MAKO-Server.git",
  );
  await makeRepo(
    join(rootB, "develop_source", "frontend"),
    "https://github.com/hyphen-mako/Hyphen-MAKO-Client.git",
  );
});

after(async () => {
  await rm(workDir, { force: true, recursive: true });
});

test("legacy path detection covers old user homes without touching current home", () => {
  assert.equal(isLegacyPath("/Users/former-user/Documents/x"), true);
  assert.equal(isLegacyPath("/Users/former-dev/repo"), true);
  assert.equal(isLegacyPath("/Users/Shared/tools"), false);
  assert.equal(isLegacyPath("relative/path"), false);
  assert.equal(isLegacyPath(""), false);
  const home = process.env.HOME;
  if (home?.startsWith("/Users/")) {
    assert.equal(isLegacyPath(home), false);
    assert.equal(isLegacyPath(`${home}/Documents/repo`), false);
  }
});

test("git url normalization matches remote url spellings", () => {
  assert.equal(
    normalizeGitUrl("https://github.com/hyphen-mako/Hyphen-MAKO-Server.git"),
    "github.com/hyphen-mako/hyphen-mako-server",
  );
  assert.equal(
    normalizeGitUrl("git@github.com:hyphen-mako/Hyphen-MAKO-Server.git"),
    normalizeGitUrl("https://github.com/hyphen-mako/Hyphen-MAKO-Server"),
  );
  assert.equal(normalizeGitUrl("https://github.com/a/b/"), "github.com/a/b");
  assert.equal(normalizeGitUrl(""), "");
});

test("repo path status classifies current, legacy, missing, and broken links", { skip: !hasGit }, async () => {
  const current = { repo: join(rootA, "Hyphen-Hermes-Ops") };
  assert.equal((await repoPathStatus(current)).status, "ok");

  const legacy = { repo: "/Users/former-user/Documents/Codex/projects/x" };
  assert.equal((await repoPathStatus(legacy)).status, "legacy");

  const missing = { repo: join(workDir, "does-not-exist") };
  assert.equal((await repoPathStatus(missing)).status, "missing");

  const broken = join(workDir, "dangling-link");
  await symlink("/Users/former-user/nowhere", broken);
  assert.equal((await repoPathStatus({ repo: broken })).status, "broken_symlink");

  assert.equal((await repoPathStatus({})).status, "unset");
});

test("resolution prefers earlier search roots and reports alternates", { skip: !hasGit }, async () => {
  await makeRepo(join(rootB, "hermes-ops-copy"), "https://github.com/hyphen-studio/Hyphen-Hermes-Ops.git");
  const project = {
    repo: "/Users/former-user/Documents/Codex/projects/hermes-mac-ops-console",
    github: "https://github.com/hyphen-studio/Hyphen-Hermes-Ops.git",
  };
  const resolved = await resolveProjectRepo(project, { roots: [rootA, rootB] });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.path, join(rootA, "Hyphen-Hermes-Ops"));
  assert.deepEqual(resolved.alternates, [join(rootB, "hermes-ops-copy")]);

  const unresolved = await resolveProjectRepo(
    { repo: "/Users/former-user/x", github: "https://github.com/none/nothing.git" },
    { roots: [rootA, rootB] },
  );
  assert.equal(unresolved.status, "unresolved");
});

test("validation reports legacy, missing, capability, and remote issues", { skip: !hasGit }, async () => {
  const projects = [
    legacyProject("hermes-mac-ops", "https://github.com/hyphen-studio/Hyphen-Hermes-Ops.git", "/Users/former-user/old"),
    legacyProject("mako", "https://github.com/hyphen-mako/Hyphen-MAKO-Server.git"),
    {
      id: "status-only",
      name: "status only",
      repo: "/Users/former-user/old",
      github: "https://github.com/none/x.git",
      miniVercelProjectId: "mini_status",
      capabilities: ["deployment_status"],
    },
    {
      id: "no-mini-id",
      name: "missing id",
      capabilities: ["deployment_status"],
    },
    {
      id: "broken-cap",
      name: "no repo",
      miniVercelProjectId: "mini_broken",
      capabilities: ["development"],
    },
  ];
  const { results, summary } = await validateRegistry(projects, { roots: [rootA, rootB] });
  const byId = Object.fromEntries(results.map((result) => [result.id, result]));
  const codes = (id) => byId[id].checks.map((check) => check.code);

  assert.ok(codes("hermes-mac-ops").includes("legacy_repo_path"));
  assert.equal(byId["hermes-mac-ops"].resolution.path, join(rootA, "Hyphen-Hermes-Ops"));

  assert.ok(codes("mako").includes("legacy_repo_path"));
  assert.equal(byId.mako.resolution.path, join(rootB, "develop_source", "backend"));

  const statusOnly = byId["status-only"];
  assert.ok(statusOnly.checks.every((check) => check.level !== "error"));
  assert.ok(codes("status-only").includes("legacy_repo_path"));

  assert.ok(codes("no-mini-id").includes("missing_mini_vercel_id"));
  assert.ok(codes("broken-cap").includes("incomplete_repo_config"));
  assert.ok(summary.errors >= 4);
});

test("validation flags a configured remote the repo does not have", { skip: !hasGit }, async () => {
  const projects = [
    {
      ...legacyProject("hermes-mac-ops", "https://github.com/hyphen-studio/Hyphen-Hermes-Ops.git", join(rootA, "Hyphen-Hermes-Ops")),
      gitRemote: "github",
    },
  ];
  const { results } = await validateRegistry(projects, { roots: [rootA, rootB] });
  const codes = results[0].checks.map((check) => check.code);
  assert.ok(codes.includes("remote_missing"));
});

test("migration dry-run leaves the registry file byte-identical", { skip: !hasGit }, async () => {
  registryPath = await writeRegistry([
    legacyProject("hermes-mac-ops", "https://github.com/hyphen-studio/Hyphen-Hermes-Ops.git"),
    legacyProject("mako", "https://github.com/hyphen-mako/Hyphen-MAKO-Server.git"),
    { id: "status-only", name: "status", capabilities: ["deployment_status"], miniVercelProjectId: "mini_s" },
  ]);
  const before = await readFile(registryPath, "utf8");
  const run = runCli(migrateScript, ["--registry", registryPath, "--roots", `${rootA}:${rootB}`]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /dry-run/);
  assert.equal(await readFile(registryPath, "utf8"), before);
  assert.equal((await readdir(workDir)).filter((name) => name.includes("backup")).length, 0);
});

test("migration apply backs up then atomically replaces the registry", { skip: !hasGit }, async () => {
  registryPath = await writeRegistry([
    legacyProject("hermes-mac-ops", "https://github.com/hyphen-studio/Hyphen-Hermes-Ops.git"),
    {
      ...legacyProject("festival", "https://github.com/hyphen-festival29/29sfilm-card-studio.git"),
      gitRemote: "github",
    },
    { id: "status-only", name: "status", capabilities: ["deployment_status"], miniVercelProjectId: "mini_s" },
  ]);
  const before = JSON.parse(await readFile(registryPath, "utf8"));
  const run = runCli(migrateScript, [
    "--registry",
    registryPath,
    "--roots",
    `${rootA}:${rootB}`,
    "--apply",
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /백업:/);

  const backups = (await readdir(workDir)).filter((name) => name.startsWith("hermes-projects.json.backup-"));
  assert.equal(backups.length, 1);
  const backup = JSON.parse(await readFile(join(workDir, backups[0]), "utf8"));
  assert.deepEqual(backup, before);

  const after = JSON.parse(await readFile(registryPath, "utf8"));
  const byId = Object.fromEntries(after.projects.map((project) => [project.id, project]));
  assert.equal(byId["hermes-mac-ops"].repo, join(rootA, "Hyphen-Hermes-Ops"));
  assert.equal(byId.festival.repo, join(rootA, "29sfilm-card-studio"));
  assert.equal(byId.festival.gitRemote, "origin");
  assert.deepEqual(byId["status-only"], before.projects.find((p) => p.id === "status-only"));
});

test("migration apply preserves the original when the backup target fails", { skip: !hasGit }, async () => {
  registryPath = await writeRegistry([
    legacyProject("hermes-mac-ops", "https://github.com/hyphen-studio/Hyphen-Hermes-Ops.git"),
  ]);
  const blocker = join(workDir, "not-a-directory");
  await writeFile(blocker, "file", "utf8");
  const before = await readFile(registryPath, "utf8");
  const run = runCli(migrateScript, [
    "--registry",
    registryPath,
    "--roots",
    `${rootA}:${rootB}`,
    "--apply",
    "--backup-dir",
    join(blocker, "inside"),
  ]);
  assert.equal(run.status, 2);
  assert.equal(await readFile(registryPath, "utf8"), before);
});

test("applyRegistryEdits replaces only the targeted field inside the target project", () => {
  const raw = JSON.stringify(
    {
      projects: [
        { id: "a", repo: "/Users/former-user/old", gitRemote: "origin" },
        { id: "b", repo: "/keep/me", gitRemote: "origin" },
      ],
    },
    null,
    2,
  );
  const next = applyRegistryEdits(raw, [
    { projectId: "a", field: "repo", to: "/new/path" },
    { projectId: "a", field: "gitRemote", to: "upstream" },
  ]);
  const parsed = JSON.parse(next);
  assert.equal(parsed.projects[0].repo, "/new/path");
  assert.equal(parsed.projects[0].gitRemote, "upstream");
  assert.equal(parsed.projects[1].repo, "/keep/me");
  assert.throws(
    () => applyRegistryEdits(raw, [{ projectId: "ghost", field: "repo", to: "/x" }]),
    /찾지 못했습니다/,
  );
});

test("preflight passes valid registries and fails legacy or missing paths", { skip: !hasGit }, async () => {
  const validPath = await writeRegistry([
    { ...legacyProject("ok-project", "https://github.com/hyphen-studio/Hyphen-Hermes-Ops.git"), repo: join(rootA, "Hyphen-Hermes-Ops") },
  ]);
  const ok = runCli(preflightScript, ["--registry", validPath, "--roots", `${rootA}:${rootB}`]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /통과/);

  const legacyPath = await writeRegistry([
    legacyProject("hermes-mac-ops", "https://github.com/hyphen-studio/Hyphen-Hermes-Ops.git"),
  ]);
  const bad = runCli(preflightScript, ["--registry", legacyPath, "--roots", `${rootA}:${rootB}`]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /legacy_repo_path/);

  const missingPath = await writeRegistry([
    { ...legacyProject("gone", "https://github.com/none/gone.git"), repo: join(workDir, "absent") },
  ]);
  const missing = runCli(preflightScript, ["--registry", missingPath, "--roots", `${rootA}:${rootB}`]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /missing_repo_path/);
  assert.match(missing.stdout, /찾지 못했습니다|수동/);

  const unreadable = runCli(preflightScript, ["--registry", join(workDir, "nope.json")]);
  assert.equal(unreadable.status, 2);
});

test("preflight json output carries machine-readable findings", { skip: !hasGit }, async () => {
  const registry = await writeRegistry([
    legacyProject("mako", "https://github.com/hyphen-mako/Hyphen-MAKO-Server.git"),
  ]);
  const run = runCli(preflightScript, [
    "--registry",
    registry,
    "--roots",
    `${rootA}:${rootB}`,
    "--json",
  ]);
  assert.equal(run.status, 1);
  const report = JSON.parse(run.stdout);
  assert.equal(report.summary.errors >= 1, true);
  const mako = report.results.find((item) => item.id === "mako");
  assert.equal(mako.resolution.path, join(rootB, "develop_source", "backend"));
});

test("planMigration skips unresolved projects instead of guessing", { skip: !hasGit }, async () => {
  const projects = [
    legacyProject("known", "https://github.com/hyphen-studio/Hyphen-Hermes-Ops.git"),
    legacyProject("unknown", "https://github.com/none/nowhere.git"),
  ];
  const plan = await planMigration(projects, { roots: [rootA, rootB] });
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].projectId, "known");
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].projectId, "unknown");
});
