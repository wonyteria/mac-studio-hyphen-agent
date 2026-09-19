#!/usr/bin/env node
import {
  DEFAULT_MAX_MANIFEST_BYTES,
  buildRestorePlan,
  collectAdapters,
  execFileRunner,
  loadBackupManifest,
  renderHuman,
  resolveManifestPath,
  scanManifest,
} from "./hermes-backup-manifest.mjs";

const usage = `Hermes 백업 준비 도구 (읽기 전용)

Mac Studio 운영 경계의 백업 매니페스트를 소비해 dry-run 산출물만 만든다.
이 도구는 백업을 생성·복사·이동·삭제·복원·마운트·스케줄하지 않고, 어떤
파일이나 서비스도 변경하지 않는다. restore-plan은 운영자 지시문이며
--apply 경로는 존재하지 않는다.

사용법:
  node scripts/hermes-backup-readiness.mjs <모드> [옵션]

모드:
  inventory       선언된 source/target의 메타데이터 인벤토리 (해시 없음)
  verify          inventory + 허용된 파일의 sha256/expect 검증 + sqlite 세트 상태
  restore-plan    매니페스트 기반 복원 지시문 (파일시스템 접근 없음)

옵션:
  --manifest <path>        읽을 매니페스트 (기본: HERMES_BACKUP_MANIFEST,
                           없으면 저장소의 hermes-backup-manifest.json)
  --format <fmt>           human(기본) | json
  --adapters               선택적 읽기 전용 상태 어댑터 실행
                           (tmutil destinationinfo, launchctl list, 경로 stat)
  --max-manifest-bytes <n> 매니페스트 최대 크기 (기본: ${DEFAULT_MAX_MANIFEST_BYTES})
  --strict                 warning도 실패로 처리
  --help                   이 도움말

종료 코드:
  0  완료 — 모든 required source가 ok
  1  error finding 존재, 또는 required source가 unknown/unverified,
     또는 --strict에서 warning 존재
  2  인자 오류 또는 매니페스트 거부 (읽기 실패, symlink, 크기 초과,
     JSON 파싱 실패, schema mismatch, 중복 id, 알 수 없는 필드,
     잘못된 해시 메타데이터, 보호/시크릿 경로)

unknown/unverified는 절대 백업 성공으로 보고하지 않는다.
.env·workers.env·credentials·tokens·cookies·keychains·개인키 등 보호
이름은 어떤 모드에서도 읽거나 순회하지 않으며, 파일 내용은 출력하지 않는다.
`;

const MODES = new Set(["inventory", "verify", "restore-plan"]);

function parseArgs(argv) {
  const options = { format: "human" };
  const takeValue = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("-")) {
      throw new Error(`${flag} 옵션에는 값이 필요합니다.`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--manifest") options.manifest = takeValue(arg, index++);
    else if (arg === "--format") options.format = takeValue(arg, index++);
    else if (arg === "--max-manifest-bytes") options.maxManifestBytes = Number(takeValue(arg, index++));
    else if (arg === "--adapters") options.adapters = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg.startsWith("-")) throw new Error(`알 수 없는 옵션입니다: ${arg}`);
    else if (options.mode === undefined) options.mode = arg;
    else throw new Error(`알 수 없는 인자입니다: ${arg}`);
  }
  if (!options.help) {
    if (options.mode === undefined) throw new Error("모드가 필요합니다: inventory | verify | restore-plan");
    if (!MODES.has(options.mode)) throw new Error(`알 수 없는 모드입니다: ${options.mode}`);
  }
  if (!["human", "json"].includes(options.format)) {
    throw new Error(`--format은 human 또는 json이어야 합니다: ${options.format}`);
  }
  if (
    options.maxManifestBytes !== undefined &&
    (!Number.isInteger(options.maxManifestBytes) || options.maxManifestBytes <= 0)
  ) {
    throw new Error("--max-manifest-bytes는 양의 정수여야 합니다.");
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

  const manifestPath = resolveManifestPath({ arg: options.manifest });
  let manifest;
  try {
    ({ manifest } = await loadBackupManifest(manifestPath, { maxBytes: options.maxManifestBytes }));
  } catch (error) {
    // Fail closed: report the code and the offending path only. Manifest
    // values and secrets never reach the log.
    console.error(`백업 매니페스트를 거부했습니다 [${error?.code || "error"}]: ${manifestPath}`);
    console.error(error instanceof Error ? error.message : String(error));
    if (Array.isArray(error?.issues)) {
      for (const issue of error.issues.slice(0, 20)) {
        console.error(`  - ${issue}`);
      }
      if (error.issues.length > 20) {
        console.error(`  - ... ${error.issues.length - 20}건 생략`);
      }
    }
    process.exitCode = 2;
    return;
  }

  const result = {
    kind: "hermes-backup-readiness",
    schemaVersion: 1,
    mode: options.mode,
    readOnly: true,
    manifest: {
      path: manifestPath,
      manifestId: manifest.manifestId,
      schemaVersion: manifest.schemaVersion,
      updatedAt: manifest.updatedAt,
      sourceCount: manifest.sources.length,
      targetCount: manifest.targets.length,
    },
  };

  if (options.mode === "restore-plan") {
    result.plan = buildRestorePlan(manifest);
  } else {
    const { sources, targets, summary } = await scanManifest(manifest, {
      verify: options.mode === "verify",
    });
    result.sources = sources;
    result.targets = targets;
    result.summary = summary;
  }
  if (options.adapters) {
    result.adapters = await collectAdapters(manifest, { run: execFileRunner() });
  }

  if (options.format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    process.stdout.write(renderHuman(result));
  }

  if (options.mode === "restore-plan") return;
  const failed =
    result.summary.errors > 0 ||
    result.summary.status === "error" ||
    result.summary.status === "unknown" ||
    (options.strict && result.summary.warnings > 0);
  if (failed) process.exitCode = 1;
}

void main();
