import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  LOCAL_MODEL_DEFAULT,
  localLlmReadiness,
  providerReadiness,
} from "../scripts/hermes-agent-providers.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function tagsResponse(models, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => ({ models: models.map((name) => ({ name })) }),
  };
}

// The local catalog on the Mac Studio: local-small/local-large/local-long.
const CATALOG = ["local-small:latest", "local-large:latest", "local-long:latest"];

test("the default local model is local-small:latest — matching the real catalog", () => {
  assert.equal(LOCAL_MODEL_DEFAULT, "local-small:latest");
  assert.ok(CATALOG.includes(LOCAL_MODEL_DEFAULT));
});

test("localLlmReadiness is ready only when the server answers AND the model exists", async () => {
  const ready = await localLlmReadiness({
    env: { HERMES_LOCAL_MODEL: "local-small:latest" },
    fetchImpl: async () => tagsResponse(CATALOG),
  });
  assert.equal(ready.state, "ready");
  assert.equal(ready.model, "local-small:latest");

  // Untagged config normalizes to :latest.
  const untagged = await localLlmReadiness({
    env: { HERMES_LOCAL_MODEL: "local-small" },
    fetchImpl: async () => tagsResponse(CATALOG),
  });
  assert.equal(untagged.state, "ready");
});

test("localLlmReadiness never reports ready when the configured model is missing", async () => {
  const missing = await localLlmReadiness({
    env: { HERMES_LOCAL_MODEL: "hermes-4.3-admin-fast-iq4xs-32k:latest" },
    fetchImpl: async () => tagsResponse(CATALOG),
  });
  assert.equal(missing.state, "unavailable");
  assert.equal(missing.reason, "model_missing");
  assert.equal(missing.model, "hermes-4.3-admin-fast-iq4xs-32k:latest");

  const malformed = await localLlmReadiness({
    env: {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: null }) }),
  });
  assert.equal(malformed.state, "unavailable");
  assert.equal(malformed.reason, "model_missing");
});

test("localLlmReadiness reports server failures truthfully", async () => {
  const unreachable = await localLlmReadiness({
    env: { OLLAMA_URL: "http://127.0.0.1:1" },
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(unreachable.state, "unavailable");
  assert.equal(unreachable.reason, "server_unreachable");

  const serverError = await localLlmReadiness({
    env: {},
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.equal(serverError.state, "unavailable");
  assert.equal(serverError.reason, "server_error");
});

test("providerReadiness reports local_llm alongside codex and devin", async () => {
  const readiness = await providerReadiness({
    env: { OLLAMA_URL: "http://127.0.0.1:1" },
    run: async () => ({ ok: false }),
  });
  assert.ok("codex" in readiness && "devin" in readiness && "local_llm" in readiness);
  assert.equal(readiness.local_llm.state, "unavailable");
  assert.equal(readiness.local_llm.reason, "server_unreachable");
  assert.equal(readiness.local_llm.model, "local-small:latest");
});

// ---- source contract: no phantom model names anywhere user-visible ----

test("the worker defaults to a real catalog model and never asserts Hermes 4.3", async () => {
  const worker = await readFile(join(repoRoot, "scripts", "hermes-local-worker.mjs"), "utf8");
  assert.ok(worker.includes('"local-small:latest"'), "default must be local-small:latest");
  assert.equal(worker.includes("hermes-4.3"), false, "nonexistent quantization must not be referenced");
  assert.equal(worker.includes("Hermes 4.3"), false, "phantom model name must not reach users or logs");
  // The execution paths gate on server + model presence, not just the server.
  const gates = worker.match(/ensureLocalModel\(\)/g) || [];
  assert.ok(gates.length >= 3, `ensureLocalModel defined + used on both LLM paths (got ${gates.length})`);
  // The provider report carries local_llm so readiness can show it.
  assert.ok(worker.includes("local_llm:"), "worker reports local_llm state");
});

test("the console labels the chat surface 로컬 LLM — never a phantom model name", async () => {
  const server = await readFile(join(repoRoot, "mini-server.mjs"), "utf8");
  assert.equal(server.includes("Hermes 4.3"), false);
  assert.ok(server.includes("로컬 LLM 대화"), "chat type label must say 로컬 LLM");
  assert.ok(server.includes("local_llm"), "integrations contract carries local_llm");
});

test("docs no longer claim the nonexistent quantization", async () => {
  for (const doc of ["README.md", "ARCHITECTURE.md", "DESIGN.md"]) {
    const text = await readFile(join(repoRoot, doc), "utf8");
    assert.equal(text.includes("hermes-4.3"), false, `${doc} must not reference the phantom model`);
    assert.equal(text.includes("Hermes 4.3"), false, `${doc} must not name Hermes 4.3`);
  }
});
