import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, relative } from "node:path";

// Guards the production-image boundary: mini-server.mjs resolves its local
// imports at startup, so any module the Dockerfile fails to COPY kills the
// container on boot (the job_cadb633b dead_letter incident). This test walks
// the full transitive local-import graph — static and dynamic — and asserts
// every resolved file is copied into the image.

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const dockerfilePath = join(repoRoot, "Dockerfile");
const entrypoint = join(repoRoot, "mini-server.mjs");

const STATIC_IMPORT = /\bimport\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function localImportsOf(source) {
  const specifiers = new Set();
  for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith("./") || specifier.startsWith("../")) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

async function transitiveLocalImports(entryFile) {
  const visited = new Set();
  const queue = [entryFile];
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, "utf8");
    for (const specifier of localImportsOf(source)) {
      const resolved = normalize(join(dirname(file), specifier));
      if (!visited.has(resolved)) queue.push(resolved);
    }
  }
  return visited;
}

// Parses COPY lines into repo-relative sources. Continuations, --from= and
// --chmod= flags are handled; dest is the last token.
function copiedSources(dockerfile) {
  const logical = dockerfile
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join(" ")
    .replace(/\\\s+/g, " ");
  const sources = [];
  for (const match of logical.matchAll(/\bCOPY\s+(.+?)(?=\s+[A-Z]+\s|$)/g)) {
    const tokens = match[1].trim().split(/\s+/).filter((token) => !token.startsWith("--"));
    if (tokens.length < 2) continue;
    for (const src of tokens.slice(0, -1)) {
      sources.push(normalize(src.replace(/^\.\//, "")));
    }
  }
  return sources;
}

function isCopied(repoRelativePath, sources) {
  return sources.some((source) => {
    if (source === "." || source === repoRelativePath) return true;
    // Directory copies (COPY scripts/ ./scripts/) cover everything beneath.
    const dir = source.endsWith("/") ? source : `${source}/`;
    return repoRelativePath.startsWith(dir);
  });
}

test("every local module mini-server.mjs imports is copied into the image", async () => {
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const sources = copiedSources(dockerfile);
  assert.ok(sources.length > 0, "Dockerfile has no COPY instructions");

  const graph = await transitiveLocalImports(entrypoint);
  assert.ok(graph.size >= 6, `expected the full module graph, got ${graph.size} files`);
  const missing = [...graph]
    .map((file) => relative(repoRoot, file))
    .filter((repoPath) => !isCopied(repoPath, sources))
    .sort();
  assert.deepEqual(missing, [], `modules missing from the Docker image: ${missing.join(", ")}`);
});

test("the image entrypoint and runtime registry are copied", async () => {
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const sources = copiedSources(dockerfile);
  assert.ok(isCopied("mini-server.mjs", sources));
  assert.ok(isCopied("hermes-projects.json", sources));
});

test("every COPY source in the Dockerfile exists in the repo", async () => {
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const sources = copiedSources(dockerfile).filter((source) => source !== ".");
  const missing = [];
  for (const source of sources) {
    await access(join(repoRoot, source)).catch(() => missing.push(source));
  }
  assert.deepEqual(missing, [], `COPY sources not in the repo: ${missing.join(", ")}`);
});
