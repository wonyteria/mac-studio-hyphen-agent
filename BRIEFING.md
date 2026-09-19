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
2. **Mini-server** — `mini-server.mjs` imports `scripts/hermes-business-registry.mjs` (shipped in the Docker image) and generates the `priorities`/`blockers`/`overview` views synchronously for the `studio_priorities`/`studio_blockers`/`studio_overview` request types. `overview` renders all five Korean sections — 오늘의 상위 우선순위, 막힌 일, 매출·고객 신호, 시스템 이상, 소유자 승인이 필요한 일 — each capped at five items and a deterministic per-section character budget, with registry-derived fields flattened to single lines and character-capped so all headers and the coverage line always fit inside the 4000-char result. The result stored on the request is a bounded Korean owner-facing rendering — project names, Korean summaries, blocker descriptions, verification flags, coverage counts, a generic source label, and `updatedAt` — never the raw briefing object, evidence refs, owner names, paths, loader messages, or any source-hash material. On failure only a bounded allowlisted error code is persisted internally; the owner-facing state stays generic.
3. **Evidence audit (갱신 점검)** — `buildEvidenceAudit` in the same module produces a deterministic review checklist: for each hyphen-core project it enumerates fields still carrying explicit unset markers (`status`/`lifecycle`/`businessType` = `unknown`, `owner`/`revenue` = `null`, `evidenceStatus` ≠ `verified`, empty `repositories`/`deploys`/`dataStores`/`kpis`) and folds pending `nextEvidence` asks into the item's actions. Priority is a fixed rule — `high` when evidenceStatus is `unknown`/`insufficient`, `medium` when `partial` or asks remain, `low` otherwise — then missing-field count, pending count, and id ascending; identical input always yields identical output. The audit document carries only allowlisted fields (`projectId`/`projectName`/`businessGroup`/`priority`/`missingFields`/`actions`/`basis`/`pendingEvidence`, ≤50 items, every string line-flattened and character-capped) — raw registry JSON, evidence refs, local paths, owner names, and repository URLs never cross. It is served synchronously for the `studio_evidence_audit` request type (사업 현황 갱신 점검 preset, same fail-closed unavailable contract) and as `GET /api/business/audit` (`{state: "ok", audit}` or `{state: "unavailable", audit: null}`, admin session only, same auth + loader). It is a checklist only — nothing is written back to the registry and no facts are filled in.

The private Studio export is **never embedded in the image**. The server resolves it only from `HERMES_BUSINESS_REGISTRY` (default `/app/var/business/registry.private.json`; production runs `/app/var/data/business/registry.private.json` inside the persistent data volume). When the file is absent or invalid the request completes as `failed` with a neutral unavailable state, not a fabricated empty briefing. Studio requests never enter the worker queue or the approval path.

## Delivery: automated sync or pinned manual copy

Two supported ways for the export to reach `HERMES_BUSINESS_REGISTRY`:

1. **Automated sync (supported path)** — `scripts/hermes-registry-sync.mjs` runs on the host (one-shot or via the `com.hyphen.hermes-registry-sync` LaunchAgent, `RunAtLoad` + 5-minute interval). On every run it re-validates the Studio export with the same `loadBusinessRegistry` rules (symlink/size/schema/`sourceHash` fail-closed), skips unchanged content, and replaces the destination only via temp + fsync + atomic `rename` at mode `0600` — the last-known-good file survives any failed run. A sibling `registry-sync-status.json` records an allowlisted outcome (`status`, `checkedAt`, `syncedAt`, `registryUpdatedAt`, `projectCount`, `errorCode` — never business content, paths, hashes, or error text), which `GET /api/business/status` turns into the Korean freshness pill (`사업 데이터 최신`/`지연`/`사용 불가`). In this mode `HERMES_BUSINESS_REGISTRY_EXPECTED_HASH` **must stay unset**: every legitimate Studio export changes `sourceHash`, so a static pin would reject every update. The trust anchor is that only the sync tool writes the destination — Hermes still re-validates the file fail-closed on every read, so a corrupted or tampered copy can never produce a briefing.
2. **Pinned manual deploy** — an operator copies a verified export once and sets `HERMES_BUSINESS_REGISTRY_EXPECTED_HASH` to its `sourceHash`. Any later drift fails closed as `source_hash_mismatch`. This mode is for deliberate freeze points, not for continuous freshness; with no sync witness the status pill honestly reports `지연`.

## Future input boundary

The boundary for additional producers is the export document, not this module's internals. A future adapter (e.g. MAKO service state, live deploy status) should emit its own `schemaVersion`ed export, get its own `consumer` string and loader beside `hermes-business-registry.mjs`, and merge upstream of `buildBusinessBriefing` — which stays deterministic and free of I/O.
