// Boot wiring for the TUI inside a dsh process — the plugin-mode equivalent
// of src/entry.tsx. Everything terminal-global (mode resets, graceful exit,
// memory monitor) stays here; React is mounted on the real process streams.
import { createElement } from 'react'

import type { Context } from '@deepseek-ai/cordis'

import type { Config } from './index.js'
import { HarnessGatewayClient } from './client.js'

export async function mountCcTui(ctx: Context, config: Config): Promise<void> {
  const allowNoTty = config.allowNoTty || process.env.DSH_CCTUI_ALLOW_NO_TTY === '1'

  if (!allowNoTty && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('dsh-cctui requires an interactive terminal (set allowNoTty for headless tests)')
  }

  // The dev react-reconciler records unbounded performance marks; production
  // is the only sane default inside a long-lived TUI process.
  process.env.NODE_ENV ??= 'production'

  // Must run before chalk/supports-color initialize anywhere downstream.
  await import('../lib/forceTruecolor.js')

  const [{ INLINE_MODE, TERMUX_TUI_MODE }, { resetTerminalModes }, { setupGracefulExit }, { startMemoryMonitor }, { openExternalUrl }] =
    await Promise.all([
      import('../config/env.js'),
      import('../lib/terminalModes.js'),
      import('../lib/gracefulExit.js'),
      import('../lib/memoryMonitor.js'),
      import('../lib/openExternalUrl.js')
    ])

  const FULLSCREEN = !INLINE_MODE

  if (!allowNoTty) {
    resetTerminalModes()
    process.on('exit', () => {
      resetTerminalModes(process.stdout, FULLSCREEN)
    })

    if (TERMUX_TUI_MODE || INLINE_MODE) {
      process.stdout.write('\n')
    } else {
      process.stdout.write('\x1b[2J\x1b[H\x1b[3J')
    }
  }

  const gw = new HarnessGatewayClient(ctx, {
    cwd: config.cwd,
    model: config.model,
    provider: config.provider,
    sessionId: config.sessionId
  })

  gw.start()

  setupGracefulExit({
    cleanups: [
      () => {
        if (!allowNoTty) {
          resetTerminalModes(process.stdout, FULLSCREEN)
        }

        return gw.kill('graceful-exit-cleanup')
      }
    ],
    onError: (scope, err) => {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)

      process.stderr.write(`dsh-cctui lifecycle ${scope}: ${message.slice(0, 2000)}\n`)
    },
    onSignal: signal => {
      if (!allowNoTty) {
        resetTerminalModes(process.stdout, FULLSCREEN)
      }

      process.stderr.write(`dsh-cctui lifecycle: received ${signal}\n`)
    }
  })

  const stopMemoryMonitor = startMemoryMonitor({
    onCritical: () => {
      process.stderr.write('dsh-cctui: exiting to avoid OOM; restart to recover\n')
      process.exit(137)
    },
    onHigh: () => {},
    onWarn: () => {}
  })

  process.on('beforeExit', () => stopMemoryMonitor())

  const [ink, { App }] = await Promise.all([import('@dsh-cctui/ink'), import('../App.js')])

  const instance = await ink.render(createElement(App, { gw }), {
    exitOnCtrlC: false,
    onHyperlinkClick: (url: string) => {
      openExternalUrl(url)
    }
  })

  ctx.effect(() => () => {
    try {
      gw.kill('plugin-teardown')
    } catch {
      // teardown is best effort
    }

    try {
      instance.unmount()
    } catch {
      // teardown is best effort
    }
  })
}
