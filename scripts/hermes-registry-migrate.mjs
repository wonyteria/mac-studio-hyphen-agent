#!/usr/bin/env node
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  applyRegistryEdits,
  defaultRegistryPath,
  planMigration,
  repoSearchRoots,
} from "./hermes-project-registry.mjs";

const usage = `Hermes 프로젝트 레지스트리 이관 도구

기본은 dry-run입니다. 파일을 변경하지 않고 이관 계획만 출력합니다.
실제 변경은 --apply가 필요하며, 교체 전 백업을 만들고 임시 파일+rename으로 원자적으로 교체합니다.

사용법:
  node scripts/hermes-registry-migrate.mjs [옵션]

옵션:
  --registry <path>    이관할 hermes-projects.json (기본: preflight와 동일한 탐색 순서)
  --roots <a:b:c>      canonical 저장소 검색 루트 (기본: HERMES_REPO_ROOTS 또는 표준 위치)
  --apply              실제 파일 변경 (없으면 dry-run)
  --backup-dir <path>  백업 디렉터리 (기본: 레지스트리와 같은 디렉터리)
  --json               계획/결과를 JSON으로 출력
  --help               이 도움말

이관 규칙:
  - repo가 legacy/끊어진 링크/존재하지 않는 경로이면 github URL이 일치하는
    로컬 저장소 하나를 검색 루트에서 찾아 repo를 그 경로로 바꿉니다.
  - 후보가 0개 또는 2개 이상이면 해당 항목은 건너뛰고 수동 등록을 요구합니다.
  - gitRemote가 해결된 저장소에 없고 github URL과 일치하는 다른 리모트가 있으면
    gitRemote를 그 이름으로 바꿉니다.
  - repo 필드가 없는 프로젝트와 이미 유효한 경로는 변경하지 않습니다.

종료 코드:
  0  dry-run 완료 또는 apply 성공/변경 없음
  1  apply 후에도 미해결 항목이 남음
  2  레지스트리 읽기/쓰기 실패 또는 인자 오류 (원본 보존)
`;

function parseArgs(argv) {
  const options = { apply: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--registry") options.registry = argv[++index];
    else if (arg === "--roots") options.roots = argv[++index]?.split(":").filter(Boolean);
    else if (arg === "--backup-dir") options.backupDir = argv[++index];
    else throw new Error(`알 수 없는 옵션입니다: ${arg}`);
  }
  return options;
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function writeAtomic(filePath, contents) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, filePath);
}

function printPlan(plan, registryPath, apply) {
  console.log(`레지스트리: ${registryPath}`);
  console.log(`모드: ${apply ? "apply (백업 후 원자적 교체)" : "dry-run (파일 변경 없음)"}`);
  console.log("");
  if (!plan.changes.length && !plan.skipped.length) {
    console.log("변경이 필요한 항목이 없습니다.");
    return;
  }
  for (const change of plan.changes) {
    console.log(`[변경] ${change.projectId}: ${change.field}`);
    console.log(`    ${change.from || "(없음)"} -> ${change.to}`);
    console.log(`    이유: ${change.reason}`);
  }
  for (const item of plan.skipped) {
    console.log(`[건너뜀] ${item.projectId}: ${item.declared}`);
    console.log(`    ${item.status}`);
  }
  console.log("");
  console.log(`계획: 변경 ${plan.changes.length}건, 수동 처리 필요 ${plan.skipped.length}건`);
  if (!apply && plan.changes.length) {
    console.log("실제 적용하려면 --apply를 추가해 다시 실행하세요.");
  }
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

  const registryPath = resolve(options.registry || (await defaultRegistryPath()));
  let raw;
  try {
    raw = await readFile(registryPath, "utf8");
  } catch (error) {
    console.error(`레지스트리를 읽지 못했습니다: ${registryPath}`);
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
    return;
  }
  let projects;
  try {
    const parsed = JSON.parse(raw);
    projects = Array.isArray(parsed.projects) ? parsed.projects : null;
    if (!projects) throw new Error("projects 배열이 없습니다.");
  } catch (error) {
    console.error(`레지스트리 JSON이 유효하지 않아 변경하지 않았습니다: ${registryPath}`);
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
    return;
  }

  const roots = options.roots || repoSearchRoots();
  const plan = await planMigration(projects, { roots });

  if (!options.apply) {
    if (options.json) {
      console.log(JSON.stringify({ registry: registryPath, mode: "dry-run", ...plan }, null, 2));
    } else {
      printPlan(plan, registryPath, false);
    }
    return;
  }

  if (!plan.changes.length) {
    if (options.json) {
      console.log(JSON.stringify({ registry: registryPath, mode: "apply", applied: false, ...plan }, null, 2));
    } else {
      printPlan(plan, registryPath, true);
      console.log("적용할 변경이 없어 파일을 그대로 둡니다.");
    }
    process.exitCode = plan.skipped.length ? 1 : 0;
    return;
  }

  let next;
  try {
    next = applyRegistryEdits(raw, plan.changes);
    const verify = JSON.parse(next);
    if (!Array.isArray(verify.projects) || verify.projects.length !== projects.length) {
      throw new Error("이관 결과 JSON 구조가 원본과 다릅니다.");
    }
  } catch (error) {
    console.error("이관 결과 생성에 실패해 원본을 변경하지 않았습니다.");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
    return;
  }

  const backupDir = options.backupDir || dirname(registryPath);
  const backupPath = resolve(backupDir, `hermes-projects.json.backup-${stamp()}`);
  try {
    await mkdir(backupDir, { recursive: true });
    await copyFile(registryPath, backupPath);
    await writeAtomic(registryPath, next);
    const written = JSON.parse(await readFile(registryPath, "utf8"));
    if (!Array.isArray(written.projects)) throw new Error("교체된 파일이 유효한 레지스트리가 아닙니다.");
  } catch (error) {
    console.error("적용에 실패했습니다. 원본 복구를 시도합니다.");
    try {
      await copyFile(backupPath, registryPath);
      console.error(`백업에서 원본을 복구했습니다: ${backupPath}`);
    } catch (restoreError) {
      console.error(`원본 복구 실패: ${restoreError.message}`);
      console.error(`백업 위치: ${backupPath}`);
    }
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
    return;
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        { registry: registryPath, mode: "apply", applied: true, backup: backupPath, ...plan },
        null,
        2,
      ),
    );
  } else {
    printPlan(plan, registryPath, true);
    console.log(`백업: ${backupPath}`);
    console.log(`적용 완료: ${plan.changes.length}건 변경, 원자적으로 교체했습니다.`);
    console.log("검증: node scripts/hermes-registry-preflight.mjs --registry", registryPath);
  }
  process.exitCode = plan.skipped.length ? 1 : 0;
}

void main();
