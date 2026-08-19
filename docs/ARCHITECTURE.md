# Port Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ dsh (cordis runtime, profile "cc")                                 │
│  @deepseek-ai/dsh-base layer                                       │
│  + dsh-cctui cordis.patch.yml layer                               │
│    └─ plugin row: dsh-cctui                                       │
│        src/harness/index.ts   name/inject/Config/apply             │
│        src/harness/plugin.ts  TTY guard · agent resolve · mount    │
│        src/harness/client.ts  HarnessGatewayClient  ◄── the seam   │
│            │ implements the clawcodex gateway contract:            │
│            │   on('event') → GatewayEvent (44 types)               │
│            │   request(method, params) → Promise (75 methods)      │
│        ────┼───────── adapter boundary (only src/harness/* may     │
│            │          import @deepseek-ai/*)                       │
│        src/app/…  src/components/…  src/lib/…  src/domain/…        │
│            (copied from clawcodex ui-tui, backend-agnostic)        │
│        packages/dsh-cctui-ink  (forked Ink renderer, vendored)     │
└────────────────────────────────────────────────────────────────────┘
```

The original `gatewayClient.ts` spawned `clawcodex agent-server --stdio` (Python) and parsed
NDJSON. `HarnessGatewayClient` keeps the identical app-facing surface —
`{ start(), drain(), kill(), getLogTail(), publishLocalEvent(), request(), on('event'|'exit') }`
— but runs **in-process** against harness services. No subprocess, no wire format.

## Event mapping: harness → `GatewayEvent`

| Harness source | GatewayEvent emitted |
|---|---|
| agent created/resumed, tools listed via `ctx.tools`, model via agent options | `gateway.ready`, `session.info` |
| `session/event: assistant/chunk` (text delta) | `message.delta` |
| `session/event: assistant/chunk` (thinking delta) | `thinking.delta` / `reasoning.delta` |
| `session/event: tool/call {callId, name, arguments}` | `tool.start {tool_id, name, args_text}` |
| `session/event: tool/result {message, error?}` paired by `callId` | `tool.complete {tool_id, result_text, error, structured_diff?}` |
| `session/event: assistant/message` + `turn/end {reason}` | `message.complete {text, usage}` |
| `agent/status` `running`/`idle` | busy state (`message.start` analog / completion) |
| `approval/request` waterfall (parked, filtered by agent id) | `approval.request {tool_name, command}` |
| `userQuestions` provider `ask(request)` | `question.request {questions}` (plan-review intent → `plan.approval`) |
| `session/event: todo/write` | todos on `tool.*` / turn state |
| `session/event: session/title` | `session.info` title update |
| `session/event: llm/retry`, `agent/error` | `status.update` / `error` |
| `ctx.goals` state | `goal.state` |
| subagent runtime events | `subagent.start/progress/complete` |
| `ctx.tokenMeter` + `resolveModelInfo` | usage on `message.complete` / `session.stats` |
| never fired (no harness equivalent) | `billing.*`, `voice.*`, `browser.progress`, `sudo.request`, `secret.request` |

Tool presentation: harness tools expose `presentCall/presentResult` returning typed views
(`DiffCallView`, `TerminalResultView`, `SearchResultView`, …). The client converts Diff views
into clawcodex `StructuredDiffPayload {filePath, kind, hunks}` so `DiffView`/`colorDiff` render
unchanged, and terminal/search/read views into `result_text` for the tool trail.

## RPC mapping: `request(method, params)` → harness

| RPC | Harness implementation |
|---|---|
| `prompt.submit` | idle: `agent.followup(createUserMessage(...))`; busy per busy-input-mode: queue (TUI-local) / `agent.steer()` / interrupt+send |
| `session.steer` | `agent.steer()` |
| `session.interrupt` | `agent.cancel({kind: 'user'})` |
| `approval.respond` | settle parked `ApprovalRequest` with `allowed-once` / `rejected` |
| `question.respond` / `planApproval.respond` | resolve parked `AskUserQuestionRequest` |
| `permission.cycle` / `set_permission_mode` | approval policy + permission preset + `ctx.planMode` transitions |
| `session.create` | `ctx.agents.create({sessionId, meta: {cwd}, agentOptions})` |
| `session.resume` | `ctx.agents.resume({resumeSessionId, …})` + transcript rehydration from `agent.session.events` |
| `session.close` | dispose agent handle |
| `session.list` / `session.active_list` | `ctx.sessionPersistence` headers + projections (`title`, `sessionListMetadata`) / `ctx.agents.list()` |
| `session.title` | `ctx.sessionTitle` / projection |
| `session.clear` | new agent session (fresh sessionId) |
| `session.compress` | `ctx.compaction` |
| `commands.catalog` | local registry ∪ `ctx.commands.list(agent)` (locals win), refreshed on `commands/change` |
| `slash.exec` / `command.dispatch` | `ctx.commands.execute(agent, line, signal)` → `command/run`+`command/done` |
| `complete.slash` | catalog prefix match |
| `complete.path` | workspace fs walk (TUI-local) |
| `model.options` | `ctx.llm` advisory catalog + `ctx.agentDefaultModel.currentSelection()` |
| `set_model` (via dispatch) | `installModelSelection(agent.ctx, ref)`; persist via `ctx.agentDefaultModel` |
| `config.get` / `config.set` | `ctx.settings` namespace `dsh-cctui` (display prefs also mirrored in `~/.dsh-cctui/`) |
| `shell.exec` (`!cmd`) | TUI-local `child_process` (same as original — it never went to the backend) |
| `setup.status` | always `{ok}` (harness profile is the setup) |
| everything else | `Promise.resolve({})` until a stage implements it |

## Differences from the original, by design

- **In-process**: no gateway subprocess, no stderr ring from a child (the log ring now carries
  harness diagnostics); `gateway.start_timeout`/crash-recovery paths become loader errors.
- **Sessions are harness sessions**: JSONL persistence, projections, and resume come from the
  harness; the TUI's own `~/.clawcodex` config/history files move to `~/.dsh-cctui/`.
- **Permission model**: harness approvals are per-request `ask`/`never` + presets; the clawcodex
  mode names are preserved in the UI and mapped (see Stage 5).
- **Cost**: the harness meters tokens, not dollars; the cost segment renders token counts.

## Package layout (target)

```
dsh-cctui/
├── package.json            # "dsh": {"bundle": {"patch": "./cordis.patch.yml"}}, peerDeps @deepseek-ai/*
├── cordis.patch.yml        # real install path: config overrides + inserts over dsh-base
├── cordis.yml              # dev: full composition incl. scripted-LLM for e2e
├── bin/dsh-cctui.js       # launcher: profile bootstrap + skew guard (Stage 9)
├── packages/dsh-cctui-ink/ # vendored fork, unchanged (file: dependency)
├── src/
│   ├── harness/            # ONLY dir importing @deepseek-ai/* (adapter boundary)
│   │   ├── index.ts        # cordis plugin surface
│   │   ├── plugin.ts       # wiring: guards, agent resolve, React mount, exit funnel
│   │   ├── client.ts       # HarnessGatewayClient
│   │   └── …
│   ├── entry.tsx App.tsx gatewayTypes.ts theme.ts …   # copied app
│   ├── app/ components/ domain/ lib/ hooks/ content/ config/ protocol/
│   └── __tests__/
└── scripts/                # build, verify-boundary, e2e drivers
```

Integration patterns adopted from dsh-TUI (all battle-tested there): `NODE_ENV ??= 'production'`
before the first React import; teardown-vs-user-exit funnel; `DUPLICATE_PROVIDER`-tolerant
`userQuestions.registerProvider`; approval parking filtered by agent id with `next()` delegation;
row-level `inject` kept wider than code-level `inject`; adapter-boundary verify script.
