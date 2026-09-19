import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PREFILL_LIMITS,
  PREFILL_PARAM_NAMES,
  PREFILL_TYPES,
  parseHandoffPrefill,
  serializePrefillForHtml,
} from "../scripts/hermes-prefill.mjs";

const { projects } = JSON.parse(await readFile(new URL("../hermes-projects.json", import.meta.url), "utf8"));
const defaultProjectId = projects[0].id;

function prefill(search) {
  return parseHandoffPrefill(search, projects);
}

test("accepts a well-formed Studio handoff", () => {
  const result = prefill("?project=hermes-mac-ops&type=development&prompt=버튼 문구를 수정해줘");
  assert.deepEqual(result, { project: "hermes-mac-ops", type: "development", prompt: "버튼 문구를 수정해줘" });
});

test("returns null when no prefill parameter is supplied", () => {
  assert.equal(prefill(""), null);
  assert.equal(prefill("?approve=true&execute=1&token=abc&path=/etc&submit=1&run=now"), null);
  assert.equal(prefill("?autoSubmit=true"), null);
});

test("resolves projects by id, name, slugged name, and domain labels only", () => {
  assert.equal(prefill("?project=hermes-mac-ops").project, "hermes-mac-ops");
  assert.equal(prefill("?project=MAKO").project, "project_2f93bab5ced44cea892995908a1cb73d");
  assert.equal(prefill("?project=mako-server").project, "project_2f93bab5ced44cea892995908a1cb73d");
  assert.equal(prefill("?project=jasupon landing").project, "project_5b688fdfa46c43919a87fd6f919fd1fb");
  assert.equal(prefill("?project=eventos.hyphen.it.com").project, "project_058b0b3e024941c2ad259ca9927f9f15");
});

test("unknown projects fail closed to the composer default", () => {
  for (const candidate of ["bogus", "../../etc/passwd", "a/b", "<script>", "x".repeat(PREFILL_LIMITS.project + 1), " "]) {
    const result = prefill(`?project=${encodeURIComponent(candidate)}&prompt=x`);
    assert.equal(result.project, null, `project ${JSON.stringify(candidate)} must fail closed`);
  }
});

test("unknown or unselectable types fail closed to auto", () => {
  for (const type of ["bogus", "custom", "shell", "AUTO", "x".repeat(PREFILL_LIMITS.type + 1)]) {
    assert.equal(prefill(`?type=${encodeURIComponent(type)}`).type, "auto", `type ${type} must degrade`);
  }
  for (const type of PREFILL_TYPES) {
    assert.equal(prefill(`?type=${type}`).type, type, `type ${type} should survive`);
  }
});

test("capability-gated types require the effective project capability", () => {
  // EVENTOS only exposes deployment_status.
  assert.equal(prefill("?project=eventos&type=deployment_status").type, "deployment_status");
  for (const gated of ["development", "project_inspect", "redeploy"]) {
    assert.equal(prefill(`?project=eventos&type=${gated}`).type, "auto", `${gated} must degrade on eventos`);
  }
  // Without a project param the composer default (hermes-mac-ops) decides.
  assert.equal(prefill("?type=development").type, "development");
});

test("duplicated parameters fail closed per field", () => {
  const result = prefill("?project=hermes-mac-ops&project=eventos&type=auto&type=development&prompt=ok&prompt=other");
  assert.equal(result.project, null);
  assert.equal(result.type, "auto");
  assert.equal(result.prompt, "");
});

test("oversized, control-character, and malformed prompts fail closed", () => {
  assert.equal(prefill(`?prompt=${"a".repeat(PREFILL_LIMITS.prompt + 1)}`).prompt, "");
  assert.equal(prefill("?prompt=a%07b").prompt, "", "C0 control must drop the prompt");
  assert.equal(prefill("?prompt=a%7Fb").prompt, "", "DEL must drop the prompt");
  assert.equal(prefill("?prompt=%E0%A4%A").prompt, "", "malformed encoding must drop the prompt");
  assert.equal(prefill("?prompt=%FF").prompt, "", "invalid UTF-8 must drop the prompt");
  // Ordinary editable text survives, including tab and newline.
  assert.equal(prefill("?prompt=first%09second%0Athird").prompt, "first\tsecond\nthird");
});

test("prefill output carries only editable draft fields", () => {
  const result = prefill("?project=hermes-mac-ops&type=auto&prompt=x");
  assert.deepEqual(Object.keys(result).sort(), ["project", "prompt", "type"]);
});

test("serialized prefill is a safe literal with only the three fields", () => {
  assert.equal(serializePrefillForHtml(null), "null");
  const embedded = serializePrefillForHtml({ project: "hermes-mac-ops", type: "auto", prompt: "</script><img>" });
  assert.equal(embedded.includes("</script>"), false);
  assert.equal(embedded.includes("<"), false);
  assert.deepEqual(JSON.parse(embedded), { project: "hermes-mac-ops", type: "auto", prompt: "</script><img>" });
  // Foreign keys never survive serialization.
  const polluted = serializePrefillForHtml({ project: "a", type: "auto", prompt: "", approve: true, path: "/x", run: "rm" });
  assert.deepEqual(Object.keys(JSON.parse(polluted)).sort(), ["project", "prompt", "type"]);
});

test("param name allowlist is exactly project, type, prompt", () => {
  assert.deepEqual([...PREFILL_PARAM_NAMES].sort(), ["project", "prompt", "type"]);
  assert.equal(typeof defaultProjectId, "string");
});
