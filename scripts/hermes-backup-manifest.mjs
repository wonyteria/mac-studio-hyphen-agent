import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Hermes backup-readiness manifest contract (schemaVersion 1).
// The manifest is owned by this repo and explicitly declares backup sources
// and targets for the Mac Studio operations boundary. This module only ever
// inspects metadata and hashes explicitly allowed files — it never creates,
// copies, moves, deletes, restores, mounts, schedules, or modifies anything.
// restore-plan output is instructions for an operator, never execution.

export const BACKUP_MANIFEST_SCHEMA_VERSION = 1;
export const BACKUP_MANIFEST_KIND = "hermes-backup-manifest";
export const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;
const FORBIDDEN_IDENTITY = new RegExp(`${String.fromCharCode(51, 120)}[-_]?ha[us]{1,2}t`, "i");

const SOURCE_TYPES = new Set(["file", "directory", "sqlite"]);
const TARGET_TYPES = new Set(["time-machine", "git-mirror", "directory", "external"]);
const ADAPTER_TYPES = new Set(["time-machine", "launchd", "path"]);
const SQLITE_CONSISTENCY = new Set(["quiesce", "online-backup"]);

// Default scan bounds. A manifest may declare tighter values in `bounds`;
// declaring anything above the hard caps is a schema violation.
export const DEFAULT_BOUNDS = Object.freeze({
  maxSources: 64,
  maxEntriesPerSource: 5000,
  maxDepth: 8,
  maxHashFileBytes: 32 * 1024 * 1024,
});
const HARD_CAPS = Object.freeze({
  maxSources: 128,
  maxEntriesPerSource: 50000,
  maxDepth: 16,
  maxHashFileBytes: 256 * 1024 * 1024,
});
const BOUND_KEYS = new Set(Object.keys(DEFAULT_BOUNDS));

// Names that must never be traversed, hashed, or have contents read. Extends
// the worker's protected-path rules with the env/token/cookie/keychain set
// required at the backup boundary. Matching is per path segment, lowercase.
const SAFE_ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const PROTECTED_EXACT = new Set([
  ".env",
  "workers.env",
  ".dev.vars",
  ".netrc",
  ".npmrc",
  ".pgpass",
  "auth.json",
  "cookies",
  ".ssh",
  ".gnupg",
  ".aws",
]);
export function isProtectedName(name) {
  const lower = String(name || "").toLowerCase();
  if (!lower || SAFE_ENV_TEMPLATES.has(lower)) return false;
  return (
    PROTECTED_EXACT.has(lower) ||
    lower.startsWith(".env.") ||
    lower.endsWith(".env") ||
    /\.(key|pem|p12|pfx|ppk|keystore|kdbx|keychain|keychain-db)$/.test(lower) ||
    /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(lower) ||
    /(^|[-_.])(secrets?|credentials?|tokens?|cookies?|keychains?|passwords?|passwd)([-_.]|$)/.test(lower)
  );
}
export function hasProtectedSegment(path) {
  return String(path || "")
    .split("/")
    .some((segment) => segment && segment !== "." && segment !== "~" && isProtectedName(segment));
}

export class BackupReadinessError extends Error {
  constructor(code, message, issues = []) {
    super(message);
    this.name = "BackupReadinessError";
    this.code = code;
    this.issues = issues;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function repoRootPath() {
  return fileURLToPath(new URL("../", import.meta.url));
}

export function defaultManifestPath(env = process.env) {
  if (env.HERMES_BACKUP_MANIFEST) return env.HERMES_BACKUP_MANIFEST;
  return join(repoRootPath(), "hermes-backup-manifest.json");
}

export function resolveManifestPath({ arg, env = process.env } = {}) {
  return arg || defaultManifestPath(env);
}

function* walkStrings(value, path) {
  if (typeof value === "string") {
    yield { path, value };
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      yield* walkStrings(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      yield* walkStrings(child, path ? `${path}.${key}` : key);
    }
  }
}

function checkKeys(object, allowed, required, path, issues) {
  for (const key of required) {
    if (!(key in object)) issues.push(`${path}: missing required field '${key}'`);
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) issues.push(`${path}: unknown field '${key}'`);
  }
}

function checkString(value, path, issues, { nullable = false, pattern = null, label = "string" } = {}) {
  if (value === null && nullable) return;
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path}: must be a non-empty ${label}`);
    return;
  }
  if (pattern && !pattern.test(value)) issues.push(`${path}: must match ${pattern}`);
}

function checkBool(value, path, issues) {
  if (typeof value !== "boolean") issues.push(`${path}: must be a boolean`);
}

function checkPositiveInt(value, path, issues, { max = null } = {}) {
  if (!Number.isInteger(value) || value <= 0) {
    issues.push(`${path}: must be a positive integer`);
    return;
  }
  if (max !== null && value > max) issues.push(`${path}: exceeds hard cap ${max}`);
}

function checkSourcePath(value, path, issues) {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path}: must be a non-empty path string`);
    return;
  }
  if (value.includes("\0")) issues.push(`${path}: must not contain NUL`);
  const isHome = value === "~" || value.startsWith("~/");
  if (!isHome && !isAbsolute(value)) {
    issues.push(`${path}: must be absolute or start with '~/' (no guessed relative paths)`);
  }
}

function checkExpect(expect, path, issues) {
  if (!isPlainObject(expect)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkKeys(expect, new Set(["bytes", "sha256"]), [], path, issues);
  if (!("bytes" in expect) && !("sha256" in expect)) {
    issues.push(`${path}: must pin at least one of 'bytes' or 'sha256'`);
  }
  if ("bytes" in expect && (!Number.isInteger(expect.bytes) || expect.bytes < 0)) {
    issues.push(`${path}.bytes: must be a non-negative integer`);
  }
  if ("sha256" in expect && !SHA256_PATTERN.test(String(expect.sha256))) {
    issues.push(`${path}.sha256: must be a lowercase sha256 hex digest`);
  }
}

function checkSqlite(sqlite, path, issues) {
  if (!isPlainObject(sqlite)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkKeys(sqlite, new Set(["consistency", "strategy"]), ["consistency", "strategy"], path, issues);
  if (!SQLITE_CONSISTENCY.has(sqlite.consistency)) {
    issues.push(`${path}.consistency: must be one of ${[...SQLITE_CONSISTENCY].join(", ")}`);
  }
  checkString(sqlite.strategy, `${path}.strategy`, issues);
  if (typeof sqlite.strategy === "string" && sqlite.strategy.length > 2000) {
    issues.push(`${path}.strategy: must be at most 2000 characters`);
  }
}

function checkExcludeEntry(entry, path, issues) {
  if (typeof entry !== "string" || entry.trim() === "") {
    issues.push(`${path}: must be a non-empty relative path`);
    return;
  }
  const normalized = normalize(entry).replaceAll("\\", "/");
  if (
    isAbsolute(entry) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("\0")
  ) {
    issues.push(`${path}: must be a relative path inside the source (no '..', no absolute)`);
  }
}

const SOURCE_COMMON_REQUIRED = ["id", "type", "path", "label", "required"];
const SOURCE_TYPE_KEYS = {
  file: new Set([...SOURCE_COMMON_REQUIRED, "expect"]),
  directory: new Set([...SOURCE_COMMON_REQUIRED, "recursive", "maxDepth", "maxEntries", "hashFiles", "exclude"]),
  sqlite: new Set([...SOURCE_COMMON_REQUIRED, "sqlite"]),
};

function checkSource(source, index, issues) {
  const path = `sources[${index}]`;
  if (!isPlainObject(source)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkString(source.id, `${path}.id`, issues, { pattern: ID_PATTERN, label: "id" });
  if (!SOURCE_TYPES.has(source.type)) {
    issues.push(`${path}.type: must be one of ${[...SOURCE_TYPES].join(", ")}`);
    return;
  }
  checkKeys(source, SOURCE_TYPE_KEYS[source.type], SOURCE_COMMON_REQUIRED, path, issues);
  checkSourcePath(source.path, `${path}.path`, issues);
  checkString(source.label, `${path}.label`, issues);
  checkBool(source.required, `${path}.required`, issues);

  if (source.type === "file" && "expect" in source) {
    checkExpect(source.expect, `${path}.expect`, issues);
  }
  if (source.type === "directory") {
    if ("recursive" in source) checkBool(source.recursive, `${path}.recursive`, issues);
    if ("hashFiles" in source) checkBool(source.hashFiles, `${path}.hashFiles`, issues);
    if ("maxDepth" in source) checkPositiveInt(source.maxDepth, `${path}.maxDepth`, issues);
    if ("maxEntries" in source) checkPositiveInt(source.maxEntries, `${path}.maxEntries`, issues);
    if ("exclude" in source) {
      if (!Array.isArray(source.exclude)) {
        issues.push(`${path}.exclude: must be an array of relative paths`);
      } else {
        source.exclude.forEach((entry, i) => checkExcludeEntry(entry, `${path}.exclude[${i}]`, issues));
      }
    }
  }
  if (source.type === "sqlite") {
    if (!("sqlite" in source)) {
      issues.push(`${path}: missing required field 'sqlite'`);
    } else {
      checkSqlite(source.sqlite, `${path}.sqlite`, issues);
    }
  }
}

function checkTarget(target, index, issues) {
  const path = `targets[${index}]`;
  if (!isPlainObject(target)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkKeys(target, new Set(["id", "type", "location", "notes"]), ["id", "type", "location", "notes"], path, issues);
  checkString(target.id, `${path}.id`, issues, { pattern: ID_PATTERN, label: "id" });
  if (!TARGET_TYPES.has(target.type)) {
    issues.push(`${path}.type: must be one of ${[...TARGET_TYPES].join(", ")}`);
  }
  checkString(target.location, `${path}.location`, issues);
  checkString(target.notes, `${path}.notes`, issues);
}

function checkAdapter(adapter, index, issues) {
  const path = `adapters[${index}]`;
  if (!isPlainObject(adapter)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkString(adapter.id, `${path}.id`, issues, { pattern: ID_PATTERN, label: "id" });
  if (!ADAPTER_TYPES.has(adapter.type)) {
    issues.push(`${path}.type: must be one of ${[...ADAPTER_TYPES].join(", ")}`);
    return;
  }
  const typeKeys = { "time-machine": new Set(), launchd: new Set(["job"]), path: new Set(["path"]) };
  checkKeys(
    adapter,
    new Set(["id", "type", "enabled", "label", ...typeKeys[adapter.type]]),
    ["id", "type", "enabled", ...typeKeys[adapter.type]],
    path,
    issues,
  );
  checkBool(adapter.enabled, `${path}.enabled`, issues);
  if (adapter.type === "launchd") checkString(adapter.job, `${path}.job`, issues);
  if (adapter.type === "path") checkSourcePath(adapter.path, `${path}.path`, issues);
  if ("label" in adapter) checkString(adapter.label, `${path}.label`, issues);
}

function checkBounds(bounds, issues) {
  if (!isPlainObject(bounds)) {
    issues.push("bounds: must be an object");
    return;
  }
  checkKeys(bounds, BOUND_KEYS, [], "bounds", issues);
  for (const key of Object.keys(bounds)) {
    if (BOUND_KEYS.has(key)) checkPositiveInt(bounds[key], `bounds.${key}`, issues, { max: HARD_CAPS[key] });
  }
}

function checkDuplicateIds(items, name, issues) {
  const seen = new Map();
  items.forEach((item, index) => {
    if (typeof item?.id !== "string") return;
    if (seen.has(item.id)) {
      issues.push(`${name}[${index}].id: duplicate id '${item.id}' (also at ${name}[${seen.get(item.id)}])`);
    } else {
      seen.set(item.id, index);
    }
  });
}

// Structural validation of the manifest. Any issue rejects the whole document
// (fail closed); there is no partial or best-effort parse.
export function validateBackupManifest(manifest) {
  const issues = [];
  if (!isPlainObject(manifest)) return ["manifest: must be an object"];
  const topKeys = new Set(["schemaVersion", "kind", "manifestId", "updatedAt", "bounds", "sources", "targets", "adapters"]);
  checkKeys(manifest, topKeys, ["schemaVersion", "kind", "manifestId", "updatedAt", "sources", "targets"], "manifest", issues);
  if (manifest.schemaVersion !== BACKUP_MANIFEST_SCHEMA_VERSION) {
    issues.push(`schemaVersion: must be ${BACKUP_MANIFEST_SCHEMA_VERSION}`);
  }
  if (manifest.kind !== BACKUP_MANIFEST_KIND) {
    issues.push(`kind: must be '${BACKUP_MANIFEST_KIND}'`);
  }
  checkString(manifest.manifestId, "manifest.manifestId", issues, { pattern: ID_PATTERN, label: "id" });
  if (!ISO_DATE.test(String(manifest.updatedAt)) && !ISO_DATETIME.test(String(manifest.updatedAt))) {
    issues.push("updatedAt: must be an ISO date/datetime");
  }
  if ("bounds" in manifest) checkBounds(manifest.bounds, issues);

  const bounds = effectiveBounds(manifest);
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) {
    issues.push("sources: must be a non-empty array");
  } else {
    if (manifest.sources.length > bounds.maxSources) {
      issues.push(`sources: ${manifest.sources.length} exceeds bounds.maxSources ${bounds.maxSources}`);
    }
    manifest.sources.forEach((source, index) => checkSource(source, index, issues));
    checkDuplicateIds(manifest.sources, "sources", issues);
  }
  if (!Array.isArray(manifest.targets)) {
    issues.push("targets: must be an array");
  } else {
    manifest.targets.forEach((target, index) => checkTarget(target, index, issues));
    checkDuplicateIds(manifest.targets, "targets", issues);
  }
  if ("adapters" in manifest) {
    if (!Array.isArray(manifest.adapters)) {
      issues.push("adapters: must be an array");
    } else {
      manifest.adapters.forEach((adapter, index) => checkAdapter(adapter, index, issues));
      checkDuplicateIds(manifest.adapters, "adapters", issues);
    }
  }
  for (const { path, value } of walkStrings(manifest, "")) {
    if (FORBIDDEN_IDENTITY.test(value)) {
      issues.push(`${path}: legacy identity marker is not allowed`);
    }
  }
  return issues;
}

// Resolves effective bounds: manifest may tighten DEFAULT_BOUNDS but never
// exceed the hard caps (enforced during validation).
export function effectiveBounds(manifest) {
  const declared = isPlainObject(manifest?.bounds) ? manifest.bounds : {};
  const bounds = {};
  for (const key of BOUND_KEYS) {
    const value = declared[key] ?? DEFAULT_BOUNDS[key];
    bounds[key] = Math.min(value, HARD_CAPS[key]);
  }
  return bounds;
}

// '~' and '~/...' expand against the current user's home — no account name is
// ever baked into a default. Anything else must already be absolute.
export function expandHome(value, home = homedir()) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return resolve(value);
}

// Reads, validates, and path-normalizes the manifest. Never modifies the file.
// Fails closed on unreadable paths, symlinks, non-regular files, oversized
// inputs, malformed JSON, schema mismatches, and protected/secret paths.
export async function loadBackupManifest(filePath, { maxBytes = DEFAULT_MAX_MANIFEST_BYTES, home = homedir() } = {}) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new BackupReadinessError("manifest_path_missing", "backup manifest path is empty");
  }
  const resolved = expandHome(filePath, home);
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    throw new BackupReadinessError(
      "manifest_unreadable",
      `backup manifest is not readable: ${resolved} (${error?.code || error})`,
    );
  }
  if (info.isSymbolicLink()) {
    throw new BackupReadinessError("manifest_symlink", `backup manifest must not be a symlink: ${resolved}`);
  }
  if (!info.isFile()) {
    throw new BackupReadinessError("manifest_not_regular", `backup manifest is not a regular file: ${resolved}`);
  }
  if (info.size > maxBytes) {
    throw new BackupReadinessError("manifest_too_large", `backup manifest exceeds ${maxBytes} bytes: ${resolved}`);
  }
  const raw = await readFile(resolved, "utf8");
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new BackupReadinessError("manifest_too_large", `backup manifest exceeds ${maxBytes} bytes: ${resolved}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new BackupReadinessError("manifest_parse_error", `backup manifest is not valid JSON: ${resolved}`);
  }
  const issues = validateBackupManifest(manifest);
  if (issues.length > 0) {
    throw new BackupReadinessError(
      "schema_mismatch",
      `backup manifest failed schema validation (${issues.length} issue(s))`,
      issues,
    );
  }
  const normalized = normalizeManifestPaths(manifest, home);
  return { path: resolved, manifest: normalized };
}

// Expands every declared path once and rejects any path that points at a
// protected name — an explicit manifest may never target secrets.
function normalizeManifestPaths(manifest, home) {
  const normalized = { ...manifest };
  normalized.sources = manifest.sources.map((source) => {
    const resolvedPath = expandHome(source.path, home);
    if (hasProtectedSegment(resolvedPath)) {
      throw new BackupReadinessError(
        "secret_path",
        `source '${source.id}' path resolves into a protected name: ${source.path}`,
      );
    }
    const extra = { resolvedPath };
    if (source.type === "directory" && Array.isArray(source.exclude)) {
      extra.excluded = new Set(source.exclude.map((entry) => normalize(entry).replaceAll("\\", "/")));
    }
    return { ...source, ...extra };
  });
  normalized.targets = manifest.targets.map((target) => {
    const isPath = target.location === "~" || target.location.startsWith("~/") || isAbsolute(target.location);
    const resolvedLocation = isPath ? expandHome(target.location, home) : target.location;
    if (isPath && (target.type === "directory" || target.type === "git-mirror") && hasProtectedSegment(resolvedLocation)) {
      throw new BackupReadinessError(
        "secret_path",
        `target '${target.id}' location resolves into a protected name: ${target.location}`,
      );
    }
    return { ...target, resolvedLocation };
  });
  normalized.adapters = (manifest.adapters || []).map((adapter) => ({
    ...adapter,
    resolvedPath: adapter.type === "path" ? expandHome(adapter.path, home) : undefined,
  }));
  return normalized;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

function finding(level, code, message, path = null) {
  return { level, code, message, ...(path ? { path } : {}) };
}

function compareNames(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

async function scanFileSource(source, verify, bounds, findings) {
  const info = await lstat(source.resolvedPath);
  const detail = { kind: "file", bytes: info.size, mtimeMs: Math.round(info.mtimeMs) };
  let status = "ok";
  if (verify) {
    if (info.size > bounds.maxHashFileBytes) {
      detail.hashStatus = "unhashed";
      detail.hashReason = "exceeds_hash_bound";
      findings.push(
        finding("warning", "hash_bound_exceeded", `file exceeds hash bound ${bounds.maxHashFileBytes} bytes`),
      );
      if (source.expect?.sha256) status = "unverified";
    } else {
      detail.sha256 = await sha256File(source.resolvedPath);
      detail.hashStatus = "hashed";
    }
  }
  if (source.expect) {
    detail.expect = { ...source.expect };
    if (source.expect.bytes !== undefined && source.expect.bytes !== info.size) {
      findings.push(
        finding("error", "expect_bytes_mismatch", `expected ${source.expect.bytes} bytes, found ${info.size}`),
      );
    }
    if (source.expect.sha256 !== undefined) {
      if (detail.sha256 === undefined) {
        findings.push(finding("warning", "expect_unverified", "pinned sha256 could not be checked"));
        status = "unverified";
      } else if (detail.sha256 !== source.expect.sha256) {
        findings.push(finding("error", "hash_mismatch", "sha256 does not match pinned expect.sha256"));
      } else {
        detail.verified = true;
      }
    }
  }
  if (findings.some((item) => item.level === "error")) status = "error";
  return { detail, status };
}

async function scanDirectorySource(source, verify, bounds, findings) {
  const stats = { files: 0, directories: 0, symlinks: 0, protected: 0, excluded: 0, other: 0, bytes: 0, hashed: 0 };
  const entries = [];
  const maxEntries = Math.min(source.maxEntries ?? bounds.maxEntriesPerSource, HARD_CAPS.maxEntriesPerSource);
  const maxDepth = Math.min(source.maxDepth ?? bounds.maxDepth, HARD_CAPS.maxDepth);
  const recursive = source.recursive !== false;
  const excluded = source.excluded || new Set();
  const depthLimited = [];
  let rootReal;
  try {
    rootReal = await realpath(source.resolvedPath);
  } catch {
    rootReal = source.resolvedPath;
  }
  let truncated = false;

  const isExcluded = (rel) => {
    for (const prefix of excluded) {
      if (rel === prefix || rel.startsWith(`${prefix}/`)) return true;
    }
    return false;
  };

  async function walk(dirAbs, rel, depth) {
    if (truncated) return;
    const dirents = (await readdir(dirAbs, { withFileTypes: true })).sort(compareNames);
    for (const dirent of dirents) {
      if (entries.length >= maxEntries) {
        truncated = true;
        findings.push(
          finding("error", "bounds_exceeded", `source has more than ${maxEntries} entries; refusing partial inventory`),
        );
        return;
      }
      const childAbs = join(dirAbs, dirent.name);
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (isExcluded(childRel)) {
        stats.excluded += 1;
        entries.push({ path: childRel, kind: "excluded" });
        continue;
      }
      // Protected names are never statted, hashed, traversed, or read — the
      // name alone is recorded so the inventory stays honest.
      if (isProtectedName(dirent.name)) {
        stats.protected += 1;
        entries.push({ path: childRel, kind: "protected" });
        continue;
      }
      if (dirent.isSymbolicLink()) {
        stats.symlinks += 1;
        const target = await realpath(childAbs).catch(() => null);
        if (target === null) {
          entries.push({ path: childRel, kind: "symlink", state: "dangling" });
          findings.push(finding("warning", "symlink_dangling", "dangling symlink not followed", childRel));
        } else if (target === rootReal || target.startsWith(`${rootReal}${sep}`)) {
          entries.push({ path: childRel, kind: "symlink", state: "inside-root" });
        } else {
          entries.push({ path: childRel, kind: "symlink", escape: true });
          findings.push(finding("error", "path_escape", "symlink resolves outside the source root", childRel));
        }
        continue;
      }
      if (dirent.isDirectory()) {
        stats.directories += 1;
        const entry = { path: childRel, kind: "directory" };
        if (recursive && depth < maxDepth) {
          entries.push(entry);
          await walk(childAbs, childRel, depth + 1);
        } else {
          entry.descended = false;
          entries.push(entry);
          if (recursive) depthLimited.push(childRel);
        }
        continue;
      }
      if (dirent.isFile()) {
        const fileInfo = await lstat(childAbs);
        stats.files += 1;
        stats.bytes += fileInfo.size;
        const entry = { path: childRel, kind: "file", bytes: fileInfo.size, mtimeMs: Math.round(fileInfo.mtimeMs) };
        if (verify && source.hashFiles === true) {
          if (fileInfo.size > bounds.maxHashFileBytes) {
            entry.hashStatus = "unhashed";
            entry.hashReason = "exceeds_hash_bound";
          } else {
            entry.sha256 = await sha256File(childAbs);
            entry.hashStatus = "hashed";
            stats.hashed += 1;
          }
        }
        entries.push(entry);
        continue;
      }
      stats.other += 1;
      entries.push({ path: childRel, kind: "other" });
      findings.push(finding("error", "unexpected_type", "entry is not a file, directory, or symlink", childRel));
    }
  }

  try {
    await walk(source.resolvedPath, "", 1);
  } catch (error) {
    findings.push(finding("error", "unreadable", `directory scan failed (${error?.code || error})`));
  }
  if (depthLimited.length > 0) {
    findings.push(
      finding(
        "warning",
        "depth_limit",
        `${depthLimited.length} director(y/ies) not descended beyond depth ${maxDepth}: ${depthLimited.slice(0, 3).join(", ")}${depthLimited.length > 3 ? ", …" : ""}`,
      ),
    );
  }
  if (stats.symlinks > 0) {
    const inside = entries.filter((entry) => entry.kind === "symlink" && entry.state === "inside-root").length;
    if (inside > 0) {
      findings.push(finding("warning", "symlinks_skipped", `${inside} in-root symlink(s) recorded but not followed`));
    }
  }
  const detail = { kind: "directory", stats, entries };
  const status = findings.some((item) => item.level === "error") ? "error" : "ok";
  return { detail, status };
}

async function sidecarInfo(path, findings) {
  const info = await lstatOrNull(path);
  if (info === null) return { present: false };
  if (info.isSymbolicLink()) {
    findings.push(finding("error", "sidecar_symlink", "sqlite sidecar must not be a symlink", path));
    return { present: true, symlink: true };
  }
  if (!info.isFile()) {
    findings.push(finding("error", "unexpected_type", "sqlite sidecar is not a regular file", path));
    return { present: true, unexpected: true };
  }
  return { present: true, bytes: info.size, mtimeMs: Math.round(info.mtimeMs) };
}

async function scanSqliteSource(source, verify, bounds, findings) {
  const db = await lstatOrNull(source.resolvedPath);
  const dbMissing = db === null || (!db.isFile() && !db.isSymbolicLink());
  if (db !== null && db.isSymbolicLink()) {
    findings.push(finding("error", "source_symlink", "sqlite database path must not be a symlink"));
    return { detail: { kind: "sqlite" }, status: "error" };
  }
  if (db !== null && !db.isFile()) {
    findings.push(finding("error", "unexpected_type", "sqlite database path is not a regular file"));
    return { detail: { kind: "sqlite" }, status: "error" };
  }
  const wal = await sidecarInfo(`${source.resolvedPath}-wal`, findings);
  const shm = await sidecarInfo(`${source.resolvedPath}-shm`, findings);
  const detail = {
    kind: "sqlite",
    consistency: source.sqlite.consistency,
    strategy: source.sqlite.strategy,
    database: dbMissing ? { present: false } : { present: true, bytes: db.size, mtimeMs: Math.round(db.mtimeMs) },
    wal,
    shm,
  };
  if (dbMissing) {
    if (wal.present || shm.present) {
      detail.setState = "stale";
      findings.push(
        finding("error", "stale_sidecar", "wal/shm sidecar exists without its database — refuse to treat as a set"),
      );
      return { detail, status: "error" };
    }
    detail.setState = "missing";
    if (source.required) {
      findings.push(finding("error", "missing_required", "required sqlite database is missing"));
      return { detail, status: "error" };
    }
    findings.push(finding("warning", "missing_optional", "optional sqlite database is absent"));
    return { detail, status: "unknown" };
  }
  if (wal.present && shm.present) {
    // A live WAL pair means committed pages may sit outside the .db file, so a
    // plain file copy is not a consistent backup. Honest unverified — the
    // declared quiesce/online-backup strategy must run first (by an operator).
    detail.setState = "live";
    return { detail, status: "unverified" };
  }
  if (wal.present !== shm.present) {
    detail.setState = "incomplete";
    findings.push(
      finding("error", "incomplete_set", "exactly one of -wal/-shm is present — the sidecar set is incomplete"),
    );
    return { detail, status: "error" };
  }
  detail.setState = "at-rest";
  if (verify) {
    if (db.size > bounds.maxHashFileBytes) {
      detail.database.hashStatus = "unhashed";
      detail.database.hashReason = "exceeds_hash_bound";
    } else {
      detail.database.sha256 = await sha256File(source.resolvedPath);
      detail.database.hashStatus = "hashed";
    }
  }
  return { detail, status: "ok" };
}

async function scanSource(source, verify, bounds) {
  const findings = [];
  const result = {
    id: source.id,
    type: source.type,
    label: source.label,
    path: source.resolvedPath,
    required: source.required,
    findings,
    detail: null,
    status: "unknown",
  };
  let info;
  try {
    info = await lstat(source.resolvedPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      findings.push(finding("error", "unreadable", `cannot stat source (${error?.code || error})`));
      return { ...result, detail: { kind: source.type }, status: "error" };
    }
    if (source.type === "sqlite") {
      const scanned = await scanSqliteSource(source, verify, bounds, findings);
      result.detail = scanned.detail;
      result.status = scanned.status;
      return result;
    }
    if (source.required) {
      findings.push(finding("error", "missing_required", "required source path is missing"));
      result.status = "error";
    } else {
      findings.push(finding("warning", "missing_optional", "optional source path is absent"));
      result.status = "unknown";
    }
    result.detail = { kind: source.type, present: false };
    return result;
  }
  if (info.isSymbolicLink()) {
    findings.push(finding("error", "source_symlink", "source path must not be a symlink"));
    return { ...result, detail: { kind: source.type }, status: "error" };
  }
  const typeOk =
    (source.type === "file" && info.isFile()) ||
    (source.type === "directory" && info.isDirectory()) ||
    source.type === "sqlite";
  if (!typeOk) {
    findings.push(finding("error", "unexpected_type", `path exists but is not a ${source.type}`));
    return { ...result, detail: { kind: source.type }, status: "error" };
  }
  try {
    const scanned =
      source.type === "file"
        ? await scanFileSource(source, verify, bounds, findings)
        : source.type === "directory"
          ? await scanDirectorySource(source, verify, bounds, findings)
          : await scanSqliteSource(source, verify, bounds, findings);
    result.detail = scanned.detail;
    result.status = scanned.status;
  } catch (error) {
    findings.push(finding("error", "scan_failed", `source scan failed (${error?.code || error})`));
    result.detail = { kind: source.type };
    result.status = "error";
  }
  return result;
}

async function targetPresence(target) {
  if (target.type === "time-machine") return "via-adapter";
  if (target.type === "external") return "not-checked";
  const info = await lstatOrNull(target.resolvedLocation);
  if (info === null) return "absent";
  if (info.isSymbolicLink()) return "symlink";
  if (info.isDirectory()) return "present";
  return "unexpected";
}

// Shared scan for inventory and verify. Manifest order is the documented
// deterministic order; directory entries are name-sorted; no wall clock.
export async function scanManifest(manifest, { verify = false } = {}) {
  const bounds = effectiveBounds(manifest);
  const sources = [];
  for (const source of manifest.sources) {
    sources.push(await scanSource(source, verify, bounds));
  }
  const targets = [];
  for (const target of manifest.targets) {
    targets.push({
      id: target.id,
      type: target.type,
      location: target.resolvedLocation,
      notes: target.notes,
      presence: await targetPresence(target),
    });
  }
  const counts = { ok: 0, unknown: 0, unverified: 0, missing: 0, error: 0 };
  let errors = 0;
  let warnings = 0;
  for (const source of sources) {
    counts[source.status] = (counts[source.status] || 0) + 1;
    for (const item of source.findings) {
      if (item.level === "error") errors += 1;
      else if (item.level === "warning") warnings += 1;
    }
  }
  // Unknown or unverified required state is reported as unknown — never as a
  // successful backup. Optional absences stay informational.
  const requiredNotOk = sources.some(
    (source) => source.required && source.status !== "ok",
  );
  const status =
    errors > 0 || counts.error > 0 ? "error" : requiredNotOk || counts.unverified > 0 ? "unknown" : "ok";
  return {
    sources,
    targets,
    summary: {
      status,
      sources: sources.length,
      ...counts,
      errors,
      warnings,
    },
  };
}

// Deterministic operator instructions only. Nothing here touches the
// filesystem, services, schedules, or backup targets — every step is manual.
export function buildRestorePlan(manifest) {
  const targetSteps = manifest.targets.map((target) => {
    const location = target.resolvedLocation || target.location;
    if (target.type === "time-machine") {
      return `target '${target.id}': Time Machine (${location}) — 운영자가 복원 시점 스냅샷을 선택한다 (${target.notes})`;
    }
    if (target.type === "git-mirror") {
      return `target '${target.id}': git mirror (${location}) — 운영자가 최신 mirror 브랜치 커밋을 확인한다 (${target.notes})`;
    }
    return `target '${target.id}': ${target.type} (${location}) — 운영자가 최신 백업 산출물을 식별한다 (${target.notes})`;
  });

  const quiesceSteps = manifest.sources
    .filter((source) => source.type === "sqlite")
    .map(
      (source) =>
        `sqlite '${source.id}': consistency=${source.sqlite.consistency} — ${source.sqlite.strategy}`,
    );

  const restoreSteps = manifest.sources.map((source) => {
    const path = source.resolvedPath || source.path;
    if (source.type === "file") {
      const steps = [`선택한 target에서 '${path}' 파일을 동일 경로로 복원한다 (권한/소유자 유지)`];
      if (source.expect?.sha256) steps.push(`복원본 sha256이 expect.sha256과 일치하는지 확인한다`);
      if (source.expect?.bytes !== undefined) steps.push(`복원본 크기가 ${source.expect.bytes} bytes인지 확인한다`);
      return { source: source.id, type: source.type, steps };
    }
    if (source.type === "directory") {
      return {
        source: source.id,
        type: source.type,
        steps: [
          `선택한 target에서 '${path}' 디렉터리 트리를 통째로 복원한다`,
          `보호 이름(.env, workers.env, auth.json, key/token/cookie/keychain/secret/credential)은 이 도구가 읽지 않았으므로 백업본에서 운영자가 직접 확인·복원한다`,
          `복원 후 inventory를 다시 실행해 entry 수·경로가 매니페스트 기대와 일치하는지 비교한다`,
        ],
      };
    }
    return {
      source: source.id,
      type: source.type,
      steps: [
        `writer를 quiesce하거나 online-backup 산출물을 확보한다 — ${source.sqlite.strategy}`,
        `'.db'와 '-wal'/'-shm'을 같은 시점 스냅샷에서 세트로 복원한다 — 서로 다른 시점의 sidecar를 섞지 않는다`,
        `복원본에 -wal/-shm만 남거나 db만 남은 불완전 세트를 그대로 기동하지 않는다`,
        `운영자가 'PRAGMA integrity_check'로 복원본을 확인한다 (이 도구는 db를 열지 않는다)`,
      ],
    };
  });

  return {
    readOnly: true,
    note: "이 계획은 지시문이다. 도구는 어떤 파일/서비스/스케줄도 변경하지 않으며 모든 단계는 운영자가 수행한다.",
    phases: [
      {
        id: "preflight",
        title: "복원 시점과 target 확인",
        steps: [
          "복원할 시점을 결정한다 — 이 도구는 백업 존재 여부를 검증하지 않는다",
          ...targetSteps,
        ],
      },
      {
        id: "quiesce",
        title: "writer 정지 (운영자 수행)",
        steps: [
          "해당 서비스 writer를 운영자가 중지한다 (launchctl unload 등 — 도구는 서비스를 건드리지 않는다)",
          ...quiesceSteps,
        ],
      },
      {
        id: "restore",
        title: "소스별 복원",
        steps: restoreSteps.map(
          (entry) => `source '${entry.source}' (${entry.type}): ${entry.steps.join(" → ")}`,
        ),
      },
      {
        id: "verify",
        title: "복원 후 검증",
        steps: [
          "node scripts/hermes-backup-readiness.mjs verify --manifest <manifest> 재실행 — 모든 required source가 ok여야 한다",
          "hash_mismatch·stale_sidecar·incomplete_set이 없는지 확인한다",
          "sqlite는 writer 재기동 전 integrity_check를 완료한다",
        ],
      },
      {
        id: "resume",
        title: "서비스 재개 (운영자 수행)",
        steps: [
          "writer 서비스를 운영자가 재기동한다",
          "node scripts/hermes-registry-preflight.mjs --strict 로 레지스트리 상태를 확인한다",
          "worker LaunchAgent·mini deploy 상태를 운영자가 확인한다",
        ],
      },
    ],
  };
}

function parseTmutilDestinations(stdout) {
  const destinations = [];
  let current = null;
  for (const line of String(stdout).split("\n")) {
    if (line.startsWith("===")) {
      if (current) destinations.push(current);
      current = {};
      continue;
    }
    const match = line.match(/^(Name|Kind|Mount Point|ID)\s*:\s*(.+?)\s*$/);
    if (match && current) {
      const key = { Name: "name", Kind: "kind", "Mount Point": "mountPoint", ID: "id" }[match[1]];
      current[key] = match[2];
    }
  }
  if (current && Object.keys(current).length > 0) destinations.push(current);
  return destinations.filter((destination) => destination.name || destination.mountPoint);
}

// Optional read-only status adapters. `run` is injectable for tests; the real
// runner is execFile with a timeout and no shell. Results are always honest —
// a missing tool is 'unavailable', an unparseable/absent state is 'unknown',
// and adapters never affect the source-scan exit decision.
export async function collectAdapters(manifest, { run = execFileRunner(), home = homedir() } = {}) {
  const results = [];
  for (const adapter of manifest.adapters || []) {
    const base = { id: adapter.id, type: adapter.type, label: adapter.label ?? null };
    if (!adapter.enabled) {
      results.push({ ...base, status: "disabled" });
      continue;
    }
    if (adapter.type === "time-machine") {
      const outcome = await run("tmutil", ["destinationinfo"]);
      if (!outcome.ok) {
        results.push({ ...base, status: "unavailable", reason: `tmutil failed (${outcome.code})` });
        continue;
      }
      const destinations = parseTmutilDestinations(outcome.stdout);
      results.push({
        ...base,
        status: destinations.length > 0 ? "available" : "unknown",
        destinations,
        ...(destinations.length === 0 ? { reason: "no destination parsed" } : {}),
      });
      continue;
    }
    if (adapter.type === "launchd") {
      const outcome = await run("launchctl", ["list"]);
      if (!outcome.ok) {
        results.push({ ...base, status: "unavailable", reason: `launchctl failed (${outcome.code})` });
        continue;
      }
      const line = String(outcome.stdout)
        .split("\n")
        .map((entry) => entry.trim())
        .find((entry) => entry.split(/\s+/).pop() === adapter.job);
      if (!line) {
        results.push({ ...base, status: "unknown", reason: `job '${adapter.job}' not loaded` });
        continue;
      }
      const [pidRaw, exitRaw] = line.split(/\s+/);
      results.push({
        ...base,
        status: "available",
        job: adapter.job,
        pid: pidRaw === "-" ? null : Number.parseInt(pidRaw, 10),
        lastExitStatus: Number.parseInt(exitRaw, 10),
      });
      continue;
    }
    const resolvedPath = adapter.resolvedPath || expandHome(adapter.path, home);
    const info = await lstatOrNull(resolvedPath);
    if (info === null) {
      results.push({ ...base, status: "unknown", reason: "path absent", path: resolvedPath });
    } else if (info.isSymbolicLink()) {
      results.push({ ...base, status: "unknown", reason: "path is a symlink", path: resolvedPath });
    } else {
      results.push({
        ...base,
        status: "available",
        path: resolvedPath,
        kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
      });
    }
  }
  return results;
}

export function execFileRunner({ timeoutMs = 5000 } = {}) {
  return (command, args) =>
    new Promise((resolvePromise) => {
      execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          resolvePromise({
            ok: false,
            code: error.code ?? error.signal ?? "error",
            stdout: String(stdout),
            stderr: String(stderr),
          });
        } else {
          resolvePromise({ ok: true, code: 0, stdout: String(stdout), stderr: String(stderr) });
        }
      });
    });
}

function statusTag(status) {
  return status.toUpperCase().replace("_", "-");
}

function renderSourceLines(source) {
  const lines = [`[${statusTag(source.status)}] ${source.id} (${source.type}) — ${source.path}`];
  const detail = source.detail || {};
  if (detail.kind === "file" && detail.bytes !== undefined) {
    lines.push(
      `       ${detail.bytes} B · mtime ${detail.mtimeMs}` +
        (detail.sha256 ? ` · sha256 ${detail.sha256.slice(0, 12)}…` : "") +
        (detail.hashStatus === "unhashed" ? ` · unhashed (${detail.hashReason})` : "") +
        (detail.verified ? " · expect 일치" : ""),
    );
  }
  if (detail.kind === "directory" && detail.stats) {
    const s = detail.stats;
    lines.push(
      `       항목 ${s.files + s.directories + s.symlinks + s.protected + s.excluded + s.other}개 ` +
        `(파일 ${s.files} · 디렉터리 ${s.directories} · 보호 생략 ${s.protected} · 제외 ${s.excluded} · symlink ${s.symlinks}) ` +
        `· ${s.bytes} B${s.hashed ? ` · 해시 ${s.hashed}개` : ""}`,
    );
  }
  if (detail.kind === "sqlite" && detail.setState) {
    lines.push(
      `       set ${detail.setState} · db ${detail.database?.present ? `${detail.database.bytes} B` : "없음"}` +
        ` · -wal ${detail.wal?.present ? "있음" : "없음"} · -shm ${detail.shm?.present ? "있음" : "없음"}` +
        ` · consistency ${detail.consistency}`,
    );
  }
  for (const item of source.findings) {
    lines.push(`       ${item.level.toUpperCase()} ${item.code}: ${item.message}${item.path ? ` (${item.path})` : ""}`);
  }
  return lines;
}

// Korean human rendering — deterministic, input-derived only.
export function renderHuman(result) {
  const lines = [
    `Hermes 백업 준비 — ${result.mode} (읽기 전용, 생성/복사/삭제/복원 없음)`,
    `매니페스트: ${result.manifest.path} · ${result.manifest.manifestId} · 갱신 ${result.manifest.updatedAt}`,
    "",
  ];
  if (result.mode === "restore-plan") {
    lines.push(result.plan.note, "");
    for (const phase of result.plan.phases) {
      lines.push(`## ${phase.id} — ${phase.title}`);
      phase.steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
      lines.push("");
    }
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
  }
  for (const source of result.sources) {
    lines.push(...renderSourceLines(source));
  }
  if (result.targets.length > 0) {
    lines.push("", "targets:");
    for (const target of result.targets) {
      lines.push(`  [${target.presence}] ${target.id} (${target.type}) — ${target.location}`);
    }
  }
  if (result.adapters) {
    lines.push("", "adapters:");
    for (const adapter of result.adapters) {
      const extra =
        adapter.type === "time-machine" && adapter.destinations
          ? ` — ${adapter.destinations.length}개 destination`
          : adapter.job
            ? ` — ${adapter.job}${adapter.pid ? ` pid ${adapter.pid}` : ""}`
            : adapter.reason
              ? ` — ${adapter.reason}`
              : "";
      lines.push(`  [${adapter.status}] ${adapter.id} (${adapter.type})${extra}`);
    }
  }
  const s = result.summary;
  lines.push(
    "",
    `요약: 소스 ${s.sources} · ok ${s.ok} · unknown ${s.unknown + s.unverified + s.missing} · error ${s.error} ` +
      `· findings error ${s.errors} warning ${s.warnings} → 상태 ${s.status}`,
  );
  if (s.status === "ok") lines.push("통과: 모든 required source가 검증됐습니다.");
  else if (s.status === "unknown") lines.push("미검증: unknown/unverified 상태는 백업 성공이 아닙니다. 수동 확인이 필요합니다.");
  else lines.push("실패: error 수준 항목을 해결한 뒤 다시 실행하세요.");
  return `${lines.join("\n")}\n`;
}
