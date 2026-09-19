# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-08-16
- Primary product surfaces: Hermes web chat at `https://hermes.hyphen.it.com`, local Mac Studio worker, registered deployment projects, Codex development pipeline.
- Evidence reviewed: `mini-server.mjs`, `scripts/hermes-local-worker.mjs`, `hermes-projects.json`, `README.md`, `ARCHITECTURE.md`, `package.json`, current mini deploy Docker state.

## Brand
- Personality: quiet, competent, internal-ops focused, Korean-first.
- Trust signals: visible request status, worker result text, clear approval boundary for risky actions.
- Avoid: marketing pages, decorative visuals, opaque automation, arbitrary destructive shell execution.

## Product goals
- Goals: let authorized internal users ask Hermes to inspect/manage the Mac Studio without remote desktop; connect deployed projects to chat requests; run approved code changes through Codex, verification, Git, and deployment; run safe operational checks immediately.
- Non-goals: replace Codex for arbitrary code edits, expose unrestricted shell over the web, make public self-service access.
- Success signals: login works reliably, request submission changes visible UI immediately, worker processes safe jobs, progress is visible while work runs, deploy/project status can be inspected remotely, and approved development reaches a verified healthy deployment.

## Personas and jobs
- Primary personas: company operator/owner managing a Mac Studio deployment server; developer/operator using Codex for implementation follow-up.
- User jobs: chat with local Hermes 4.3, check machine/deployment health, ask for cleanup candidates, approve Hermes operations, request project edits, approve redeploys, see whether work finished.
- Key contexts of use: mobile or desktop browser outside the local network; Korean short-form requests; production Mac Studio running mini-vercel and local agents.

## Information architecture
- Primary navigation: left thread list, main conversation, composer controls.
- Core routes/screens: login screen, chat console, request detail in conversation, approval/result block.
- Content hierarchy: newest request first in the sidebar; active request shown as user message plus Hermes response/result.

## Design principles
- Principle 1: Chat first, operations second. The user should type natural requests and see status/result inline.
- Principle 2: Safe autonomy. Hermes should execute bounded safe checks immediately and require approval for destructive, code-changing, or deployment-affecting operations.
- Tradeoffs: one approval covers the complete registered-project pipeline, while arbitrary shell access and unregistered filesystem paths remain unavailable.

## Visual language
- Color: neutral ChatGPT-like base with black primary controls, green Hermes status accents, red/warn colors only for risk and failure.
- Typography: system sans, compact operational density, Korean-readable line height.
- Spacing/layout rhythm: stable sidebar and centered conversation width; no nested cards beyond individual result blocks.
- Shape/radius/elevation: 8px or smaller for normal controls; composer may use larger radius to match chat pattern.
- Motion: minimal; no decorative animation.
- Imagery/iconography: text symbols only in the compact runtime server; use lucide icons if the React surface becomes production again.

## Components
- Existing components to reuse: mini-server login shell, sidebar threads, message bubbles, assistant result block, approval button.
- New/changed components: request type selector with tool-free Hermes chat as the default, project selector, operation result summaries, progress event list, worker heartbeat/status endpoint.
- Variants and states: queued, approval required, running, done, failed; empty chat; login error.
- Token/component ownership: `mini-server.mjs` owns production UI tokens while Docker deployment uses the compact Node runtime.

## Accessibility
- Target standard: practical WCAG AA contrast/readability for the internal console.
- Keyboard/focus behavior: login submit, composer Enter-to-send, Shift+Enter newline, visible focus rings.
- Contrast/readability: neutral surfaces with high text contrast; status colors paired with labels.
- Screen-reader semantics: form controls use labels/placeholders and button titles; future React surface should add richer ARIA labels.
- Reduced motion and sensory considerations: no required motion.

## Responsive behavior
- Supported breakpoints/devices: desktop and mobile browser.
- Layout adaptations: desktop uses sidebar plus chat; mobile hides sidebar and keeps the composer full-width.
- Touch/hover differences: controls remain at least 34px high, with hover states as enhancement only.

## Interaction states
- Loading: queued and running requests poll more frequently and show the current worker stage plus recent events.
- Empty: centered Korean prompt asking what Hermes should do.
- Error: inline Korean error text.
- Success: result block shows `완료` and worker output.
- Disabled: approvals only appear for approval-required jobs.
- Offline/slow network, if applicable: polling failure falls back to login state today; future iteration should show disconnected status.

## Content voice
- Tone: concise Korean, operational, no hype.
- Terminology: Hermes, Mac Studio, Codex 개발 요청, 배포 상태, 프로젝트 점검, 재배포.
- Microcopy rules: describe current status, not feature explanations; dangerous operations use explicit approval wording.

## Implementation constraints
- Framework/styling system: production route is self-contained Node HTTP server in `mini-server.mjs`; React/vinext files are not the active deployment surface.
- Design-token constraints: CSS custom properties in the embedded runtime page.
- Performance constraints: no heavy frontend bundle required for production console; worker avoids local LLM for status/deploy checks, runs the Hermes 4.3 quantization with a measured 16K context only for chat/approved agent work, and invokes Codex only for approved development work.
- Compatibility constraints: Docker runtime on Node 22 Alpine; Mac Studio worker launched by LaunchAgent from `~/.local/share/hermes-ops`.
- Test/screenshot expectations: API smoke, Docker build, production curl smoke; browser screenshot when visual fidelity is the primary task.

## Open questions
- [ ] Which additional deployed projects should be added to `hermes-projects.json` / owner: operator / impact: expands the approved automation surface.
- [ ] Whether redeploy should always pull latest GitHub main or support branch selection / owner: operator / impact: deployment workflow safety.
- [ ] Whether to replace password-only access with SSO or VPN allowlisting / owner: operator / impact: security posture.
