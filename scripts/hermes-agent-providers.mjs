// Development-executor provider contract shared by the web console, the
// readiness/canary tools, and tests. The worker (single self-contained file)
// implements the same contract inline — see DEVIN.md for why the execution
// adapters live in the worker while readiness lives here.
//
// Truthful states only: a provider is never reported connected without real
// evidence. "ready" means the official interface was probed successfully,
// "configured" means credentials are present but no live call was attempted,
// "unavailable" means the provider cannot execute anything right now.

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";

export const EXECUTOR_TYPES = ["codex", "devin"];
export const PROVIDER_STATES = ["ready", "configured", "unavailable"];

export const DEVIN_DEFAULT_API_URL = "https://api.devin.ai";
export const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";
// The on-device model for routine low-risk chat/routing — must match a real
// `ollama list` entry on the Mac Studio (local-small/local-large/local-long).
export const LOCAL_MODEL_DEFAULT = "local-small:latest";

export function normalizeExecutor(value) {
  return EXECUTOR_TYPES.includes(value) ? value : "codex";
}

export function runner(execFileImpl = execFile) {
  return (command, args, { timeoutMs = 5000 } = {}) =>
    new Promise((resolvePromise) => {
      execFileImpl(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
        resolvePromise({
          ok: !error,
          code: typeof error?.code === "number" ? error.code : null,
          killed: Boolean(error?.killed),
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      });
    });
}

// Codex readiness = the official non-interactive CLI actually runs
// (`codex --version`, bounded). A configured-but-broken binary is unavailable.
export async function codexReadiness({ env = process.env, run = runner() } = {}) {
  const configured = env.CODEX_BIN || "";
  if (configured) {
    try {
      await access(configured, constants.X_OK);
    } catch {
      return { provider: "codex", state: "unavailable", reason: "binary_not_executable" };
    }
  }
  const probe = await run(configured || "codex", ["--version"]);
  if (!probe.ok) return { provider: "codex", state: "unavailable", reason: "cli_probe_failed" };
  return { provider: "codex", state: "ready" };
}

// Devin readiness = official v3 credentials configured (service user API key +
// org id). Presence only — no live call, no value echo. Missing/legacy pieces
// are honestly unavailable.
export function devinReadiness({ env = process.env } = {}) {
  if (!env.DEVIN_API_KEY) {
    return { provider: "devin", state: "unavailable", reason: "missing_credential" };
  }
  if (!String(env.DEVIN_API_KEY).startsWith("cog_")) {
    return { provider: "devin", state: "unavailable", reason: "invalid_key_prefix" };
  }
  if (!env.DEVIN_ORG_ID) {
    return { provider: "devin", state: "unavailable", reason: "missing_org_id" };
  }
  const apiUrl = env.DEVIN_API_URL || DEVIN_DEFAULT_API_URL;
  let host;
  try {
    host = new URL(apiUrl).host;
  } catch {
    return { provider: "devin", state: "unavailable", reason: "invalid_api_url" };
  }
  return { provider: "devin", state: "configured", apiHost: host };
}

// Local-LLM readiness = the Ollama server answers AND the configured model is
// actually present in its catalog. A reachable server without the model is
// unavailable (model_missing) — a missing model is never "ready". The model
// name is a config value, not a secret, and is reported for diagnostics.
export async function localLlmReadiness({ env = process.env, fetchImpl = fetch } = {}) {
  const base = env.OLLAMA_URL || OLLAMA_DEFAULT_URL;
  const model = env.HERMES_LOCAL_MODEL || LOCAL_MODEL_DEFAULT;
  let tags;
  try {
    const response = await fetchImpl(new URL("/api/tags", base), {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return { provider: "local_llm", state: "unavailable", reason: "server_error", model };
    }
    tags = await response.json();
  } catch {
    return { provider: "local_llm", state: "unavailable", reason: "server_unreachable", model };
  }
  const names = new Set(
    (Array.isArray(tags?.models) ? tags.models : [])
      .map((entry) => String(entry?.name || entry?.model || "").toLowerCase())
      .filter(Boolean),
  );
  const wanted = String(model).toLowerCase();
  const tagged = wanted.includes(":") ? wanted : `${wanted}:latest`;
  if (!names.has(wanted) && !names.has(tagged)) {
    return { provider: "local_llm", state: "unavailable", reason: "model_missing", model };
  }
  return { provider: "local_llm", state: "ready", model };
}

export async function providerReadiness({ env = process.env, run = runner(), fetchImpl = fetch } = {}) {
  const [codex, devin, localLlm] = await Promise.all([
    codexReadiness({ env, run }),
    Promise.resolve(devinReadiness({ env })),
    localLlmReadiness({ env, fetchImpl }),
  ]);
  return { codex, devin, local_llm: localLlm };
}

// Devin API request/status/result contract — official v3 organization scope
// (docs.devin.ai/api-reference). The worker executes this against fetch;
// tests run it against a fixture server. v3 has no idempotency key — the
// hermes-<requestId> tag provides traceability instead.
export function devinSessionCreatePath(orgId) {
  if (!/^[\w-]{2,120}$/.test(String(orgId || ""))) {
    throw new Error("유효하지 않은 Devin 조직 ID입니다.");
  }
  return `/v3/organizations/${orgId}/sessions`;
}

export function devinSessionPath(orgId, devinId) {
  if (!/^devin-[\w-]{2,120}$/.test(String(devinId || ""))) {
    throw new Error("유효하지 않은 Devin 세션 ID입니다.");
  }
  return `${devinSessionCreatePath(orgId)}/${devinId}`;
}

export function devinSessionMessagesPath(orgId, devinId) {
  return `${devinSessionPath(orgId, devinId)}/messages`;
}

export function devinSessionRequest({ prompt, requestId, title, repos = [], maxAcu = null }) {
  const body = {
    prompt: String(prompt || "").slice(0, 8000),
    title: String(title || "Hermes 개발 요청").slice(0, 140),
    tags: ["hermes-ops", `hermes-${String(requestId || "").slice(0, 40)}`],
    resumable: false,
    structured_output_schema: {
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
    },
  };
  if (Array.isArray(repos) && repos.length) body.repos = repos.slice(0, 4);
  const acu = Number(maxAcu);
  if (Number.isFinite(acu) && acu > 0) body.max_acu_limit = Math.min(Math.floor(acu), 100);
  return { method: "POST", body };
}

// Normalizes the official v3 SessionResponse to a small allowlist — never
// echo raw provider payloads beyond bounded fields.
export function parseDevinSession(payload) {
  const structured = payload?.structured_output;
  return {
    id: String(payload?.session_id || ""),
    url: String(payload?.url || ""),
    status: String(payload?.status || "").toLowerCase(),
    statusDetail: String(payload?.status_detail || "").toLowerCase(),
    detail: String(structured?.result || "").slice(0, 4000),
    pullRequests: Array.isArray(payload?.pull_requests)
      ? payload.pull_requests
          .map((pr) => String(pr?.pr_url || pr?.url || ""))
          .filter(Boolean)
          .slice(0, 8)
      : [],
  };
}

const DEVIN_WAITING_DETAILS = new Set(["waiting_for_user", "waiting_for_approval"]);
const DEVIN_FAILED_DETAILS = new Set([
  "usage_limit_exceeded",
  "out_of_credits",
  "out_of_quota",
  "no_quota_allocation",
  "payment_declined",
  "org_usage_limit_exceeded",
  "user_usage_limit_exceeded",
  "total_session_limit_exceeded",
  "error",
]);

// Fail-closed terminal mapping: 'exit' is only a success with
// status_detail 'finished'; waiting_for_user is pollable; waiting_for_approval
// fails because the worker can never satisfy Devin's internal approval.
export function devinTerminalStatus(session) {
  const { status, statusDetail } = session;
  if (status === "exit") return statusDetail === "finished" ? "finished" : "failed";
  if (status === "error" || status === "suspended") return "failed";
  if (DEVIN_FAILED_DETAILS.has(statusDetail)) return "failed";
  if (statusDetail === "waiting_for_approval") return "failed";
  if (status === "running" && statusDetail === "waiting_for_user") return "waiting";
  if (["new", "claimed", "running", "resuming"].includes(status)) return "running";
  if (DEVIN_WAITING_DETAILS.has(statusDetail)) return "waiting";
  return "running"; // unknown enum — bounded by the 45-minute deadline
}

// Extracts the last agent message text from a GET messages response for the
// final report — bounded, no raw payload echo.
export function devinLastAgentMessage(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
  const agentMessages = items.filter((item) => /devin|agent|assistant/i.test(String(item?.role || item?.type || "")));
  const last = agentMessages.at(-1) || items.at(-1);
  return String(last?.message || last?.content || last?.text || "").slice(0, 4000);
}
