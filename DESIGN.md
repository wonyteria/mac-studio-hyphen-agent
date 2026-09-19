# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-09-19
- Primary product surfaces: Hyphen Studio (project cockpit, owned separately), the Mac Studio agent workspace at `https://hermes.hyphen.it.com` (`mini-server.mjs`), the local Mac Studio worker, registered deployment projects, Codex development pipeline.
- Evidence reviewed: `mini-server.mjs`, `scripts/hermes-local-worker.mjs`, `scripts/hermes-system1.mjs`, `hermes-projects.json`, `README.md`, `ARCHITECTURE.md`, `SYSTEM1.md`, `package.json`, current mini deploy Docker state.

## Product model
- Hyphen Studio is the project cockpit where the owner decides direction. This repository is the **Hyphen Studio Agent** — the execution and evidence surface that runs on the Mac Studio.
- The owner chooses a registered project, asks in natural Korean, sees the fast System 1 observation, understands whether approval is needed, follows execution, and inspects the outcome without technical jargon.
- Evidence flow: Studio cockpit (intent) -> agent workspace (request queue + chat) -> System 1 observation (`빠른 판단`, observational only) -> System 2 execution (worker / Hermes 4.3 / Codex) -> deterministic verification -> result + evidence back in the workspace.
- System 1 never decides execution. Its shadow observation is advisory evidence only; classification, approval gates, and worker dispatch remain deterministic and unchanged.

## Brand
- Name: **Hyphen Studio Agent**, powered by Hermes on Mac Studio.
- Personality: quiet, competent, internal-ops focused, Korean-first.
- Trust signals: truthful connection state, visible request status, active project context, a clearly labeled observation-only `빠른 판단` panel, explicit approval wording that states what will happen before the owner approves.
- Avoid: marketing pages, decorative visuals, opaque automation, fake status indicators, arbitrary destructive shell execution.

## Product goals
- Goals: let the owner ask naturally without remote desktop; connect deployed projects to chat requests; show a fast advisory observation before execution; run approved changes through Codex, verification, Git, and deployment; run safe operational checks immediately; report outcomes as inspectable evidence.
- Non-goals: replace Codex for arbitrary code edits, expose unrestricted shell over the web, make public self-service access, let System 1 influence routing or approval, integrate Jev, surface internal features/reasons/paths/provider payloads in the UI, fabricate live business data beyond the exported Studio registry, or imply real-time Studio connectivity the deterministic export does not have.
- Success signals: login works reliably, presets prefill without submitting, connection state reflects real API results, the active request shows its project, approval copy explains consequences, `빠른 판단` renders only safe summary fields, and approved development reaches a verified healthy deployment.

## Personas and jobs
- Primary persona: Korean-first owner/operator managing Hyphen Studio projects from the Mac Studio agent — not a developer audience. Secondary: developer/operator following up on Codex work.
- User jobs: pick a project, ask for today's priorities or blocked work, check Mac and deployment health, approve or decline risky operations, request project edits, watch progress, read the result as evidence.
- Key contexts of use: desktop browser on the Mac Studio itself and mobile browser away from the local network; Korean short-form requests; production Mac Studio running mini deploy and local agents.

## Information architecture
- Primary navigation: left thread list, main conversation, composer controls.
- Core routes/screens: login screen, agent workspace (chat console), request detail in conversation, approval/result block, `빠른 판단` observation panel.
- Content hierarchy: newest request first in the sidebar; active request shown as user message plus agent response/result; observation panel sits inside the result block and is visually subordinate.

## Design principles
- Principle 1: Chat first, operations second. The owner types natural requests and sees status/result inline.
- Principle 2: Safe autonomy. Bounded safe checks run immediately; destructive, code-changing, or deployment-affecting work requires one explicit approval with consequence copy.
- Principle 3: Evidence over assertion. Connection state, project context, observations, and summaries are computed from real API data and stored records — never static placeholders.
- Tradeoffs: one approval covers the complete registered-project pipeline, while arbitrary shell access and unregistered filesystem paths remain unavailable; System 1 evidence is shown but never acted on.

## Visual language
- Color: neutral ChatGPT-like base with black primary controls, green status accents, red/warn colors only for risk, failure, and disconnection.
- Typography: system sans, compact operational density, Korean-readable line height.
- Spacing/layout rhythm: stable sidebar and centered conversation width; no nested cards beyond individual result/observation blocks.
- Shape/radius/elevation: 8px or smaller for normal controls; composer may use larger radius to match chat pattern.
- Motion: minimal; no decorative animation.
- Imagery/iconography: text symbols only in the compact runtime server; use lucide icons if the React surface becomes production again.

## Components
- Existing components to reuse: mini-server login shell, sidebar threads, message bubbles, assistant result block, approval button.
- New/changed components: Hyphen Studio Agent branding, empty-state preset launcher (오늘 브리핑 / 오늘 우선순위 / 막힌 프로젝트 / Mac 상태 점검 / 배포 상태 확인), truthful connection indicator, project context on the active request, per-type approval consequence copy, `빠른 판단` observation panel, small shadow-evidence summary.
- Preset contract: a preset only prefills the composer text and selects an existing request type (and project where appropriate). It never auto-submits and never bypasses approval. `오늘 브리핑`, `오늘 우선순위`, and `막힌 프로젝트` are true cross-project Studio actions: they map to the allowlisted `studio_overview`/`studio_priorities`/`studio_blockers` types and display `전체 Hyphen Studio` scope, while Mac/deployment/project actions remain selected-project scoped. `오늘 브리핑` renders all five Korean sections (오늘의 상위 우선순위 / 막힌 일 / 매출·고객 신호 / 시스템 이상 / 소유자 승인이 필요한 일), each capped at five items and a deterministic per-section character budget, with honest `근거 없음` markers for empty sections — registry-derived fields are flattened to single lines and character-capped so all headers and the coverage line always fit the 4000-char result. Studio requests are generated synchronously in `mini-server.mjs` from the mounted business registry — deterministic, read-only, no worker dispatch, no approval, no LLM, no external call — and store only a bounded Korean owner-facing result plus safe freshness metadata (a generic source label and `updatedAt`); failures persist only a bounded allowlisted error code internally. `전체 Hyphen Studio` is the visible scope both before submit (composer hint) and after (request block-head). The registry path is server-configured only (`HERMES_BUSINESS_REGISTRY`, optional `HERMES_BUSINESS_REGISTRY_EXPECTED_HASH`); missing or invalid input completes as `failed` with a neutral unavailable state, never a fabricated empty briefing. When the selected project lacks the capability a preset (or manually chosen type) requires, the composer shows type-specific Korean guidance to pick a capable project before submission (repository wording only for `project_inspect`/`development`) — the backend capability gate still decides, and a `project_capability_not_enabled` rejection is marked as guidance so it recomputes instead of sticking as a raw error.
- Handoff prefill contract: the Studio cockpit/inbox `Agent에게 실행 요청` action opens `https://hermes.hyphen.it.com?project=&type=&prompt=`. `GET /` validates every value server-side (`scripts/hermes-prefill.mjs`) — project resolves only against registry id/name/domain aliases, type must be a composer-selectable type and satisfy the effective project's `capabilities`, prompt is editable text capped at 2000 chars — then embeds only `{project, type, prompt}` as `window.__HERMES_PREFILL__`. Unknown/duplicate values, oversized text, control characters, and malformed encoding fail closed to neutral defaults; foreign parameters are ignored. After login the workspace applies the draft once to the editable composer with a `Studio에서 넘겨받은 초안` notice, clears the value, and resets the URL — it never auto-submits and never bypasses login or approval. Public Studio intake arrives only as editable draft text.
- Observation panel contract: render only route, policy verdict, confidence, and the `관찰 전용 · 실행에 영향 없음` label for `system1_shadow.status === "ok"`; a neutral unavailable state for `status === "error"`; nothing when no record exists. Never render features, reasons, raw text, paths, or provider payloads.
- Variants and states: queued, approval required, running, done, failed; empty chat with preset launcher; login error; connected/disconnected.
- Token/component ownership: `mini-server.mjs` owns production UI tokens while Docker deployment uses the compact Node runtime.

## Accessibility
- Target standard: practical WCAG AA contrast/readability for the internal console.
- Keyboard/focus behavior: login submit, composer Enter-to-send, Shift+Enter newline, preset buttons reachable by keyboard, visible focus rings.
- Contrast/readability: neutral surfaces with high text contrast; status colors always paired with text labels.
- Screen-reader semantics: form controls use labels/placeholders and button titles; future React surface should add richer ARIA labels.
- Reduced motion and sensory considerations: no required motion.

## Responsive behavior
- Supported breakpoints/devices: desktop and mobile browser.
- Layout adaptations: desktop uses sidebar plus chat; mobile hides sidebar, keeps the composer full-width, and wraps preset buttons.
- Touch/hover differences: controls remain at least 34px high, with hover states as enhancement only.

## Interaction states
- Loading: queued and running requests poll more frequently and show the current worker stage plus recent events.
- Connection: a successful API load shows `연결됨`; an auth failure returns to login; a transient failure keeps the workspace visible with `연결 끊김 · 재시도 중` and continues polling.
- Empty: centered Korean prompt with the four-preset launcher.
- Error: inline Korean error text; `빠른 판단` shows only a neutral unavailable state.
- Success: result block shows `완료` and worker output.
- Disabled: approvals only appear for approval-required jobs; presets never submit.
- Offline/slow network: disconnection is surfaced as a real state instead of silently reverting to login.

## Content voice
- Tone: concise Korean, operational, no hype, no jargon.
- Terminology: Hyphen Studio Agent, Hermes, Mac Studio, 빠른 판단, Codex 개발 요청, 배포 상태, 프로젝트 점검, 재배포.
- Microcopy rules: describe current status and consequences, not feature explanations; dangerous operations use explicit approval wording that names what runs next; observation UI always carries the `관찰 전용 · 실행에 영향 없음` disclaimer.

## Implementation constraints
- Framework/styling system: production route is the self-contained Node HTTP server in `mini-server.mjs`; React/vinext files are not the active deployment surface.
- Design-token constraints: CSS custom properties in the embedded runtime page.
- Performance constraints: no heavy frontend bundle required for production console; worker avoids local LLM for status/deploy checks, runs the Hermes 4.3 quantization with a measured 16K context only for chat/approved agent work, and invokes Codex only for approved development work.
- Evidence constraints: `/api/system1/summary` is admin-only, read-only, and makes no external calls. Its semantics are fixed: `totalEligibleRequests` counts every valid stored request, `observedOk`/`observedError` count requests carrying the bounded `system1_shadow` marker (an error marker still counts as observed), `coverageRate` = observed / eligible (traffic coverage, `0` when empty), and route/policy/abstained aggregates use `status === "ok"` records only. The response is a strict count allowlist — no ids, content, timestamps, features, or paths.
- Compatibility constraints: Docker runtime on Node 22 Alpine; Mac Studio worker launched by LaunchAgent from `~/.local/share/hermes-ops`.
- Test/screenshot expectations: API smoke, Docker build, production curl smoke; browser screenshot when visual fidelity is the primary task.

## Open questions
- [ ] Which additional deployed projects should be added to `hermes-projects.json` / owner: operator / impact: expands the approved automation surface.
- [ ] Whether redeploy should always pull latest GitHub main or support branch selection / owner: operator / impact: deployment workflow safety.
- [ ] Whether to replace password-only access with SSO or VPN allowlisting / owner: operator / impact: security posture.
- [x] Whether Studio cockpit should deep-link into specific agent requests / owner: operator / resolved: the `Agent에게 실행 요청` handoff opens Hermes with bounded `project`/`type`/`prompt` prefill parameters validated fail-closed in `scripts/hermes-prefill.mjs` — drafts only, never auto-submitted; deep-linking into existing request threads remains open.
- [x] Which connector should bring the Studio business registry into the agent workspace for true cross-project briefings / owner: operator / resolved: the `studio_overview`/`studio_priorities`/`studio_blockers` types render deterministic briefing views in-server from the `HERMES_BUSINESS_REGISTRY` mount — see `BRIEFING.md`.
