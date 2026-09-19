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

// Devin readiness = an official-API credential is configured. Presence only —
// no live call, no value echo. Missing key is honestly unavailable.
export function devinReadiness({ env = process.env } = {}) {
  if (!env.DEVIN_API_KEY) {
    return { provider: "devin", state: "unavailable", reason: "missing_credential" };
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

export async function providerReadiness({ env = process.env, run = runner() } = {}) {
  const [codex, devin] = await Promise.all([
    codexReadiness({ env, run }),
    Promise.resolve(devinReadiness({ env })),
  ]);
  return { codex, devin };
}

// Devin API request/status/result contract (bounded adapter shape). The worker
// executes this against fetch; tests run it against a fixture server.
export function devinSessionRequest({ prompt, idempotencyKey }) {
  return {
    path: "/v1/sessions",
    method: "POST",
    body: {
      prompt: String(prompt || "").slice(0, 8000),
      idempotent: true,
      idempotency_key: String(idempotencyKey || "").slice(0, 120),
    },
  };
}

export function devinSessionStatusPath(sessionId) {
  if (!/^[\w-]{4,120}$/.test(String(sessionId || ""))) {
    throw new Error("유효하지 않은 Devin 세션 ID입니다.");
  }
  return `/v1/sessions/${sessionId}`;
}

// Normalizes the official session payload to a small allowlist — never echo
// raw provider text beyond bounded fields the report already constrains.
export function parseDevinSession(payload) {
  const statusEnum = String(payload?.status_enum || payload?.status || "").toLowerCase();
  const structured = payload?.structured_output;
  return {
    id: String(payload?.session_id || payload?.id || ""),
    url: String(payload?.url || ""),
    status: statusEnum,
    detail: String(structured?.result || payload?.result_detail || "").slice(0, 4000),
  };
}

export function devinTerminalStatus(session) {
  if (["finished", "succeeded", "completed", "done"].includes(session.status)) return "finished";
  if (["expired", "failed", "error", "suspended", "blocked"].includes(session.status)) return "failed";
  return "running";
}
