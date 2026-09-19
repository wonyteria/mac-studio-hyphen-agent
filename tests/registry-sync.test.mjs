import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  SYNC_STATUS_FIELDS,
  SYNC_STATUS_FILENAME,
  businessRegistryFreshness,
  buildSyncStatus,
  parseSyncStatusDocument,
} from "../scripts/hermes-business-registry.mjs";
import { protectedPrefixFor, writeAtomicMode } from "../scripts/hermes-registry-sync.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const syncScript = join(repoRoot, "scripts", "hermes-registry-sync.mjs");

let workDir;
let sourceFile;
let destFile;
let statusFile;

function evidence(label = "근거", ref = "docs/proof.md", checkedAt = "2026-09-19") {
  return { label, ref, checkedAt };
}

function project(overrides = {}) {
  return {
    blockers: [],
    businessGroup: "테스트 그룹",
    businessType: "internal-ops",
    dataStores: [],
    deploys: [],
    evidence: [evidence()],
    evidenceStatus: "insufficient",
    id: "alpha",
    kpis: [],
    lifecycle: "unknown",
    name: "Alpha",
    nextEvidence: [],
    organization: "hyphen",
    owner: null,
    repositories: [],
    revenue: null,
    status: "unknown",
    ...overrides,
  };
}

function exportPayload(projects, overrides = {}) {
  return {
    schemaVersion: 1,
    scope: "private",
    consumer: "hermes",
    sourceHash: "a".repeat(64),
    updatedAt: "2026-09-19",
    projects,
    ...overrides,
  };
}

async function writeSource(payload = exportPayload([project()])) {
  await writeFile(sourceFile, JSON.stringify(payload, null, 2), "utf8");
  return sourceFile;
}

function runCli(args, env = {}, spawnOptions = {}) {
  const result = spawnSync(process.execPath, [syncScript, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30 * 1000,
    ...spawnOptions,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, signal: result.signal };
}

function syncArgs(extra = []) {
  return ["sync", "--source", sourceFile, "--destination", destFile, ...extra];
}

async function readStatusDoc() {
  return JSON.parse(await readFile(statusFile, "utf8"));
}

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "hermes-sync-test-"));
  sourceFile = join(workDir, "src", "registry.private.json");
  destFile = join(workDir, "dest", "registry.private.json");
  statusFile = join(workDir, "dest", SYNC_STATUS_FILENAME);
  await mkdir(join(workDir, "src"), { recursive: true });
  await writeSource();
});

after(async () => {
  await rm(workDir, { force: true, recursive: true });
});

test("sync copies a validated registry atomically with 0600 and writes an allowlisted status", async () => {
  const run = runCli(syncArgs());
  assert.equal(run.status, 0, run.stderr);
  const copied = JSON.parse(await readFile(destFile, "utf8"));
  assert.equal(copied.projects[0].id, "alpha");
  assert.equal((await stat(destFile)).mode & 0o777, 0o600);

  const status = await readStatusDoc();
  assert.deepEqual(Object.keys(status).sort(), [...SYNC_STATUS_FIELDS].sort());
  assert.equal(status.status, "synced");
  assert.equal(status.projectCount, 1);
  assert.equal(status.registryUpdatedAt, "2026-09-19");
  assert.equal(status.errorCode, null);
  assert.ok(status.checkedAt && status.syncedAt);
  assert.equal((await stat(statusFile)).mode & 0o777, 0o600);
  // The status document carries no paths, hashes, or error text.
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes(workDir), false);
  assert.equal(serialized.includes("a".repeat(64)), false);
});

test("a second run reports unchanged and preserves the original syncedAt", async () => {
  const first = runCli(syncArgs());
  assert.equal(first.status, 0, first.stderr);
  const firstDoc = await readStatusDoc();
  const before = await readFile(destFile, "utf8");
  const second = runCli(syncArgs());
  assert.equal(second.status, 0, second.stderr);
  const secondDoc = await readStatusDoc();
  assert.equal(secondDoc.status, "unchanged");
  assert.equal(secondDoc.syncedAt, firstDoc.syncedAt);
  assert.equal(await readFile(destFile, "utf8"), before);
});

test("an updated source replaces the destination and refreshes syncedAt", async () => {
  runCli(syncArgs());
  await writeSource(exportPayload([project(), project({ id: "beta", name: "Beta" })], { updatedAt: "2026-09-20" }));
  const run = runCli(syncArgs());
  assert.equal(run.status, 0, run.stderr);
  const copied = JSON.parse(await readFile(destFile, "utf8"));
  assert.equal(copied.projects.length, 2);
  const status = await readStatusDoc();
  assert.equal(status.status, "synced");
  assert.equal(status.projectCount, 2);
  assert.equal(status.registryUpdatedAt, "2026-09-20");
});

test("an invalid source is rejected and the last-good destination is preserved", async () => {
  runCli(syncArgs());
  const good = await readFile(destFile, "utf8");
  const previous = await readStatusDoc();
  await writeSource(exportPayload([project()], { scope: "public" }));
  const run = runCli(syncArgs());
  await writeSource(); // restore the fixture before asserting anything
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr.includes(workDir), false, "sync failure output must not leak paths");
  assert.equal(await readFile(destFile, "utf8"), good, "last-known-good must survive a failed run");
  const status = await readStatusDoc();
  assert.equal(status.status, "error");
  assert.equal(status.errorCode, "schema_mismatch");
  assert.equal(status.registryUpdatedAt, previous.registryUpdatedAt, "last-good metadata is preserved");
  assert.equal(JSON.stringify(status).includes("public"), false, "no error text leaks into status");
});

test("a symlinked source is rejected fail-closed", async () => {
  const link = join(workDir, "src-link.json");
  await symlink(sourceFile, link);
  const run = runCli(["sync", "--source", link, "--destination", destFile]);
  assert.equal(run.status, 1);
  const status = await readStatusDoc();
  assert.equal(status.errorCode, "registry_symlink");
});

test("a symlinked destination is never followed or replaced", async () => {
  const real = join(workDir, "elsewhere.json");
  await writeFile(real, "{}", "utf8");
  const linkDest = join(workDir, "dest-link", "registry.private.json");
  await mkdir(dirname(linkDest), { recursive: true });
  await symlink(real, linkDest);
  const run = runCli(["sync", "--source", sourceFile, "--destination", linkDest]);
  assert.equal(run.status, 1);
  const info = await lstat(linkDest);
  assert.equal(info.isSymbolicLink(), true, "destination symlink must remain untouched");
  const status = JSON.parse(await readFile(join(workDir, "dest-link", SYNC_STATUS_FILENAME), "utf8"));
  assert.equal(status.errorCode, "destination_symlink");
});

test("oversized, malformed, and missing sources are rejected with bounded codes", async () => {
  const big = join(workDir, "big.json");
  await writeFile(big, " ".repeat(64), "utf8");
  const bigRun = runCli(["sync", "--source", big, "--destination", destFile, "--max-bytes", "8"]);
  assert.equal(bigRun.status, 1);

  const broken = join(workDir, "broken.json");
  await writeFile(broken, "{ not json ", "utf8");
  const brokenRun = runCli(["sync", "--source", broken, "--destination", join(workDir, "d2", "registry.private.json")]);
  assert.equal(brokenRun.status, 1);
  const brokenStatus = JSON.parse(await readFile(join(workDir, "d2", SYNC_STATUS_FILENAME), "utf8"));
  assert.equal(brokenStatus.errorCode, "registry_parse_error");

  const missingRun = runCli(["sync", "--source", join(workDir, "absent.json"), "--destination", join(workDir, "d3", "registry.private.json")]);
  assert.equal(missingRun.status, 1);
  const missingStatus = JSON.parse(await readFile(join(workDir, "d3", SYNC_STATUS_FILENAME), "utf8"));
  assert.equal(missingStatus.errorCode, "registry_unreadable");
});

test("missing source or destination is a usage error, never a silent default", async () => {
  const noSource = runCli(["sync", "--destination", destFile]);
  assert.equal(noSource.status, 2);
  assert.match(noSource.stderr, /HERMES_REGISTRY_SYNC_SOURCE/);
  const noDest = runCli(["sync", "--source", sourceFile]);
  assert.equal(noDest.status, 2);
  assert.match(noDest.stderr, /HERMES_REGISTRY_SYNC_DESTINATION/);
  // No registry-id inference and no fallback UUID: explicit paths only.
  const bareRun = runCli(["sync"], { HERMES_REGISTRY_SYNC_SOURCE: "", HERMES_REGISTRY_SYNC_DESTINATION: "" });
  assert.equal(bareRun.status, 2);
});

test("paths resolve from dedicated environment variables", async () => {
  const envDest = join(workDir, "env-dest", "registry.private.json");
  const run = runCli(["sync"], {
    HERMES_REGISTRY_SYNC_SOURCE: sourceFile,
    HERMES_REGISTRY_SYNC_DESTINATION: envDest,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(await stat(envDest));
});

test("--dry-run validates and reports without writing anything", async () => {
  const dryDest = join(workDir, "dry-dest", "registry.private.json");
  const run = runCli(["sync", "--source", sourceFile, "--destination", dryDest, "--dry-run"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /dry-run/);
  const info = await lstat(join(workDir, "dry-dest")).catch(() => null);
  assert.equal(info, null, "dry-run must not create the destination directory");
});

test("a live lock skips the run without touching destination or status", async () => {
  const lockedDest = join(workDir, "locked", "registry.private.json");
  await mkdir(join(workDir, "locked"), { recursive: true });
  // A fresh lock owned by this (alive) process blocks the run.
  await writeFile(join(workDir, "locked", "registry-sync.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
  const run = runCli(["sync", "--source", sourceFile, "--destination", lockedDest]);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /건너뜁니다/);
  assert.equal(await lstat(lockedDest).catch(() => null), null, "locked run must not write the destination");
});

test("a stale lock is taken over and the sync proceeds", async () => {
  const staleDest = join(workDir, "stale-lock", "registry.private.json");
  await mkdir(join(workDir, "stale-lock"), { recursive: true });
  const lock = join(workDir, "stale-lock", "registry-sync.lock");
  await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: "2020-01-01T00:00:00Z" }), "utf8");
  const past = new Date(Date.now() - 60 * 60 * 1000);
  await chmod(lock, 0o600);
  await utimes(lock, past, past);
  const run = runCli(["sync", "--source", sourceFile, "--destination", staleDest]);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(await stat(staleDest));
});

test("--expect-hash pins the source sourceHash and drift fails closed", async () => {
  const ok = runCli(syncArgs(["--expect-hash", "a".repeat(64)]));
  assert.equal(ok.status, 0, ok.stderr);
  const driftDest = join(workDir, "drift", "registry.private.json");
  const drift = runCli(["sync", "--source", sourceFile, "--destination", driftDest, "--expect-hash", "b".repeat(64)]);
  assert.equal(drift.status, 1);
  const status = JSON.parse(await readFile(join(workDir, "drift", SYNC_STATUS_FILENAME), "utf8"));
  assert.equal(status.errorCode, "source_hash_mismatch");
  assert.equal(await lstat(driftDest).catch(() => null), null, "drift must never write the destination");
});

test("install --dry-run renders a plist with resolved node, staged script, and explicit paths", () => {
  const run = runCli([
    "install",
    "--source", sourceFile,
    "--destination", destFile,
    "--dry-run",
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /com\.hyphen\.hermes-registry-sync/);
  assert.match(run.stdout, /<key>RunAtLoad<\/key>/);
  assert.match(run.stdout, /<integer>300<\/integer>/);
  assert.ok(run.stdout.includes(process.execPath), "current node binary is baked in");
  // The plist must reference the staged copy — never the repo path, which a
  // launchd child cannot open under a protected directory.
  assert.match(run.stdout, /Application Support.*hermes-registry-sync\.mjs/);
  assert.equal(run.stdout.includes(`<string>${syncScript}</string>`), false, "repo script path must not be baked in");
  assert.ok(run.stdout.includes(destFile), "explicit destination is baked in");
  assert.ok(run.stdout.includes("registry-sync-status.json"), "status path is baked in");
  assert.match(run.stdout, /동기화 경로 설정/);
});

test("install without explicit paths fails closed with a usage error", () => {
  const run = runCli(["install", "--dry-run"], {
    HERMES_REGISTRY_SYNC_SOURCE: "",
    HERMES_REGISTRY_SYNC_DESTINATION: "",
  });
  assert.equal(run.status, 2);
});

test("status command reports the recorded sync state read-only", async () => {
  const synced = runCli(syncArgs());
  assert.equal(synced.status, 0, synced.stderr);
  const ok = runCli(["status", "--destination", destFile]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /마지막 동기화/);
  // A recorded error exits 1 without changing anything.
  const errDest = join(workDir, "err-status", "registry.private.json");
  await mkdir(join(workDir, "err-status"), { recursive: true });
  await writeStatusDocAt(join(workDir, "err-status", SYNC_STATUS_FILENAME), buildSyncStatus({
    status: "error",
    checkedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    errorCode: "schema_mismatch",
  }));
  const err = runCli(["status", "--destination", errDest]);
  assert.equal(err.status, 1);
  assert.match(err.stdout, /schema_mismatch/);
});

async function writeStatusDocAt(path, doc) {
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

test("parseSyncStatusDocument enforces the allowlist strictly", () => {
  const good = buildSyncStatus({
    status: "synced",
    checkedAt: "2026-09-19T00:00:00Z",
    syncedAt: "2026-09-19T00:00:00Z",
    registryUpdatedAt: "2026-09-19",
    projectCount: 3,
  });
  assert.deepEqual(parseSyncStatusDocument(JSON.stringify(good)), good);
  assert.equal(parseSyncStatusDocument(JSON.stringify({ ...good, path: "/tmp/x" })), null);
  assert.equal(parseSyncStatusDocument(JSON.stringify({ ...good, status: "weird" })), null);
  assert.equal(parseSyncStatusDocument(JSON.stringify({ ...good, errorCode: "raw error text /tmp" })), null);
  assert.equal(parseSyncStatusDocument(JSON.stringify({ ...good, projectCount: -1 })), null);
  assert.equal(parseSyncStatusDocument("{ not json"), null);
  assert.equal(parseSyncStatusDocument(JSON.stringify({ ...good, checkedAt: "not a date" })), null);

  // Status invariants: error requires an allowlisted code; success requires
  // errorCode null plus complete last-good evidence.
  const errored = { ...good, status: "error", errorCode: "schema_mismatch" };
  assert.deepEqual(parseSyncStatusDocument(JSON.stringify(errored)), errored);
  assert.equal(parseSyncStatusDocument(JSON.stringify({ ...good, status: "error" })), null);
  assert.equal(parseSyncStatusDocument(JSON.stringify({ ...good, status: "error", errorCode: null })), null);
  assert.equal(parseSyncStatusDocument(JSON.stringify({ ...good, status: "error", errorCode: "ENOENT: /tmp/x" })), null);
  assert.equal(parseSyncStatusDocument(JSON.stringify({ ...good, errorCode: "sync_error" })), null);
  assert.equal(parseSyncStatusDocument(JSON.stringify({ ...good, syncedAt: null })), null);
  assert.equal(parseSyncStatusDocument(JSON.stringify({ ...good, registryUpdatedAt: null })), null);
  assert.equal(parseSyncStatusDocument(JSON.stringify({ ...good, projectCount: null })), null);
  assert.equal(parseSyncStatusDocument(JSON.stringify({ ...good, status: "unchanged", errorCode: "sync_error" })), null);
});

test("businessRegistryFreshness classifies fresh, stale, and unavailable", () => {
  const now = Date.parse("2026-09-19T12:00:00Z");
  const registry = { updatedAt: "2026-09-19" };
  const fresh = buildSyncStatus({
    status: "unchanged",
    checkedAt: "2026-09-19T11:58:00Z",
    syncedAt: "2026-09-19T11:00:00Z",
    registryUpdatedAt: "2026-09-19",
    projectCount: 1,
  });
  assert.equal(businessRegistryFreshness({ registry, status: fresh, now }), "fresh");
  assert.equal(businessRegistryFreshness({ registry: null, status: fresh, now }), "unavailable");
  assert.equal(businessRegistryFreshness({ registry, status: null, now }), "stale");
  assert.equal(
    businessRegistryFreshness({ registry, status: { ...fresh, status: "error", errorCode: "schema_mismatch" }, now }),
    "stale",
  );
  assert.equal(
    businessRegistryFreshness({ registry, status: { ...fresh, checkedAt: "2026-09-19T11:40:00Z" }, now, staleMs: 10 * 60 * 1000 }),
    "stale",
  );
  assert.equal(
    businessRegistryFreshness({ registry: { updatedAt: "2026-09-20" }, status: fresh, now }),
    "stale",
  );
  // A checkedAt beyond the allowed clock skew must not stay fresh forever.
  assert.equal(
    businessRegistryFreshness({ registry, status: { ...fresh, checkedAt: "2026-09-19T12:10:00Z" }, now }),
    "stale",
  );
  // Within the skew tolerance, a slightly future timestamp is still trusted.
  assert.equal(
    businessRegistryFreshness({ registry, status: { ...fresh, checkedAt: "2026-09-19T12:03:00Z" }, now }),
    "fresh",
  );
});

test("non-ENOENT I/O errors fail closed with bounded, path-free output", async () => {
  const nopermDir = join(workDir, "noperm");
  await mkdir(nopermDir);
  await chmod(nopermDir, 0o000);
  const run = runCli(["sync", "--source", sourceFile, "--destination", join(nopermDir, "registry.private.json")]);
  try {
    assert.equal(run.status, 2, `expected exit 2, got ${run.status}: ${run.stderr}`);
    assert.equal(run.stderr.includes(workDir), false, "sync logs must never leak local paths");
    assert.match(run.stderr, /status 기록에 실패했습니다 \[sync_error\]/);
    assert.match(run.stderr, /동기화를 거부했습니다 \[sync_error\]/);
  } finally {
    await chmod(nopermDir, 0o755);
  }
  assert.deepEqual(await readdir(nopermDir), [], "no lock or temp file residue may remain");
});

test("an unreadable destination fails closed and is never overwritten", async () => {
  const permDestDir = join(workDir, "perm-dest");
  const permDest = join(permDestDir, "registry.private.json");
  const ok = runCli(["sync", "--source", sourceFile, "--destination", permDest]);
  assert.equal(ok.status, 0, ok.stderr);
  await chmod(permDest, 0o000);
  const run = runCli(["sync", "--source", sourceFile, "--destination", permDest]);
  try {
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stderr.includes(workDir), false, "bounded output must not leak paths");
    const status = JSON.parse(await readFile(join(permDestDir, SYNC_STATUS_FILENAME), "utf8"));
    assert.equal(status.errorCode, "destination_unreadable");
  } finally {
    await chmod(permDest, 0o600);
  }
  const parsed = JSON.parse(await readFile(permDest, "utf8"));
  assert.equal(parsed.projects[0].id, "alpha", "an uninspectable destination was never replaced");
});

test("a status write failure exits 2 with bounded, path-free output", async () => {
  const okDest = join(workDir, "ok-dest", "registry.private.json");
  const roStatusDir = join(workDir, "ro-status");
  await mkdir(roStatusDir);
  await chmod(roStatusDir, 0o555);
  const run = runCli([
    "sync", "--source", sourceFile, "--destination", okDest,
    "--status", join(roStatusDir, "s.json"),
  ]);
  try {
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stderr.includes(workDir), false);
    assert.match(run.stderr, /status 기록에 실패했습니다 \[/);
  } finally {
    await chmod(roStatusDir, 0o755);
  }
  assert.deepEqual(await readdir(roStatusDir), [], "a failed status write must leave no temp file");
});

test("writeAtomicMode leaves no temp file and preserves the target on failure", async () => {
  const roDir = join(workDir, "ro-atomic");
  await mkdir(roDir);
  const target = join(roDir, "registry.private.json");
  await writeFile(target, "last-good", "utf8");
  await chmod(roDir, 0o555);
  try {
    await assert.rejects(writeAtomicMode(target, "new-content", 0o600));
    assert.deepEqual(await readdir(roDir), ["registry.private.json"], "no temp fragment may remain");
  } finally {
    await chmod(roDir, 0o755);
  }
  assert.equal(await readFile(target, "utf8"), "last-good", "target must survive a failed atomic write");
});

test("writeAtomicMode cleans the temp file when rename fails", async () => {
  const clashDir = join(workDir, "atomic-clash");
  await mkdir(clashDir);
  const destAsDir = join(clashDir, "target");
  await mkdir(destAsDir);
  await writeFile(join(destAsDir, "keep"), "x", "utf8"); // non-empty dir defeats rename
  await assert.rejects(writeAtomicMode(destAsDir, "x"));
  assert.deepEqual(await readdir(clashDir), ["target"], "temp must be removed after a failed rename");
  assert.equal(await readFile(join(destAsDir, "keep"), "utf8"), "x", "the clashing entry is untouched");
});

test("writeAtomicMode succeeds with the requested mode and no residue", async () => {
  const dir = join(workDir, "atomic-ok");
  await mkdir(dir);
  const target = join(dir, "f.json");
  await writeAtomicMode(target, "v1", 0o600);
  assert.equal(await readFile(target, "utf8"), "v1");
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ["f.json"], "no temp file may remain after success");
});

test("uninstall reports whether the plist actually existed", async () => {
  const fakeHome = join(workDir, "fake-home");
  const plistDir = join(fakeHome, "Library", "LaunchAgents");
  await mkdir(plistDir, { recursive: true });
  const env = { HOME: fakeHome, HERMES_REGISTRY_SYNC_LAUNCHCTL: "/usr/bin/false" };
  const absent = runCli(["uninstall"], env);
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /plist가 없습니다/);
  assert.equal(absent.stdout.includes("제거했습니다"), false);
  const plistPath = join(plistDir, "com.hyphen.hermes-registry-sync.plist");
  await writeFile(plistPath, "<plist/>", "utf8");
  const removed = runCli(["uninstall"], env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /plist를 제거했습니다/);
  assert.equal(await lstat(plistPath).catch(() => null), null, "the plist must actually be gone");
});

test("a normal sync exits promptly with no lock or timer residue", async () => {
  const quickDest = join(workDir, "quick-dest", "registry.private.json");
  const started = Date.now();
  const run = runCli(["sync", "--source", sourceFile, "--destination", quickDest], {}, { timeout: 10 * 1000 });
  const elapsed = Date.now() - started;
  assert.equal(run.signal, null, "the CLI must exit on its own, not be killed");
  assert.equal(run.status, 0, run.stderr);
  assert.ok(elapsed < 2000, `a finished sync must not wait out the watchdog (${elapsed}ms)`);
  const entries = await readdir(join(workDir, "quick-dest"));
  assert.equal(entries.includes("registry-sync.lock"), false, "the lock must be released");
  assert.equal(entries.some((name) => name.includes(".tmp-")), false, "no temp residue");
});

test("a wedged fs call degrades to bounded sync_timeout instead of a zombie process", async () => {
  const fifoDestDir = join(workDir, "fifo-dest");
  await mkdir(fifoDestDir, { recursive: true });
  // A FIFO at the lock path makes acquireLock's readFile block forever —
  // the watchdog must fire, report a bounded error, and exit the process.
  spawnSync("mkfifo", [join(fifoDestDir, "registry-sync.lock")]);
  const run = runCli(
    ["sync", "--source", sourceFile, "--destination", join(fifoDestDir, "registry.private.json")],
    { HERMES_REGISTRY_SYNC_TIMEOUT_MS: "2000" },
    { timeout: 20 * 1000 },
  );
  // The watchdog self-terminates with SIGKILL: a wedged threadpool open()
  // cannot be unwound — even process.exit() would join the dead thread and
  // hang. SIGKILL before the harness timeout proves the bound works.
  assert.equal(run.signal, "SIGKILL");
  assert.match(run.stderr, /동기화를 거부했습니다 \[sync_timeout\]/);
  assert.equal(run.stderr.includes(workDir), false, "bounded output must not leak paths");
  const status = JSON.parse(await readFile(join(fifoDestDir, SYNC_STATUS_FILENAME), "utf8"));
  assert.equal(status.errorCode, "sync_timeout");
  assert.deepEqual(
    (await readdir(fifoDestDir)).sort(),
    ["registry-sync-status.json", "registry-sync.lock"].sort(),
    "the wedged lock and the recorded error are the only artifacts — no temp or half-written files",
  );
});

test("install refuses paths a launchd child cannot open", async () => {
  const fakeHome = join(workDir, "guard-home");
  await mkdir(join(fakeHome, "Documents"), { recursive: true });
  const env = { HOME: fakeHome, HERMES_REGISTRY_SYNC_LAUNCHCTL: "/usr/bin/false" };
  const run = runCli(
    ["install", "--source", join(fakeHome, "Documents", "registry.private.json"), "--destination", destFile, "--dry-run"],
    env,
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /보호 경로/);
  const plistPath = join(fakeHome, "Library", "LaunchAgents", "com.hyphen.hermes-registry-sync.plist");
  assert.equal(await lstat(plistPath).catch(() => null), null, "no plist may be written on refusal");
  // The explicit override keeps an operator with arranged access in charge.
  const allowed = runCli(
    [
      "install", "--source", join(fakeHome, "Documents", "registry.private.json"),
      "--destination", destFile, "--dry-run", "--allow-protected-paths",
    ],
    env,
  );
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /보호 경로를 명시적으로 허용/);
});

test("install stages a runnable tool copy and records the sync-paths config", async () => {
  const fakeHome = join(workDir, "install-home");
  const mirror = join(fakeHome, "Library", "Application Support", "mirror", "registry.private.json");
  const env = { HOME: fakeHome, HERMES_REGISTRY_SYNC_LAUNCHCTL: "/usr/bin/false" };
  const run = runCli(["install", "--source", mirror, "--destination", destFile, "--no-load"], env);
  assert.equal(run.status, 0, run.stderr);
  const stageDir = join(fakeHome, "Library", "Application Support", "Hyphen", "hermes-registry-sync", "tool");
  for (const name of ["hermes-registry-sync.mjs", "hermes-business-registry.mjs"]) {
    const staged = join(stageDir, name);
    assert.equal(await readFile(staged, "utf8"), await readFile(join(repoRoot, "scripts", name), "utf8"), `${name} must be staged verbatim`);
    assert.equal((await stat(staged)).mode & 0o777, 0o600);
  }
  const plistPath = join(fakeHome, "Library", "LaunchAgents", "com.hyphen.hermes-registry-sync.plist");
  const plist = await readFile(plistPath, "utf8");
  assert.ok(plist.includes(join(stageDir, "hermes-registry-sync.mjs")), "plist runs the staged script");
  assert.equal(plist.includes(syncScript), false, "plist never references the repo script");
  const configPath = join(fakeHome, "Library", "Application Support", "Hyphen", "hermes-registry-sync", "sync-paths.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.source, mirror);
  assert.equal(config.destination, destFile);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  // uninstall removes the whole install footprint truthfully.
  const gone = runCli(["uninstall"], env);
  assert.equal(gone.status, 0, gone.stderr);
  assert.match(gone.stdout, /스테이징된 도구를 제거했습니다/);
  assert.match(gone.stdout, /동기화 경로 설정을 제거했습니다/);
  assert.equal(await lstat(configPath).catch(() => null), null);
  assert.equal(await lstat(stageDir).catch(() => null), null);
});

test("an install --no-load plist keeps every launchd-touched path outside protected prefixes", async () => {
  const fakeHome = join(workDir, "plist-guard-home");
  const mirror = join(fakeHome, "Library", "Application Support", "mirror", "registry.private.json");
  const dest = join(fakeHome, "Library", "Application Support", "dest", "registry.private.json");
  const env = { HOME: fakeHome, HERMES_REGISTRY_SYNC_LAUNCHCTL: "/usr/bin/false" };
  const run = runCli(["install", "--source", mirror, "--destination", dest, "--no-load"], env);
  assert.equal(run.status, 0, run.stderr);
  const plistPath = join(fakeHome, "Library", "LaunchAgents", "com.hyphen.hermes-registry-sync.plist");
  const plist = await readFile(plistPath, "utf8");
  // ProgramArguments order: node, staged script, "sync", --source, source,
  // --destination, destination, --status, statusPath. Every path the launchd
  // child opens must sit outside the protected prefixes — an open() under
  // one suspends in the kernel forever, which is the field defect this
  // install layout exists to prevent. --allow-protected-paths is not used.
  const stageDir = join(fakeHome, "Library", "Application Support", "Hyphen", "hermes-registry-sync", "tool");
  const statusPath = join(dirname(dest), SYNC_STATUS_FILENAME);
  const launchdPaths = {
    script: join(stageDir, "hermes-registry-sync.mjs"),
    source: mirror,
    destination: dest,
    status: statusPath,
  };
  for (const [label, launchdPath] of Object.entries(launchdPaths)) {
    assert.ok(plist.includes(`<string>${launchdPath}</string>`), `plist must carry the ${label} path`);
    assert.equal(
      protectedPrefixFor(launchdPath, fakeHome),
      null,
      `plist ${label} path must be outside Documents/Desktop/Downloads/Mobile Documents/CloudStorage`,
    );
  }
});
