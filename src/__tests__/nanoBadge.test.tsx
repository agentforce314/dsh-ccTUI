// Nano badge in the status line: `modelNano` renders a "nano" chip beside
// the model name (same slot pattern as the `fast` chip), driven by the
// backend's system/init `nano` field (agent_server.py emit_init).
import React from 'react'
import { describe, expect, it } from 'vitest'

import { StatusRule } from '../components/appChrome.js'
import { infoAfterModelSwitch } from '../domain/modelSwitch.js'
import { buildSessionStatsLine } from '../lib/sessionStats.js'
import { DEFAULT_THEME } from '../theme.js'
import type { SessionInfo } from '../types.js'

type ReactNodeLike = React.ReactNode

const textContent = (node: ReactNodeLike): string => {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return ''
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  if (Array.isArray(node)) {
    return node.map(textContent).join('')
  }

  if (React.isValidElement(node)) {
    return textContent(node.props.children)
  }

  return ''
}

const baseProps = {
  bgCount: 0,
  busy: false,
  cols: 100,
  cwdLabel: '~/repo',
  liveSessionCount: 0,
  model: 'deepseek-v4-flash',
  sessionStartedAt: null,
  status: 'ready',
  statusColor: DEFAULT_THEME.color.ok,
  t: DEFAULT_THEME,
  turnStartedAt: null,
  usage: { context_max: 128_000, context_percent: 10, context_used: 12_800, total: 12_800 },
  voiceLabel: ''
}

describe('nano badge', () => {
  it('renders a nano chip beside the model name when modelNano is set', () => {
    const text = textContent(StatusRule({ ...baseProps, modelNano: true }))

    expect(text).toContain('v4 flash nano')
  })

  it('renders no nano chip by default', () => {
    const text = textContent(StatusRule({ ...baseProps }))

    expect(text).toContain('v4 flash')
    expect(text).not.toContain('nano')
  })

  it('keeps chip order model → effort → fast → nano', () => {
    const text = textContent(
      StatusRule({
        ...baseProps,
        model: 'opus-4.8',
        modelFast: true,
        modelNano: true,
        modelReasoningEffort: 'high'
      })
    )

    expect(text).toContain('opus 4.8 high fast nano')
  })

  it('survives a mid-session model switch (infoAfterModelSwitch spreads info)', () => {
    const info: SessionInfo = { model: 'deepseek-v4-flash', nano: true, skills: {}, tools: {} }
    const next = infoAfterModelSwitch(info, 'deepseek-v4-pro', 'deepseek')

    expect(next.nano).toBe(true)
    expect(next.model).toBe('deepseek-v4-pro')
  })

  it('rides the model segment of the session-stats line and is never shed', () => {
    const base = {
      cwd: '/home/u/very/long/path/to/some/deeply/nested/project',
      model: 'deepseek-v4-flash',
      nano: true,
      provider: 'deepseek',
      stats: { costUsd: 0.0042, inputTokens: 54_847, outputTokens: 2_421, turns: 7 }
    }

    expect(buildSessionStatsLine({ ...base, cols: 200 })).toContain('deepseek-v4-flash nano')
    // Narrow terminal: cwd sheds, the nano chip must survive.
    const narrow = buildSessionStatsLine({ ...base, cols: 60 })

    expect(narrow).toContain('deepseek-v4-flash nano')
    expect(buildSessionStatsLine({ ...base, cols: 200, nano: undefined })).not.toContain('nano')
  })
})
