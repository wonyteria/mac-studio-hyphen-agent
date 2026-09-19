import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const smokeScript = join(repoRoot, "scripts", "hermes-smoke.mjs");

function runSmoke(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [smokeScript, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HERMES_OPS_URL: "",
        HERMES_BUSINESS_REGISTRY: "",
        HERMES_BACKUP_DESTINATION: "",
        DISCORD_PUBLIC_KEY: "",
        DISCORD_GUILD_ID: "",
        DISCORD_CHANNEL_IDS: "",
        DISCORD_USER_IDS: "",
        DEVIN_API_KEY: "",
        DEVIN_ORG_ID: "",
        OLLAMA_URL: "http://127.0.0.1:1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const EXPECTED_CHECKS = ["health", "auth", "business", "queue", "providers", "discord", "backup", "projects"];

test("read-only smoke emits the full check list in JSON", async () => {
  const { code, stdout } = await runSmoke(["--format", "json"]);
  const report = JSON.parse(stdout);
  assert.equal(report.kind, "hermes-smoke");
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.checks.map((check) => check.name), EXPECTED_CHECKS);
  // Without credentials the report is honest — nothing fabricated as ok.
  assert.equal(report.checks.find((check) => check.name === "discord").state, "unavailable");
  assert.equal(report.checks.find((check) => check.name === "backup").state, "unavailable");
  assert.equal(report.checks.find((check) => check.name === "backup").reason, "destination_missing");
  assert.equal(report.checks.find((check) => check.name === "projects").state, "ok");
  assert.equal(report.checks.find((check) => check.name === "projects").total, 26);
  const providers = report.checks.find((check) => check.name === "providers");
  assert.equal(providers.local_llm, "unavailable", "a missing/unreachable local model is never ready");
  assert.equal(providers.local_llm_reason, "server_unreachable");
  assert.equal(providers.local_llm_model, "local-small:latest");
  assert.equal(stdout.includes("/Users/"), false, "report stays path-free");
  assert.equal(code, 1, "degraded overall exits 1");
});

test("human format renders Korean state labels", async () => {
  const { stdout } = await runSmoke([]);
  assert.ok(stdout.includes("[사용 불가] discord"));
  assert.ok(stdout.includes("전체:"));
});

test("staging mutation canary exercises the approval state machine end to end", async () => {
  const { stdout } = await runSmoke(["--mutation-canary", "--format", "json"]);
  const report = JSON.parse(stdout);
  const canary = report.checks.find((check) => check.name === "mutation_canary");
  assert.equal(canary.mode, "staging");
  assert.equal(canary.state, "ok");
  const steps = Object.fromEntries(canary.steps.map((step) => [step.step, step.ok]));
  assert.equal(steps.health, true);
  assert.equal(steps.login, true);
  assert.equal(steps.create_mutation, true, "mutation lands as approval_required");
  assert.equal(steps.unclaimed_before_approval, true, "worker cannot claim before approval");
  assert.equal(steps.approve, true);
  assert.equal(steps.cancel, true);
});

test("production mutation canary is blocked without explicit approval evidence", async () => {
  const { code, stdout } = await runSmoke([
    "--mutation-canary",
    "--production",
    "--ops",
    "http://127.0.0.1:1",
    "--format",
    "json",
  ]);
  const report = JSON.parse(stdout);
  const canary = report.checks.find((check) => check.name === "mutation_canary");
  assert.equal(canary.state, "blocked");
  assert.ok(canary.reason.includes("--approve"));
  assert.equal(code, 2);
});

test("production mutation canary with evidence stays read-only", async () => {
  const { stdout } = await runSmoke([
    "--mutation-canary",
    "--production",
    "--approve",
    "deadbeef",
    "--ops",
    "http://127.0.0.1:1",
    "--format",
    "json",
  ]);
  const report = JSON.parse(stdout);
  const canary = report.checks.find((check) => check.name === "mutation_canary");
  assert.equal(canary.state, "skipped");
});
