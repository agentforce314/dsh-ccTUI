# Porting Notes

Running log of deliberate deviations from the pristine `reference_projects/clawcodex/ui-tui`
sources. Everything not listed here is a verbatim copy.

## Stage 3 — app source copy

- `src/` and `scripts/{build,build-dev,profile-tui}.mjs` copied byte-identical from ui-tui
  (verified with `diff -r`).
- `vitest.config.ts`: `testTimeout` raised to 120s. The upstream cursor-drift regression test
  walks every typing prefix through a real Ink render and needs >5s on this hardware (WSL2);
  it passes given time.
- **7 tests marked `it.skip` with a `KNOWN-SKEW(upstream)` comment.** All 7 fail identically in
  the pristine ui-tui checkout with its own lockfile (verified 2026-08-18), i.e. the upstream
  tests drifted from the upstream sources before the snapshot was taken; the sources are the
  authority for look/feel, so the stale expectations are skipped rather than "fixed":
  - `createGatewayEventHandler.test.ts` — expects `Patch("foo.ts")`-style quoted tool-trail
    labels and an `Args:` verbose block that `buildToolTrailLine` no longer emits.
  - `statusRule.test.ts` (2) — expects a `cost` segment that `statusBarSegments` no longer
    returns.
  - `useConfigSync.test.ts` (2) — expects the default indicator style to be `kaomoji`; the
    source default is `star`.
  - `virtualHeights.test.ts` (1) — expects a different wrap estimate for compound user prompts.
- `slashParity.test.ts` shells out to the Python `clawcodex_cli` package to compare slash
  catalogs and self-skips ("best effort") when the module is missing, as it is here.

Revisit: when a stage touches one of these areas, reconcile the skipped expectation with the
observed behavior instead of leaving it skipped.

- Local flake class: the interactive `.tsx` suites (modelPicker, questionPromptMount, ...)
  drive fake stdin with fixed 20ms delays and can fail under full-suite parallel load on slow
  machines while passing consistently in isolation. Mitigated with `retry: 1` in
  vitest.config.ts — a real regression still fails twice.

## Stage 4 — harness gateway

- `src/gatewayClient.ts`: single-token diff — `const SLASHES` became `export const SLASHES`
  so the harness client can serve `commands.catalog`/`complete.slash` from the same table.
- New `src/harness/` (the only directory allowed to import `@deepseek-ai/*`, gated by
  `npm run verify:boundary`): `index.ts` (cordis plugin surface), `plugin.ts` (entry.tsx-
  equivalent boot wiring), `client.ts` (`HarnessGatewayClient extends GatewayClient` —
  overrides `start`/`request`/`kill`; start() creates an in-process harness agent instead of
  spawning Python, and `session/event` records are translated onto the GatewayEvent union).
- `dist/plugin.js` is an esbuild bundle with ONLY `@deepseek-ai/*` external: React, the ink
  fork, and the app ship inside the plugin file, so a dsh profile needs no additional
  node_modules and there is never a second React copy.
- e2e (`npm run e2e`): boots the real `dsh` CLI from this repo's node_modules (one copy of
  every harness package in the process), dsh-base bundle + a scripted mock LLM adapter
  (`test/e2e/mock-llm.mjs`, provider route `mock`), inside a Python PTY driver that answers
  DA1/CPR/OSC-11 terminal queries. Asserts banner+composer render, a streamed
  `MOCK-REPLY: <prompt>` turn, and clean `/quit`.
- The mock adapter must pick the last message with `source.kind === 'user'` — the harness
  injects context (time, instructions) as user-role messages and a naive "last user message"
  echoes those instead of the human prompt.

## Stage 5 — interaction gates

- Approvals: the client is the `approval/request` waterfall answerer for its own agent
  (delegates other agents via next()). The gated command shown in the box is recovered from
  the `tool/call` arguments by callId. `allow_permanent` is false — the harness has no
  persistent grant store, so the "don't ask again" option is hidden and `always` maps to
  allowed-once if it ever arrives. In the stock dsh-base composition, approvals fire on
  sandbox escalations (`sandbox_permissions` on bash) rather than on every tool call.
- Questions: the client registers as the `ctx.userQuestions` provider
  (DUPLICATE_PROVIDER-tolerant). QuestionSpec has no id, so answers are re-paired by
  question text; multi-select answers arrive as ', '-joined labels and are split back into
  selected labels + custom leftovers.
- Plan review: a single question carrying intent {kind:'plan-review', approve} renders as
  the clawcodex PlanApprovalPrompt; approve choices answer with the intent's approve label,
  accept-edits maps to default (no per-category harness equivalent), bypass additionally
  sets approval policy 'never'; deny answers with the feedback as custom text.
- Permission modes: Shift+Tab cycles default → plan → bypassPermissions (acceptEdits is
  omitted — no harness analog). plan drives ctx.planMode.set, bypass drives
  ctx.approval.setPolicy('never'); 'plan/mode' session events (e.g. the model exiting plan
  mode) flow back as permission.mode updates.

## Stage 6 — sessions

- The client keeps a live-agent registry (Map<sid, AgentHandle>); the UI binds to one
  (attach() = swap subscriptions + rebuild info + recount the turn odometer from the log).
  session.close disposes; kill() disposes all.
- session.resume/activate: live handles switch in place; persisted ids go through
  ctx.agents.resume, then the transcript is rehydrated from agent.session.events
  (user/message with source.kind user → user rows; assistant/message → assistant rows;
  tool/call → tool trail rows with prettyArgs context).
- session.list serves sessionPersistence.list() newest-first with titles from
  sessionProjectionCache.cachedSnapshot when warm; session.active_list reflects the live
  map with agent.status. session.title get/rename via ctx.sessionTitle.
- e2e is now two-phase: phase 2 boots fresh and `/sessions <fixed-id>` replays phase 1's
  persisted conversation.

## Stage 7 — slash commands, model picker, usage

- commands.catalog / complete.slash now merge `ctx.commands.list(agent)` behind the static
  SLASHES table (locals win on collisions — a harness command never shadows a built-in).
- slash.exec: `effort` and `context` are handled in the client (selection.reasoningEffort /
  tokenMeter snapshot); everything else bridges to `ctx.commands.execute` — note the
  dsh-commands parseCommand contract requires the LEADING SLASH on the line.
- config.set model → applyModelSwitch: accepts `model`, `provider:model`, and
  `model --provider slug`; updates the live selection (installModelSelection ref), persists
  via agentDefaultModel.saveSelection, refreshes the context window, republishes session.info.
- model.options / model.effort_options from the ctx.llm advisory catalog + resolveModelInfo.
- session.usage + message.complete usage now carry context_used/max/percent from
  tokenMeter.measure + the resolved model context window (drives the context bar).
- e2e lesson: a bare slash word leaves the completion menu open and Enter ACCEPTS instead of
  submitting — the PTY driver sends Esc first; and flattened-transcript needles must avoid
  digits (some glyphs render via absolute cursor positioning and vanish in the flattener).

## Stage 8 — rich rendering & telemetry

- tool/result now routes through the owning tool's presentResult view: diff views convert
  to StructuredDiffPayload via jsdiff structuredPatch (create → content + firstLine; multi-
  file diffs render the first + a "+N more" note), terminal views render output + exit code,
  search path views join paths; everything else falls back to the raw text blocks.
- todo/write snapshots stash and ride the next tool.complete's `todos` (the todo_write tool
  completes immediately after, which is where the clawcodex TodoPanel reads them).
- tool-call-delta chunks announce tool.generating once per call id.
- session.stats {session_turns} publishes after resume/activate so the odometer is right
  before the next turn.
- e2e mock lesson: "has a tool result" must be scoped to messages AFTER the last human
  prompt — the derived history keeps earlier turns' tool results forever.

## Stage 9 — packaging & install

- Distribution is checkout-based: `./install.sh` builds locally then
  `dsh plugin --profile dsh-cctui add <checkout>` (a pnpm link install). The bundle's
  cordis.patch.yml supplies the cctui row; module resolution from the linked checkout finds
  the repo's own node_modules, so the plugin externals resolve without touching the profile.
- `bin/dsh-cctui.js` is a thin launcher (probe dsh, verify the profile, exec
  `dsh --profile dsh-cctui` with NODE_ENV=production).
- The installed path has its own e2e (`npm run e2e:install`, in CI): scratch DSH_HOME,
  real `dsh plugin add`, boot with only a mock-LLM overlay patch, one streamed turn.
- Not ported (backend never fires them, UI degrades silently): billing/credits, voice,
  pets gallery (pet RPCs resolve empty), browser progress, worktree exit flow, rollback,
  memory targets, sudo/secret prompts.

## Stage 10 — DeepSeek rebrand (v0.2.0)

- Wordmark: DSH-CCTUI in the same ANSI-shadow style (69 cols, hand-assembled, uniform width).
- Mascot: the lobster became a blue whale; it now always paints from the active /logo
  gradient (default: the new `whale` palette, anchored on DeepSeek blue #4D6BFE). `sunset`
  remains selectable; `/logo` grammar gained `whale`.
- brand: name `dsh-ccTUI`, icon 🐳; tagline "Claude Code style TUI for Deepseek-Harness"
  (mid tier: "Claude Code style TUI"; tiny tier: "dsh-ccTUI").
- Every user-visible "clawcodex" string was renamed; functional identifiers stay
  (CLAWCODEX_* env vars, ~/.clawcodex data dir, @dsh-cctui/ink package name).
- Identifier rename: every `cc-tui` token became `cctui` (package `dsh-cctui`, row id
  `cctui`, bin `dsh-cctui`, env prefix `DSH_CCTUI_*`); the default profile is `dsh-cctui`.
- SessionInfo.version now carries the real plugin version (package.json, resolved from
  dist/ or src/), so the panel reads "dsh-ccTUI v0.2.0".
- e2e determinism fix: the write-tool scenario deletes its probe file first — a leftover
  file turned the create into an update and hit the read-before-write observation policy.

## Stage 11 — ocean-blue brand, own data directory (v0.2.1)

- The banner shipped GREEN despite the v0.2.0 rebrand: `readLogoColorSync` read
  `~/.clawcodex/config.json`, so a clawcodex `/logo forest` preference overrode the new
  default. Two fixes: the app now owns `~/.dsh-cctui` (`src/lib/appHome.ts`, env override
  `DSH_CCTUI_HOME`) for the logo pref, prompt history, lifecycle logs, perf log, heapdumps
  and the memory-file home; and `config.set logoColor` persists there (previously it fell
  through to `{}`, so `/logo` silently failed to stick).
  No migration from `~/.clawcodex` — inheriting another product's UI prefs is the bug.
- Brand palette is the existing `ocean` ramp (now `DEFAULT_LOGO_PALETTE`), not a bespoke
  one; `LOGO_BRAND` pins the same six stops as literals and a test asserts they match.
- Theme brand hue moved off Claude terracotta to DeepSeek blue: dark `#4D6BFE`,
  light `#3A57E8` (deeper for contrast on white), shimmer band recolored to match. This is
  what makes the whole header/chrome read blue, not just the ASCII art.
- Testing lesson that caused this: the v0.2.0 e2e asserted banner *glyphs* but never the
  SGR *colors*, so a stale palette passed. The e2e now asserts every brand-colored run in
  the banner region is blue-dominant, and a unit test pins the default ramp to ocean.

## Stage 12 — fork and identifier rename (v0.3.0)

- `packages/clawcodex-ink` → `packages/dsh-cctui-ink`, package `@clawcodex/ink` →
  `@dsh-cctui/ink` (143 files, ~29k LOC; 96 import sites, three esbuild aliases, the ambient
  `.d.ts` module declaration, tsconfig paths and the vitest excludes). It is a vendored fork
  of Ink that this repo ships and bundles, so carrying another product's brand in its
  package identity was wrong; MIT permits the rename and NOTICE.md keeps the attribution
  (renaming never removes credit).
- Environment knobs `CLAWCODEX_*` / `CLAWCODEX_TUI_*` → `DSH_CCTUI_*` (49 names; the
  redundant `TUI_` infix was dropped, e.g. `CLAWCODEX_TUI_INLINE` → `DSH_CCTUI_INLINE`).
  `CLAUDE_CODE_SCROLL_SPEED` is deliberately KEPT as a migration fallback — it is another
  product's knob read for interop, not our branding.
- Remaining "clawcodex" mentions in the tree are provenance comments ("ported from …") and
  the dead Python-gateway test fixtures; those describe history and stay.
- The inert `/memory` feature's file name became `DSH-CCTUI.md` under `~/.dsh-cctui`.
