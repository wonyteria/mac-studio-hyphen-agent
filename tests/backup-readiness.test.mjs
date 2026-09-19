import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectAdapters,
  hasProtectedSegment,
  isProtectedName,
  loadBackupManifest,
  scanManifest,
  validateBackupManifest,
} from "../scripts/hermes-backup-manifest.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cliScript = join(repoRoot, "scripts", "hermes-backup-readiness.mjs");

let workDir;
let fixtureDir;

function manifestPayload(sources, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "hermes-backup-manifest",
    manifestId: "test-boundary",
    updatedAt: "2026-09-19",
    sources,
    targets: [],
    ...overrides,
  };
}

function fileSource(path, overrides = {}) {
  return { id: "a-file", type: "file", path, label: "테스트 파일", required: true, ...overrides };
}

function dirSource(path, overrides = {}) {
  return { id: "a-dir", type: "directory", path, label: "테스트 디렉터리", required: true, ...overrides };
}

function sqliteSource(path, overrides = {}) {
  return {
    id: "a-sqlite",
    type: "sqlite",
    path,
    label: "테스트 sqlite",
    required: true,
    sqlite: { consistency: "online-backup", strategy: "sqlite3 .backup로 일관 산출물을 만든다" },
    ...overrides,
  };
}

async function writeManifest(payload, name = "manifest.json") {
  const file = join(workDir, name);
  await writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [cliScript, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "hermes-backup-test-"));
  fixtureDir = join(workDir, "fixture");
  await mkdir(join(fixtureDir, "tree", "sub"), { recursive: true });
  await writeFile(join(fixtureDir, "config.json"), JSON.stringify({ a: 1 }), "utf8");
  await writeFile(join(fixtureDir, "tree", "b.txt"), "bravo", "utf8");
  await writeFile(join(fixtureDir, "tree", "a.txt"), "alpha", "utf8");
  await writeFile(join(fixtureDir, "tree", "sub", "c.txt"), "charlie", "utf8");
  await writeFile(join(fixtureDir, "tree", ".env"), "TOPSECRET=do-not-read\n", "utf8");
  await writeFile(join(fixtureDir, "tree", "workers.env"), "TOKEN=do-not-read\n", "utf8");
  await writeFile(join(fixtureDir, "tree", "auth.json"), "{\"token\":\"do-not-read\"}", "utf8");
  await writeFile(join(fixtureDir, "app.db"), "sqlite-format-stub", "utf8");
});

after(async () => {
  await rm(workDir, { force: true, recursive: true });
});

test("happy path: inventory and verify succeed on a well-formed fixture", async () => {
  const manifestPath = await writeManifest(
    manifestPayload([
      fileSource(join(fixtureDir, "config.json")),
      dirSource(join(fixtureDir, "tree")),
      sqliteSource(join(fixtureDir, "app.db")),
    ]),
  );
  const inventory = runCli(["inventory", "--manifest", manifestPath]);
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.match(inventory.stdout, /Hermes 백업 준비 — inventory/);

  const verify = runCli(["verify", "--manifest", manifestPath, "--format", "json"]);
  assert.equal(verify.status, 0, verify.stderr);
  const result = JSON.parse(verify.stdout);
  assert.equal(result.kind, "hermes-backup-readiness");
  assert.equal(result.mode, "verify");
  assert.equal(result.readOnly, true);
  assert.equal(result.summary.status, "ok");
  assert.equal(result.sources.length, 3);
  const fileResult = result.sources.find((source) => source.id === "a-file");
  assert.equal(fileResult.status, "ok");
  assert.match(fileResult.detail.sha256, /^[0-9a-f]{64}$/);
  const sqliteResult = result.sources.find((source) => source.id === "a-sqlite");
  assert.equal(sqliteResult.detail.setState, "at-rest");
  assert.match(sqliteResult.detail.database.sha256, /^[0-9a-f]{64}$/);
  const dirResult = result.sources.find((source) => source.id === "a-dir");
  assert.equal(dirResult.detail.stats.files, 3);
  assert.equal(dirResult.detail.stats.protected, 3);
});

test("identical input produces byte-identical JSON and human output", async () => {
  const manifestPath = await writeManifest(
    manifestPayload([
      fileSource(join(fixtureDir, "config.json")),
      dirSource(join(fixtureDir, "tree"), { hashFiles: true }),
      sqliteSource(join(fixtureDir, "app.db")),
    ]),
    "det.json",
  );
  const first = runCli(["verify", "--manifest", manifestPath, "--format", "json"]);
  const second = runCli(["verify", "--manifest", manifestPath, "--format", "json"]);
  assert.equal(first.status, 0);
  assert.equal(first.stdout, second.stdout);
  const human1 = runCli(["verify", "--manifest", manifestPath]);
  const human2 = runCli(["verify", "--manifest", manifestPath]);
  assert.equal(human1.stdout, human2.stdout);
  // No wall-clock fields in the envelope.
  assert.deepEqual(Object.keys(JSON.parse(first.stdout)).sort(), [
    "kind",
    "manifest",
    "mode",
    "readOnly",
    "schemaVersion",
    "sources",
    "summary",
    "targets",
  ]);
});

test("missing, stale, and incomplete sqlite sets are reported honestly", async () => {
  // missing required db
  let manifestPath = await writeManifest(
    manifestPayload([sqliteSource(join(fixtureDir, "absent.db"))]),
    "sq-missing.json",
  );
  let run = runCli(["verify", "--manifest", manifestPath, "--format", "json"]);
  assert.equal(run.status, 1);
  let result = JSON.parse(run.stdout);
  assert.equal(result.sources[0].detail.setState, "missing");
  assert.equal(result.sources[0].status, "error");

  // stale: sidecar without its database
  await writeFile(join(fixtureDir, "stale.db-wal"), "wal-bytes", "utf8");
  manifestPath = await writeManifest(
    manifestPayload([sqliteSource(join(fixtureDir, "stale.db"))]),
    "sq-stale.json",
  );
  run = runCli(["verify", "--manifest", manifestPath, "--format", "json"]);
  assert.equal(run.status, 1);
  result = JSON.parse(run.stdout);
  assert.equal(result.sources[0].detail.setState, "stale");
  assert.ok(result.sources[0].findings.some((item) => item.code === "stale_sidecar"));

  // incomplete: db + -wal but no -shm
  await writeFile(join(fixtureDir, "inc.db"), "db", "utf8");
  await writeFile(join(fixtureDir, "inc.db-wal"), "wal", "utf8");
  manifestPath = await writeManifest(
    manifestPayload([sqliteSource(join(fixtureDir, "inc.db"))]),
    "sq-inc.json",
  );
  run = runCli(["verify", "--manifest", manifestPath, "--format", "json"]);
  assert.equal(run.status, 1);
  result = JSON.parse(run.stdout);
  assert.equal(result.sources[0].detail.setState, "incomplete");
  assert.ok(result.sources[0].findings.some((item) => item.code === "incomplete_set"));

  // live: db + -wal + -shm → unverified, never ok
  await writeFile(join(fixtureDir, "inc.db-shm"), "shm", "utf8");
  manifestPath = await writeManifest(
    manifestPayload([sqliteSource(join(fixtureDir, "inc.db"))]),
    "sq-live.json",
  );
  run = runCli(["verify", "--manifest", manifestPath, "--format", "json"]);
  assert.equal(run.status, 1);
  result = JSON.parse(run.stdout);
  assert.equal(result.sources[0].detail.setState, "live");
  assert.equal(result.sources[0].status, "unverified");
  assert.equal(result.summary.status, "unknown");
});

test("optional sqlite missing is informational, not a failure", async () => {
  const manifestPath = await writeManifest(
    manifestPayload([sqliteSource(join(fixtureDir, "gone.db"), { required: false })]),
    "sq-opt.json",
  );
  const run = runCli(["verify", "--manifest", manifestPath, "--format", "json"]);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.sources[0].status, "unknown");
  assert.equal(result.summary.status, "ok");
  const strict = runCli(["verify", "--manifest", manifestPath, "--strict"]);
  assert.equal(strict.status, 1, "warning must fail under --strict");
});

test("symlinked source paths and in-tree symlink escapes fail closed", async () => {
  // source path itself is a symlink → error finding
  const link = join(workDir, "linked-config.json");
  await symlink(join(fixtureDir, "config.json"), link);
  let manifestPath = await writeManifest(manifestPayload([fileSource(link)]), "link-src.json");
  let run = runCli(["inventory", "--manifest", manifestPath, "--format", "json"]);
  assert.equal(run.status, 1);
  let result = JSON.parse(run.stdout);
  assert.ok(result.sources[0].findings.some((item) => item.code === "source_symlink"));

  // in-tree symlink escaping the source root → path_escape error
  const escapeDir = join(fixtureDir, "escape");
  await mkdir(escapeDir, { recursive: true });
  await writeFile(join(escapeDir, "inside.txt"), "ok", "utf8");
  await symlink("/etc/hosts", join(escapeDir, "out-link"));
  manifestPath = await writeManifest(manifestPayload([dirSource(escapeDir)]), "escape.json");
  run = runCli(["inventory", "--manifest", manifestPath, "--format", "json"]);
  assert.equal(run.status, 1);
  result = JSON.parse(run.stdout);
  assert.ok(result.sources[0].findings.some((item) => item.code === "path_escape"));
  const escapeEntry = result.sources[0].detail.entries.find((entry) => entry.path === "out-link");
  assert.equal(escapeEntry.escape, true);

  // in-root symlink → recorded, warning only, not followed
  const insideDir = join(fixtureDir, "inside-links");
  await mkdir(insideDir, { recursive: true });
  await writeFile(join(insideDir, "real.txt"), "real", "utf8");
  await symlink(join(insideDir, "real.txt"), join(insideDir, "in-link"));
  manifestPath = await writeManifest(manifestPayload([dirSource(insideDir)]), "inlink.json");
  run = runCli(["inventory", "--manifest", manifestPath, "--format", "json"]);
  assert.equal(run.status, 0, run.stderr);
  result = JSON.parse(run.stdout);
  const entry = result.sources[0].detail.entries.find((item) => item.path === "in-link");
  assert.equal(entry.state, "inside-root");
  assert.equal(entry.sha256, undefined, "symlinks are never followed or hashed");
});

test("malformed, oversized, symlinked, and missing manifests are rejected", async () => {
  const broken = join(workDir, "broken.json");
  await writeFile(broken, "{ not json ", "utf8");
  await assert.rejects(loadBackupManifest(broken), (error) => error.code === "manifest_parse_error");
  let run = runCli(["inventory", "--manifest", broken]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /manifest_parse_error/);

  const valid = await writeManifest(manifestPayload([fileSource(join(fixtureDir, "config.json"))]), "ok.json");
  await assert.rejects(
    loadBackupManifest(valid, { maxBytes: 8 }),
    (error) => error.code === "manifest_too_large",
  );
  run = runCli(["inventory", "--manifest", valid, "--max-manifest-bytes", "8"]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /manifest_too_large/);

  const link = join(workDir, "linked-manifest.json");
  await symlink(valid, link);
  await assert.rejects(loadBackupManifest(link), (error) => error.code === "manifest_symlink");

  await assert.rejects(
    loadBackupManifest(join(workDir, "absent.json")),
    (error) => error.code === "manifest_unreadable",
  );

  run = runCli(["inventory", "--manifest", join(workDir, "a-directory")]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /manifest_unreadable|manifest_not_regular/);
});

test("unknown fields and wrong-type keys are schema violations", async () => {
  const extraTop = manifestPayload([fileSource("/tmp/x")], { bogus: true });
  assert.ok(validateBackupManifest(extraTop).some((issue) => issue.includes("unknown field 'bogus'")));

  const wrongTypeKey = manifestPayload([fileSource("/tmp/x", { exclude: ["a"] })]);
  assert.ok(validateBackupManifest(wrongTypeKey).some((issue) => issue.includes("unknown field 'exclude'")));

  const badVersion = manifestPayload([fileSource("/tmp/x")], { schemaVersion: 2 });
  assert.ok(validateBackupManifest(badVersion).some((issue) => issue.includes("schemaVersion")));

  const badKind = manifestPayload([fileSource("/tmp/x")], { kind: "other" });
  assert.ok(validateBackupManifest(badKind).some((issue) => issue.includes("kind")));

  const relativePath = manifestPayload([fileSource("relative/path.txt")]);
  assert.ok(validateBackupManifest(relativePath).some((issue) => issue.includes("absolute")));

  const file = await writeManifest(manifestPayload([fileSource("/tmp/x")], { extra: 1 }), "unknown.json");
  const run = runCli(["inventory", "--manifest", file]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /schema_mismatch/);
});

test("duplicate ids across sources, targets, and adapters are rejected", () => {
  const dupSources = manifestPayload([
    fileSource("/tmp/x"),
    dirSource("/tmp/y", { id: "a-file" }),
  ]);
  assert.ok(validateBackupManifest(dupSources).some((issue) => issue.includes("duplicate id 'a-file'")));

  const dupTargets = manifestPayload([fileSource("/tmp/x")], {
    targets: [
      { id: "t", type: "directory", location: "/a", notes: "n" },
      { id: "t", type: "directory", location: "/b", notes: "n" },
    ],
  });
  assert.ok(validateBackupManifest(dupTargets).some((issue) => issue.includes("duplicate id 't'")));
});

test("expect hash metadata is validated and mismatches fail closed", async () => {
  // invalid hash metadata → schema violation
  const badHash = manifestPayload([
    fileSource(join(fixtureDir, "config.json"), { expect: { sha256: "xyz" } }),
  ]);
  assert.ok(validateBackupManifest(badHash).some((issue) => issue.includes("sha256")));
  const badFile = await writeManifest(badHash, "badhash.json");
  const badRun = runCli(["verify", "--manifest", badFile]);
  assert.equal(badRun.status, 2);
  assert.match(badRun.stderr, /schema_mismatch/);

  // wrong but well-formed pin → hash_mismatch finding, exit 1
  const mismatch = manifestPayload([
    fileSource(join(fixtureDir, "config.json"), { expect: { sha256: "b".repeat(64) } }),
  ]);
  const mismatchFile = await writeManifest(mismatch, "mismatch.json");
  const run = runCli(["verify", "--manifest", mismatchFile, "--format", "json"]);
  assert.equal(run.status, 1);
  const result = JSON.parse(run.stdout);
  assert.ok(result.sources[0].findings.some((item) => item.code === "hash_mismatch"));
  assert.equal(result.sources[0].status, "error");

  // bytes pin mismatch → error too
  const badBytes = manifestPayload([
    fileSource(join(fixtureDir, "config.json"), { expect: { bytes: 999999 } }),
  ]);
  const bytesFile = await writeManifest(badBytes, "badbytes.json");
  const bytesRun = runCli(["verify", "--manifest", bytesFile, "--format", "json"]);
  assert.equal(bytesRun.status, 1);
  assert.ok(JSON.parse(bytesRun.stdout).sources[0].findings.some((item) => item.code === "expect_bytes_mismatch"));

  // correct pins verify cleanly
  const { manifest } = await loadBackupManifest(
    await writeManifest(manifestPayload([fileSource(join(fixtureDir, "config.json"))]), "pin-src.json"),
  );
  const scanned = await scanManifest(manifest, { verify: true });
  const sha = scanned.sources[0].detail.sha256;
  const size = scanned.sources[0].detail.bytes;
  const pinned = manifestPayload([
    fileSource(join(fixtureDir, "config.json"), { expect: { sha256: sha, bytes: size } }),
  ]);
  const pinnedFile = await writeManifest(pinned, "pinned.json");
  const okRun = runCli(["verify", "--manifest", pinnedFile, "--format", "json"]);
  assert.equal(okRun.status, 0, okRun.stderr);
  assert.equal(JSON.parse(okRun.stdout).sources[0].detail.verified, true);
});

test("secret paths and names are never read, traversed, or hashed", async () => {
  // a manifest pointing directly at a protected name is rejected at load
  const envManifest = manifestPayload([fileSource(join(fixtureDir, "tree", ".env"))]);
  const envFile = await writeManifest(envManifest, "env.json");
  await assert.rejects(loadBackupManifest(envFile), (error) => error.code === "secret_path");
  const envRun = runCli(["verify", "--manifest", envFile]);
  assert.equal(envRun.status, 2);
  assert.match(envRun.stderr, /secret_path/);

  // protected names inside a directory are skipped, never hashed or read
  const { manifest } = await loadBackupManifest(
    await writeManifest(
      manifestPayload([dirSource(join(fixtureDir, "tree"), { hashFiles: true })]),
      "prot.json",
    ),
  );
  const scanned = await scanManifest(manifest, { verify: true });
  const dirResult = scanned.sources[0];
  const protectedEntries = dirResult.detail.entries.filter((entry) => entry.kind === "protected");
  assert.deepEqual(
    protectedEntries.map((entry) => entry.path).sort(),
    [".env", "auth.json", "workers.env"],
  );
  for (const entry of protectedEntries) {
    assert.equal(entry.sha256, undefined);
    assert.equal(entry.bytes, undefined, "protected entries are not even statted");
  }
  // every hashed entry is a non-protected regular file
  for (const entry of dirResult.detail.entries) {
    if (entry.sha256) assert.equal(isProtectedName(entry.path), false);
  }

  // human output never carries file contents
  const human = runCli(["verify", "--manifest", join(workDir, "prot.json")]);
  assert.equal(human.stdout.includes("do-not-read"), false);
  assert.equal(human.stdout.includes("TOPSECRET"), false);
});

test("protected-name matching covers the required secret set", () => {
  for (const name of [
    ".env",
    ".env.local",
    "workers.env",
    "app.env",
    ".dev.vars",
    "auth.json",
    "credentials",
    "credentials.json",
    "token.json",
    "api-token",
    "cookies.sqlite",
    "login.keychain-db",
    "my.keychain",
    "id_rsa",
    "id_ed25519.pub",
    "server.pem",
    "client.key",
    "bundle.p12",
    "cert.pfx",
    "passwords.txt",
    "db-secret.yaml",
    ".netrc",
    ".ssh",
  ]) {
    assert.equal(isProtectedName(name), true, `${name} must be protected`);
  }
  for (const name of [".env.example", ".env.sample", "config.json", "readme.md", "platform.db", "notes.txt"]) {
    assert.equal(isProtectedName(name), false, `${name} must not be protected`);
  }
  assert.equal(hasProtectedSegment("/Users/x/.ssh/config"), true);
  assert.equal(hasProtectedSegment("/Users/x/docs/notes.txt"), false);
});

test("unexpected path types and bound overflows are errors", async () => {
  // file source pointing at a directory
  let manifestPath = await writeManifest(
    manifestPayload([fileSource(join(fixtureDir, "tree"))]),
    "type1.json",
  );
  let run = runCli(["inventory", "--manifest", manifestPath, "--format", "json"]);
  assert.equal(run.status, 1);
  assert.ok(JSON.parse(run.stdout).sources[0].findings.some((item) => item.code === "unexpected_type"));

  // directory source pointing at a regular file
  manifestPath = await writeManifest(
    manifestPayload([dirSource(join(fixtureDir, "config.json"))]),
    "type2.json",
  );
  run = runCli(["inventory", "--manifest", manifestPath, "--format", "json"]);
  assert.equal(run.status, 1);
  assert.ok(JSON.parse(run.stdout).sources[0].findings.some((item) => item.code === "unexpected_type"));

  // bounded entry count
  manifestPath = await writeManifest(
    manifestPayload([dirSource(join(fixtureDir, "tree"), { maxEntries: 2 })]),
    "bound.json",
  );
  run = runCli(["inventory", "--manifest", manifestPath, "--format", "json"]);
  assert.equal(run.status, 1);
  assert.ok(JSON.parse(run.stdout).sources[0].findings.some((item) => item.code === "bounds_exceeded"));
});

test("restore-plan emits operator instructions only and changes nothing", async () => {
  const snapshotBefore = await readdir(fixtureDir, { recursive: true });
  const dbBefore = await readFile(join(fixtureDir, "app.db"), "utf8");
  const manifestPath = await writeManifest(
    manifestPayload(
      [
        fileSource(join(fixtureDir, "config.json")),
        dirSource(join(fixtureDir, "tree")),
        sqliteSource(join(fixtureDir, "app.db")),
      ],
      {
        targets: [
          { id: "tm", type: "time-machine", location: "/Volumes/X", notes: "usb disk" },
        ],
      },
    ),
    "plan.json",
  );
  const run = runCli(["restore-plan", "--manifest", manifestPath, "--format", "json"]);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.mode, "restore-plan");
  assert.equal(result.plan.readOnly, true);
  assert.deepEqual(
    result.plan.phases.map((phase) => phase.id),
    ["preflight", "quiesce", "restore", "verify", "resume"],
  );
  const sqliteSteps = result.plan.phases
    .find((phase) => phase.id === "restore")
    .steps.find((step) => step.includes("a-sqlite"));
  assert.match(sqliteSteps, /-wal/);
  assert.match(sqliteSteps, /세트|set/i);
  const quiesce = result.plan.phases.find((phase) => phase.id === "quiesce");
  assert.ok(quiesce.steps.some((step) => step.includes("online-backup")));

  const human = runCli(["restore-plan", "--manifest", manifestPath]);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /운영자/);

  // deterministic: identical plan twice, and the fixture is untouched
  const second = runCli(["restore-plan", "--manifest", manifestPath, "--format", "json"]);
  assert.equal(second.stdout, run.stdout);
  assert.deepEqual(await readdir(fixtureDir, { recursive: true }), snapshotBefore);
  assert.equal(await readFile(join(fixtureDir, "app.db"), "utf8"), dbBefore);
});

test("adapters report honest available/unavailable/unknown states", async () => {
  const manifest = {
    sources: [],
    targets: [],
    adapters: [
      { id: "tm", type: "time-machine", enabled: true },
      { id: "mirror", type: "launchd", job: "com.hyphen.project-mirror-backups", enabled: true },
      { id: "path-ok", type: "path", path: fixtureDir, enabled: true },
      { id: "path-gone", type: "path", path: join(fixtureDir, "nope"), enabled: true },
      { id: "off", type: "time-machine", enabled: false },
    ],
  };
  const tmOut = "====================================================\nName          : My Passport\nKind          : Local\nMount Point   : /Volumes/My Passport 1\nID            : AE42361B-8D83-4617-B919-059ACFCFADFD\n";
  const launchctlOut = "1151\t0\tcom.hyphen.cloudflared.mac-ai\n-\t0\tcom.hyphen.project-mirror-backups\n";
  const run = async (command) => {
    if (command === "tmutil") return { ok: true, code: 0, stdout: tmOut, stderr: "" };
    if (command === "launchctl") return { ok: true, code: 0, stdout: launchctlOut, stderr: "" };
    return { ok: false, code: "ENOENT", stdout: "", stderr: "" };
  };
  const results = await collectAdapters(manifest, { run });
  const byId = new Map(results.map((item) => [item.id, item]));
  assert.equal(byId.get("tm").status, "available");
  assert.equal(byId.get("tm").destinations[0].name, "My Passport");
  assert.equal(byId.get("mirror").status, "available");
  assert.equal(byId.get("mirror").pid, null);
  assert.equal(byId.get("path-ok").status, "available");
  assert.equal(byId.get("path-gone").status, "unknown");
  assert.equal(byId.get("off").status, "disabled");

  const failing = await collectAdapters(
    { sources: [], targets: [], adapters: [{ id: "tm", type: "time-machine", enabled: true }] },
    { run: async () => ({ ok: false, code: "ENOENT", stdout: "", stderr: "" }) },
  );
  assert.equal(failing[0].status, "unavailable");

  const missingJob = await collectAdapters(
    { sources: [], targets: [], adapters: [{ id: "j", type: "launchd", job: "com.absent.job", enabled: true }] },
    { run },
  );
  assert.equal(missingJob[0].status, "unknown");
  assert.match(missingJob[0].reason, /not loaded/);
});

test("missing required file/directory sources are errors; missing mode or args exit 2", async () => {
  const manifestPath = await writeManifest(
    manifestPayload([fileSource(join(fixtureDir, "absent.txt")), dirSource(join(fixtureDir, "absent-dir"), { required: false })]),
    "missing.json",
  );
  const run = runCli(["inventory", "--manifest", manifestPath, "--format", "json"]);
  assert.equal(run.status, 1);
  const result = JSON.parse(run.stdout);
  assert.equal(result.sources[0].status, "error");
  assert.equal(result.sources[1].status, "unknown");

  for (const args of [[], ["bogus-mode"], ["inventory", "--manifest"], ["inventory", "--format", "yaml"]]) {
    const bad = runCli(args);
    assert.equal(bad.status, 2, `expected exit 2 for: ${args.join(" ")}`);
  }
});

test("the shipped repo manifest validates and scans on this machine", async () => {
  const shipped = join(repoRoot, "hermes-backup-manifest.json");
  const { manifest } = await loadBackupManifest(shipped);
  assert.equal(manifest.manifestId, "mac-studio-ops-boundary");
  const result = await scanManifest(manifest, { verify: false });
  assert.equal(result.sources.length, manifest.sources.length);
  for (const source of result.sources) {
    assert.ok(["ok", "unknown", "unverified", "error"].includes(source.status));
  }
  const plan = runCli(["restore-plan", "--manifest", shipped]);
  assert.equal(plan.status, 0, plan.stderr);
});
