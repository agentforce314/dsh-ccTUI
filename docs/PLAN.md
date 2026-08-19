# dsh-ccTUI — Staged Porting Plan

Goal: port the **clawcodex `ui-tui`** TypeScript terminal UI (Claude-Code-style look, feel, and
interactions) to a **deepseek-harness plugin**, using **dsh-TUI** as the packaging/integration
skeleton reference.

Reference material (gitignored, vendored locally under `reference_projects/`):

| Project | Role |
|---|---|
| `reference_projects/clawcodex/ui-tui` | The TUI to port: ~41k LOC React app + ~29k LOC forked Ink renderer (`packages/dsh-cctui-ink`). MIT. |
| `reference_projects/dsh-TUI` | A proven claude-code-style TUI plugin for deepseek-harness; we borrow its packaging skeleton and integration patterns. MIT. |
| `reference_projects/deepseek-harness` | The harness itself (docs + source). Published on npm as `@deepseek-ai/*@0.1.0-rc.7`. |

## Core architectural insight

The clawcodex TUI has exactly **one backend seam**: `src/gatewayClient.ts` (~2.9k LOC). It spawns
the Python backend as a subprocess and translates NDJSON into an app-facing contract:

- an `EventEmitter` emitting a **44-member `GatewayEvent` union** (`message.delta`, `tool.start`,
  `approval.request`, …) defined in `src/gatewayTypes.ts`, and
- a `request(method, params)` promise RPC surface (~75 dotted methods: `prompt.submit`,
  `session.list`, `approval.respond`, …) where **unhandled methods gracefully resolve `{}`**.

Everything above that seam (157 non-test files) is backend-agnostic. Therefore the port is:

1. **Copy the app + the Ink fork wholesale** (preserving look/feel/interactions by construction).
2. **Replace only the gateway client internals** with an in-process implementation over
   deepseek-harness services (`ctx.agents`, `session/event`, `approval/request` waterfall,
   `ctx.userQuestions`, `ctx.commands`, `ctx.sessionPersistence`, …). The graceful-degradation
   design means the TUI runs early and features light up RPC-by-RPC.
3. **Package as a cordis bundle plugin** (`package.json` → `"dsh": {"bundle": {"patch":
   "./cordis.patch.yml"}}`), installable with `dsh plugin --profile <p> add <pkg>` and launched
   with `dsh --profile <p>`, following dsh-TUI's proven skeleton (peerDeps on `@deepseek-ai/*`,
   adapter boundary, exit funnel, `NODE_ENV=production` for React).

The full event/RPC mapping is in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Working agreements

- Each stage: implement → test → PR → merge → next stage. Branch names `stage-N-<slug>`.
- English is the project language (code, docs, commits, UI strings).
- Tests per stage: `tsc --noEmit` + `vitest run` (ported suites) and, from Stage 4 on, scripted
  end-to-end boots of the real harness (`@deepseek-ai/dsh` rc.7) with a **scripted LLM plugin**
  (no API key exists in dev/CI; the mock replays canned deltas/tool calls).
- Features whose backend doesn't exist in the harness stay as gracefully-degrading stubs:
  billing/credits, voice, pets, browser progress, worktree exit flow, rollback. The UI code
  remains; the RPCs resolve `{}` / events never fire.
- Provenance: clawcodex and dsh-TUI are MIT; attribution kept in `NOTICE.md`.

## Stages

### Stage 1 — Plan & scaffolding (this PR)
Deliverables: `docs/PLAN.md`, `docs/ARCHITECTURE.md`, `README.md`, `LICENSE`, `NOTICE.md`,
`.gitignore`.
Acceptance: docs merged to `main`.

### Stage 2 — Toolchain + vendored Ink fork
- Root `package.json` (`dsh-cctui`, ESM, React 19, `file:` dep on the fork), `tsconfig.json`,
  `vitest.config.ts`, CI workflow (typecheck + vitest).
- Vendor `packages/dsh-cctui-ink` unchanged (esbuild build, root `index.js` shims).
- Acceptance: fork builds; its own unit tests pass; a headless `renderSync` smoke test renders
  Box/Text into a fake stdout; CI green.

### Stage 3 — App source copy compiles; unit suite green (null gateway)
- Copy `src/` app + tests from ui-tui. Keep `gatewayTypes.ts` verbatim (it is the contract).
- Replace `gatewayClient.ts` with the same class surface backed by a **null backend** (no
  subprocess; RPCs resolve `{}`), keeping `SLASHES` catalog and pure helpers.
- Adapt/skip subprocess-specific tests with a documented list; everything else must pass.
- Acceptance: `tsc --noEmit` green; `vitest run` green; headless mount of `AppLayout` renders the
  banner/composer.

### Stage 4 — Harness plugin boots; core conversation loop works
- `src/harness/` adapter (the only dir importing `@deepseek-ai/*`): plugin entry
  (`name`/`inject`/`Config`/`apply`), TTY guard, exit funnel, React mount; `cordis.patch.yml` +
  dev `cordis.yml`; `HarnessGatewayClient` v1:
  - boot: agent create/resume → `gateway.ready` + `session.info`;
  - `prompt.submit` → `agent.followup()` / busy → `agent.steer()`; `session.interrupt` →
    `agent.cancel({kind:'user'})`;
  - `session/event` → `message.delta` (assistant/chunk text), `thinking.delta` (reasoning
    chunks), `tool.start` (tool/call), `tool.complete` (tool/result), `message.complete`
    (assistant/message + turn/end), busy state from `agent/status`.
- Scripted-LLM e2e: a tiny test-only cordis plugin registering a canned LLM adapter; PTY/headless
  boot asserts prompt→stream→tool→result renders in the transcript.
- Acceptance: `dsh --profile cc` (dev profile) shows the clawcodex UI and completes a scripted
  turn end-to-end.

### Stage 5 — Interaction gates
- `approval/request` waterfall → `approval.request` → ApprovalPrompt → outcomes
  (`allowed-once`/`rejected`); pairing with streamed `tool/call` via `callId`.
- `ctx.userQuestions.registerProvider` → `question.request` → AskUserQuestion panel; plan-review
  intent → PlanApprovalPrompt; plan mode via `ctx.planMode`.
- Permission modes: map clawcodex `default/plan/acceptEdits/bypassPermissions` onto harness
  approval policy + permission presets + plan mode; Shift+Tab cycle; footer badges.
- Acceptance: e2e scripts covering approve/deny, question answer/cancel, mode cycling.

### Stage 6 — Sessions
- `session.list`/`active_list`/`resume`/`create`/`close`/`delete`/`title`/`stats` over
  `ctx.agents`, `ctx.sessionPersistence`, `ctx.sessionProjections`; transcript rehydration from
  the session event log on resume; Ctrl+X switcher; `/clear`, `/new`, `/rename`, `/resume`.
- Acceptance: e2e resume of a prior scripted session shows the replayed transcript.

### Stage 7 — Slash commands, completions, model picker, config
- Merge local registry + `ctx.commands` catalog (`commands.catalog`, `slash.exec`,
  `command.dispatch`, `commands/change` refresh); `complete.slash` + `complete.path`.
- `/model` via `ctx.llm` catalog + `installModelSelection` + `ctx.agentDefaultModel`; `/compact`
  via `ctx.compaction`; `/status`, `/help`, `/usage`; `config.get/set` over a `dsh-cctui`
  settings namespace.
- Acceptance: e2e slash dispatch of a harness-registered command; model switch reflected in
  `session.info`.

### Stage 8 — Rich rendering & telemetry
- Structured diffs: tool `presentCall/presentResult` Diff views → `StructuredDiffPayload`
  (colorDiff pipeline); terminal views → tool trail output; `todo/write` → TodoPanel;
  token usage/context bar via `ctx.tokenMeter` + `resolveModelInfo`; subagent progress
  (`ctx.subagents` → `subagent.*`); goal indicator (`ctx.goals`); notices.
- Acceptance: e2e scripted Edit tool shows the diff card; todos render; context % moves.

### Stage 9 — Packaging, launcher, final QA
- `bin/dsh-cctui.js` launcher (profile bootstrap via `dsh plugin add`, version-skew guard,
  `NODE_ENV=production`), `install.sh`, packaged `files` list, README usage docs.
- Fresh-`DSH_HOME` install e2e from a local checkout; tag `v0.1.0`.
- Acceptance: `./install.sh` on a clean profile launches the TUI.

## Status log

- 2026-08-18: Stage 1 merged (#1). Stage 2 merged (#2) — fork vendored, 129 fork tests green.
- 2026-08-18: Stage 3 merged (#3) — verbatim app copy, 1879 tests green, AppLayout mounts headless.
- 2026-08-18: Stage 4 merged (#4) — harness gateway: real dsh boots the TUI as a cordis
  plugin; scripted end-to-end turn passes in a PTY e2e (also in CI).
- 2026-08-18: Stage 5 merged (#5) — gates: approvals (sandbox escalation e2e round-trip),
  user questions, plan review, permission-mode cycle.
- 2026-08-18: Stage 6 merged (#6) — sessions: live-agent registry, resume/activate with
  transcript rehydration, session list/close/title; two-phase resume e2e.
- 2026-08-18: Stage 7 merged (#7) — command bridge, /model + effort via llm catalog with
  persisted selection, token-meter usage/context bar.
- 2026-08-18: Stage 8 merged (#8) — presentation views (diff cards via structuredPatch,
  terminal/search views), todos rider, tool.generating, resume stats.
- 2026-08-18: Stage 9 merged (#9) — packaging: install.sh + bin launcher, installed-path
  e2e via real `dsh plugin add` (in CI), README.
- 2026-08-18: **v0.1.0 tagged — all nine stages complete.** The clawcodex TUI runs as a
  deepseek-harness plugin: conversation loop, tool trail + diff cards, approvals, questions,
  plan review, permission modes, sessions/resume, command bridge, model picker, usage
  metering, checkout-based install. Remaining ideas live in PORTING-NOTES (skipped upstream
  test skew, features with no harness backend).
- 2026-08-18: v0.2.1 — ocean-blue brand ramp + DeepSeek-blue theme hue; the app owns
  `~/.dsh-cctui` (no longer reads clawcodex's config); `/logo` persistence implemented;
  banner colors now regression-tested.
