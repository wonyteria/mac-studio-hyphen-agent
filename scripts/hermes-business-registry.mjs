import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Hyphen Studio business registry (outputs/registry.private.json) reader.
// This is a separate input from the deployment registry in hermes-projects.json:
// it describes business facts Studio verified about each project, not where a
// repository lives or what the worker may mutate. Nothing here ever writes to
// the registry file, and every briefing item stays traceable to explicit
// registry fields plus the project's evidence entries.

export const BUSINESS_REGISTRY_SCHEMA_VERSION = 1;
export const BUSINESS_REGISTRY_SCOPE = "private";
export const BUSINESS_REGISTRY_CONSUMER = "hermes";
export const HYPHEN_CORE_ORGANIZATION = "hyphen";
export const DEFAULT_MAX_REGISTRY_BYTES = 1024 * 1024;

const ORGANIZATIONS = new Set(["hyphen", "29sfilm"]);
const LIFECYCLES = new Set(["idea", "building", "active", "paused", "archived", "unknown"]);
const STATUSES = new Set(["operational", "degraded", "down", "building", "unknown"]);
const EVIDENCE_STATUSES = new Set(["verified", "partial", "insufficient", "unknown"]);
const REPOSITORY_ROLES = new Set(["canonical", "mirror", "fork"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FORBIDDEN_IDENTITY = new RegExp(`${String.fromCharCode(51, 120)}[-_]?ha[us]{1,2}t`, "i");

const EXPORT_KEYS = new Set([
  "schemaVersion",
  "scope",
  "consumer",
  "sourceHash",
  "updatedAt",
  "usage",
  "projects",
]);
const EXPORT_REQUIRED = ["schemaVersion", "scope", "consumer", "sourceHash", "updatedAt", "projects"];
const PROJECT_KEYS = new Set([
  "id", "name", "organization", "businessGroup", "businessType", "lifecycle", "status",
  "owner", "revenue", "repositories", "deploys", "dataStores", "kpis",
  "evidence", "evidenceStatus", "blockers", "nextEvidence",
]);
const PROJECT_REQUIRED = [...PROJECT_KEYS];

export class BusinessRegistryError extends Error {
  constructor(code, message, issues = []) {
    super(message);
    this.name = "BusinessRegistryError";
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

// Default: the Studio checkout expected next to this repository. Operators can
// always override with HERMES_BUSINESS_REGISTRY or an explicit CLI argument;
// no account-specific path is baked in as the only default.
export function defaultBusinessRegistryPath(env = process.env) {
  if (env.HERMES_BUSINESS_REGISTRY) return env.HERMES_BUSINESS_REGISTRY;
  return join(repoRootPath(), "..", "Hyphen-Studio", "outputs", "registry.private.json");
}

export function resolveBusinessRegistryPath({ arg, env = process.env } = {}) {
  return arg || defaultBusinessRegistryPath(env);
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

function checkEvidenceEntry(entry, path, issues) {
  if (!isPlainObject(entry)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkKeys(entry, new Set(["label", "ref", "checkedAt"]), ["label", "ref", "checkedAt"], path, issues);
  checkString(entry.label, `${path}.label`, issues);
  checkString(entry.ref, `${path}.ref`, issues);
  if (!ISO_DATE.test(String(entry.checkedAt)) && !ISO_DATETIME.test(String(entry.checkedAt))) {
    issues.push(`${path}.checkedAt: must be an ISO date/datetime`);
  }
}

function checkBlocker(blocker, path, issues) {
  if (!isPlainObject(blocker)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkKeys(blocker, new Set(["description", "since"]), ["description"], path, issues);
  checkString(blocker.description, `${path}.description`, issues);
  if (blocker.since !== undefined && blocker.since !== null && !ISO_DATE.test(String(blocker.since))) {
    issues.push(`${path}.since: must be an ISO date or null`);
  }
}

function checkKpi(kpi, path, issues) {
  if (!isPlainObject(kpi)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkKeys(kpi, new Set(["name", "value", "unit", "source", "measuredAt"]), ["name", "value", "source", "measuredAt"], path, issues);
  checkString(kpi.name, `${path}.name`, issues);
  if (kpi.value !== null && typeof kpi.value !== "number" && typeof kpi.value !== "string") {
    issues.push(`${path}.value: must be null, number, or string`);
  }
  checkString(kpi.unit, `${path}.unit`, issues, { nullable: true });
  checkString(kpi.source, `${path}.source`, issues);
  if (kpi.measuredAt !== null && !ISO_DATE.test(String(kpi.measuredAt)) && !ISO_DATETIME.test(String(kpi.measuredAt))) {
    issues.push(`${path}.measuredAt: must be an ISO date/datetime or null`);
  }
}

function checkRevenue(revenue, path, issues) {
  if (revenue === null) return;
  if (!isPlainObject(revenue)) {
    issues.push(`${path}: must be null or an object`);
    return;
  }
  checkKeys(revenue, new Set(["amount", "currency", "period", "source", "asOf"]), ["amount", "currency", "source", "asOf"], path, issues);
  if (typeof revenue.amount !== "number" || !Number.isFinite(revenue.amount)) {
    issues.push(`${path}.amount: must be a finite number`);
  }
  checkString(revenue.currency, `${path}.currency`, issues);
  checkString(revenue.period, `${path}.period`, issues, { nullable: true });
  checkString(revenue.source, `${path}.source`, issues);
  if (!ISO_DATE.test(String(revenue.asOf))) issues.push(`${path}.asOf: must be an ISO date`);
}

function checkRepository(repository, path, issues) {
  if (!isPlainObject(repository)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkKeys(repository, new Set(["url", "branch", "role", "localPath"]), ["url", "role"], path, issues);
  checkString(repository.url, `${path}.url`, issues);
  checkString(repository.branch, `${path}.branch`, issues, { nullable: true });
  if (!REPOSITORY_ROLES.has(repository.role)) {
    issues.push(`${path}.role: must be one of ${[...REPOSITORY_ROLES].join(", ")}`);
  }
  checkString(repository.localPath, `${path}.localPath`, issues, { nullable: true });
}

function checkDeploy(deploy, path, issues) {
  if (!isPlainObject(deploy)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkKeys(deploy, new Set(["url", "healthcheck", "platform"]), ["url"], path, issues);
  checkString(deploy.url, `${path}.url`, issues);
  checkString(deploy.healthcheck, `${path}.healthcheck`, issues, { nullable: true });
  checkString(deploy.platform, `${path}.platform`, issues, { nullable: true });
}

function checkDataStore(store, path, issues) {
  if (!isPlainObject(store)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkKeys(store, new Set(["name", "kind", "location", "backup"]), ["name", "kind", "location", "backup"], path, issues);
  checkString(store.name, `${path}.name`, issues);
  checkString(store.kind, `${path}.kind`, issues);
  checkString(store.location, `${path}.location`, issues);
  if (store.backup !== null) {
    if (!isPlainObject(store.backup)) {
      issues.push(`${path}.backup: must be null or an object`);
    } else {
      checkKeys(store.backup, new Set(["location", "schedule"]), ["location"], `${path}.backup`, issues);
      checkString(store.backup.location, `${path}.backup.location`, issues);
      checkString(store.backup.schedule, `${path}.backup.schedule`, issues, { nullable: true });
    }
  }
}

function checkProject(project, index, issues) {
  const path = `projects[${index}]`;
  if (!isPlainObject(project)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkKeys(project, PROJECT_KEYS, PROJECT_REQUIRED, path, issues);
  checkString(project.id, `${path}.id`, issues, { pattern: ID_PATTERN, label: "id" });
  checkString(project.name, `${path}.name`, issues);
  checkString(project.businessGroup, `${path}.businessGroup`, issues);
  checkString(project.businessType, `${path}.businessType`, issues);
  checkString(project.owner, `${path}.owner`, issues, { nullable: true });

  if (!ORGANIZATIONS.has(project.organization)) {
    issues.push(`${path}.organization: must be one of ${[...ORGANIZATIONS].join(", ")}`);
  }
  if (!LIFECYCLES.has(project.lifecycle)) {
    issues.push(`${path}.lifecycle: must be one of ${[...LIFECYCLES].join(", ")}`);
  }
  if (!STATUSES.has(project.status)) {
    issues.push(`${path}.status: must be one of ${[...STATUSES].join(", ")}`);
  }
  if (!EVIDENCE_STATUSES.has(project.evidenceStatus)) {
    issues.push(`${path}.evidenceStatus: must be one of ${[...EVIDENCE_STATUSES].join(", ")}`);
  }

  const arrayFields = [
    ["repositories", checkRepository],
    ["deploys", checkDeploy],
    ["dataStores", checkDataStore],
    ["kpis", checkKpi],
    ["evidence", checkEvidenceEntry],
    ["blockers", checkBlocker],
  ];
  for (const [field, check] of arrayFields) {
    const list = project[field];
    if (!Array.isArray(list)) {
      issues.push(`${path}.${field}: must be an array`);
      continue;
    }
    list.forEach((item, itemIndex) => check(item, `${path}.${field}[${itemIndex}]`, issues));
  }
  checkRevenue(project.revenue, `${path}.revenue`, issues);

  if (!Array.isArray(project.nextEvidence)) {
    issues.push(`${path}.nextEvidence: must be an array`);
  } else {
    project.nextEvidence.forEach((item, itemIndex) => checkString(item, `${path}.nextEvidence[${itemIndex}]`, issues));
  }

  // Producer parity: factual claims are only credible with at least one
  // evidence entry. A private export that asserts facts without evidence is
  // treated as a schema violation, not rendered as an unverified item.
  const assertsFacts =
    project.lifecycle !== "unknown" ||
    project.status !== "unknown" ||
    project.owner !== null ||
    (Array.isArray(project.kpis) && project.kpis.length > 0) ||
    project.revenue !== null ||
    project.evidenceStatus === "verified";
  if (assertsFacts && (!Array.isArray(project.evidence) || project.evidence.length === 0)) {
    issues.push(`${path}: factual claims (owner/status/kpi/revenue/verified) require at least one evidence entry`);
  }
}

// Structural validation of the Studio private export. Any issue rejects the
// whole document (fail closed); there is no partial or best-effort parse.
export function validateBusinessRegistry(registry) {
  const issues = [];
  if (!isPlainObject(registry)) return ["registry: must be an object"];
  checkKeys(registry, EXPORT_KEYS, EXPORT_REQUIRED, "registry", issues);
  if (registry.schemaVersion !== BUSINESS_REGISTRY_SCHEMA_VERSION) {
    issues.push(`schemaVersion: must be ${BUSINESS_REGISTRY_SCHEMA_VERSION}`);
  }
  if (registry.scope !== BUSINESS_REGISTRY_SCOPE) {
    issues.push(`scope: must be '${BUSINESS_REGISTRY_SCOPE}'`);
  }
  if (registry.consumer !== BUSINESS_REGISTRY_CONSUMER) {
    issues.push(`consumer: must be '${BUSINESS_REGISTRY_CONSUMER}'`);
  }
  if (!SHA256_PATTERN.test(String(registry.sourceHash))) {
    issues.push("sourceHash: must be a lowercase sha256 hex digest");
  }
  if (!ISO_DATE.test(String(registry.updatedAt)) && !ISO_DATETIME.test(String(registry.updatedAt))) {
    issues.push("updatedAt: must be an ISO date/datetime");
  }
  if ("usage" in registry && !isPlainObject(registry.usage)) {
    issues.push("usage: must be an object");
  }
  if (!Array.isArray(registry.projects) || registry.projects.length === 0) {
    issues.push("projects: must be a non-empty array");
  } else {
    registry.projects.forEach((project, index) => checkProject(project, index, issues));
    const ids = new Map();
    registry.projects.forEach((project, index) => {
      if (typeof project?.id !== "string") return;
      if (ids.has(project.id)) {
        issues.push(`projects[${index}].id: duplicate id '${project.id}' (also at projects[${ids.get(project.id)}])`);
      } else {
        ids.set(project.id, index);
      }
    });
  }
  for (const { path, value } of walkStrings(registry, "")) {
    if (FORBIDDEN_IDENTITY.test(value)) {
      issues.push(`${path}: legacy identity marker is not allowed`);
    }
  }
  return issues;
}

// Reads and validates the private export. Never modifies the file. Fails
// closed on unreadable paths, symlinks, non-regular files, oversized inputs,
// malformed JSON, schema mismatches, and operator-pinned sourceHash drift.
export async function loadBusinessRegistry(filePath, { maxBytes = DEFAULT_MAX_REGISTRY_BYTES, expectedHash } = {}) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new BusinessRegistryError("registry_path_missing", "business registry path is empty");
  }
  const resolved = resolve(filePath);
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    throw new BusinessRegistryError(
      "registry_unreadable",
      `business registry is not readable: ${resolved} (${error?.code || error})`,
    );
  }
  if (info.isSymbolicLink()) {
    throw new BusinessRegistryError("registry_symlink", `business registry must not be a symlink: ${resolved}`);
  }
  if (!info.isFile()) {
    throw new BusinessRegistryError("registry_not_regular", `business registry is not a regular file: ${resolved}`);
  }
  if (info.size > maxBytes) {
    throw new BusinessRegistryError(
      "registry_too_large",
      `business registry exceeds ${maxBytes} bytes: ${resolved}`,
    );
  }
  const raw = await readFile(resolved, "utf8");
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new BusinessRegistryError(
      "registry_too_large",
      `business registry exceeds ${maxBytes} bytes: ${resolved}`,
    );
  }
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch {
    throw new BusinessRegistryError("registry_parse_error", `business registry is not valid JSON: ${resolved}`);
  }
  const issues = validateBusinessRegistry(registry);
  if (issues.length > 0) {
    throw new BusinessRegistryError(
      "schema_mismatch",
      `business registry failed schema validation (${issues.length} issue(s))`,
      issues,
    );
  }
  if (expectedHash && registry.sourceHash !== expectedHash) {
    throw new BusinessRegistryError(
      "source_hash_mismatch",
      `business registry sourceHash drifted from the pinned value: ${resolved}`,
    );
  }
  return { path: resolved, registry };
}

// --- Registry sync-status contract -----------------------------------------
// Written atomically by scripts/hermes-registry-sync.mjs next to the synced
// destination copy; read by mini-server.mjs for the freshness indicator. The
// document is a strict allowlist — it carries sync outcomes only, never
// business content, paths, hashes, or loader error text.
export const SYNC_STATUS_FILENAME = "registry-sync-status.json";
export const SYNC_STATUS_MAX_BYTES = 64 * 1024;
export const SYNC_STATUSES = new Set(["synced", "unchanged", "error"]);
export const SYNC_STATUS_FIELDS = new Set([
  "status",
  "checkedAt",
  "syncedAt",
  "registryUpdatedAt",
  "projectCount",
  "errorCode",
]);
// Bounded error vocabulary for status.errorCode: loader rejection codes plus
// destination/write failures. Values only — messages never enter the document.
export const SYNC_ERROR_CODES = new Set([
  "registry_path_missing",
  "registry_unreadable",
  "registry_symlink",
  "registry_not_regular",
  "registry_too_large",
  "registry_parse_error",
  "schema_mismatch",
  "source_hash_mismatch",
  "destination_symlink",
  "destination_not_regular",
  "destination_unreadable",
  "destination_dir_unusable",
  "write_failed",
  "sync_timeout",
  "sync_error",
]);
// checkedAt may sit slightly in the future under normal clock drift; beyond
// this tolerance a "fresh" claim from the future is not trusted.
export const SYNC_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

// Maps any thrown error to a bounded status errorCode. Unknown errors collapse
// to "sync_error"; messages and paths are dropped here.
export function syncErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "sync_error";
  return SYNC_ERROR_CODES.has(code) ? code : "sync_error";
}

// Builds the allowlisted status document. Every field is always present so a
// reader can validate a fixed shape; nullable fields carry null, never "".
export function buildSyncStatus({ status, checkedAt, syncedAt = null, registryUpdatedAt = null, projectCount = null, errorCode = null }) {
  return { status, checkedAt, syncedAt, registryUpdatedAt, projectCount, errorCode };
}

function isIsoDateOrDatetime(value) {
  return ISO_DATE.test(String(value)) || ISO_DATETIME.test(String(value));
}

// Strict reader-side validation of a status file's text. Returns the document
// or null on any deviation: malformed JSON, non-object, missing/extra keys,
// bad enums, or mistyped fields — the file is untrusted input too.
export function parseSyncStatusDocument(raw, { maxBytes = SYNC_STATUS_MAX_BYTES } = {}) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > maxBytes) return null;
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(doc)) return null;
  const keys = Object.keys(doc);
  if (keys.length !== SYNC_STATUS_FIELDS.size || !keys.every((key) => SYNC_STATUS_FIELDS.has(key))) {
    return null;
  }
  if (!SYNC_STATUSES.has(doc.status)) return null;
  if (!ISO_DATETIME.test(String(doc.checkedAt))) return null;
  if (doc.syncedAt !== null && !isIsoDateOrDatetime(doc.syncedAt)) return null;
  if (doc.registryUpdatedAt !== null && !isIsoDateOrDatetime(doc.registryUpdatedAt)) return null;
  if (doc.projectCount !== null && (!Number.isInteger(doc.projectCount) || doc.projectCount < 0)) {
    return null;
  }
  if (doc.errorCode !== null && !SYNC_ERROR_CODES.has(doc.errorCode)) return null;
  // Cross-field invariants: an error record must name a bounded code, and a
  // success record must carry the full freshness evidence — partial or
  // contradictory documents are never trusted.
  if (doc.status === "error") {
    if (doc.errorCode === null) return null;
  } else if (doc.errorCode !== null || doc.syncedAt === null || doc.registryUpdatedAt === null || doc.projectCount === null) {
    return null;
  }
  return doc;
}

// Freshness classification for the owner-facing indicator. `registry` is the
// already-validated registry object or null when it cannot be loaded; `status`
// is the parsed status document or null. Deterministic given `now`.
//   unavailable — no usable registry at the destination at all.
//   stale       — registry loads, but there is no trustworthy sync witness:
//                 no/invalid status file, last run errored, the tool stopped
//                 checking in (checkedAt older than staleMs), or the status
//                 no longer describes the destination's content.
//   fresh       — registry loads and a recent successful run confirms it.
export function businessRegistryFreshness({ registry = null, status = null, now = Date.now(), staleMs = 10 * 60 * 1000, maxFutureSkewMs = SYNC_MAX_CLOCK_SKEW_MS } = {}) {
  if (!registry) return "unavailable";
  if (!status) return "stale";
  if (status.status === "error") return "stale";
  const checkedAt = Date.parse(status.checkedAt);
  if (!Number.isFinite(checkedAt) || now - checkedAt > staleMs) return "stale";
  if (checkedAt - now > maxFutureSkewMs) return "stale";
  if (status.registryUpdatedAt && status.registryUpdatedAt !== registry.updatedAt) return "stale";
  return "fresh";
}

function projectEvidence(project) {
  return project.evidence.map((entry) => ({
    label: entry.label,
    ref: entry.ref,
    checkedAt: entry.checkedAt,
  }));
}

function briefingItem(project, kind, summary, basis, details = {}) {
  const evidence = projectEvidence(project);
  return {
    projectId: project.id,
    projectName: project.name,
    kind,
    summary,
    basis,
    details,
    evidence,
    verified: evidence.length > 0,
  };
}

const LIFECYCLE_RANK = { active: 5, building: 4, idea: 3, paused: 2, archived: 1, unknown: 0 };
const STATUS_RANK = { down: 2, degraded: 1 };

function compareById(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Priority ranking is a documented lexicographic order over verifiable fields
// only — never inferred urgency:
//   1. more explicit blockers first
//   2. status down before degraded before anything else
//   3. more pending nextEvidence entries first
//   4. more advanced lifecycle first (active > building > idea > paused > archived > unknown)
//   5. project id ascending as the final deterministic tie-break
function comparePriority(a, b) {
  const blockers = b.blockers.length - a.blockers.length;
  if (blockers) return blockers;
  const status = (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0);
  if (status) return status;
  const nextEvidence = b.nextEvidence.length - a.nextEvidence.length;
  if (nextEvidence) return nextEvidence;
  const lifecycle = (LIFECYCLE_RANK[b.lifecycle] || 0) - (LIFECYCLE_RANK[a.lifecycle] || 0);
  if (lifecycle) return lifecycle;
  return compareById(a, b);
}

function prioritySummary(project) {
  const parts = [];
  if (project.blockers.length > 0) parts.push(`명시적 blocker ${project.blockers.length}건`);
  if (project.status === "down" || project.status === "degraded") parts.push(`상태 ${project.status}`);
  if (project.nextEvidence.length > 0) parts.push(`확인 대기 ${project.nextEvidence.length}건`);
  if (project.lifecycle !== "unknown") parts.push(`lifecycle ${project.lifecycle}`);
  return parts.join(", ");
}

function priorityBasis(project) {
  const basis = [];
  if (project.blockers.length > 0) basis.push("blockers");
  if (project.status === "down" || project.status === "degraded") basis.push("status");
  if (project.nextEvidence.length > 0) basis.push("nextEvidence");
  if (project.lifecycle !== "unknown") basis.push("lifecycle");
  return basis;
}

// Splits projects into the hyphen-core set and the per-organization exclusion
// tally shared by the briefing and the evidence audit. 29sfilm entries are
// never part of the core set.
function hyphenCoreSplit(registry) {
  const hyphen = [];
  const excludedByOrg = new Map();
  for (const project of registry.projects) {
    if (project.organization === HYPHEN_CORE_ORGANIZATION) {
      hyphen.push(project);
    } else {
      excludedByOrg.set(project.organization, (excludedByOrg.get(project.organization) || 0) + 1);
    }
  }
  const excludedOrganizations = [...excludedByOrg.entries()]
    .map(([organization, count]) => ({ organization, count }))
    .sort((a, b) => (a.organization < b.organization ? -1 : 1));
  return { hyphen, excludedOrganizations };
}

function registryCoverage(registry, hyphen, excludedOrganizations) {
  return {
    projects: registry.projects.length,
    hyphenCore: hyphen.length,
    excluded: registry.projects.length - hyphen.length,
    statusUnknown: hyphen.filter((project) => project.status === "unknown").length,
    evidenceUnverified: hyphen.filter((project) => project.evidenceStatus !== "verified").length,
    ownerMissing: hyphen.filter((project) => project.owner === null).length,
    excludedOrganizations,
  };
}

// Builds the read-only business briefing. Pure and deterministic: identical
// registry input always produces identical output, and no wall-clock time,
// environment, or random source is consulted. Unknown/null registry values are
// reported as unverified gaps, never filled with guesses.
export function buildBusinessBriefing(registry) {
  const { hyphen, excludedOrganizations } = hyphenCoreSplit(registry);
  const coverage = registryCoverage(registry, hyphen, excludedOrganizations);

  const candidates = hyphen.filter(
    (project) =>
      project.blockers.length > 0 ||
      project.status === "down" ||
      project.status === "degraded" ||
      project.nextEvidence.length > 0,
  );
  const topPriorities = [...candidates].sort(comparePriority).slice(0, 3).map((project) =>
    briefingItem(project, "priority", prioritySummary(project), priorityBasis(project), {
      blockers: project.blockers.length,
      status: project.status,
      lifecycle: project.lifecycle,
      nextEvidence: project.nextEvidence.length,
      owner: project.owner,
    }),
  );

  const blocked = hyphen
    .filter((project) => project.blockers.length > 0)
    .sort((a, b) => b.blockers.length - a.blockers.length || compareById(a, b))
    .map((project) =>
      briefingItem(
        project,
        "blocker",
        `명시적 blocker ${project.blockers.length}건`,
        ["blockers"],
        {
          blockers: project.blockers.map((blocker) => ({
            description: blocker.description,
            since: blocker.since ?? null,
          })),
          owner: project.owner,
        },
      ),
    );

  const revenueSignals = hyphen
    .filter((project) => project.revenue !== null || project.kpis.length > 0)
    .sort((a, b) => Number(b.revenue !== null) - Number(a.revenue !== null) || compareById(a, b))
    .map((project) =>
      briefingItem(
        project,
        "revenue_signal",
        project.revenue !== null
          ? `매출 ${project.revenue.amount} ${project.revenue.currency} (${project.revenue.asOf} 기준, 출처 ${project.revenue.source})`
          : `KPI ${project.kpis.length}건`,
        [project.revenue !== null ? "revenue" : null, project.kpis.length > 0 ? "kpis" : null].filter(Boolean),
        {
          revenue: project.revenue
            ? {
                amount: project.revenue.amount,
                currency: project.revenue.currency,
                period: project.revenue.period ?? null,
                source: project.revenue.source,
                asOf: project.revenue.asOf,
              }
            : null,
          kpis: project.kpis.map((kpi) => ({
            name: kpi.name,
            value: kpi.value,
            unit: kpi.unit ?? null,
            source: kpi.source,
            measuredAt: kpi.measuredAt,
          })),
        },
      ),
    );

  const anomalies = [];
  for (const project of hyphen) {
    if (project.status === "down" || project.status === "degraded") {
      anomalies.push({
        rank: STATUS_RANK[project.status],
        project,
        item: briefingItem(project, `status_${project.status}`, `서비스 상태 ${project.status}로 기록됨`, ["status"], {
          status: project.status,
          deploys: project.deploys.map((deploy) => deploy.url),
        }),
      });
    }
  }
  const systemAnomalies = anomalies
    .sort((a, b) => b.rank - a.rank || compareById(a.project, b.project))
    .map((entry) => entry.item);

  const ownerApprovals = hyphen
    .filter((project) => project.blockers.length > 0 || project.nextEvidence.length > 0)
    .sort(
      (a, b) =>
        b.blockers.length - a.blockers.length ||
        b.nextEvidence.length - a.nextEvidence.length ||
        compareById(a, b),
    )
    .map((project) => {
      const basis = [];
      if (project.blockers.length > 0) basis.push("blockers");
      if (project.nextEvidence.length > 0) basis.push("nextEvidence");
      const parts = [];
      if (project.blockers.length > 0) parts.push(`blocker 해결 결정 ${project.blockers.length}건`);
      if (project.nextEvidence.length > 0) parts.push(`확인 요청 ${project.nextEvidence.length}건`);
      return briefingItem(
        project,
        "owner_action",
        `${parts.join(" · ")}${project.owner === null ? " — owner 미지정" : ""}`,
        basis,
        {
          owner: project.owner,
          blockers: project.blockers.map((blocker) => ({
            description: blocker.description,
            since: blocker.since ?? null,
          })),
          nextEvidence: [...project.nextEvidence],
        },
      );
    });

  return {
    kind: "hyphen-business-briefing",
    schemaVersion: 1,
    source: {
      updatedAt: registry.updatedAt,
      sourceHash: registry.sourceHash,
      scope: registry.scope,
      consumer: registry.consumer,
    },
    coverage,
    sections: {
      topPriorities,
      blocked,
      revenueSignals,
      systemAnomalies,
      ownerApprovals,
    },
  };
}

function markdownEvidence(evidence) {
  if (evidence.length === 0) return ["  - evidence: 없음 — 확인 필요"];
  return evidence.map((entry) => `  - evidence: ${entry.label} — ${entry.ref} (${entry.checkedAt})`);
}

function markdownItem(item, index) {
  const lines = [`${index + 1}. **${item.projectName}** (\`${item.projectId}\`) — ${item.summary}`];
  lines.push(`   - 근거 필드: ${item.basis.join(", ")}`);
  if (!item.verified) lines.push("   - (근거 부족 — 확인 필요)");
  for (const line of markdownEvidence(item.evidence)) lines.push(` ${line}`);
  return lines;
}

function markdownSection(title, items) {
  const lines = [`## ${title}`, ""];
  if (items.length === 0) {
    lines.push("근거 없음 — 입력 레지스트리에 해당 신호가 없습니다. 확인 필요.", "");
    return lines;
  }
  items.forEach((item, index) => {
    lines.push(...markdownItem(item, index));
  });
  lines.push("");
  return lines;
}

// Deterministic Korean markdown rendering. The only timestamps shown come from
// the registry payload itself (updatedAt, evidence checkedAt); nothing reads
// the wall clock, so identical input yields identical markdown.
export function renderBriefingMarkdown(briefing) {
  const lines = [
    "# 하이픈 사업 브리핑",
    "",
    "Studio 운영 레지스트리(private export)를 소비하는 읽기 전용 브리핑입니다.",
    "근거(evidence)가 없는 값은 사실로 표시하지 않습니다.",
    "",
    `- 소스 업데이트: ${briefing.source.updatedAt}`,
    `- sourceHash: \`${briefing.source.sourceHash}\``,
    `- 범위: organization === '${HYPHEN_CORE_ORGANIZATION}' — ${briefing.coverage.hyphenCore}개 포함 / ${briefing.coverage.excluded}개 제외`,
  ];
  for (const entry of briefing.coverage.excludedOrganizations) {
    lines.push(`  - 제외: ${entry.organization} ${entry.count}개`);
  }
  lines.push(
    `- 미검증 현황: status unknown ${briefing.coverage.statusUnknown}개 · evidence 미충족 ${briefing.coverage.evidenceUnverified}개 · owner 미지정 ${briefing.coverage.ownerMissing}개`,
    "",
    ...markdownSection("오늘의 상위 3개 우선순위", briefing.sections.topPriorities),
    ...markdownSection("막힌 일", briefing.sections.blocked),
    ...markdownSection("매출·고객 신호", briefing.sections.revenueSignals),
    ...markdownSection("시스템 이상", briefing.sections.systemAnomalies),
    ...markdownSection("소유자 승인이 필요한 일", briefing.sections.ownerApprovals),
  );
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// ---- Evidence audit: read-only "사업 현황 갱신 점검" -----------------------
//
// A deterministic review checklist derived only from the registry's explicit
// unset markers. It never infers facts, assigns owners, or edits the registry;
// it only enumerates which fields are still unverified per project so an
// operator can update them deliberately.

export const EVIDENCE_AUDIT_KIND = "hyphen-evidence-audit";
export const EVIDENCE_AUDIT_MAX_ITEMS = 50;
export const EVIDENCE_AUDIT_PRIORITIES = new Set(["high", "medium", "low"]);

const AUDIT_NAME_MAX_CHARS = 80;

// Registry strings are unbounded: flatten to a single line and cap the length
// so no value can consume the output budget or inject extra lines.
function auditText(value, maxChars) {
  const flat = String(value ?? "").replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

// Fixed missing-field rules. A field counts as missing only when the registry
// carries its explicit unset marker: "unknown" for enum-like strings, null for
// owner/revenue, and an empty list for inventory arrays. The action phrases
// are fixed Korean instructions — never a guessed value.
const EVIDENCE_AUDIT_FIELDS = [
  { field: "status", missing: (p) => p.status === "unknown", action: "운영 상태를 확인해 기록" },
  { field: "lifecycle", missing: (p) => p.lifecycle === "unknown", action: "현재 사업 단계를 확인해 기록" },
  { field: "businessType", missing: (p) => p.businessType === "unknown", action: "사업 유형을 분류해 기록" },
  { field: "owner", missing: (p) => p.owner === null, action: "담당자를 지정해 기록" },
  { field: "evidenceStatus", missing: (p) => p.evidenceStatus !== "verified", action: "근거를 수집해 검증 상태를 갱신" },
  { field: "repositories", missing: (p) => p.repositories.length === 0, action: "연결된 저장소가 있으면 등록" },
  { field: "deploys", missing: (p) => p.deploys.length === 0, action: "배포 위치가 있으면 등록" },
  { field: "dataStores", missing: (p) => p.dataStores.length === 0, action: "데이터 저장소가 있으면 등록" },
  { field: "kpis", missing: (p) => p.kpis.length === 0, action: "핵심 지표가 있으면 등록" },
  { field: "revenue", missing: (p) => p.revenue === null, action: "매출 발생 여부를 기록" },
];

const AUDIT_PRIORITY_RANK = { high: 2, medium: 1, low: 0 };

// Fixed priority rule — completeness of verification decides, never inferred
// urgency:
//   high   — evidenceStatus is unknown/insufficient (nothing verified yet)
//   medium — evidenceStatus partial, or verified but review asks still pending
//   low    — verified with only inventory gaps left
function auditPriority(project) {
  if (project.evidenceStatus === "unknown" || project.evidenceStatus === "insufficient") return "high";
  if (project.evidenceStatus === "partial" || project.nextEvidence.length > 0) return "medium";
  return "low";
}

function compareAuditItems(a, b) {
  const priority = AUDIT_PRIORITY_RANK[b.priority] - AUDIT_PRIORITY_RANK[a.priority];
  if (priority) return priority;
  const missing = b.missingFields.length - a.missingFields.length;
  if (missing) return missing;
  const pending = b.pendingEvidence - a.pendingEvidence;
  if (pending) return pending;
  return a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0;
}

// Builds the read-only evidence audit. Pure and deterministic: identical
// registry input always produces identical output — no wall-clock time,
// environment, or randomness. Items expose only the allowlisted fields, and
// actions are fixed Korean phrases plus a pending-ask count — raw registry
// JSON, evidence refs, nextEvidence text, local paths, and secret-like
// values are never copied into the result.
export function buildEvidenceAudit(registry) {
  const { hyphen, excludedOrganizations } = hyphenCoreSplit(registry);
  const coverage = registryCoverage(registry, hyphen, excludedOrganizations);

  const fieldGaps = Object.fromEntries(EVIDENCE_AUDIT_FIELDS.map(({ field }) => [field, 0]));
  let pendingEvidence = 0;
  const byPriority = { high: 0, medium: 0, low: 0 };
  const items = [];

  for (const project of hyphen) {
    const missing = EVIDENCE_AUDIT_FIELDS.filter(({ missing }) => missing(project));
    const pending = project.nextEvidence.length;
    pendingEvidence += pending;
    for (const { field } of missing) fieldGaps[field] += 1;
    if (missing.length === 0 && pending === 0) continue;

    const priority = auditPriority(project);
    byPriority[priority] += 1;
    // nextEvidence entries are operator-authored free text and may contain
    // local paths or other private detail — the audit never copies them. A
    // fixed count phrase stands in for the recorded asks; the operator opens
    // Studio to see them.
    const actions = missing.map(({ action }) => action);
    if (pending > 0) actions.push(`등록된 확인 요청 ${pending}건을 확인`);
    items.push({
      projectId: auditText(project.id, AUDIT_NAME_MAX_CHARS),
      projectName: auditText(project.name, AUDIT_NAME_MAX_CHARS),
      businessGroup: auditText(project.businessGroup, AUDIT_NAME_MAX_CHARS),
      priority,
      missingFields: missing.map(({ field }) => field),
      actions,
      basis: [...missing.map(({ field }) => field), ...(pending > 0 ? ["nextEvidence"] : [])],
      pendingEvidence: pending,
    });
  }

  items.sort(compareAuditItems);
  return {
    kind: EVIDENCE_AUDIT_KIND,
    schemaVersion: 1,
    source: {
      updatedAt: registry.updatedAt,
      sourceHash: registry.sourceHash,
      scope: registry.scope,
      consumer: registry.consumer,
    },
    coverage,
    summary: {
      projectsNeedingReview: items.length,
      fieldGaps,
      pendingEvidence,
      byPriority,
    },
    items: items.slice(0, EVIDENCE_AUDIT_MAX_ITEMS),
  };
}
