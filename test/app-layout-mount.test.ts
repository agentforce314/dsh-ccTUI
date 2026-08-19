// Stage 3 acceptance: the copied app's full AppLayout mounts headlessly and
// renders transcript rows + the composer. Prop shapes mirror scripts/profile-tui.mjs.
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

const noop = () => {}

class Sink {
  columns = 100
  rows = 36
  isTTY = true
  output = ''
  listeners = new Map<string, unknown>()
  write(chunk: unknown) {
    this.output += String(chunk ?? '')
    return true
  }
  on(event: string, fn: unknown) {
    this.listeners.set(event, fn)
    return this
  }
  off(event: string) {
    this.listeners.delete(event)
    return this
  }
  once(event: string, fn: unknown) {
    this.listeners.set(event, fn)
    return this
  }
  removeListener(event: string) {
    this.listeners.delete(event)
    return this
  }
}

describe('AppLayout headless mount', () => {
  it('renders intro, transcript rows, and the composer prompt', async () => {
    const [{ render }, { AppLayout }, { GatewayProvider }, { resetOverlayState }, { resetTurnState }, { resetUiState }] = await Promise.all([
      import('@dsh-cctui/ink'),
      import('../src/components/appLayout.js'),
      import('../src/app/gatewayContext.js'),
      import('../src/app/overlayStore.js'),
      import('../src/app/turnStore.js'),
      import('../src/app/uiStore.js')
    ])
    resetUiState()
    resetTurnState()
    resetOverlayState()

    const historyItems = [
      { kind: 'intro', role: 'system', text: '', info: { model: 'test-model', tools: {}, skills: {}, version: 'test' } },
      { role: 'user', text: 'hello from the user' },
      { role: 'assistant', text: 'a ported transcript row' }
    ]
    const scrollRef = {
      current: {
        getScrollTop: () => 0,
        getPendingDelta: () => 0,
        getScrollHeight: () => 12,
        getViewportHeight: () => 24,
        getViewportTop: () => 0,
        isSticky: () => true,
        subscribe: () => () => {},
        scrollBy: noop,
        scrollTo: noop,
        scrollToBottom: noop,
        setClampBounds: noop,
        getLastManualScrollAt: () => 0
      }
    }
    const props = {
      actions: { answerApproval: noop, answerClarify: noop, answerSecret: noop, answerSudo: noop, onModelSelect: noop, resumeById: noop, setStickyPrompt: noop },
      composer: { cols: 100, compIdx: 0, completions: [], empty: true, handleTextPaste: () => null, input: '', pagerPageSize: 10, queueEditIdx: null, queuedDisplay: [], submit: noop, updateInput: noop },
      mouseTracking: false,
      progress: {
        activity: [], outcome: '', reasoning: '', reasoningActive: false, reasoningStreaming: false, reasoningTokens: 0,
        showProgressArea: false, showStreamingArea: false, streamPendingTools: [], streamSegments: [], streaming: '',
        subagents: [], toolTokens: 0, tools: [], turnTrail: [], todos: []
      },
      status: { cwdLabel: '~/repo', goodVibesTick: 0, sessionStartedAt: Date.now(), showStickyPrompt: false, statusColor: '#98c379', stickyPrompt: '', turnStartedAt: 0, voiceLabel: 'voice off' },
      transcript: {
        historyItems,
        scrollRef,
        virtualHistory: {
          bottomSpacer: 0,
          end: historyItems.length,
          measureRef: () => noop,
          offsets: historyItems.map((_, i) => i * 4),
          start: 0,
          topSpacer: 0
        },
        virtualRows: historyItems.map((msg, index) => ({ index, key: `m${index}`, msg }))
      }
    }

    const stdout = new Sink()
    const stdin = { isTTY: true, setRawMode: noop, on: noop, off: noop, once: noop, removeListener: noop, resume: noop, pause: noop }
    const { EventEmitter } = await import('node:events')
    const fakeGw = Object.assign(new EventEmitter(), {
      request: async () => ({}),
      publishLocalEvent: noop,
      getLogTail: () => [],
      drain: noop,
      kill: noop
    })
    const services = { gw: fakeGw, rpc: async () => null }
    const instance = await render(createElement(GatewayProvider as never, { value: services } as never, createElement(AppLayout as never, props as never)), {
      // @ts-expect-error test streams stand in for process streams
      stdout,
      stdin,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false
    })
    await new Promise(resolve => setTimeout(resolve, 150))
    instance.unmount()

    // Single-word assertions: the renderer emits inter-word padding as cursor moves.
    expect(stdout.output).toContain('hello')
    expect(stdout.output).toContain('ported')
    expect(stdout.output).toContain('❯')
  })
})
