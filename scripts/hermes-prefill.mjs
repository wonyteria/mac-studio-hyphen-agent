// Bounded Studio -> Hermes composer prefill contract.
//
// The only browser-controllable handoff inputs are three URL query parameters
// on GET /: project, type, and prompt. Every value is validated here against
// the deployment project registry and the fixed request-type allowlist before
// it is embedded in the served page. Unknown projects or types, oversized
// text, duplicated parameters, control characters, and malformed encoding all
// fail closed to neutral defaults, so the page only ever receives an editable
// composer draft. The contract carries no registry path, shell command,
// credential, approval, auto-submit flag, or execution state — applying it
// can never submit a request or bypass login or approval.

export const PREFILL_PARAM_NAMES = ["project", "type", "prompt"];
export const PREFILL_LIMITS = { project: 120, type: 40, prompt: 2000 };

// The composer select options: every type the owner could pick manually.
// "custom" (a legacy hermes_chat alias) is intentionally not selectable.
export const PREFILL_TYPES = new Set([
  "auto",
  "hermes_chat",
  "hermes_ops",
  "mac_status",
  "deployment_status",
  "project_inspect",
  "redeploy",
  "file_cleanup",
  "development",
  "studio_priorities",
  "studio_blockers",
  "studio_overview",
]);

const CAPABILITY_GATED_TYPES = new Set(["deployment_status", "project_inspect", "redeploy", "development"]);

// Anything that is not ordinary editable text: C0/C1 controls (tab and
// newline survive), DEL, line/paragraph separators, BOM, bidi/format marks,
// and the malformed-encoding replacement character.
const DISALLOWED_TEXT_CODES = new Set([
  0x2028, 0x2029, 0xfeff,
  0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069, 0xfffd,
]);

function hasInvalidText(value) {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === 0x09 || code === 0x0a) continue;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || DISALLOWED_TEXT_CODES.has(code)) return true;
  }
  return false;
}

// Absent and duplicated parameters both resolve to null so the caller falls
// back to the neutral default for that field.
function singleValue(searchParams, name) {
  const values = searchParams.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function cleanText(raw, maximum) {
  if (typeof raw !== "string" || raw.length > maximum || hasInvalidText(raw)) return "";
  return raw.trim();
}

function normalizeKey(value) {
  return String(value).trim().toLowerCase().replace(/[\s_]+/g, "-");
}

// Candidates come only from the server-side registry: exact id, display name,
// slugged name, full domain host, or the first domain label.
function projectKeys(project) {
  const keys = new Set();
  if (typeof project.id === "string") keys.add(normalizeKey(project.id));
  if (typeof project.name === "string" && project.name) keys.add(normalizeKey(project.name));
  if (typeof project.domain === "string" && project.domain) {
    try {
      const host = new URL(project.domain).hostname.toLowerCase();
      if (host) {
        keys.add(host);
        keys.add(host.split(".")[0]);
      }
    } catch {
      // Malformed registry domains contribute no aliases.
    }
  }
  return keys;
}

function resolveProject(raw, projects) {
  const text = cleanText(raw, PREFILL_LIMITS.project);
  if (!text) return null;
  const wanted = normalizeKey(text);
  for (const project of projects) {
    if (projectKeys(project).has(wanted) && typeof project.id === "string") return project.id;
  }
  return null;
}

function projectSupports(project, type) {
  if (!CAPABILITY_GATED_TYPES.has(type)) return true;
  return Array.isArray(project?.capabilities) && project.capabilities.includes(type);
}

// Returns null when no prefill parameter was supplied at all, otherwise a
// per-field validated draft: project is a resolved registry id or null (keep
// the composer default), type is an allowlisted type or "auto", prompt is
// editable text or "".
export function parseHandoffPrefill(searchParams, projects) {
  const params = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(String(searchParams || ""));
  if (!PREFILL_PARAM_NAMES.some((name) => params.has(name))) return null;
  const list = Array.isArray(projects) ? projects : [];
  const projectId = resolveProject(singleValue(params, "project"), list);
  const effectiveProject = list.find((candidate) => candidate.id === projectId) || list[0] || null;
  let type = cleanText(singleValue(params, "type"), PREFILL_LIMITS.type);
  if (!PREFILL_TYPES.has(type) || !projectSupports(effectiveProject, type)) type = "auto";
  const prompt = cleanText(singleValue(params, "prompt"), PREFILL_LIMITS.prompt);
  return { project: projectId, type, prompt };
}

// Emits a JS literal holding only {project, type, prompt}. JSON metacharacters
// that could break out of the inline <script> are escaped.
export function serializePrefillForHtml(prefill) {
  if (!prefill || typeof prefill !== "object") return "null";
  const safe = {
    project: typeof prefill.project === "string" ? prefill.project : null,
    type: PREFILL_TYPES.has(prefill.type) ? prefill.type : "auto",
    prompt: typeof prefill.prompt === "string" ? prefill.prompt.slice(0, PREFILL_LIMITS.prompt) : "",
  };
  return JSON.stringify(safe).replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
