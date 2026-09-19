import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXECUTOR_KIND,
  executorStatus,
  rehearseRestore,
  runBackup,
  verifySnapshot,
} from "../scripts/hermes-backup-executor.mjs";
import { loadBackupManifest } from "../scripts/hermes-backup-manifest.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/hermes-backup-executor.mjs", import.meta.url));
let root;
let srcDir;
let destDir;
let manifest;

async function writeManifest(overrides = {}) {
  const doc = {
    schemaVersion: 1,
    kind: "hermes-backup-manifest",
    manifestId: "executor-test",
    updatedAt: "2026-01-01",
    sources: [
      {
        id: "config-file",
        type: "file",
        path: join(srcDir, "config.json"),
        label: "config",
        required: true,
      },
      {
        id: "data-dir",
        type: "directory",
        path: join(srcDir, "data"),
        label: "data dir",
        required: true,
        recursive: true,
        maxDepth: 5,
        maxEntries: 500,
        hashFiles: false,
        exclude: ["ignored"],
      },
      {
        id: "optional-missing",
        type: "file",
        path: join(srcDir, "absent.json"),
        label: "optional",
        required: false,
      },
      ...overrides.extraSources,
    ],
    targets: [{ id: "t1", type: "directory", location: destDir, notes: "test" }],
  };
  const path = join(root, "manifest.json");
  await writeFile(path, JSON.stringify(doc, null, 2));
  return path;
}

async function loadFixtureManifest() {
  const path = await writeManifest({ extraSources: [] });
  return (await loadBackupManifest(path)).manifest;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "hermes-backup-exec-"));
  srcDir = join(root, "src");
  destDir = join(root, "dest");
  await mkdir(join(srcDir, "data", "sub"), { recursive: true });
  await mkdir(join(srcDir, "data", "ignored"), { recursive: true });
  await mkdir(destDir, { recursive: true });
  await writeFile(join(srcDir, "config.json"), JSON.stringify({ a: 1 }));
  await writeFile(join(srcDir, "data", "one.txt"), "first file");
  await writeFile(join(srcDir, "data", "sub", "two.txt"), "second file");
  await writeFile(join(srcDir, "data", "ignored", "skip.txt"), "must not be copied");
  await writeFile(join(srcDir, "data", ".env"), "SECRET=never");
  await writeFile(join(srcDir, "data", "id_rsa"), "private key material");
  manifest = await loadFixtureManifest();
});

after(async () => {
  await rm(root, { force: true, recursive: true });
});

test("run produces a checksummed atomic snapshot and bounded state", async () => {
  const result = await runBackup({ destination: destDir, manifest });
  assert.equal(result.ok, true);
  assert.match(result.snapshotId, /^snapshot-\d{8}T\d{6}Z$/);
  const doc = JSON.parse(await readFile(join(destDir, result.snapshotId, "snapshot.json"), "utf8"));
  assert.equal(doc.kind, EXECUTOR_KIND);
  const config = doc.sources.find((source) => source.id === "config-file");
  assert.equal(config.status, "ok");
  assert.match(config.files[0].sha256, /^[0-9a-f]{64}$/);
  // Copied content matches the source bytes.
  const copied = await readFile(join(destDir, result.snapshotId, "config-file", "config.json"), "utf8");
  assert.equal(copied, JSON.stringify({ a: 1 }));
  const state = JSON.parse(await readFile(join(destDir, "hermes-backup-state.json"), "utf8"));
  assert.equal(state.lastResult, "ok");
  assert.equal(state.lastSnapshotId, result.snapshotId);
});

test("protected names and excludes are never copied", async () => {
  const result = await runBackup({ destination: destDir, manifest });
  const dir = join(destDir, result.snapshotId, "data-dir");
  const doc = JSON.parse(await readFile(join(destDir, result.snapshotId, "snapshot.json"), "utf8"));
  const records = doc.sources.find((source) => source.id === "data-dir").files;
  const paths = records.map((record) => `${record.kind}:${record.path}`);
  assert.ok(paths.includes("protected:.env"), "protected name recorded, not copied");
  assert.ok(paths.includes("protected:id_rsa"));
  assert.ok(paths.includes("excluded:ignored"));
  await assert.rejects(readFile(join(dir, ".env"), "utf8"));
  await assert.rejects(readFile(join(dir, "ignored", "skip.txt"), "utf8"));
});

test("symlink escapes fail closed; in-root symlinks are recorded not followed", async () => {
  await writeFile(join(root, "outside.txt"), "outside");
  await symlink(join(root, "outside.txt"), join(srcDir, "data", "escape-link")).catch(() => {});
  const bad = await runBackup({ destination: destDir, manifest }).then(
    () => null,
    (error) => error,
  );
  assert.equal(bad?.code, "path_escape");
  // Remove the escape; a dangling symlink is recorded but not followed.
  await rm(join(srcDir, "data", "escape-link"), { force: true });
  await symlink(join(srcDir, "data", "does-not-exist"), join(srcDir, "data", "dangling")).catch(() => {});
  const ok = await runBackup({ destination: destDir, manifest });
  assert.equal(ok.ok, true);
  const doc = JSON.parse(await readFile(join(destDir, ok.snapshotId, "snapshot.json"), "utf8"));
  const records = doc.sources.find((source) => source.id === "data-dir").files;
  assert.ok(records.some((record) => record.kind === "symlink" && record.path === "dangling"));
  await rm(join(srcDir, "data", "dangling"), { force: true });
});

test("missing destination is a hard error, not an auto-create", async () => {
  const missing = join(root, "no-such-dest");
  const error = await runBackup({ destination: missing, manifest }).then(() => null, (err) => err);
  assert.equal(error?.code, "destination_unavailable");
});

test("verify re-hashes a snapshot; rehearsal restores into isolation and re-verifies", async () => {
  const run = await runBackup({ destination: destDir, manifest });
  const verify = await verifySnapshot({ destination: destDir, snapshotId: run.snapshotId });
  assert.equal(verify.ok, true);
  assert.ok(verify.checked >= 2);
  // Corrupt one file — verify must catch it.
  await writeFile(join(destDir, run.snapshotId, "config-file", "config.json"), "tampered");
  const broken = await verifySnapshot({ destination: destDir, snapshotId: run.snapshotId });
  assert.equal(broken.ok, false);
  assert.ok(broken.mismatches.some((item) => item.code === "hash_mismatch"));
});

test("status is truthful across empty/ok/failed states", async () => {
  const emptyDest = join(root, "empty-dest");
  await mkdir(emptyDest);
  const empty = await executorStatus({ destination: emptyDest });
  assert.equal(empty.state, "unverified");
  const missing = await executorStatus({ destination: join(root, "missing-dest") });
  assert.equal(missing.state, "unavailable");
  const ok = await executorStatus({ destination: destDir });
  assert.ok(["ok", "unknown"].includes(ok.state));
  assert.ok(ok.snapshotCount >= 1);
});

test("retention removes only pattern-matched old snapshots", async () => {
  const keepDest = join(root, "keep-dest");
  await mkdir(keepDest);
  for (const name of ["snapshot-20200101T000000Z", "snapshot-20200102T000000Z", "not-a-snapshot"]) {
    await mkdir(join(keepDest, name), { recursive: true });
    await writeFile(join(keepDest, name, "snapshot.json"), JSON.stringify({ kind: EXECUTOR_KIND }));
  }
  await runBackup({ destination: keepDest, manifest, keep: 2 });
  const status = await executorStatus({ destination: keepDest });
  assert.ok(status.snapshotCount <= 3); // 2 kept + whatever pattern dirs remain valid
  const { readdir } = await import("node:fs/promises");
  const names = (await readdir(keepDest)).sort();
  assert.ok(names.includes("not-a-snapshot"), "non-pattern dir is never deleted");
});

test("rehearse restores into an isolated temp dir and re-verifies checksums", async () => {
  const run = await runBackup({ destination: destDir, manifest });
  const rehearsal = await rehearseRestore({ destination: destDir, snapshotId: run.snapshotId });
  assert.equal(rehearsal.ok, true);
  assert.match(rehearsal.rehearsalRoot, /hermes-backup-rehearsal-/);
  assert.ok(
    rehearsal.sources.every((source) => source.status === "ok" || source.status === "absent"),
    `unexpected rehearsal states: ${JSON.stringify(rehearsal.sources)}`,
  );
  // The rehearsal dir is always discarded — nothing persists outside the snapshot.
  const { lstat } = await import("node:fs/promises");
  const leftover = await lstat(rehearsal.rehearsalRoot).catch(() => null);
  assert.equal(leftover, null);
  // Live source untouched: still intact.
  assert.equal(await readFile(join(srcDir, "config.json"), "utf8"), JSON.stringify({ a: 1 }));
});

test("CLI status without destination reports unavailable truthfully", async () => {
  const proc = spawn(process.execPath, [scriptPath, "status"], {
    env: { ...process.env, HERMES_BACKUP_DESTINATION: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  proc.stdout.on("data", (chunk) => (stdout += chunk));
  const code = await new Promise((resolvePromise) => proc.on("close", resolvePromise));
  assert.equal(code, 0);
  const data = JSON.parse(stdout);
  assert.equal(data.state, "unavailable");
  assert.equal(data.reason, "destination_missing");
});

test("readiness tool stays read-only — no apply surface exists", async () => {
  const { readFile: rf } = await import("node:fs/promises");
  const src = await rf(fileURLToPath(new URL("../scripts/hermes-backup-readiness.mjs", import.meta.url)), "utf8");
  // The word "apply" may appear in comments documenting the absent flag;
  // what must not exist is an apply code path or filesystem mutation.
  assert.equal(/flags\.has\("apply"\)|has\("--apply"\)|argv\.includes\([^)]*apply/.test(src), false);
  assert.equal(/copyFile\(|\.partial|runBackup\(/.test(src), false, "readiness CLI must not write or copy");
});
