// HarnessGatewayClient translation unit tests: synthetic harness session
// events in, clawcodex GatewayEvents out — no real cordis tree needed.
import { describe, expect, it, vi } from 'vitest'

import type { GatewayEvent } from '../gatewayTypes.js'
import { HarnessGatewayClient } from '../harness/client.js'

type Listener = (...args: unknown[]) => void

const SESSION = { marker: 'session' }

function makeWorld() {
  const listeners = new Map<string, Listener[]>()
  const followups: unknown[] = []
  const steers: unknown[] = []
  const cancels: unknown[] = []
  const agent = {
    followup: (m: unknown) => followups.push(m),
    steer: (m: unknown) => steers.push(m),
    cancel: (c: unknown) => cancels.push(c),
    id: 'cc-test-session',
    session: SESSION,
    status: 'idle'
  }
  const handle = { agent, dispose: vi.fn(async () => {}) }
  const ctx = {
    agents: {
      create: vi.fn(async () => handle)
    },
    get: (name: string) => {
      if (name === 'tools') {
        return { schemas: () => [{ name: 'bash' }, { name: 'read' }] }
      }

      return undefined
    },
    on: (name: string, fn: Listener) => {
      const arr = listeners.get(name) ?? []

      arr.push(fn)
      listeners.set(name, arr)

      return () => {}
    }
  }
  const client = new HarnessGatewayClient(ctx as never, { cwd: '/tmp/w', model: 'mock-1', provider: 'mock' })
  const events: GatewayEvent[] = []

  client.on('event', ev => events.push(ev as GatewayEvent))
  client.drain()

  const fire = (type: string, data: unknown) => {
    for (const fn of listeners.get('session/event') ?? []) {
      fn(SESSION, { data, seq: 0, time: 0, type })
    }
  }

  return { agent, cancels, client, ctx, events, fire, followups, steers }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('HarnessGatewayClient', () => {
  it('start() creates the agent and emits gateway.ready + session.info', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()

    expect((w.ctx.agents.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect(w.events.map(e => e.type)).toEqual(['gateway.ready', 'session.info'])

    const info = w.events[1] as Extract<GatewayEvent, { type: 'session.info' }>

    expect(info.payload.model).toBe('mock-1')
    expect(info.payload.tools).toEqual({ harness: ['bash', 'read'] })
  })

  it('translates a full streamed turn with a tool call', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.events.length = 0

    w.fire('turn/start', { turn: 1 })
    w.fire('assistant/chunk', { chunk: { index: 0, text: 'Hel', type: 'text-delta' }, step: 1, turn: 1 })
    w.fire('assistant/chunk', { chunk: { index: 0, text: 'lo', type: 'text-delta' }, step: 1, turn: 1 })
    w.fire('assistant/chunk', { chunk: { index: 0, text: 'why', type: 'reasoning-delta' }, step: 1, turn: 1 })
    w.fire('tool/call', { arguments: '{"command":"ls"}', callId: 'c1', name: 'bash', step: 1, turn: 1 })
    w.fire('tool/result', {
      message: { content: [{ content: [{ text: 'file.txt', type: 'text' }], toolCallId: 'c1', type: 'tool-result' }] },
      step: 1,
      turn: 1
    })
    w.fire('assistant/message', {
      message: { content: [{ text: 'Hello', type: 'text' }], id: 'm1', role: 'assistant', source: { kind: 'model' } },
      step: 1,
      turn: 1,
      usage: { inputTokens: 10, outputTokens: 5 }
    })
    w.fire('turn/end', { reason: { kind: 'completed' }, turn: 1 })

    const types = w.events.map(e => e.type)

    expect(types).toEqual([
      'message.start',
      'message.delta',
      'message.delta',
      'thinking.delta',
      'tool.start',
      'tool.complete',
      'message.complete'
    ])

    const toolStart = w.events[4] as Extract<GatewayEvent, { type: 'tool.start' }>

    expect(toolStart.payload).toMatchObject({ args_text: 'ls', name: 'bash', tool_id: 'c1' })

    const toolDone = w.events[5] as Extract<GatewayEvent, { type: 'tool.complete' }>

    expect(toolDone.payload).toMatchObject({ name: 'bash', result_text: 'file.txt', tool_id: 'c1' })
    expect(toolDone.payload.error).toBeUndefined()

    const complete = w.events[6] as Extract<GatewayEvent, { type: 'message.complete' }>

    expect(complete.payload?.text).toBe('Hello')
    expect(complete.payload?.usage).toMatchObject({ calls: 1, input: 10, output: 5, total: 15 })
    expect(complete.payload?.session_turns).toBe(1)
  })

  it('marks failed tool results with an error', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.events.length = 0

    w.fire('turn/start', { turn: 1 })
    w.fire('tool/call', { arguments: '{}', callId: 'c9', name: 'bash', step: 1, turn: 1 })
    w.fire('tool/result', {
      error: { code: 'EXIT_1', name: 'ToolError' },
      message: { content: [{ content: [{ text: 'boom', type: 'text' }], isError: true, toolCallId: 'c9', type: 'tool-result' }] },
      step: 1,
      turn: 1
    })

    const toolDone = w.events.at(-1) as Extract<GatewayEvent, { type: 'tool.complete' }>

    expect(toolDone.type).toBe('tool.complete')
    expect(toolDone.payload.error).toBe('ToolError: EXIT_1')
  })

  it('routes prompt.submit/steer/interrupt to the agent', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()

    await w.client.request('prompt.submit', { text: 'hi there' })
    expect(w.followups).toHaveLength(1)

    const msg = w.followups[0] as { content: Array<{ text: string; type: string }>; role: string; source: { kind: string } }

    expect(msg.role).toBe('user')
    expect(msg.content).toEqual([{ text: 'hi there', type: 'text' }])
    expect(msg.source.kind).toBe('user')

    await w.client.request('session.steer', { text: 'change course' })
    expect(w.steers).toHaveLength(1)

    await w.client.request('session.interrupt', {})
    expect(w.cancels).toEqual([{ kind: 'user' }])
  })

  it('session.create resolves with the created session id after readiness', async () => {
    const w = makeWorld()

    w.client.start()

    const res = await w.client.request<{ session_id: string }>('session.create', {})
    const createOpts = (w.ctx.agents.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { sessionId: unknown }

    expect(res.session_id).toBe(String(createOpts.sessionId))
    expect(res.session_id).toMatch(/^cc-tui-/)
  })

  it('unmapped RPCs resolve to an empty object', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    await expect(w.client.request('billing.state', {})).resolves.toEqual({})
  })
})
