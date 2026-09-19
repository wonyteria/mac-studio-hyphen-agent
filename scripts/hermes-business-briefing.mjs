#!/usr/bin/env node
import {
  DEFAULT_MAX_REGISTRY_BYTES,
  SHA256_PATTERN,
  loadBusinessRegistry,
  renderBriefingMarkdown,
  buildBusinessBriefing,
  resolveBusinessRegistryPath,
} from "./hermes-business-registry.mjs";

const usage = `Hyphen Studio 사업 레지스트리 브리핑 (읽기 전용)

Studio private export(outputs/registry.private.json)를 소비해 결정론적인
사업 브리핑을 만든다. 같은 입력이면 항상 같은 출력을 내고, 레지스트리
파일은 절대 수정하지 않는다. hermes-projects.json(배포 레지스트리)과는
별개 입력이다.

사용법:
  node scripts/hermes-business-briefing.mjs [옵션]

옵션:
  --registry <path>     읽을 registry.private.json
                        (기본: HERMES_BUSINESS_REGISTRY, 없으면 sibling
                        체크아웃 ../Hyphen-Studio/outputs/registry.private.json)
  --format <fmt>        markdown(기본) | json
  --expect-hash <sha>   기대 sourceHash 고정값. 다르면 drift로 실패
                        (기본: HERMES_BUSINESS_REGISTRY_EXPECTED_HASH)
  --max-bytes <n>       허용 최대 파일 크기 (기본: ${DEFAULT_MAX_REGISTRY_BYTES})
  --help                이 도움말

종료 코드:
  0  브리핑 생성 성공
  2  인자 오류 또는 입력 거부 (읽기 실패, symlink, 크기 초과,
     JSON 파싱 실패, schema mismatch, sourceHash drift)

실패 시 어떤 경우에도 레지스트리 본문이나 값을 출력하지 않는다.
`;

function parseArgs(argv) {
  const options = { format: "markdown" };
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
    else if (arg === "--registry") options.registry = takeValue(arg, index++);
    else if (arg === "--format") options.format = takeValue(arg, index++);
    else if (arg === "--expect-hash") options.expectHash = takeValue(arg, index++);
    else if (arg === "--max-bytes") options.maxBytes = Number(takeValue(arg, index++));
    else throw new Error(`알 수 없는 옵션입니다: ${arg}`);
  }
  if (!["markdown", "json"].includes(options.format)) {
    throw new Error(`--format은 markdown 또는 json이어야 합니다: ${options.format}`);
  }
  if (options.expectHash !== undefined && !SHA256_PATTERN.test(options.expectHash)) {
    throw new Error("--expect-hash는 소문자 64자리 sha256 hex여야 합니다.");
  }
  if (options.maxBytes !== undefined && (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0)) {
    throw new Error("--max-bytes는 양의 정수여야 합니다.");
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

  const registryPath = resolveBusinessRegistryPath({ arg: options.registry });
  const expectedHash = options.expectHash || process.env.HERMES_BUSINESS_REGISTRY_EXPECTED_HASH || undefined;
  if (expectedHash && !SHA256_PATTERN.test(expectedHash)) {
    console.error("HERMES_BUSINESS_REGISTRY_EXPECTED_HASH는 소문자 64자리 sha256 hex여야 합니다.");
    process.exitCode = 2;
    return;
  }

  let registry;
  try {
    ({ registry } = await loadBusinessRegistry(registryPath, {
      maxBytes: options.maxBytes,
      expectedHash,
    }));
  } catch (error) {
    // Fail closed: report the code and the offending path only. Registry
    // contents, field values, and secrets never reach the log.
    console.error(`브리핑 입력을 거부했습니다 [${error?.code || "error"}]: ${registryPath}`);
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

  const briefing = buildBusinessBriefing(registry);
  if (options.format === "json") {
    console.log(JSON.stringify(briefing, null, 2));
  } else {
    process.stdout.write(renderBriefingMarkdown(briefing));
  }
}

void main();
