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
