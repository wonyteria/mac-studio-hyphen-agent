#!/usr/bin/env node
import {
  DEFAULT_ACCURACY_FLOOR,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_MAX_CORPUS_BYTES,
  buildEvalReport,
  createDeterministicBaselineAdapter,
  createFixtureProbabilityAdapter,
  createJevAdapter,
  createOfflineTransport,
  defaultCorpusPath,
  evaluateAdapter,
  loadEvalCorpus,
  renderEvalMarkdown,
} from "./hermes-system1.mjs";

const usage = `Hermes System 1 오프라인 평가 (읽기 전용)

버전된 eval corpus를 소비해 사용 가능한 오프라인 provider adapter를 비교한다.
이 도구는 외부 API를 호출하지 않고, 어떤 시스템 상태도 변경하지 않으며,
실제 Jev 통합을 주장하지 않는다. Jev adapter는 주입 가능한 transport 계약만
검증하는 contract probe다.

사용법:
  node scripts/hermes-system1-eval.mjs [옵션]

옵션:
  --corpus <path>          읽을 eval corpus (기본: HERMES_SYSTEM1_CORPUS,
                           없으면 저장소의 eval/system1-corpus.json)
  --format <fmt>           markdown(기본) | json
  --adapters <csv>         평가할 adapter: baseline | fixture | jev-offline | all
                           (기본: all — jev-offline은 contract probe로만 보고)
  --threshold <0..1>       confidence abstain 임계값 (기본: ${DEFAULT_CONFIDENCE_THRESHOLD})
  --accuracy-floor <0..1>  adoption gate의 최소 accuracy (기본: ${DEFAULT_ACCURACY_FLOOR})
  --max-corpus-bytes <n>   corpus 최대 크기 (기본: ${DEFAULT_MAX_CORPUS_BYTES})
  --help                   이 도움말

종료 코드:
  0  리포트 생성 + 게이트 평가 대상 모든 adapter가 adoption gate 통과
  1  리포트는 생성됐지만 하나 이상의 adapter가 adoption gate 실패
     (false-auto가 protected case에서 0이 아닌 경우 포함)
  2  인자 오류 또는 corpus 거부 (읽기 실패, symlink, 크기 초과,
     JSON 파싱 실패, schema mismatch)

실패 시 어떤 경우에도 corpus 본문이나 요청 텍스트를 출력하지 않는다.
`;

const ADAPTER_NAMES = new Set(["baseline", "fixture", "jev-offline", "all"]);

function parseArgs(argv) {
  const options = { format: "markdown", adapters: "all" };
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
    else if (arg === "--corpus") options.corpus = takeValue(arg, index++);
    else if (arg === "--format") options.format = takeValue(arg, index++);
    else if (arg === "--adapters") options.adapters = takeValue(arg, index++);
    else if (arg === "--threshold") options.threshold = Number(takeValue(arg, index++));
    else if (arg === "--accuracy-floor") options.accuracyFloor = Number(takeValue(arg, index++));
    else if (arg === "--max-corpus-bytes") options.maxCorpusBytes = Number(takeValue(arg, index++));
    else throw new Error(`알 수 없는 옵션입니다: ${arg}`);
  }
  if (!["markdown", "json"].includes(options.format)) {
    throw new Error(`--format은 markdown 또는 json이어야 합니다: ${options.format}`);
  }
  for (const name of options.adapters.split(",")) {
    if (!ADAPTER_NAMES.has(name.trim())) {
      throw new Error(`알 수 없는 adapter입니다: ${name}`);
    }
  }
  for (const [flag, value] of [["--threshold", options.threshold], ["--accuracy-floor", options.accuracyFloor]]) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error(`${flag}는 0과 1 사이의 숫자여야 합니다.`);
    }
  }
  if (options.maxCorpusBytes !== undefined && (!Number.isInteger(options.maxCorpusBytes) || options.maxCorpusBytes <= 0)) {
    throw new Error("--max-corpus-bytes는 양의 정수여야 합니다.");
  }
  return options;
}

function selectAdapters(corpus, selection) {
  const fixtures = new Map();
  for (const entry of corpus.cases) {
    if (entry.mockProvider && typeof entry.mockProvider === "object") {
      fixtures.set(entry.id, entry.mockProvider);
    }
  }
  const requested = selection === "all"
    ? ["baseline", "fixture", "jev-offline"]
    : selection.split(",").map((name) => name.trim()).filter((name) => name !== "all");
  const adapters = [];
  for (const name of requested) {
    if (name === "baseline") adapters.push(createDeterministicBaselineAdapter());
    else if (name === "fixture") adapters.push(createFixtureProbabilityAdapter(fixtures));
    else if (name === "jev-offline") adapters.push(createJevAdapter({ transport: createOfflineTransport() }));
  }
  return adapters;
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

  const corpusPath = options.corpus || process.env.HERMES_SYSTEM1_CORPUS || defaultCorpusPath();
  let loaded;
  try {
    loaded = await loadEvalCorpus(corpusPath, { maxBytes: options.maxCorpusBytes });
  } catch (error) {
    // Fail closed: 코드와 경로만 보고하고 corpus 내용·값은 출력하지 않는다.
    console.error(`평가 corpus 입력을 거부했습니다 [${error?.code || "error"}]: ${corpusPath}`);
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

  const threshold = options.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const accuracyFloor = options.accuracyFloor ?? DEFAULT_ACCURACY_FLOOR;
  const adapters = selectAdapters(loaded.corpus, options.adapters);
  const adapterReports = [];
  for (const adapter of adapters) {
    adapterReports.push(await evaluateAdapter(loaded.corpus, adapter, { threshold, accuracyFloor }));
  }
  const report = buildEvalReport(loaded.corpus, loaded.corpusHash, adapterReports, { threshold, accuracyFloor });

  if (options.format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(renderEvalMarkdown(report));
  }

  const evaluated = adapterReports.filter((entry) => entry.adoption.gatesEvaluated);
  const allPass = evaluated.length > 0 && evaluated.every((entry) =>
    entry.adoption.gates.every((gate) => gate.pass),
  );
  if (!allPass) process.exitCode = 1;
}

void main();
