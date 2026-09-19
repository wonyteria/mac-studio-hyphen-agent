# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-09-19
- Primary product surfaces: Hyphen Studio (project cockpit, owned separately), the Mac Studio agent workspace at `https://hermes.hyphen.it.com` (`mini-server.mjs`), the local Mac Studio worker, registered deployment projects, Codex development pipeline.
- Evidence reviewed: `mini-server.mjs`, `scripts/hermes-local-worker.mjs`, `scripts/hermes-system1.mjs`, `scripts/hermes-business-registry.mjs`, `hermes-projects.json`, `README.md`, `ARCHITECTURE.md`, `SYSTEM1.md`, `package.json`, current mini deploy Docker state, and the owner's narrow-viewport review of the live site.

## Product model
- Hyphen Studio is the project cockpit where the owner decides direction. This repository is the **Hyphen Studio Agent** — the execution and evidence surface that runs on the Mac Studio.
- The owner chooses a registered project, asks in natural Korean, sees the fast System 1 observation, understands whether approval is needed, follows execution, and inspects the outcome without technical jargon.
- Evidence flow: Studio cockpit (intent) -> agent workspace (request queue + chat) -> System 1 observation (`빠른 판단`, observational only) -> System 2 execution (worker / local LLM / Codex) -> deterministic verification -> result + evidence back in the workspace.
- System 1 never decides execution. Its shadow observation is advisory evidence only; classification, approval gates, and worker dispatch remain deterministic and unchanged.

## Brand
- Name: **Hyphen Studio Agent**, powered by Hermes on Mac Studio.
- Personality: quiet, competent, internal-ops focused, Korean-first.
- Trust signals: truthful connection state, visible request status, active project context, a clearly labeled observation-only `빠른 판단` panel, explicit approval wording that states what will happen before the owner approves.
- Avoid: marketing pages, decorative visuals, opaque automation, fake status indicators, arbitrary destructive shell execution.

## Product goals
- Primary jobs: see the business state in seconds, start a common task in one or two taps, read results without technical formatting, and find previous requests on desktop or mobile.
- Goals: let the owner ask naturally without remote desktop; connect deployed projects to chat requests; show a fast advisory observation before execution; run approved changes through Codex, verification, Git, and deployment; run safe operational checks immediately; report outcomes as inspectable evidence.
- Non-goals: replace Codex for arbitrary code edits, expose unrestricted shell over the web, make public self-service access, let System 1 influence routing or approval, integrate Jev, surface internal features/reasons/paths/provider payloads in the UI, fabricate live business data beyond the exported Studio registry, or imply real-time Studio connectivity the deterministic export does not have.
- Success signals: login works reliably, presets prefill without submitting, connection state reflects real API results, the active request shows its project, approval copy explains consequences, `빠른 판단` renders only safe summary fields, results read as Korean evidence (not raw technical dumps), and approved development reaches a verified healthy deployment.

## Personas and jobs
- Primary persona: Korean-first owner/operator managing Hyphen Studio projects from the Mac Studio agent — not a developer audience. Frequently uses a narrow in-app/mobile viewport.
- Secondary: developer/operator following up on Codex work.
- User jobs: glance at business state, start a common task in one or two taps, ask for today's priorities or blocked work, check Mac and deployment health, approve or decline risky operations, request project edits, watch progress, read the result as evidence, and find previous requests on any screen size.
- Key contexts of use: desktop browser on the Mac Studio itself and mobile browser away from the local network; Korean short-form requests; production Mac Studio running mini deploy and local agents.

## Information architecture
- Primary navigation: desktop keeps a left sidebar (brand, 홈 · 빠른 작업, 새 요청, request history, logout); mobile collapses it behind a header menu button that opens a request-history drawer (sheet) with the same entries.
- Core routes/screens: login screen, home/overview (greeting, compact current-state chips, categorized quick actions), agent workspace (chat console), request detail in conversation, approval/result block, `빠른 판단` observation fold.
- Content hierarchy: header carries a compact title row plus a wrapping operational-status strip (connection, business-data freshness, observation coverage); the active request renders as user message plus agent response/result; observation and event history sit inside the result block as collapsible, visually subordinate regions.
- Home is persistent and reachable from both desktop (sidebar) and mobile (drawer), not only for a new empty request.

## Design principles
- Principle 1: Calm operations workspace. Warm off-white surfaces, high-contrast Korean type, restrained green for healthy state; amber/red only when attention is required. No dashboard clutter or decorative effects.
- Principle 2: Chat first, operations second. The owner types natural requests and sees status/result inline; common tasks are one or two taps away from Home.
- Principle 3: Safe autonomy. Bounded safe checks run immediately; destructive, code-changing, or deployment-affecting work requires one explicit approval with consequence copy.
- Principle 4: Evidence over assertion. Connection state, project context, observations, and summaries are computed from real API data and stored records — never static placeholders.
- Tradeoffs: one approval covers the complete registered-project pipeline, while arbitrary shell access and unregistered filesystem paths remain unavailable; System 1 evidence is shown but never acted on.

## Visual language
- Color: warm neutral base (`--bg #faf8f4`, sidebar `#f5f1ea`, white surfaces, warm-gray lines), near-black warm text `#1c1914`, black primary controls, restrained green `#1c7a54` for healthy state, amber `#b54708`/red `#b42318` only for attention, failure, and disconnection. Soft tinted chips (`--accent-soft`, `--warning-soft`, `--danger-soft`) carry state without heavy borders.
- Typography: system sans with `Apple SD Gothic Neo` preferred for Korean, compact operational density, Korean-readable line height (1.5–1.7 in results).
- Spacing/layout rhythm: stable desktop sidebar and centered conversation width; mobile uses a full-width stacked layout; result blocks are the only cards, plus compact audit metric/item cards.
- Shape/radius/elevation: 10–12px radii for controls and cards, 16px composer card, subtle single shadow; no nested decoration.
- Motion: minimal; interface works identically under `prefers-reduced-motion` (all motion disabled).
- Imagery/iconography: text symbols only in the compact runtime server; use lucide icons if the React surface becomes production again.

## Components
- Existing components to reuse: mini-server login shell, sidebar threads, message bubbles, assistant result block, approval button.
- Shell: `.chat-top` header with a menu button (mobile only), never-clipped title, and a wrapping `.status-row` (connection pill, business-data freshness pill, observation coverage, refresh).
- Drawer: `#drawer` sheet + scrim for mobile history — 홈, 새 요청, request list, 새로고침, 로그아웃; closes on selection, scrim tap, or Escape; `aria-modal` with focus return to the menu button.
- Home: `.home` overview — greeting, `.home-state` live chips (connection, registry freshness, observation coverage), `.action-groups` (사업: 브리핑/우선순위/막힌 프로젝트/갱신 점검 · 운영: Mac/배포 상태 · 개발: 프로젝트 점검/개발 요청), and scope copy distinguishing 전체 Hyphen Studio actions from selected-project actions.
- Composer: textarea on top, labeled `프로젝트`/`작업 종류` selects in a wrapping field row, 44px send button, plain-Korean `scope-line` (범위: 전체 Hyphen Studio or 프로젝트: <name>), guidance/error line below.
- Results: `.result-text` sans-serif panel (pre-wrap, anywhere-wrap, 1.7 line-height) for text results; `.audit-view` structured card for `studio_evidence_audit` — four metrics, priority chips, per-project collapsible items with Korean missing-field chips and 2–4 Korean next actions, remaining-count note.
- Collapsibles: `.fold` details regions for `빠른 판단` observation and `최근 기록` event history.
- Freshness pill contract: a small header pill fed by `GET /api/business/status` shows `사업 데이터 최신` (with ` · 기준 <updatedAt>`), `사업 데이터 지연`, or `사업 데이터 사용 불가` — display-only, never a submission or approval path. The endpoint answers a fixed allowlist `{state, checkedAt, syncedAt, registryUpdatedAt, projectCount, errorCode}` derived from the synced registry plus the sync tool's `registry-sync-status.json`; paths, hashes, registry content, and error text never reach the response. `지연` honestly covers every case where data exists but freshness cannot be verified — no status witness, last run errored, check-ins older than `HERMES_BUSINESS_REGISTRY_STALE_MS` (default 10 min), or status/content mismatch — including pinned manual deployments.
- Preset contract: a preset only prefills the composer text and selects an existing request type (and project where appropriate). It never auto-submits and never bypasses approval. `오늘 브리핑`, `오늘 우선순위`, `막힌 프로젝트`, and `사업 현황 갱신 점검` are true cross-project Studio actions: they map to the allowlisted `studio_overview`/`studio_priorities`/`studio_blockers`/`studio_evidence_audit` types and display `전체 Hyphen Studio` scope, while Mac/deployment/inspect/development actions remain selected-project scoped. `오늘 브리핑` renders all five Korean sections (오늘의 상위 우선순위 / 막힌 일 / 매출·고객 신호 / 시스템 이상 / 소유자 승인이 필요한 일), each capped at five items and a deterministic per-section character budget, with honest `근거 없음` markers for empty sections — registry-derived fields are flattened to single lines and character-capped so all headers and the coverage line always fit the 4000-char result. Studio requests are generated synchronously in `mini-server.mjs` from the mounted business registry — deterministic, read-only, no worker dispatch, no approval, no LLM, no external call — and store only a bounded Korean owner-facing result plus safe freshness metadata (a generic source label and `updatedAt`); failures persist only a bounded allowlisted error code internally. `전체 Hyphen Studio` is the visible scope both before submit (composer hint + scope line) and after (request block-head). The registry path is server-configured only (`HERMES_BUSINESS_REGISTRY`, optional `HERMES_BUSINESS_REGISTRY_EXPECTED_HASH`); missing or invalid input completes as `failed` with a neutral unavailable state, never a fabricated empty briefing. When the selected project lacks the capability a preset (or manually chosen type) requires, the composer shows type-specific Korean guidance to pick a capable project before submission (repository wording only for `project_inspect`/`development`) — the backend capability gate still decides, and a `project_capability_not_enabled` rejection is marked as guidance so it recomputes instead of sticking as a raw error.
- Structured audit contract: `studio_evidence_audit` requests store `request.briefing.audit`, a bounded `audit-v1` view model re-sliced from the allowlisted `buildEvidenceAudit` output — `{coverage, summary.byPriority, items (≤10: projectId/projectName/businessGroup/priority/missingFields/actions), remaining}` only. No source hash, evidence references, local paths, raw `nextEvidence` text, secrets, owner names, or repository URLs cross; missing-field chips and actions render as natural Korean (상태/사업 단계/사업 유형/담당자/근거/저장소/배포/데이터 저장소/지표/매출), never internal field tokens. Requests without the view model fall back to the bounded text result.
- Handoff prefill contract: the Studio cockpit/inbox `Agent에게 실행 요청` action opens `https://hermes.hyphen.it.com?project=&type=&prompt=`. `GET /` validates every value server-side (`scripts/hermes-prefill.mjs`) — project resolves only against registry id/name/domain aliases, type must be a composer-selectable type and satisfy the effective project's `capabilities`, prompt is editable text capped at 2000 chars — then embeds only `{project, type, prompt}` as `window.__HERMES_PREFILL__`. Unknown/duplicate values, oversized text, control characters, and malformed encoding fail closed to neutral defaults; foreign parameters are ignored. After login the workspace applies the draft once to the editable composer with a `Studio에서 넘겨받은 초안` notice, clears the value, and resets the URL — it never auto-submits and never bypasses login or approval. Public Studio intake arrives only as editable draft text.
- Observation panel contract: render only route, policy verdict, confidence, and the `관찰 전용 · 실행에 영향 없음` label for `system1_shadow.status === "ok"`; a neutral unavailable state for `status === "error"`; nothing when no record exists. Never render features, reasons, raw text, paths, or provider payloads. Rendered as a collapsed `.fold` region inside the result block.
- Variants and states: queued, approval required, running, done, failed, canceled; home overview with grouped preset launcher; login error; connected/disconnected.
- Token/component ownership: `mini-server.mjs` owns production UI tokens while Docker deployment uses the compact Node runtime.

## Accessibility
- Target standard: practical WCAG AA contrast/readability for the internal console.
- Keyboard/focus behavior: login submit, composer Enter-to-send, Shift+Enter newline, preset and thread buttons reachable by keyboard, drawer supports Escape and returns focus to the menu button, visible `:focus-visible` rings on controls and details summaries.
- Touch: interactive controls at least 44px tall where practical (presets, send, drawer actions, thread rows, sidebar entries).
- Contrast/readability: warm neutral surfaces with high text contrast; status colors always paired with text labels.
- Screen-reader semantics: `lang="ko"`, labeled selects, `aria-label`/`aria-controls`/`aria-expanded` on the menu button, `role="dialog" aria-modal` drawer, `aria-current` on the selected thread, `role="status"` on the composer guidance line.
- Reduced motion and sensory considerations: `prefers-reduced-motion` disables all transitions/animations; no required motion.

## Responsive behavior
- Supported breakpoints/devices: desktop and mobile browser, tested down to 320px width; no horizontal page scroll at any supported width (all flex/grid children use `min-width: 0`, text wraps with `overflow-wrap`).
- Layout adaptations: desktop = sidebar + chat; ≤760px = single column, sidebar hidden, menu button opens the history drawer, composer fields wrap (two-up then stacked ≤420px), audit metrics go 2×2.
- Touch/hover differences: hover is enhancement only; every action is reachable by tap and keyboard.

## Interaction states
- Loading: queued and running requests poll more frequently and show the current worker stage; event history stays collapsed under `최근 기록`.
- Connection: a successful API load shows `연결됨` (green pill); an auth failure returns to login; a transient failure keeps the workspace visible with `연결 끊김 · 재시도 중` and continues polling.
- Empty: Home overview — greeting, live state chips, and the grouped action launcher.
- Error: inline Korean error text under the composer; guidance copy renders muted instead of danger; `빠른 판단` shows only a neutral unavailable state.
- Success: result block shows `완료`; evidence audits render the structured card, other results render the readable text panel.
- Disabled: approvals only appear for approval-required jobs; presets never submit.
- Offline/slow network: disconnection is surfaced as a real state instead of silently reverting to login.

## Content voice
- Tone: concise Korean, operational, no hype, no jargon, no internal field names in owner-facing copy.
- Terminology: Hyphen Studio Agent, Hermes, Mac Studio, 빠른 판단, Codex 개발 요청, 배포 상태, 프로젝트 점검, 재배포, 사업 현황 갱신 점검, 상태/사업 단계/사업 유형/담당자/근거.
- Microcopy rules: describe current status and consequences, not feature explanations; dangerous operations use explicit approval wording that names what runs next; observation UI always carries the `관찰 전용 · 실행에 영향 없음` disclaimer; scope is always stated in plain Korean (전체 Hyphen Studio vs 선택한 프로젝트).

## Implementation constraints
- Framework/styling system: production route is the self-contained Node HTTP server in `mini-server.mjs`; React/vinext files are not the active deployment surface.
- Design-token constraints: CSS custom properties in the embedded runtime page.
- Performance constraints: no heavy frontend bundle required for production console; worker avoids local LLM for status/deploy checks, runs the configured local model with a measured 16K context only for chat/approved agent work, and invokes Codex only for approved development work.
- Evidence constraints: `/api/system1/summary` is admin-only, read-only, and makes no external calls. Its semantics are fixed: `totalEligibleRequests` counts every valid stored request, `observedOk`/`observedError` count requests carrying the bounded `system1_shadow` marker (an error marker still counts as observed), `coverageRate` = observed / eligible (traffic coverage, `0` when empty), and route/policy/abstained aggregates use `status === "ok"` records only. The response is a strict count allowlist — no ids, content, timestamps, features, or paths.
- Compatibility constraints: Docker runtime on Node 22 Alpine; Mac Studio worker launched by LaunchAgent from `~/.local/share/hermes-ops`.
- Test/screenshot expectations: API smoke, Docker build, production curl smoke; browser screenshot when visual fidelity is the primary task.

## Open questions
- [ ] Which additional deployed projects should be added to `hermes-projects.json` / owner: operator / impact: expands the approved automation surface.
- [ ] Whether redeploy should always pull latest GitHub main or support branch selection / owner: operator / impact: deployment workflow safety.
- [ ] Whether to replace password-only access with SSO or VPN allowlisting / owner: operator / impact: security posture.
- [x] Whether Studio cockpit should deep-link into specific agent requests / owner: operator / resolved: the `Agent에게 실행 요청` handoff opens Hermes with bounded `project`/`type`/`prompt` prefill parameters validated fail-closed in `scripts/hermes-prefill.mjs` — drafts only, never auto-submitted; deep-linking into existing request threads remains open.
- [x] Which connector should bring the Studio business registry into the agent workspace for true cross-project briefings / owner: operator / resolved: the `studio_overview`/`studio_priorities`/`studio_blockers` types render deterministic briefing views in-server from the `HERMES_BUSINESS_REGISTRY` mount — see `BRIEFING.md`.
- [x] How the business registry stays current without manual mounts or a static hash pin blocking every export / owner: operator / resolved: `scripts/hermes-registry-sync.mjs` validates and atomically copies the Studio export into Hermes persistent data (LaunchAgent, 5-minute interval), `registry-sync-status.json` records an allowlisted outcome, and `GET /api/business/status` feeds the freshness pill. `HERMES_BUSINESS_REGISTRY_EXPECTED_HASH` stays unset in auto-sync mode — it remains the manual-deploy freeze pin only.
