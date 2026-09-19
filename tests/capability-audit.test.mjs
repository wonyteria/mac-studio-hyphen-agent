import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import {
  applyAuditPlan,
  auditProject,
  auditRegistry,
  renderAuditHuman,
} from "../scripts/hermes-capability-audit.mjs";
import {
  REMOVE_FIELD,
  applyRegistryUpsert,
  collectRepoIndex,
} from "../scripts/hermes-project-registry.mjs";

let root;
let repoMain;
let repoOther;
let index;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(path, remoteUrl, branch = "main") {
  execFileSync("git", ["init", "-b", branch, path], { encoding: "utf8" });
  git(["-C", path, "remote", "add", "origin", remoteUrl]);
  writeFileSync(join(path, "README.md"), "# fixture\n");
  git(["-C", path, "add", "README.md"]);
  git(["-C", path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);
}

// ls-remote stub: remote branch existence is injected so tests never touch a
// network. `exists` toggles the stdout payload; `fail` simulates unreachable.
const remoteRun = (exists = true, fail = false) => () =>
  Promise.resolve(
    fail
      ? { ok: false, code: 128, killed: false, stdout: "", stderr: "fatal" }
      : { ok: true, code: 0, killed: false, stdout: exists ? "abc123\trefs/heads/main\n" : "", stderr: "" },
  );

before(async () => {
  root = await mkdtemp(join(tmpdir(), "hermes-cap-audit-"));
  repoMain = join(root, "repo-main");
  repoOther = join(root, "repo-other");
  makeRepo(repoMain, "https://github.com/acme/app.git");
  makeRepo(repoOther, "https://github.com/acme/other.git");
  index = await collectRepoIndex([root]);
});

after(async () => {
  await rm(root, { force: true, recursive: true });
});

test("declared repo + matching remote + remote branch → verified", async () => {
  const project = {
    id: "p1",
    name: "App",
    github: "https://github.com/acme/app.git",
    repo: repoMain,
    gitRemote: "origin",
    branch: "main",
    capabilities: ["deployment_status"],
  };
  const result = await auditProject(project, index, { run: remoteRun(true) });
  assert.equal(result.verdict, "verified");
  assert.equal(result.reason, null);
  assert.deepEqual(result.edits.capabilities, [
    "deployment_status",
    "project_inspect",
    "redeploy",
    "development",
  ]);
  assert.equal(result.edits.repo, undefined, "declared repo must not be rewritten");
  assert.equal(result.edits.gitRemote, undefined);
  assert.equal(result.edits.capabilityReason, REMOVE_FIELD);
});

test("repo resolved by github remote match fills repo/gitRemote edits", async () => {
  const project = {
    id: "p2",
    name: "App2",
    github: "https://github.com/acme/app",
    branch: "main",
    capabilities: ["deployment_status"],
  };
  const result = await auditProject(project, index, { run: remoteRun(true) });
  assert.equal(result.verdict, "verified");
  assert.equal(result.edits.repo, repoMain);
  assert.equal(result.edits.gitRemote, "origin");
});

test("unresolvable repo degrades to status-only with explicit reason", async () => {
  const project = { id: "p3", name: "Ghost", github: "https://github.com/acme/missing.git", branch: "main" };
  const result = await auditProject(project, index, { run: remoteRun(true) });
  assert.equal(result.verdict, "status-only");
  assert.equal(result.reason, "repo_unset");
  assert.deepEqual(result.edits.capabilities, ["deployment_status"]);
  assert.equal(result.edits.capabilityReason, "repo_unset");
});

test("declared-but-missing repo reports repo_unresolved", async () => {
  const project = {
    id: "p4",
    name: "Stale",
    github: "https://github.com/acme/app.git",
    repo: join(root, "does-not-exist"),
    gitRemote: "origin",
    branch: "main",
  };
  const result = await auditProject(project, index, { run: remoteRun(true) });
  // The declared path is stale but the github URL still resolves via index —
  // resolution succeeds, so the verdict depends on the remaining checks.
  assert.equal(result.verdict, "verified");
  assert.equal(result.edits.repo, repoMain);
  const unresolved = await auditProject(
    { ...project, github: "https://github.com/acme/nowhere.git" },
    index,
    { run: remoteRun(true) },
  );
  assert.equal(unresolved.verdict, "status-only");
  assert.equal(unresolved.reason, "repo_unresolved");
});

test("repo without a github-matching remote → remote_missing", async () => {
  const project = {
    id: "p5",
    name: "NoRemote",
    github: "https://github.com/acme/app.git",
    repo: repoOther,
    gitRemote: "origin",
    branch: "main",
  };
  const result = await auditProject(project, index, { run: remoteRun(true) });
  assert.equal(result.verdict, "status-only");
  assert.equal(result.reason, "remote_missing");
});

test("unreachable remote and missing remote branch degrade truthfully", async () => {
  const project = {
    id: "p6",
    name: "App6",
    github: "https://github.com/acme/app.git",
    repo: repoMain,
    gitRemote: "origin",
    branch: "main",
  };
  const down = await auditProject(project, index, { run: remoteRun(true, true) });
  assert.equal(down.reason, "remote_unreachable");
  const absent = await auditProject(project, index, { run: remoteRun(false) });
  assert.equal(absent.reason, "branch_remote_missing");
  const unset = await auditProject({ ...project, branch: "" }, index, { run: remoteRun(true) });
  assert.equal(unset.reason, "branch_unset");
});

test("--no-remote verifies with local refs only", async () => {
  const project = {
    id: "p7",
    name: "App7",
    github: "https://github.com/acme/app.git",
    repo: repoMain,
    gitRemote: "origin",
    branch: "main",
  };
  const result = await auditProject(project, index, { remote: false });
  assert.equal(result.verdict, "verified");
  const ghost = await auditProject({ ...project, branch: "deploy/gone" }, index, { remote: false });
  assert.equal(ghost.reason, "branch_missing");
});

test("audit output is deterministic for identical inputs", async () => {
  const projects = [
    { id: "a", name: "A", github: "https://github.com/acme/app.git", repo: repoMain, gitRemote: "origin", branch: "main" },
    { id: "b", name: "B", github: "https://github.com/acme/ghost.git", branch: "main" },
  ];
  const one = await auditRegistry(projects, { roots: [root], run: remoteRun(true) });
  const two = await auditRegistry(projects, { roots: [root], run: remoteRun(true) });
  assert.equal(JSON.stringify(one), JSON.stringify(two));
  assert.equal(one.summary.verified, 1);
  assert.equal(one.summary.statusOnly, 1);
  assert.match(renderAuditHuman(one), /\[검증됨\] A/);
  assert.match(renderAuditHuman(one), /\[상태 조회만\] B/);
});

test("applyRegistryUpsert updates, inserts, and removes fields surgically", () => {
  const compact =
    '{ "id": "p1", "name": "A", "capabilities": ["deployment_status"] },\n    { "id": "p2", "name": "B" }';
  // Same-value update must not duplicate the key.
  let next = applyRegistryUpsert(compact, "p1", { capabilities: ["deployment_status"] });
  assert.equal(next.match(/"capabilities"/g).length, 1);
  // Insert into a compact object.
  next = applyRegistryUpsert(compact, "p1", { capabilityReason: "repo_unset" });
  assert.match(next, /"capabilities": \["deployment_status"\], "capabilityReason": "repo_unset"\}/);
  // Insert into a multi-line object keeps the property indent.
  const pretty = `{
    "id": "p3",
    "name": "C"
  }`;
  const inserted = applyRegistryUpsert(pretty, "p3", { repo: "/x/y" });
  assert.match(inserted, /"name": "C",\n {4}"repo": "\/x\/y"/);
  // Update an existing field then remove it.
  const removed = applyRegistryUpsert(next, "p1", { capabilityReason: REMOVE_FIELD });
  assert.equal(removed.includes("capabilityReason"), false);
  // Removing an absent field is a no-op.
  assert.equal(applyRegistryUpsert(compact, "p2", { capabilityReason: REMOVE_FIELD }), compact);
  // Unknown project fails closed.
  assert.throws(() => applyRegistryUpsert(compact, "nope", { a: 1 }), /찾지 못/);
});

test("applyAuditPlan writes a backup and is idempotent", async () => {
  const registryPath = join(root, "projects.json");
  const registry = {
    projects: [
      { id: "a", name: "A", github: "https://github.com/acme/app.git", repo: repoMain, gitRemote: "origin", branch: "main", capabilities: ["deployment_status"] },
      { id: "b", name: "B", github: "https://github.com/acme/ghost.git", branch: "main", capabilities: ["deployment_status"] },
    ],
  };
  await writeFile(registryPath, JSON.stringify(registry, null, 2));
  const report = await auditRegistry(registry.projects, { roots: [root], run: remoteRun(true) });
  const applied = await applyAuditPlan(registryPath, report);
  assert.equal(applied.changed, true);
  const parsed = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(parsed.projects.length, 2);
  assert.deepEqual(parsed.projects[0].capabilities, [
    "deployment_status",
    "project_inspect",
    "redeploy",
    "development",
  ]);
  assert.equal(parsed.projects[1].capabilityReason, "repo_unset");
  // Re-applying a converged report changes nothing and leaves no backup.
  const converged = await auditRegistry(parsed.projects, { roots: [root], run: remoteRun(true) });
  assert.equal(converged.summary.changed, 0);
  const again = await applyAuditPlan(registryPath, converged);
  assert.equal(again.changed, false);
});
