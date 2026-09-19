#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  defaultRegistryPath,
  repoSearchRoots,
  validateRegistry,
} from "./hermes-project-registry.mjs";

const usage = `Hermes 프로젝트 레지스트리 preflight 검사 (읽기 전용)

사용법:
  node scripts/hermes-registry-preflight.mjs [옵션]

옵션:
  --registry <path>   검사할 hermes-projects.json (기본: HERMES_PROJECT_REGISTRY,
                      ~/.local/share/hermes-ops/hermes-projects.json, 저장소 파일 순)
  --roots <a:b:c>     canonical 저장소 검색 루트 (기본: HERMES_REPO_ROOTS 또는 표준 위치)
  --project <id>      특정 프로젝트만 검사
  --no-git            Git ref/리모트 검사 생략
  --json              결과를 JSON으로 출력
  --strict            warning도 실패로 처리
  --help              이 도움말

종료 코드:
  0  모든 검사 통과 (warning만 있어도 통과, --strict 제외)
  1  error 수준 검사 항목 존재
  2  레지스트리를 읽지 못했거나 인자 오류
`;

function parseArgs(argv) {
  const options = { git: true, json: false, strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--no-git") options.git = false;
    else if (arg === "--registry") options.registry = argv[++index];
    else if (arg === "--roots") options.roots = argv[++index]?.split(":").filter(Boolean);
    else if (arg === "--project") options.project = argv[++index];
    else throw new Error(`알 수 없는 옵션입니다: ${arg}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage);
    return;
  }

  const registryPath = options.registry || (await defaultRegistryPath());
  let projects;
  try {
    const parsed = JSON.parse(await readFile(registryPath, "utf8"));
    projects = Array.isArray(parsed.projects) ? parsed.projects : [];
    if (!projects.length) throw new Error("projects 배열이 비어 있습니다.");
  } catch (error) {
    console.error(`레지스트리를 읽지 못했습니다: ${registryPath}`);
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
    return;
  }

  if (options.project) {
    projects = projects.filter((project) => project.id === options.project);
    if (!projects.length) {
      console.error(`레지스트리에 없는 프로젝트입니다: ${options.project}`);
      process.exitCode = 2;
      return;
    }
  }

  const roots = options.roots || repoSearchRoots();
  const { results, summary } = await validateRegistry(projects, {
    roots,
    checkGit: options.git,
  });

  if (options.json) {
    console.log(JSON.stringify({ registry: registryPath, roots, results, summary }, null, 2));
  } else {
    console.log(`레지스트리: ${registryPath}`);
    console.log(`검색 루트: ${roots.join(", ")}`);
    console.log("");
    for (const result of results) {
      const worst = result.checks.some((check) => check.level === "error")
        ? "ERROR"
        : result.checks.some((check) => check.level === "warning")
          ? "WARN"
          : "OK";
      console.log(`[${worst}] ${result.name} (${result.id || "no-id"})`);
      for (const check of result.checks) {
        if (check.level === "ok") continue;
        console.log(`  ${check.level.toUpperCase()} ${check.code}: ${check.message}`);
        if (check.action) console.log(`    조치: ${check.action}`);
      }
    }
    console.log("");
    console.log(
      `요약: 프로젝트 ${summary.projects}개, error ${summary.errors}건, warning ${summary.warnings}건`,
    );
    if (summary.errors) {
      console.log("실패: error 수준 항목을 해결한 뒤 다시 실행하세요.");
    } else if (summary.warnings) {
      console.log("통과(warning 있음): warning 항목은 다음 변경 전에 확인하세요.");
    } else {
      console.log("통과: 모든 등록 경로와 capability가 유효합니다.");
    }
  }

  if (summary.errors > 0 || (options.strict && summary.warnings > 0)) {
    process.exitCode = 1;
  }
}

void main();
