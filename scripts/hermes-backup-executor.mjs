// Hermes backup executor — the explicit, fail-closed counterpart to the
// read-only backup-readiness tool. This is the ONLY component that creates
// backup snapshots. Everything it writes lives under an explicitly declared
// destination (--destination / HERMES_BACKUP_DESTINATION); it never infers a
// destination from the manifest, projects registry, or home directory.
//
// Commands: run | status | verify | rehearse | install | uninstall
//   run       scan the manifest → copy into snapshot-<ts>.partial → checksum
//             every artifact → atomic rename → retention → bounded state file
//   status    bounded state + snapshot listing (read-only)
//   verify    re-hash an existing snapshot against its recorded checksums
//   rehearse  restore a snapshot into an isolated temp dir, re-verify every
//             checksum + sqlite integrity, then discard — never touches the
//             live sources (no destructive restore exists)
//   install   write the com.hyphen.hermes-backup LaunchAgent (explicit only)
//   uninstall remove it (explicit only)
//
// Fail-closed guarantees: protected names are never copied, symlinks are
// never followed (escapes are errors), missing destination is a hard error,
// sqlite uses the online-backup API or an at-rest file copy — never a live
// WAL copy. Unknown/unverified is never reported as backup success.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BackupReadinessError,
  effectiveBounds,
  expandHome,
  hasProtectedSegment,
  isProtectedName,
  loadBackupManifest,
  resolveManifestPath,
  scanManifest,
} from "./hermes-backup-manifest.mjs";

export const EXECUTOR_SCHEMA_VERSION = 1;
export const EXECUTOR_KIND = "hermes-backup-executor";
export const SNAPSHOT_PATTERN = /^snapshot-\d{8}T\d{6}Z$/;
export const LAUNCH_AGENT_LABEL = "com.hyphen.hermes-backup";
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_KEEP = 7;
const MAX_KEEP = 60;
const MAX_ERROR_CHARS = 240;
const MAX_STATE_ITEMS = 200;

class ExecutorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutorError";
    this.code = code;
  }
}

function runner(execFileImpl = execFile) {
  return (command, args, { timeoutMs = 30000 } = {}) =>
    new Promise((resolvePromise) => {
      execFileImpl(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
        resolvePromise({
          ok: !error,
          code: typeof error?.code === "number" ? error.code : null,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      });
    });
}

function parseArgs(argv) {
  const options = { flags: new Set(), values: new Map(), positionals: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      options.positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      options.values.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--") && VALUE_OPTIONS.has(body)) {
      options.values.set(body, next);
      index += 1;
      continue;
    }
    options.flags.add(body);
  }
  return options;
}

const VALUE_OPTIONS = new Set(["destination", "manifest", "keep", "snapshot", "label-dir", "stage-dir"]);

function resolveDestination({ options, env = process.env } = {}) {
  const raw = options?.values.get("destination") || env.HERMES_BACKUP_DESTINATION || "";
  if (!raw.trim()) {
    throw new ExecutorError(
      "destination_missing",
      "backup destination is required — pass --destination or set HERMES_BACKUP_DESTINATION (never inferred)",
    );
  }
  const resolved = expandHome(raw.trim());
  if (hasProtectedSegment(resolved)) {
    throw new ExecutorError("secret_path", `destination resolves into a protected name: ${raw}`);
  }
  return resolved;
}

async function requireDestination(destination, { mustExist = true } = {}) {
  let info;
  try {
    info = await lstat(destination);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (!mustExist) return null;
      throw new ExecutorError(
        "destination_unavailable",
        `backup destination does not exist: ${destination} — create it first; the executor never auto-creates the root`,
      );
    }
    throw new ExecutorError("destination_unreadable", `cannot stat destination (${error?.code || error})`);
  }
  if (info.isSymbolicLink()) {
    throw new ExecutorError("destination_symlink", "backup destination must not be a symlink");
  }
  if (!info.isDirectory()) {
    throw new ExecutorError("destination_not_directory", "backup destination is not a directory");
  }
  return info;
}

function assertDestinationOutsideSources(destination, sources) {
  const destReal = destination;
  for (const source of sources) {
    const src = source.resolvedPath;
    if (destReal === src || destReal.startsWith(`${src}${sep}`)) {
      throw new ExecutorError(
        "destination_inside_source",
        `destination must not live inside source '${source.id}'`,
      );
    }
    if (src === destReal || src.startsWith(`${destReal}${sep}`)) {
      throw new ExecutorError(
        "source_inside_destination",
        `source '${source.id}' lives inside the backup destination`,
      );
    }
  }
}

async function sha256Stream(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

// PID lock — same contract as the registry-sync lock: O_EXCL create, stale
// detection by pid liveness, always released in a finally.
async function acquireLock(destination) {
  const lockPath = join(destination, ".hermes-backup.lock");
  await mkdir(destination, { recursive: true });
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      let stale = false;
      try {
        const holder = JSON.parse(await readFile(lockPath, "utf8"));
        const pid = Number(holder?.pid);
        const at = Date.parse(holder?.at || "");
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch {
            stale = true; // process is gone — lock is stale
          }
        }
        if (!stale && Number.isFinite(at) && Date.now() - at > LOCK_STALE_MS) stale = true;
      } catch {
        stale = true; // unreadable lock is treated as stale
      }
      if (!stale) {
        throw new ExecutorError("locked", "another backup run holds the destination lock");
      }
      await rm(lockPath, { force: true });
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), {
        encoding: "utf8",
        flag: "wx",
      });
    } else {
      throw error;
    }
  }
  return async () => rm(lockPath, { force: true });
}

function snapshotName(date = new Date()) {
  return `snapshot-${date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
}

// Second-resolution names can collide on fast repeat runs — walk forward one
// second at a time until an unused name is found (deterministic, bounded).
async function uniqueSnapshotName(destination, start = new Date()) {
  for (let offset = 0; offset < 120; offset += 1) {
    const name = snapshotName(new Date(start.getTime() + offset * 1000));
    const taken = await lstat(join(destination, name)).catch(() => null);
    const partialTaken = await lstat(join(destination, `${name}.partial`)).catch(() => null);
    if (!taken && !partialTaken) return name;
  }
  throw new ExecutorError("snapshot_name_exhausted", "could not allocate a unique snapshot name");
}

// Directory copy mirrors the readiness scanner's rules exactly: sorted names,
// the same bounds, protected names recorded-not-copied, excludes honored,
// symlinks never followed (escapes fail closed). Returns the file manifest.
async function copyDirectorySource(source, destDir, bounds, records) {
  const maxEntries = Math.min(source.maxEntries ?? bounds.maxEntriesPerSource, 50000);
  const maxDepth = Math.min(source.maxDepth ?? bounds.maxDepth, 16);
  const recursive = source.recursive !== false;
  const excluded = source.excluded || new Set();
  let rootReal;
  try {
    rootReal = await realpath(source.resolvedPath);
  } catch {
    rootReal = source.resolvedPath;
  }
  let visited = 0;

  const isExcluded = (rel) => {
    for (const prefix of excluded) {
      if (rel === prefix || rel.startsWith(`${prefix}/`)) return true;
    }
    return false;
  };

  async function walk(dirAbs, rel, depth) {
    const dirents = (await readdir(dirAbs, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const dirent of dirents) {
      visited += 1;
      if (visited > maxEntries) {
        throw new ExecutorError("bounds_exceeded", `source '${source.id}' exceeds ${maxEntries} entries`);
      }
      const childAbs = join(dirAbs, dirent.name);
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (isExcluded(childRel)) {
        records.push({ path: childRel, kind: "excluded" });
        continue;
      }
      if (isProtectedName(dirent.name)) {
        records.push({ path: childRel, kind: "protected" });
        continue;
      }
      if (dirent.isSymbolicLink()) {
        const target = await realpath(childAbs).catch(() => null);
        if (target !== null && target !== rootReal && !target.startsWith(`${rootReal}${sep}`)) {
          throw new ExecutorError("path_escape", `symlink escapes source root: ${childRel}`);
        }
        records.push({ path: childRel, kind: "symlink", state: target === null ? "dangling" : "skipped" });
        continue;
      }
      if (dirent.isDirectory()) {
        if (recursive && depth < maxDepth) {
          records.push({ path: childRel, kind: "directory" });
          await mkdir(join(destDir, childRel), { recursive: true });
          await walk(childAbs, childRel, depth + 1);
        } else {
          records.push({ path: childRel, kind: "directory", descended: false });
        }
        continue;
      }
      if (dirent.isFile()) {
        const info = await lstat(childAbs);
        const destPath = join(destDir, childRel);
        await mkdir(join(destPath, ".."), { recursive: true });
        await copyFile(childAbs, destPath);
        const sha256 = await sha256Stream(destPath);
        records.push({ path: childRel, kind: "file", bytes: info.size, sha256 });
        continue;
      }
      throw new ExecutorError("unexpected_type", `entry is not a file/dir/symlink: ${childRel}`);
    }
  }

  await mkdir(destDir, { recursive: true });
  await walk(source.resolvedPath, "", 1);
}

async function copyFileSource(source, destDir, records) {
  const info = await lstat(source.resolvedPath);
  if (info.isSymbolicLink()) throw new ExecutorError("source_symlink", `source '${source.id}' is a symlink`);
  if (!info.isFile()) throw new ExecutorError("unexpected_type", `source '${source.id}' is not a file`);
  await mkdir(destDir, { recursive: true });
  const destPath = join(destDir, basename(source.resolvedPath));
  await copyFile(source.resolvedPath, destPath);
  const sha256 = await sha256Stream(destPath);
  records.push({ path: basename(source.resolvedPath), kind: "file", bytes: info.size, sha256 });
}

// sqlite: online-backup API when a live WAL set is present (or always when
// sqlite3 exists and consistency is online-backup); plain copy only when the
// set is provably at rest. Never copies a live .db alongside its -wal.
async function copySqliteSource(source, destDir, records, { run = runner() } = {}) {
  const dbInfo = await lstat(source.resolvedPath).catch(() => null);
  if (!dbInfo || !dbInfo.isFile() || dbInfo.isSymbolicLink()) {
    throw new ExecutorError("sqlite_unavailable", `sqlite source '${source.id}' is not a regular file`);
  }
  const sidecars = await Promise.all(
    [`${source.resolvedPath}-wal`, `${source.resolvedPath}-shm`].map((path) =>
      lstat(path)
        .then((info) => info.isFile())
        .catch(() => false),
    ),
  );
  const live = sidecars[0] || sidecars[1];
  await mkdir(destDir, { recursive: true });
  const destPath = join(destDir, basename(source.resolvedPath));
  if (live || source.sqlite.consistency === "online-backup") {
    const outcome = await run("sqlite3", [source.resolvedPath, `.backup '${destPath}'`], { timeoutMs: 120000 });
    if (!outcome.ok) {
      if (live) {
        throw new ExecutorError(
          "sqlite_live_unbacked",
          `sqlite source '${source.id}' has live WAL sidecars and the online-backup tool failed — refusing a torn copy`,
        );
      }
      // At rest: fall back to a plain consistent file copy.
      await copyFile(source.resolvedPath, destPath);
    }
  } else {
    await copyFile(source.resolvedPath, destPath);
  }
  const sha256 = await sha256Stream(destPath);
  const record = { path: basename(source.resolvedPath), kind: "sqlite", bytes: (await lstat(destPath)).size, sha256 };
  const integrity = await run("sqlite3", [destPath, "PRAGMA integrity_check;"], { timeoutMs: 120000 });
  record.integrity = integrity.ok && /(^|\n)\s*ok\s*(\n|$)/.test(integrity.stdout) ? "ok" : "unverified";
  records.push(record);
}

async function listSnapshots(destination) {
  const entries = await readdir(destination, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && SNAPSHOT_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function readSnapshotManifest(destination, snapshotId) {
  const raw = await readFile(join(destination, snapshotId, "snapshot.json"), "utf8");
  const doc = JSON.parse(raw);
  if (doc?.kind !== EXECUTOR_KIND) throw new ExecutorError("snapshot_manifest_invalid", "snapshot.json kind mismatch");
  return doc;
}

async function writeState(destination, patch) {
  const statePath = join(destination, "hermes-backup-state.json");
  let state = { schemaVersion: EXECUTOR_SCHEMA_VERSION, kind: EXECUTOR_KIND, runsCompleted: 0, runsFailed: 0 };
  try {
    const existing = JSON.parse(await readFile(statePath, "utf8"));
    if (existing?.kind === EXECUTOR_KIND) state = { ...state, ...existing };
  } catch {
    // absent/corrupt state starts fresh — status stays honest via snapshots
  }
  Object.assign(state, patch);
  state.updatedAt = new Date().toISOString();
  const temp = `${statePath}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
  await rename(temp, statePath);
}

function boundedError(error) {
  return String(error instanceof Error ? error.message : error).slice(0, MAX_ERROR_CHARS);
}

export async function runBackup({ destination, manifest, keep = DEFAULT_KEEP, run = runner() } = {}) {
  await requireDestination(destination);
  assertDestinationOutsideSources(destination, manifest.sources);
  const releaseLock = await acquireLock(destination);
  const startedAt = new Date();
  const snapshotId = await uniqueSnapshotName(destination, startedAt);
  const partial = join(destination, `${snapshotId}.partial`);
  const finalDir = join(destination, snapshotId);
  try {
    await rm(partial, { force: true, recursive: true });
    await mkdir(partial, { recursive: true });
    const sources = [];
    for (const source of manifest.sources) {
      const records = [];
      const destDir = join(partial, source.id);
      try {
        if (source.type === "file") await copyFileSource(source, destDir, records);
        else if (source.type === "directory") await copyDirectorySource(source, destDir, effectiveBounds(manifest), records);
        else await copySqliteSource(source, destDir, records, { run });
        sources.push({ id: source.id, type: source.type, required: source.required, status: "ok", files: records });
      } catch (error) {
        sources.push({
          id: source.id,
          type: source.type,
          required: source.required,
          status: "failed",
          errorCode: error?.code || "copy_failed",
          error: boundedError(error),
          files: records.slice(0, MAX_STATE_ITEMS),
        });
        if (source.required) throw error;
      }
    }
    const doc = {
      kind: EXECUTOR_KIND,
      schemaVersion: EXECUTOR_SCHEMA_VERSION,
      snapshotId,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      manifestId: manifest.manifestId,
      sources,
    };
    await writeFile(join(partial, "snapshot.json"), JSON.stringify(doc, null, 2), "utf8");
    const failedRequired = sources.some((source) => source.status === "failed" && source.required);
    if (failedRequired) {
      throw new ExecutorError("required_source_failed", "a required source failed — snapshot discarded");
    }
    await rename(partial, finalDir);
    // Retention: only ever removes names matching the snapshot pattern.
    const snapshots = await listSnapshots(destination);
    const excess = snapshots.length - Math.min(Math.max(1, keep), MAX_KEEP);
    const removed = [];
    if (excess > 0) {
      for (const old of snapshots.slice(0, excess)) {
        await rm(join(destination, old), { force: true, recursive: true });
        removed.push(old);
      }
    }
    await writeState(destination, {
      lastResult: "ok",
      lastSnapshotId: snapshotId,
      lastError: null,
      runsCompleted: await readSnapshotCount(destination),
      snapshotsRemoved: removed.slice(0, 20),
    });
    const partialFailures = sources.some((source) => source.status === "failed");
    return {
      ok: true,
      partial: partialFailures,
      snapshotId,
      destination,
      sources: sources.map(({ id, status, files, errorCode }) => ({
        id,
        status,
        files: files?.filter((file) => file.kind === "file" || file.kind === "sqlite").length ?? 0,
        ...(errorCode ? { errorCode } : {}),
      })),
      removed,
    };
  } catch (error) {
    await rm(partial, { force: true, recursive: true }).catch(() => {});
    await writeState(destination, {
      lastResult: "failed",
      lastSnapshotId: null,
      lastError: { code: error?.code || "backup_failed", message: boundedError(error) },
    }).catch(() => {});
    throw error;
  } finally {
    await releaseLock();
  }
}

async function readSnapshotCount(destination) {
  const statePath = join(destination, "hermes-backup-state.json");
  try {
    const existing = JSON.parse(await readFile(statePath, "utf8"));
    return Number(existing.runsCompleted || 0) + 1;
  } catch {
    return 1;
  }
}

export async function executorStatus({ destination } = {}) {
  const info = await requireDestination(destination).catch((error) => {
    if (error?.code === "destination_unavailable") return null;
    throw error;
  });
  if (!info) {
    return { kind: EXECUTOR_KIND, state: "unavailable", reason: "destination_missing" };
  }
  let state = null;
  try {
    state = JSON.parse(await readFile(join(destination, "hermes-backup-state.json"), "utf8"));
  } catch {
    state = null;
  }
  const snapshots = await listSnapshots(destination);
  return {
    kind: EXECUTOR_KIND,
    state: state?.lastResult === "ok" ? "ok" : snapshots.length > 0 ? "unknown" : "unverified",
    reason: state?.lastResult === "failed" ? "last_run_failed" : snapshots.length === 0 ? "no_snapshots" : null,
    lastResult: state?.lastResult || null,
    lastSnapshotId: state?.lastSnapshotId || null,
    lastError: state?.lastError || null,
    runsCompleted: Number(state?.runsCompleted || 0),
    snapshots: snapshots.slice(-20),
    snapshotCount: snapshots.length,
    updatedAt: state?.updatedAt || null,
  };
}

export async function verifySnapshot({ destination, snapshotId } = {}) {
  await requireDestination(destination);
  const snapshots = await listSnapshots(destination);
  const target = snapshotId || snapshots.at(-1);
  if (!target || !SNAPSHOT_PATTERN.test(target)) {
    throw new ExecutorError("snapshot_missing", "no snapshot to verify");
  }
  const doc = await readSnapshotManifest(destination, target);
  const mismatches = [];
  let checked = 0;
  for (const source of doc.sources || []) {
    for (const record of source.files || []) {
      if (record.kind !== "file" && record.kind !== "sqlite") continue;
      const path = join(destination, target, source.id, record.path);
      const info = await lstat(path).catch(() => null);
      if (!info?.isFile()) {
        mismatches.push({ source: source.id, path: record.path, code: "missing" });
        continue;
      }
      const sha256 = await sha256Stream(path);
      checked += 1;
      if (sha256 !== record.sha256) {
        mismatches.push({ source: source.id, path: record.path, code: "hash_mismatch" });
      }
    }
  }
  return {
    snapshotId: target,
    ok: mismatches.length === 0,
    checked,
    mismatches: mismatches.slice(0, 50),
  };
}

export async function rehearseRestore({ destination, snapshotId, run = runner() } = {}) {
  await requireDestination(destination);
  const snapshots = await listSnapshots(destination);
  const target = snapshotId || snapshots.at(-1);
  if (!target || !SNAPSHOT_PATTERN.test(target)) {
    throw new ExecutorError("snapshot_missing", "no snapshot to rehearse");
  }
  const doc = await readSnapshotManifest(destination, target);
  const rehearsalRoot = await mkdtemp(join(tmpdir(), "hermes-backup-rehearsal-"));
  try {
    const results = [];
    for (const source of doc.sources || []) {
      const srcDir = join(destination, target, source.id);
      const dstDir = join(rehearsalRoot, source.id);
      // A source that failed during backup has no snapshot directory — its
      // absence is honest snapshot state, not a rehearsal failure.
      if (source.status === "failed" || !(await lstat(srcDir).catch(() => null))) {
        results.push({ source: source.id, status: "absent" });
        continue;
      }
      const copy = await run("cp", ["-R", srcDir, dstDir], { timeoutMs: 300000 });
      if (!copy.ok) {
        results.push({ source: source.id, status: "failed", code: "copy_failed" });
        continue;
      }
      let checked = 0;
      let failed = 0;
      for (const record of source.files || []) {
        if (record.kind !== "file" && record.kind !== "sqlite") continue;
        const rehearsed = join(dstDir, record.path);
        const info = await lstat(rehearsed).catch(() => null);
        if (!info?.isFile()) {
          failed += 1;
          continue;
        }
        const sha256 = await sha256Stream(rehearsed);
        checked += 1;
        if (sha256 !== record.sha256) failed += 1;
        if (record.kind === "sqlite") {
          const integrity = await run("sqlite3", [rehearsed, "PRAGMA integrity_check;"], { timeoutMs: 120000 });
          record.rehearsalIntegrity = integrity.ok && /(^|\n)\s*ok\s*(\n|$)/.test(integrity.stdout) ? "ok" : "failed";
          if (record.rehearsalIntegrity !== "ok") failed += 1;
        }
      }
      results.push({ source: source.id, status: failed === 0 ? "ok" : "failed", checked, failed });
    }
    return {
      snapshotId: target,
      rehearsalRoot,
      ok: results.every((entry) => entry.status === "ok" || entry.status === "absent"),
      sources: results,
      note: "rehearsal ran in an isolated temp dir; live sources were never touched and there is no destructive restore",
    };
  } finally {
    await rm(rehearsalRoot, { force: true, recursive: true }).catch(() => {});
  }
}

// --- LaunchAgent lifecycle (explicit operator commands only) ---

const TCC_SEGMENTS = ["/Documents", "/Desktop", "/Downloads", "/Library/CloudStorage", "/Pictures/Photos Library"];

function refusesProtectedLaunchPath(path) {
  return TCC_SEGMENTS.some((segment) => path.includes(segment));
}

export async function installLaunchAgent({
  destination,
  manifestPath,
  labelDir,
  env = process.env,
  keep = DEFAULT_KEEP,
} = {}) {
  await requireDestination(destination);
  const agentsDir = labelDir || join(env.HOME || homedir(), "Library", "LaunchAgents");
  const plistPath = join(agentsDir, `${LAUNCH_AGENT_LABEL}.plist`);
  const scriptPath = fileURLToPath(new URL(import.meta.url));
  if (refusesProtectedLaunchPath(scriptPath)) {
    throw new ExecutorError(
      "protected_path",
      `the executor script lives under a TCC-protected path (${scriptPath}) — stage it outside Documents/Desktop/Downloads first (see RUNBOOK)`,
    );
  }
  await mkdir(agentsDir, { recursive: true });
  const nodePath = process.execPath;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>run</string>
    <string>--destination</string>
    <string>${destination}</string>
    <string>--manifest</string>
    <string>${manifestPath}</string>
    <string>--keep</string>
    <string>${keep}</string>
  </array>
  <key>RunAtLoad</key><false/>
  <key>StartInterval</key><integer>21600</integer>
  <key>StandardOutPath</key><string>${join(destination, "hermes-backup.log")}</string>
  <key>StandardErrorPath</key><string>${join(destination, "hermes-backup.log")}</string>
</dict>
</plist>
`;
  const temp = `${plistPath}.${process.pid}.tmp`;
  await writeFile(temp, plist, "utf8");
  await rename(temp, plistPath);
  return {
    ok: true,
    plistPath,
    label: LAUNCH_AGENT_LABEL,
    note: "plist written. Load it explicitly: launchctl bootstrap gui/$UID " + plistPath,
  };
}

export async function uninstallLaunchAgent({ labelDir, env = process.env } = {}) {
  const agentsDir = labelDir || join(env.HOME || homedir(), "Library", "LaunchAgents");
  const plistPath = join(agentsDir, `${LAUNCH_AGENT_LABEL}.plist`);
  const info = await lstat(plistPath).catch(() => null);
  if (!info) return { ok: true, removed: false, plistPath };
  await rm(plistPath, { force: true });
  return { ok: true, removed: true, plistPath, note: "boot it out first if loaded: launchctl bootout gui/$UID " + LAUNCH_AGENT_LABEL };
}

async function loadManifestForRun(options, env) {
  const manifestPath = resolveManifestPath({ arg: options.values.get("manifest"), env });
  const { manifest } = await loadBackupManifest(manifestPath);
  return { manifestPath, manifest };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const command = options.positionals[0] || "status";
  const keep = Math.min(Math.max(1, Number(options.values.get("keep") || env.HERMES_BACKUP_KEEP || DEFAULT_KEEP)), MAX_KEEP);
  try {
    if (command === "run") {
      const destination = resolveDestination({ options, env });
      const { manifest, manifestPath } = await loadManifestForRun(options, env);
      void manifestPath;
      // Readiness scan first — a failing manifest scan refuses to back up.
      const scan = await scanManifest(manifest, { verify: false });
      if (scan.summary.errors > 0) {
        throw new ExecutorError("preflight_failed", `manifest scan reported ${scan.summary.errors} error(s)`);
      }
      const result = await runBackup({ destination, manifest, keep });
      printJson(result);
      return 0;
    }
    if (command === "status") {
      const destination = options.values.get("destination") || env.HERMES_BACKUP_DESTINATION || "";
      if (!destination.trim()) {
        printJson({ kind: EXECUTOR_KIND, state: "unavailable", reason: "destination_missing" });
        return 0;
      }
      printJson(await executorStatus({ destination: expandHome(destination.trim()) }));
      return 0;
    }
    if (command === "verify") {
      const destination = resolveDestination({ options, env });
      printJson(await verifySnapshot({ destination, snapshotId: options.values.get("snapshot") }));
      return 0;
    }
    if (command === "rehearse") {
      const destination = resolveDestination({ options, env });
      const result = await rehearseRestore({ destination, snapshotId: options.values.get("snapshot") });
      printJson(result);
      return result.ok ? 0 : 1;
    }
    if (command === "install") {
      const destination = resolveDestination({ options, env });
      const { manifestPath } = await loadManifestForRun(options, env);
      printJson(
        await installLaunchAgent({
          destination,
          manifestPath,
          labelDir: options.values.get("label-dir"),
          env,
          keep,
        }),
      );
      return 0;
    }
    if (command === "uninstall") {
      printJson(await uninstallLaunchAgent({ labelDir: options.values.get("label-dir"), env }));
      return 0;
    }
    process.stderr.write(`unknown command '${command}' — run|status|verify|rehearse|install|uninstall\n`);
    return 2;
  } catch (error) {
    if (error instanceof BackupReadinessError || error instanceof ExecutorError) {
      printJson({ ok: false, error: { code: error.code, message: boundedError(error) } });
      return 1;
    }
    throw error;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const code = await main();
  process.exitCode = code;
}
