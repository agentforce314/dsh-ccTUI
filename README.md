# dsh-cc-tui

A Claude-Code-style terminal UI for [deepseek-harness](https://deepseek-harness.github.io/deepseek-harness/),
ported from the clawcodex `ui-tui` and packaged as a `dsh` bundle plugin.

> Status: under staged development — see [docs/PLAN.md](docs/PLAN.md) for the roadmap and
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the port works.

## What this is

- The clawcodex TUI's look, feel, and interactions — streaming markdown transcript, tool trail,
  approval/question prompts, slash commands, session switcher, model picker — running
  **in-process** as a deepseek-harness (cordis) plugin.
- Installed like any dsh bundle:

```sh
dsh plugin --profile cc add <this package>
dsh --profile cc
```

## Development

```sh
npm install
npm run typecheck
npm test
```

See `docs/` for the plan, architecture, and per-stage acceptance criteria.

## Provenance & license

MIT. Substantial portions are ported from the MIT-licensed clawcodex `ui-tui` (including its
forked Ink renderer) with integration patterns from the MIT-licensed dsh-TUI project — see
[NOTICE.md](NOTICE.md).
