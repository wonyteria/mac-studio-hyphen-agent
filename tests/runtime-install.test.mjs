import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const installScript = join(repoRoot, "scripts", "hermes-runtime-install.mjs");
const workerSource = join(repoRoot, "scripts", "hermes-local-worker.mjs");
const registrySource = join(repoRoot, "hermes-projects.json");

let workDir;
let tinyRegistry;

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [installScript, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function writeTinyRegistry(dir) {
  const file = join(dir, "tiny-registry.json");
  await writeFile(
    file,
    `${JSON.stringify(
      {
        projects: [
          {
            id: "staging-project",
            name: "staging",
            miniVercelProjectId: "mini_staging",
            capabilities: ["deployment_status"],
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return file;
}

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "hermes-runtime-test-"));
  tinyRegistry = await writeTinyRegistry(workDir);
});

after(async () => {
  await rm(workDir, { force: true, recursive: true });
});

test("plan is a dry-run and never creates the runtime directory", async () => {
  const target = join(workDir, "plan-only-runtime");
  const run = runCli(["--runtime", target]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /dry-run/);
  assert.match(run.stdout, /hermes-local-worker\.mjs/);
  assert.equal(await stat(target).catch(() => null), null);
});

test("plan reports .env preservation without reading it", async () => {
  const target = join(workDir, "env-runtime");
  await mkdir(target, { recursive: true });
  const sentinel = "HERMES_OPS_URL=https://example.invalid\nHERMES_WORKER_TOKEN=test-sentinel\n";
  await writeFile(join(target, ".env"), sentinel, { mode: 0o600 });
  const run = runCli(["--runtime", target]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /보존/);
  assert.ok(!run.stdout.includes("test-sentinel"), "plan must not print .env contents");
});

test("apply installs worker, registry, plist, manifest and runtime dirs while preserving .env", async () => {
  const target = join(workDir, "apply-runtime");
  await mkdir(target, { recursive: true });
  const sentinel = "HERMES_OPS_URL=https://example.invalid\nHERMES_WORKER_TOKEN=keep-me\n";
  await writeFile(join(target, ".env"), sentinel, { mode: 0o600 });

  const run = runCli(["--runtime", target, "--registry", tinyRegistry, "--apply"]);
  assert.equal(run.status, 0, run.stderr);

  const installedWorker = await readFile(join(target, "hermes-local-worker.mjs"), "utf8");
  assert.equal(installedWorker, await readFile(workerSource, "utf8"));
  const mode = (await stat(join(target, "hermes-local-worker.mjs"))).mode & 0o777;
  assert.equal(mode, 0o755);

  const registry = JSON.parse(await readFile(join(target, "hermes-projects.json"), "utf8"));
  assert.equal(registry.projects[0].id, "staging-project");

  const plist = await readFile(join(target, "com.hyphen.hermes-ops-worker.plist"), "utf8");
  assert.match(plist, /com\.hyphen\.hermes-ops-worker/);
  assert.ok(plist.includes(target));

  const manifest = JSON.parse(await readFile(join(target, "hermes-runtime-manifest.json"), "utf8"));
  assert.equal(manifest.runtimeDir, target);
  assert.ok(manifest.files["hermes-local-worker.mjs"].sha256);

  for (const name of ["requests", "locks", "worktrees", "persistence"]) {
    assert.ok((await stat(join(target, name))).isDirectory(), `${name} missing`);
  }
  assert.equal(await readFile(join(target, ".env"), "utf8"), sentinel);
});

test("re-running apply on an identical install is a no-op with no backups", async () => {
  const target = join(workDir, "apply-runtime");
  const run = runCli(["--runtime", target, "--registry", tinyRegistry, "--apply"]);
  assert.equal(run.status, 0, run.stderr);
  const backups = (await readdir(target)).filter((name) => name.includes(".backup-"));
  assert.equal(backups.length, 0);
});

test("apply backs up a diverged target before replacing it", async () => {
  const target = join(workDir, "backup-runtime");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "hermes-local-worker.mjs"), "// stale worker\n", "utf8");
  await writeFile(join(target, "hermes-projects.json"), "{}\n", "utf8");

  const run = runCli(["--runtime", target, "--registry", tinyRegistry, "--apply"]);
  assert.equal(run.status, 0, run.stderr);
  const backups = (await readdir(target)).filter((name) => name.includes(".backup-"));
  assert.ok(backups.some((name) => name.startsWith("hermes-local-worker.mjs.backup-")));
  assert.ok(backups.some((name) => name.startsWith("hermes-projects.json.backup-")));
  assert.equal(
    await readFile(join(target, "hermes-local-worker.mjs"), "utf8"),
    await readFile(workerSource, "utf8"),
  );
});

test("verify passes after a clean apply and reports per-check results", async () => {
  const target = join(workDir, "apply-runtime");
  const run = runCli(["--runtime", target, "--registry", tinyRegistry, "--verify"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /worker_smoke/);
  assert.match(run.stdout, /registry_json/);
  assert.match(run.stdout, /env_present/);
  assert.match(run.stdout, /통과/);
});

test("verify detects drift and missing files", async () => {
  const target = join(workDir, "drift-runtime");
  await mkdir(target, { recursive: true });
  const apply = runCli(["--runtime", target, "--registry", tinyRegistry, "--apply"]);
  assert.equal(apply.status, 0, apply.stderr);
  await writeFile(join(target, "hermes-projects.json"), "{}\n", "utf8");

  const run = runCli(["--runtime", target, "--registry", tinyRegistry, "--verify"]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /registry_differs/);

  const empty = join(workDir, "empty-runtime");
  const missing = runCli(["--runtime", empty, "--registry", tinyRegistry, "--verify"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /runtime_missing/);
});

test("verify warns when .env is absent and --strict escalates it", async () => {
  const target = join(workDir, "noenv-runtime");
  const apply = runCli(["--runtime", target, "--registry", tinyRegistry, "--apply"]);
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /없습니다/);

  const verify = runCli(["--runtime", target, "--registry", tinyRegistry, "--verify"]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /env_missing/);

  const strict = runCli(["--runtime", target, "--registry", tinyRegistry, "--verify", "--strict"]);
  assert.equal(strict.status, 1);
});

test("rollback restores the newest backup after drift", async () => {
  const target = join(workDir, "rollback-runtime");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "hermes-projects.json"), '{"projects":[{"id":"old"}]}\n', "utf8");
  const apply = runCli(["--runtime", target, "--registry", tinyRegistry, "--apply"]);
  assert.equal(apply.status, 0, apply.stderr);

  const rollback = runCli(["--runtime", target, "--rollback"]);
  assert.equal(rollback.status, 0, rollback.stderr);
  const restored = JSON.parse(await readFile(join(target, "hermes-projects.json"), "utf8"));
  assert.equal(restored.projects[0].id, "old");
});

test("rollback reports when no transaction exists", async () => {
  const target = join(workDir, "no-backup-runtime");
  await mkdir(target, { recursive: true });
  const run = runCli(["--runtime", target, "--rollback"]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /트랜잭션/);
});

test("fresh-install rollback removes managed files, manifest, and created dirs while preserving .env and requests", async () => {
  const target = join(workDir, "fresh-rollback-runtime");
  await mkdir(join(target, "requests"), { recursive: true });
  await writeFile(join(target, "requests", "keep.md"), "sentinel\n", "utf8");
  const sentinel = "HERMES_OPS_URL=https://example.invalid\nHERMES_WORKER_TOKEN=keep-me\n";
  await writeFile(join(target, ".env"), sentinel, { mode: 0o600 });

  const apply = runCli(["--runtime", target, "--registry", tinyRegistry, "--apply"]);
  assert.equal(apply.status, 0, apply.stderr);

  const rollback = runCli(["--runtime", target, "--rollback"]);
  assert.equal(rollback.status, 0, rollback.stderr);

  for (const name of [
    "hermes-local-worker.mjs",
    "hermes-projects.json",
    "com.hyphen.hermes-ops-worker.plist",
    "hermes-runtime-manifest.json",
    "locks",
    "worktrees",
    "persistence",
  ]) {
    assert.equal(await stat(join(target, name)).catch(() => null), null, `${name} should be removed`);
  }
  assert.equal(await readFile(join(target, ".env"), "utf8"), sentinel);
  assert.equal(await readFile(join(target, "requests", "keep.md"), "utf8"), "sentinel\n");

  const journal = JSON.parse(await readFile(join(target, "hermes-runtime-journal.json"), "utf8"));
  assert.equal(journal.transactions.at(-1).status, "rolled-back");

  const again = runCli(["--runtime", target, "--rollback"]);
  assert.equal(again.status, 1);
});

test("mixed install+update rollback restores pre-apply state exactly", async () => {
  const target = join(workDir, "mixed-rollback-runtime");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "hermes-local-worker.mjs"), "// stale worker\n", "utf8");

  const apply = runCli(["--runtime", target, "--registry", tinyRegistry, "--apply"]);
  assert.equal(apply.status, 0, apply.stderr);

  const rollback = runCli(["--runtime", target, "--rollback"]);
  assert.equal(rollback.status, 0, rollback.stderr);

  assert.equal(await readFile(join(target, "hermes-local-worker.mjs"), "utf8"), "// stale worker\n");
  assert.equal(await stat(join(target, "hermes-projects.json")).catch(() => null), null);
  assert.equal(await stat(join(target, "com.hyphen.hermes-ops-worker.plist")).catch(() => null), null);

  const manifest = JSON.parse(await readFile(join(target, "hermes-runtime-manifest.json"), "utf8"));
  assert.equal(manifest.state, "rolled-back");
  const workerSha = createHash("sha256").update("// stale worker\n").digest("hex");
  assert.equal(manifest.files["hermes-local-worker.mjs"].sha256, workerSha);
  assert.ok(!manifest.files["hermes-projects.json"]);
});

test("mid-apply failure auto-compensates already-applied files via the transaction", async () => {
  const target = join(workDir, "fail-apply-runtime");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "persistence"), "not a directory\n", "utf8");

  const run = runCli(["--runtime", target, "--registry", tinyRegistry, "--apply"]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /복구/);

  assert.equal(await stat(join(target, "hermes-local-worker.mjs")).catch(() => null), null);
  assert.equal(await stat(join(target, "hermes-projects.json")).catch(() => null), null);
  assert.equal(await stat(join(target, "com.hyphen.hermes-ops-worker.plist")).catch(() => null), null);
  assert.equal(await stat(join(target, "requests")).catch(() => null), null);
  assert.equal(await readFile(join(target, "persistence"), "utf8"), "not a directory\n");

  const journal = JSON.parse(await readFile(join(target, "hermes-runtime-journal.json"), "utf8"));
  assert.equal(journal.transactions.at(-1).status, "failed");
});

test("rollback recovers an interrupted in-progress transaction", async () => {
  const target = join(workDir, "inprogress-runtime");
  await mkdir(target, { recursive: true });
  const stray = "// partially applied worker\n";
  await writeFile(join(target, "hermes-local-worker.mjs"), stray, "utf8");
  const journal = {
    transactions: [
      {
        id: "2026-09-19T00-00-00-000Z",
        status: "in-progress",
        createdDirs: [],
        entries: [
          {
            name: "hermes-local-worker.mjs",
            target: join(target, "hermes-local-worker.mjs"),
            action: "install",
            existedBefore: false,
            backup: null,
            afterSha256: createHash("sha256").update(stray).digest("hex"),
          },
        ],
      },
    ],
  };
  await writeFile(join(target, "hermes-runtime-journal.json"), JSON.stringify(journal), "utf8");

  const rollback = runCli(["--runtime", target, "--rollback"]);
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(await stat(join(target, "hermes-local-worker.mjs")).catch(() => null), null);
});

test("rollback skips files changed after apply unless --force is given", async () => {
  const target = join(workDir, "force-rollback-runtime");
  await mkdir(target, { recursive: true });

  const apply = runCli(["--runtime", target, "--registry", tinyRegistry, "--apply"]);
  assert.equal(apply.status, 0, apply.stderr);
  await writeFile(join(target, "hermes-projects.json"), '{"projects":[{"id":"edited"}]}\n', "utf8");

  const cautious = runCli(["--runtime", target, "--rollback"]);
  assert.equal(cautious.status, 1);
  assert.match(cautious.stdout, /건너뜀/);
  const kept = JSON.parse(await readFile(join(target, "hermes-projects.json"), "utf8"));
  assert.equal(kept.projects[0].id, "edited");

  const forced = runCli(["--runtime", target, "--rollback", "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(await stat(join(target, "hermes-projects.json")).catch(() => null), null);
});

test("verify after rollback confirms manifest matches the actual restored state", async () => {
  const target = join(workDir, "post-rollback-verify-runtime");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "hermes-local-worker.mjs"), "// previous worker\n", "utf8");

  const apply = runCli(["--runtime", target, "--registry", tinyRegistry, "--apply"]);
  assert.equal(apply.status, 0, apply.stderr);
  const rollback = runCli(["--runtime", target, "--rollback"]);
  assert.equal(rollback.status, 0, rollback.stderr);

  const verify = runCli(["--runtime", target, "--registry", tinyRegistry, "--verify"]);
  assert.equal(verify.status, 1);
  assert.match(verify.stdout, /worker_differs/);
  assert.match(verify.stdout, /manifest_ok/);
  assert.ok(!verify.stdout.includes("manifest_stale"));
});

test("installed worker stays a single self-contained file", async () => {
  const source = await readFile(workerSource, "utf8");
  assert.ok(
    !/(from\s+["']\.{1,2}\/|import\s*\(\s*["']\.{1,2}\/|require\s*\(\s*["']\.{1,2}\/)/.test(source),
    "worker must not import sibling modules",
  );
});

test("source registry remains valid JSON that ships to runtime", async () => {
  const parsed = JSON.parse(await readFile(registrySource, "utf8"));
  assert.ok(Array.isArray(parsed.projects) && parsed.projects.length > 0);
});
