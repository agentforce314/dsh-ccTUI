# dsh-cc-tui

A Claude-Code-style terminal UI for [deepseek-harness](https://deepseek-harness.github.io/deepseek-harness/),
ported from the clawcodex `ui-tui` and packaged as a `dsh` bundle plugin.

The full clawcodex look, feel, and interactions — streaming markdown transcript, tool trail
with diff cards, approval and question prompts, plan review, session switcher and resume,
slash commands, model picker, context bar — running **in-process** against harness services
(`ctx.agents`, `session/event`, the approval waterfall, `ctx.userQuestions`, `ctx.commands`).

## Install

Requires Node ≥ 22.19, npm, pnpm, and the `dsh` CLI (`npm install -g @deepseek-ai/dsh`).

```sh
git clone https://github.com/agentforce314/dsh-ccTUI.git
cd dsh-ccTUI
./install.sh          # builds, then: dsh plugin --profile cc-tui add "$PWD"
dsh --profile cc-tui  # launch (or ./bin/dsh-cc-tui.js)
```

Model/provider configuration comes from your dsh profile (`agent-default-model` settings or
an `- id: cc-tui` config override in the profile's `cordis.patch.yml`: `provider`, `model`,
`cwd`, `sessionId`).

## Highlights

- **Conversation loop**: streamed deltas render live; reasoning behind Ctrl+O/Ctrl+R density
  toggles; busy verbs and spinners; Esc interrupts (Ctrl+C never kills the app).
- **Tools**: Claude-style `⏺ Tool(args)` / `⎿ result` trail; write/edit diffs render as
  structured diff cards; sandbox-escalation approvals pop the approval box (`1` approve /
  `2`+Enter deny); todo lists pin under the busy line.
- **Sessions**: `/sessions` (Ctrl+X) lists live and persisted sessions; `/resume <id>`
  replays a persisted transcript; `/new`, `/title`, `/rename`.
- **Commands**: every harness `ctx.commands` entry (e.g. `/plan`, `/goal`) appears in the
  completion menu and dispatches through the harness; `/model` opens the picker backed by
  the llm catalog; `/effort`, `/context`, `/usage`, `/help`, `/status`.
- **Modes**: Shift+Tab cycles default → plan → bypassPermissions (mapped onto the harness
  plan-mode controller and approval policy).

## Development

```sh
npm install
npm run typecheck && npm test    # 149 files / ~1900 tests
npm run e2e                      # PTY e2e against a real dsh boot + scripted LLM
npm run e2e:install              # the real `dsh plugin add` install path
```

Architecture and porting details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/PLAN.md](docs/PLAN.md), [docs/PORTING-NOTES.md](docs/PORTING-NOTES.md). The adapter
boundary (`src/harness/` is the only place that may import `@deepseek-ai/*`) is CI-gated.

## Provenance & license

MIT. Substantial portions are ported from the MIT-licensed clawcodex `ui-tui` (including its
forked Ink renderer) with integration patterns from the MIT-licensed dsh-TUI project — see
[NOTICE.md](NOTICE.md).
