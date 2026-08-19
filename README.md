# dsh-ccTUI

**Claude Code style TUI for Deepseek-Harness** — 🐳 ported from the clawcodex `ui-tui` and
packaged as a `dsh` bundle plugin (npm package `dsh-cctui`).

The full Claude-Code-style look, feel, and interactions — streaming markdown transcript, tool trail
with diff cards, approval and question prompts, plan review, session switcher and resume,
slash commands, model picker, context bar — running **in-process** against harness services
(`ctx.agents`, `session/event`, the approval waterfall, `ctx.userQuestions`, `ctx.commands`).

## Install

Requires Node ≥ 22.19, npm, pnpm, and the `dsh` CLI (`npm install -g @deepseek-ai/dsh`).

```sh
git clone https://github.com/agentforce314/dsh-ccTUI.git
cd dsh-ccTUI
./install.sh           # builds, then: dsh plugin --profile dsh-cctui add "$PWD"
dsh --profile dsh-cctui # launch (or ./bin/dsh-cctui.js)
```

Model/provider configuration comes from your dsh profile (`agent-default-model` settings or
an `- id: cctui` config override in the profile's `cordis.patch.yml`: `provider`, `model`,
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

## Configuration

Environment knobs use the `DSH_CCTUI_` prefix — e.g. `DSH_CCTUI_INLINE=0` (alternate screen
instead of inline scrollback), `DSH_CCTUI_THEME=light|dark`, `DSH_CCTUI_HOME` (data dir,
default `~/.dsh-cctui`), `DSH_CCTUI_FPS=1`. `CLAUDE_CODE_SCROLL_SPEED` is still honored as a
migration fallback for people coming from Claude Code.

## Development

```sh
npm install
npm run typecheck && npm test    # 149 files / ~1900 tests
npm run e2e                      # PTY e2e against a real dsh boot + scripted LLM
npm run e2e:install              # the real `dsh plugin add` install path
```

### Versioning

Each shipped change bumps the **patch** digit by 0.0.1 — `0.3.0` → `0.3.1` → `0.3.2`. Bump
`package.json` in the change's own commit, then tag `v<version>` on `main` after it merges.

Architecture and porting details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/PLAN.md](docs/PLAN.md), [docs/PORTING-NOTES.md](docs/PORTING-NOTES.md). The adapter
boundary (`src/harness/` is the only place that may import `@deepseek-ai/*`) is CI-gated.

## Provenance & license

MIT. Substantial portions are ported from the MIT-licensed clawcodex `ui-tui` (including its
forked Ink renderer) with integration patterns from the MIT-licensed dsh-TUI project — see
[NOTICE.md](NOTICE.md).
