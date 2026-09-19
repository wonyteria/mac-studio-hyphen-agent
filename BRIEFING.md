# Business Briefing — Studio Registry Consumer

Hermes consumes the Hyphen Studio **business registry** (`outputs/registry.private.json`) to produce a read-only Korean business briefing. This is a different input from `hermes-projects.json`:

- `hermes-projects.json` — the **deployment registry**: where canonical repositories live and which capabilities the worker may execute. Owned by this repo.
- `registry.private.json` — the **Studio business registry export**: business facts Studio verified about each project (status, revenue, KPIs, blockers, evidence). Owned by Hyphen-Studio; Hermes only reads it.

## Input contract

Expected document (fail-closed — any deviation rejects the whole input):

- `schemaVersion: 1`, `scope: "private"`, `consumer: "hermes"`
- `sourceHash`: lowercase sha256 hex of Studio's source registry
- `updatedAt`: ISO date
- `projects`: non-empty array; each project carries `id`, `name`, `organization`, `businessGroup`, `businessType`, `lifecycle`, `status`, `owner`, `revenue`, `repositories`, `deploys`, `dataStores`, `kpis`, `evidence`, `evidenceStatus`, `blockers`, `nextEvidence`

Producer parity is re-validated on the consumer side: enum values, evidence entry shape (`label`/`ref`/`checkedAt`), and the rule that factual claims (`owner`, non-`unknown` status/lifecycle, `kpis`, `revenue`, `evidenceStatus: verified`) require at least one evidence entry. The legacy identity marker is rejected inside any string.

## Input resolution and safety

```bash
node scripts/hermes-business-briefing.mjs                 # markdown to stdout
node scripts/hermes-business-briefing.mjs --format json   # JSON to stdout
npm run briefing                                          # same, via package script
```

Path resolution order: `--registry <path>` → `HERMES_BUSINESS_REGISTRY` → the sibling checkout `../Hyphen-Studio/outputs/registry.private.json` relative to this repo. No account-specific path is the only default.

`loadBusinessRegistry` fails closed (exit 2, no output) on: unreadable paths, **symlinked input files**, non-regular files, inputs over `--max-bytes` (default 1 MiB), malformed JSON, schema mismatches, and `sourceHash` drift against a pinned expectation (`--expect-hash` or `HERMES_BUSINESS_REGISTRY_EXPECTED_HASH`). Errors report codes and field paths only — registry values and secrets never reach stderr.

## Briefing sections

Five sections, in order. Every item carries `projectId`, `projectName`, `basis` (the registry fields that justify it), and `evidence` (`label`/`ref`/`checkedAt` entries copied from the project). Items without evidence entries are marked `verified: false` and rendered as *확인 필요*, never stated as fact. `unknown`/`null` registry values are reported as unverified gaps in `coverage`, never filled with guesses.

1. **오늘의 상위 3개 우선순위** — top 3 hyphen-core projects ranked by explicit grounds only: more `blockers` first → `status` down before degraded → more `nextEvidence` entries → more advanced `lifecycle` → project id ascending (final deterministic tie-break).
2. **막힌 일** — projects with explicit `blockers` entries.
3. **매출·고객 신호** — projects with an explicit `revenue` object or `kpis` entries; amounts, units, sources, and dates are copied verbatim.
4. **시스템 이상** — `status: down`/`degraded` only. Null/absent fields such as `backup: null` mean *unknown/unverified* in this contract, not "missing", and never raise an anomaly on their own.
5. **소유자 승인이 필요한 일** — projects with `blockers` or `nextEvidence`; `owner: null` is shown as *owner 미지정* rather than guessed.

Only `organization === "hyphen"` enters the core briefing. Other organizations (e.g. `29sfilm`) are counted in `coverage.excludedOrganizations` and never itemized. Empty sections render *근거 없음 — 확인 필요* instead of fabricated content.

## Determinism

`buildBusinessBriefing` and `renderBriefingMarkdown` are pure: identical input bytes produce identical JSON and markdown. The only timestamps in the output come from the payload itself (`updatedAt`, `checkedAt`); nothing reads the wall clock.

## Surface: CLI plus bounded mini-server connector

Two surfaces consume this module:

1. **CLI** — `scripts/hermes-business-briefing.mjs` renders the full briefing locally.
2. **Mini-server** — `mini-server.mjs` imports `scripts/hermes-business-registry.mjs` (shipped in the Docker image) and generates the `priorities`/`blockers` views synchronously for the `studio_priorities`/`studio_blockers` request types. The result stored on the request is a bounded Korean owner-facing rendering — project names, Korean summaries, blocker descriptions, verification flags, coverage counts, a generic source label, and `updatedAt` — never the raw briefing object, evidence refs, owner names, paths, loader messages, or any source-hash material. On failure only a bounded allowlisted error code is persisted internally; the owner-facing state stays generic.

The private Studio export is **never embedded in the image**. The server resolves it only from `HERMES_BUSINESS_REGISTRY` (default `/app/var/business/registry.private.json`), with optional `HERMES_BUSINESS_REGISTRY_EXPECTED_HASH` drift pinning. Operators mount the export read-only into the runtime; when the file is absent or invalid the request completes as `failed` with a neutral unavailable state, not a fabricated empty briefing. Studio requests never enter the worker queue or the approval path.

## Future input boundary

The boundary for additional producers is the export document, not this module's internals. A future adapter (e.g. MAKO service state, live deploy status) should emit its own `schemaVersion`ed export, get its own `consumer` string and loader beside `hermes-business-registry.mjs`, and merge upstream of `buildBusinessBriefing` — which stays deterministic and free of I/O.
