import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildBusinessBriefing,
  defaultBusinessRegistryPath,
  loadBusinessRegistry,
  renderBriefingMarkdown,
  resolveBusinessRegistryPath,
  validateBusinessRegistry,
} from "../scripts/hermes-business-registry.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const briefingScript = join(repoRoot, "scripts", "hermes-business-briefing.mjs");
const studioExportPath = defaultBusinessRegistryPath({});

let workDir;

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
    usage: {
      hyphenCoreFilter: "organization === 'hyphen'",
      unknowns: "null and unknown values mean unverified; never fill them from guesses",
    },
    projects,
    ...overrides,
  };
}

async function writeExport(payload, name = "registry.private.json") {
  const file = join(workDir, name);
  await writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [briefingScript, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "hermes-briefing-test-"));
});

after(async () => {
  await rm(workDir, { force: true, recursive: true });
});

test("validation accepts the real Studio private export shape", async () => {
  let raw;
  try {
    raw = await readFile(studioExportPath, "utf8");
  } catch {
    return; // Studio checkout absent — covered by fixture tests below.
  }
  const registry = JSON.parse(raw);
  assert.deepEqual(validateBusinessRegistry(registry), []);
  const { registry: loaded } = await loadBusinessRegistry(studioExportPath);
  const briefing = buildBusinessBriefing(loaded);
  assert.equal(briefing.coverage.projects, loaded.projects.length);
  assert.ok(briefing.coverage.excluded >= 0);
});

test("CLI consumes the Studio private export read-only when present", async () => {
  let before;
  try {
    before = await readFile(studioExportPath, "utf8");
  } catch {
    return;
  }
  const run = runCli(["--registry", studioExportPath, "--format", "json"]);
  assert.equal(run.status, 0, run.stderr);
  const briefing = JSON.parse(run.stdout);
  assert.equal(briefing.kind, "hyphen-business-briefing");
  assert.equal((await readFile(studioExportPath, "utf8")), before, "registry file must be unchanged");
  const md = runCli(["--registry", studioExportPath, "--format", "markdown"]);
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /하이픈 사업 브리핑/);
});

test("29sfilm projects are excluded from every core briefing section", () => {
  const registry = exportPayload([
    project({ id: "core-a", name: "Core A" }),
    project({
      id: "29sfilm-cor",
      name: "29sfilm-cor",
      organization: "29sfilm",
      blockers: [{ description: "결제 대행 승인 대기", since: "2026-09-01" }],
      revenue: { amount: 100, currency: "KRW", source: "ledger", asOf: "2026-09-19" },
      status: "down",
      nextEvidence: ["확인"],
    }),
  ]);
  const briefing = buildBusinessBriefing(registry);
  const serialized = JSON.stringify(briefing);
  assert.equal(serialized.includes("29sfilm-cor"), false);
  assert.equal(serialized.includes("결제 대행"), false);
  assert.equal(briefing.coverage.hyphenCore, 1);
  assert.deepEqual(briefing.coverage.excludedOrganizations, [{ organization: "29sfilm", count: 1 }]);
  const markdown = renderBriefingMarkdown(briefing);
  assert.equal(markdown.includes("29sfilm-cor"), false);
  assert.match(markdown, /제외: 29sfilm 1개/);
});

test("briefing sections derive only from explicit fields with evidence attached", () => {
  const registry = exportPayload([
    project({
      id: "core-blocked",
      name: "Blocked",
      blockers: [{ description: "도메인 이전 승인 대기", since: "2026-09-10" }],
      evidence: [evidence("승인 요청 기록", "ops/approvals.md")],
    }),
    project({
      id: "core-down",
      name: "Down",
      status: "down",
      lifecycle: "active",
      evidenceStatus: "partial",
      deploys: [{ url: "https://down.example.com" }],
      evidence: [evidence("배포 상태 확인", "ops/deploys.md")],
    }),
    project({
      id: "core-rev",
      name: "Revenue",
      revenue: { amount: 1200000, currency: "KRW", period: "2026-08", source: "stripe", asOf: "2026-09-01" },
      kpis: [{ name: "MAU", value: 340, unit: "users", source: "analytics", measuredAt: "2026-09-01" }],
      owner: "won",
      evidence: [evidence("정산 내역", "finance/2026-08.csv")],
    }),
    project({ id: "core-quiet", name: "Quiet" }),
  ]);
  const briefing = buildBusinessBriefing(registry);
  const { topPriorities, blocked, revenueSignals, systemAnomalies, ownerApprovals } = briefing.sections;

  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].projectId, "core-blocked");
  assert.equal(blocked[0].details.blockers[0].description, "도메인 이전 승인 대기");

  assert.equal(revenueSignals.length, 1);
  assert.equal(revenueSignals[0].details.revenue.amount, 1200000);
  assert.equal(revenueSignals[0].details.kpis[0].name, "MAU");

  assert.equal(systemAnomalies.length, 1);
  assert.equal(systemAnomalies[0].kind, "status_down");

  const approvalIds = ownerApprovals.map((item) => item.projectId);
  assert.ok(approvalIds.includes("core-blocked"));

  // Ranking: blocker + down both outrank quiet; every item carries evidence.
  assert.ok(topPriorities.length <= 3);
  const ids = topPriorities.map((item) => item.projectId);
  assert.equal(ids.includes("core-quiet"), false);

  for (const items of [topPriorities, blocked, revenueSignals, systemAnomalies, ownerApprovals]) {
    for (const item of items) {
      assert.ok(item.projectId, "projectId required");
      assert.ok(item.projectName, "projectName required");
      assert.ok(Array.isArray(item.basis) && item.basis.length > 0);
      assert.ok(Array.isArray(item.evidence));
      assert.equal(item.verified, item.evidence.length > 0);
      for (const entry of item.evidence) {
        assert.deepEqual(Object.keys(entry).sort(), ["checkedAt", "label", "ref"]);
      }
    }
  }
  // Factual items must carry at least one evidence entry.
  for (const item of [...blocked, ...revenueSignals, ...systemAnomalies]) {
    assert.equal(item.verified, true, `${item.projectId} factual item without evidence`);
  }
});

test("priority ranking is deterministic with documented tie-breaks", () => {
  const registry = exportPayload([
    project({ id: "z-last", nextEvidence: ["확인"] }),
    project({ id: "a-first", nextEvidence: ["확인"] }),
    project({ id: "m-mid", nextEvidence: ["확인"] }),
    project({ id: "b-blocked", blockers: [{ description: "막힘" }], nextEvidence: ["확인"] }),
    project({ id: "c-down", status: "down", evidenceStatus: "partial" }),
  ]);
  const briefing = buildBusinessBriefing(registry);
  const ids = briefing.sections.topPriorities.map((item) => item.projectId);
  // blocked > down > nextEvidence ties broken by id ascending.
  assert.deepEqual(ids, ["b-blocked", "c-down", "a-first"]);
});

test("identical input produces byte-identical JSON and markdown", () => {
  const registry = exportPayload([
    project({ id: "a", nextEvidence: ["확인"], blockers: [{ description: "막힘" }] }),
    project({ id: "b", revenue: { amount: 5, currency: "USD", source: "x", asOf: "2026-09-01" } }),
  ]);
  const first = buildBusinessBriefing(registry);
  const second = buildBusinessBriefing(JSON.parse(JSON.stringify(registry)));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(renderBriefingMarkdown(first), renderBriefingMarkdown(second));
  // No wall-clock fields anywhere in the output: the envelope carries only
  // input-derived source metadata.
  assert.deepEqual(Object.keys(first).sort(), ["coverage", "kind", "schemaVersion", "sections", "source"]);
  assert.deepEqual(Object.keys(first.source).sort(), ["consumer", "scope", "sourceHash", "updatedAt"]);
});

test("empty and unknown registries render honest empty sections", () => {
  const registry = exportPayload([
    project({ id: "u-1", evidence: [] }),
    project({ id: "u-2", evidence: [], nextEvidence: ["배포 상태 확인"] }),
  ]);
  const briefing = buildBusinessBriefing(registry);
  assert.equal(briefing.sections.blocked.length, 0);
  assert.equal(briefing.sections.revenueSignals.length, 0);
  assert.equal(briefing.sections.systemAnomalies.length, 0);
  assert.equal(briefing.coverage.statusUnknown, 2);
  assert.equal(briefing.coverage.ownerMissing, 2);
  const markdown = renderBriefingMarkdown(briefing);
  assert.match(markdown, /근거 없음 — 입력 레지스트리에 해당 신호가 없습니다\. 확인 필요\./);
  // u-2 has an explicit nextEvidence entry → owner action queue, but unverified.
  const pending = briefing.sections.ownerApprovals.find((item) => item.projectId === "u-2");
  assert.ok(pending);
  assert.equal(pending.verified, false);
  assert.match(markdown, /\(근거 부족 — 확인 필요\)/);
});

test("malformed JSON is rejected fail-closed", async () => {
  const file = join(workDir, "broken.json");
  await writeFile(file, "{ not json ", "utf8");
  await assert.rejects(loadBusinessRegistry(file), (error) => error.code === "registry_parse_error");
  const run = runCli(["--registry", file]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /registry_parse_error/);
});

test("schema mismatches are rejected fail-closed without leaking values", async () => {
  const file = await writeExport(exportPayload([project()], { scope: "public" }));
  await assert.rejects(loadBusinessRegistry(file), (error) => error.code === "schema_mismatch");

  const wrongVersion = await writeExport(exportPayload([project()], { schemaVersion: 2 }), "v2.json");
  const run = runCli(["--registry", wrongVersion]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /schema_mismatch/);
  assert.equal(run.stderr.includes("Alpha"), false, "field values must not reach stderr");

  const badConsumer = await writeExport(exportPayload([project()], { consumer: "mako" }), "consumer.json");
  await assert.rejects(loadBusinessRegistry(badConsumer), (error) => error.code === "schema_mismatch");

  const missingId = exportPayload([{ name: "No Id" }]);
  const issues = validateBusinessRegistry(missingId);
  assert.ok(issues.some((issue) => issue.includes("missing required field 'id'")));

  const factWithoutEvidence = exportPayload([
    project({ status: "down", revenue: { amount: 1, currency: "KRW", source: "x", asOf: "2026-09-01" }, evidence: [] }),
  ]);
  const parityIssues = validateBusinessRegistry(factWithoutEvidence);
  assert.ok(parityIssues.some((issue) => issue.includes("require at least one evidence entry")));
});

test("sourceHash drift against a pinned expectation is rejected", async () => {
  const file = await writeExport(exportPayload([project()]));
  const pinned = "b".repeat(64);
  await assert.rejects(
    loadBusinessRegistry(file, { expectedHash: pinned }),
    (error) => error.code === "source_hash_mismatch",
  );
  const ok = await loadBusinessRegistry(file, { expectedHash: "a".repeat(64) });
  assert.equal(ok.registry.sourceHash, "a".repeat(64));
  const run = runCli(["--registry", file, "--expect-hash", pinned]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /source_hash_mismatch/);
});

test("oversized, symlinked, missing, and non-regular inputs are rejected", async () => {
  const file = await writeExport(exportPayload([project()]));
  await assert.rejects(
    loadBusinessRegistry(file, { maxBytes: 8 }),
    (error) => error.code === "registry_too_large",
  );

  const link = join(workDir, "linked.json");
  await symlink(file, link);
  await assert.rejects(loadBusinessRegistry(link), (error) => error.code === "registry_symlink");
  const linkRun = runCli(["--registry", link]);
  assert.equal(linkRun.status, 2);
  assert.match(linkRun.stderr, /registry_symlink/);

  await assert.rejects(
    loadBusinessRegistry(join(workDir, "absent.json")),
    (error) => error.code === "registry_unreadable",
  );

  const dir = join(workDir, "a-directory");
  await mkdir(dir);
  await assert.rejects(loadBusinessRegistry(dir), (error) => error.code === "registry_not_regular");
});

test("value-required CLI options fail closed on missing or option-like values", async () => {
  const file = await writeExport(exportPayload([project()]));
  const cases = [
    ["--registry"],
    ["--registry", "--format", "json"],
    ["--format"],
    ["--format", "--registry", file],
    ["--expect-hash"],
    ["--expect-hash", "--registry", file],
    ["--max-bytes"],
    ["--max-bytes", "--registry", file],
  ];
  for (const args of cases) {
    const run = runCli(args);
    assert.equal(run.status, 2, `expected exit 2 for: ${args.join(" ")}`);
    assert.match(run.stderr, /값이 필요합니다/);
  }
});

test("--expect-hash accepts only a lowercase 64-char sha256 hex", async () => {
  const file = await writeExport(exportPayload([project()]));
  const invalid = [
    "A".repeat(64), // uppercase
    "a".repeat(63), // too short
    "a".repeat(65), // too long
    "g".repeat(64), // non-hex
    `${"a".repeat(63)} `,
  ];
  for (const value of invalid) {
    const run = runCli(["--registry", file, "--expect-hash", value]);
    assert.equal(run.status, 2, `expected exit 2 for hash '${value}'`);
    assert.match(run.stderr, /sha256 hex/);
  }
  // The same pin via environment must obey the same contract.
  const envRun = runCli(["--registry", file], { HERMES_BUSINESS_REGISTRY_EXPECTED_HASH: "nope" });
  assert.equal(envRun.status, 2);
  assert.match(envRun.stderr, /sha256 hex/);
  // And a well-formed pin still reaches the drift check, not arg rejection.
  const driftRun = runCli(["--registry", file, "--expect-hash", "b".repeat(64)]);
  assert.equal(driftRun.status, 2);
  assert.match(driftRun.stderr, /source_hash_mismatch/);
});

test("--max-bytes rejects non-numeric and non-integer values", async () => {
  const file = await writeExport(exportPayload([project()]));
  for (const value of ["abc", "1.5", "0", "-1", "NaN"]) {
    const run = runCli(["--registry", file, "--max-bytes", value]);
    assert.equal(run.status, 2, `expected exit 2 for --max-bytes ${value}`);
  }
});

test("backup: null is unverified, never a system anomaly", () => {
  const registry = exportPayload([
    project({
      id: "with-store",
      dataStores: [{ name: "requests", kind: "json-file", location: "container:/data/requests.json", backup: null }],
    }),
  ]);
  const briefing = buildBusinessBriefing(registry);
  assert.equal(briefing.sections.systemAnomalies.length, 0);
  const serialized = JSON.stringify(briefing);
  assert.equal(serialized.includes("backup"), false, "null backup must not surface as a briefing fact");
  const markdown = renderBriefingMarkdown(briefing);
  assert.equal(markdown.includes("requests"), false);
});

test("the legacy identity marker is rejected inside registry strings", () => {
  const marker = `${String.fromCharCode(51, 120)}haust`;
  const registry = exportPayload([
    project({ evidence: [evidence("legit", `docs/${marker}.md`)] }),
  ]);
  const issues = validateBusinessRegistry(registry);
  assert.ok(issues.some((issue) => issue.includes("legacy identity marker")));
});

test("path resolution prefers explicit arg, then env, then sibling default", () => {
  assert.equal(resolveBusinessRegistryPath({ arg: "/tmp/x.json", env: {} }), "/tmp/x.json");
  assert.equal(
    resolveBusinessRegistryPath({ env: { HERMES_BUSINESS_REGISTRY: "/tmp/env.json" } }),
    "/tmp/env.json",
  );
  const fallback = resolveBusinessRegistryPath({ env: {} });
  assert.equal(fallback, defaultBusinessRegistryPath({}));
  // The default is repo-relative: the Studio checkout next to this repository.
  assert.equal(fallback, join(repoRoot, "..", "Hyphen-Studio", "outputs", "registry.private.json"));
});
