import { PassThrough } from 'node:stream'

import { Box, renderSync, type ScrollBoxHandle, Text } from '@clawcodex/ink'
import React from 'react'
import { describe, expect, it } from 'vitest'

import { TranscriptScrollbar } from '../components/appChrome.js'
import { INLINE_MODE } from '../config/env.js'
import { stripAnsi } from '../lib/text.js'
import { DEFAULT_THEME } from '../theme.js'

/**
 * Regression: resizing the terminal blanked the whole transcript (reported in
 * the VS Code integrated terminal).
 *
 * Inline mode lays the tree out with `calculateLayout(columns)` and NO height
 * constraint, so the transcript ScrollBox sizes to its content. This scrollbar
 * is a ROW SIBLING of that ScrollBox and renders exactly `viewportHeight` rows
 * tall — and that value is LAST frame's `scrollViewportHeight`, written by the
 * renderer at paint time. A flex row stretches its children to the tallest one,
 * so a stale-tall bar stretches the ScrollBox; its inner wrapper (flexGrow:1)
 * fills the extra with blank rows; and the stretched height becomes the next
 * frame's `scrollViewportHeight`, re-rendering the bar at that same height. A
 * stable fixed point, not a transient.
 *
 * Widening the terminal re-wraps every row shorter, so the gap opens exactly
 * when the content shrinks: measured 161 → 102 rows at 60 → 110 columns on a
 * real PTY, with the ScrollBox pinned at 161. Those ~59 blank rows pushed the
 * transcript above the terminal viewport, where the resize repaint's
 * ERASE_SCROLLBACK (log-update `fullReset` → `clearTerminal`) wiped it from
 * scrollback — so the transcript was gone, not merely scrolled off.
 *
 * ROWS, not glyphs, is the thing to assert. Inline mode always satisfies
 * `total <= vp`, so the bar takes its !scrollable branch and paints a column of
 * SPACES: invisible, but 40 rows tall, and height is the whole defect. Pinning
 * "draws no bar characters" would pass against the bug.
 *
 * The end-to-end proof is a PTY + pyte run against the real binary: blank rows
 * after a 60→110 resize went 20-22/30 → 7-8/30. Only WIDENING exhibits it —
 * narrowing grows the content past the stale-short bar, so there is no gap to
 * open — and that run needs a live agent-server, so it can't happen here.
 *
 * What this file pins is the guard, not the loop: reproducing the loop needs a
 * real TTY resize, which renderSync over a PassThrough does not deliver.
 */

const SENTINEL = 'BAR_PROBE'

/** Reports a stale-tall viewport, exactly as it would one frame after a widen. */
function staleTallHandle(viewportHeight: number, scrollHeight: number): ScrollBoxHandle {
  return {
    getFreshScrollHeight: () => scrollHeight,
    getLastManualScrollAt: () => 0,
    getPendingDelta: () => 0,
    getScrollHeight: () => scrollHeight,
    getScrollTop: () => 0,
    getViewportHeight: () => viewportHeight,
    getViewportTop: () => 0,
    isSticky: () => true,
    scrollBy: () => {},
    scrollTo: () => {},
    scrollToBottom: () => {},
    scrollToElement: () => {},
    setClampBounds: () => {},
    subscribe: () => () => {}
  } as unknown as ScrollBoxHandle
}

/**
 * Rows the bar occupies, measured from a frame we KNOW was painted.
 *
 * A fixed settle would be load-dependent, and here it would fail open: with the
 * fix the bar paints nothing, so "no rows yet" is indistinguishable from "not
 * rendered yet" and a slow CI box would turn this green against the bug. The
 * sentinel is a positive signal — once it appears a frame has flushed, and the
 * bar's contribution to that frame's height is exactly what we measure.
 */
async function paintedRows(bar: null | { scrollHeight: number; viewportHeight: number }) {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const stderr = new PassThrough()
  let out = ''

  stdout.on('data', (c: Buffer) => {
    out += c.toString()
  })
  Object.assign(stdout, { columns: 80, isTTY: true, rows: 24 })
  Object.assign(stdin, { isTTY: true, ref: () => {}, setRawMode: () => {}, unref: () => {} })

  const app = renderSync(
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(Text, null, SENTINEL),
      bar
        ? React.createElement(TranscriptScrollbar, {
            scrollRef: { current: staleTallHandle(bar.viewportHeight, bar.scrollHeight) },
            t: DEFAULT_THEME
          })
        : null
    ),
    {
      exitOnCtrlC: false,
      patchConsole: false,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream
    }
  )

  // Two conditions, both required. The sentinel proves a frame was flushed —
  // without it, "no rows yet" and "not rendered yet" are indistinguishable and
  // the assertion would fail OPEN against the bug. The quiet period then proves
  // the frame is COMPLETE: ink writes incrementally, so measuring on first
  // paint can catch the sentinel in one chunk and the bar's rows in a later
  // one. Both renders settle the same way, which is what makes their row counts
  // comparable.
  const deadline = Date.now() + 15_000
  let quiet = 0
  let lastSize = -1

  while (Date.now() < deadline) {
    if (out.length === lastSize && stripAnsi(out).includes(SENTINEL)) {
      if (++quiet >= 5) {
        break
      }
    } else {
      quiet = 0
      lastSize = out.length
    }

    await new Promise(resolve => setTimeout(resolve, 20))
  }

  app.unmount()

  const painted = stripAnsi(out)

  if (!painted.includes(SENTINEL) || quiet < 5) {
    throw new Error('renderer never settled a frame')
  }

  return (painted.match(/\n/g) ?? []).length
}

describe('TranscriptScrollbar in inline mode', () => {
  it('is the default mode, so the guard below is the one that ships', () => {
    expect(INLINE_MODE).toBe(true)
  })

  it('adds no rows when the content fits — the real inline case', async () => {
    // total === vp is what inline mode always produces: the ScrollBox sizes to
    // its content, so it never scrolls. Pre-fix this painted 40 rows of spaces
    // and stretched the transcript by the same 40 rows.
    const baseline = await paintedRows(null)

    expect(await paintedRows({ scrollHeight: 40, viewportHeight: 40 })).toBe(baseline)
  })

  it('adds no rows even if it somehow believes it is scrollable', async () => {
    // Defence in depth: a stale snapshot could report total > vp mid-resize,
    // which pre-fix drew 40 rows of ┃/│ glyphs.
    const baseline = await paintedRows(null)

    expect(await paintedRows({ scrollHeight: 120, viewportHeight: 40 })).toBe(baseline)
  })
})
