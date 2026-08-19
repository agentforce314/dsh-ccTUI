// HarnessGatewayClient translation unit tests: synthetic harness session
// events in, clawcodex GatewayEvents out — no real cordis tree needed.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GatewayEvent } from '../gatewayTypes.js'
import { HarnessGatewayClient } from '../harness/client.js'

type Listener = (...args: unknown[]) => void

const SESSION = { events: [] as unknown[], header: { createdAt: 100, cwd: '/tmp/w', id: 'cc-test-session', version: 1 }, marker: 'session' }

const TOOL_CARDS: Record<string, unknown> = {
  bash: { card: 'terminal', exitCode: 0, output: 'ran fine' },
  failing_bash: { card: 'terminal', exitCode: 1, output: 'ls: nope: No such file or directory\n' },
  fenced: { card: 'generic', content: [{ text: '```console\nboom\n```', type: 'text' }] },
  glob: { card: 'search', paths: ['src/a.ts', 'src/b.ts'], shape: 'paths', total: 2, truncated: false },
  glob_capped: { card: 'search', paths: ['src/a.ts'], shape: 'paths', total: 9, truncated: true },
  grep: {
    card: 'search',
    files: [
      { matches: [{ line: 'const a = 1', lineNumber: 3 }], path: 'src/a.ts' },
      { matches: [{ line: 'const a = 2', lineNumber: 7 }], path: 'src/b.ts' }
    ],
    shape: 'matches',
    total: 2,
    truncated: false
  },
  killed_bash: { card: 'terminal', output: 'partial', signal: 'SIGTERM' },
  web_fetch: { card: 'web', kind: 'fetch', statusCode: 200, truncated: false, url: 'https://example.com' },
  web_fetch_gone: { card: 'web', kind: 'fetch', statusCode: 404, truncated: false, url: 'https://example.com/x' },
  web_search: {
    card: 'web',
    kind: 'search',
    sources: [
      { title: 'deepseek-harness', url: 'https://github.com/deepseek-ai/deepseek-harness' },
      { url: 'https://example.com/untitled' }
    ],
    truncated: false
  },
  read_window: {
    card: 'read',
    lines: [
      { number: 8, text: 'import x' },
      { number: 9, text: '' },
      { number: 10, text: 'export const y = 1' }
    ],
    offset: 8,
    path: 'src/y.ts',
    totalLines: 40
  },
  write: { card: 'diff', diffs: [{ newText: 'line one\nline two\n', oldText: null, path: 'notes.txt' }] }
}

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
  const storedEvents = [
    { data: { content: [{ text: 'old prompt', type: 'text' }], id: 'u1', role: 'user', source: { kind: 'user' } }, seq: 1, time: 1, type: 'user/message' },
    { data: { arguments: '{"command":"ls"}', callId: 'c1', name: 'bash', step: 1, turn: 1 }, seq: 2, time: 2, type: 'tool/call' },
    { data: { message: { content: [{ text: 'old reply', type: 'text' }], id: 'a1', role: 'assistant', source: { kind: 'model' } }, step: 1, turn: 1 }, seq: 3, time: 3, type: 'assistant/message' },
    { data: { reason: { kind: 'completed' }, turn: 1 }, seq: 4, time: 4, type: 'turn/end' }
  ]
  const resumedAgent = {
    cancel: vi.fn(),
    followup: vi.fn(),
    id: 'cc-resumed-1',
    session: { events: storedEvents, header: { createdAt: 111, cwd: '/tmp/w', id: 'cc-resumed-1', version: 1 }, marker: 'resumed' },
    status: 'idle',
    steer: vi.fn()
  }
  const resumedHandle = { agent: resumedAgent, dispose: vi.fn(async () => {}) }
  const policies: Array<[unknown, string]> = []
  const planSets: Array<[unknown, boolean]> = []
  const providers: Array<{ ask: (r: unknown) => Promise<unknown> }> = []
  const ctx = {
    agents: {
      create: vi.fn(async () => handle),
      resume: vi.fn(async () => resumedHandle)
    },
    get: (name: string) => {
      if (name === 'tools') {
        return {
          // One entry per presentation card the real tools return. Like them,
          // every card is withheld on a failed call, so the error path renders
          // the tool's own message rather than an empty card.
          get: (toolName: string) => {
            const card = TOOL_CARDS[toolName]

            return card
              ? { presentResult: (_args: unknown, result: { isError: boolean }) => (result.isError ? undefined : card) }
              : undefined
          },
          schemas: () => [{ name: 'bash' }, { name: 'read' }]
        }
      }

      if (name === 'approval') {
        return { setPolicy: (a: unknown, policy: string) => policies.push([a, policy]) }
      }

      if (name === 'planMode') {
        return { set: (a: unknown, active: boolean) => planSets.push([a, active]) }
      }

      if (name === 'userQuestions') {
        return { registerProvider: (prov: { ask: (r: unknown) => Promise<unknown> }) => { providers.push(prov); return () => {} } }
      }

      if (name === 'commands') {
        return {
          execute: async (_a: unknown, line: string) => {
            // faithful to dsh-commands: the line must carry the leading slash
            if (!line.startsWith('/')) {
              return undefined
            }

            if (line.startsWith('/mycmd')) {
              return { result: { kind: 'success', text: `mycmd ran: ${line.slice(1)}` } }
            }

            if (line.startsWith('/bad')) {
              return { result: { kind: 'error', text: 'boom' } }
            }

            return undefined
          },
          list: () => [{ description: 'My command', input: { hint: '<text>' }, name: 'mycmd' }]
        }
      }

      if (name === 'llm') {
        return {
          listModels: async () => [{ id: 'mock-1' }, { id: 'mock-2' }],
          listProviders: () => [{ id: 'mock', name: 'Mock' }],
          resolveModelInfo: async () => ({ context: { contextWindow: 64000 }, reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })
        }
      }

      if (name === 'tokenMeter') {
        return { measure: () => ({ totalTokens: 3200 }) }
      }

      if (name === 'agentDefaultModel') {
        return { currentSelection: () => undefined, saveSelection: async () => {} }
      }

      if (name === 'sessionPersistence') {
        return {
          list: async () => [
            { createdAt: 50, id: 'cc-old-1', version: 1 },
            { createdAt: 90, id: 'cc-old-2', version: 1 }
          ]
        }
      }

      if (name === 'sessionTitle') {
        return {
          get: () => ({ title: 'existing title' }),
          rename: (_s: unknown, t: string) => ({ title: t })
        }
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

  return { agent, cancels, client, ctx, events, fire, followups, listeners, planSets, policies, providers, resumedAgent, resumedHandle, steers }
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

    expect(toolStart.payload).toMatchObject({ args_text: 'ls', context: 'ls', name: 'bash', tool_id: 'c1' })

    const toolDone = w.events[5] as Extract<GatewayEvent, { type: 'tool.complete' }>

    expect(toolDone.payload).toMatchObject({ name: 'bash', result_text: 'ran fine', tool_id: 'c1' })
    expect(toolDone.payload.error).toBeUndefined()

    const complete = w.events[6] as Extract<GatewayEvent, { type: 'message.complete' }>

    expect(complete.payload?.text).toBe('Hello')
    expect(complete.payload?.usage).toMatchObject({ calls: 1, input: 10, output: 5, total: 15 })
    expect(complete.payload?.session_turns).toBe(1)
  })

  it('gives every tool.start the salient argument its row renders in parens', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.events.length = 0

    w.fire('turn/start', { turn: 1 })
    w.fire('tool/call', {
      arguments: '{"file_path":"notes.txt","content":"alpha\\nbeta\\n"}',
      callId: 'w1',
      name: 'write',
      step: 1,
      turn: 1
    })

    const start = w.events.at(-1) as Extract<GatewayEvent, { type: 'tool.start' }>

    // `⏺ Write(notes.txt)`, never the file body that would bury it.
    expect(start.type).toBe('tool.start')
    expect(start.payload.context).toBe('notes.txt')
  })

  it('renders the tool’s own message on a failed call, not its error code', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.events.length = 0

    w.fire('turn/start', { turn: 1 })
    w.fire('tool/call', { arguments: '{"file_path":"gone.ts"}', callId: 'r1', name: 'read', step: 1, turn: 1 })
    w.fire('tool/result', {
      error: { code: 'FS_NOT_FOUND', name: 'FsError' },
      message: {
        content: [
          { content: [{ text: 'cannot read "gone.ts": not found', type: 'text' }], isError: true, toolCallId: 'r1', type: 'tool-result' }
        ]
      },
      step: 1,
      turn: 1
    })

    const done = w.events.at(-1) as Extract<GatewayEvent, { type: 'tool.complete' }>

    expect(done.payload.error).toBe('Error: cannot read "gone.ts": not found')
  })

  it('falls back to the harness error identity when the call failed silently', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.events.length = 0

    w.fire('turn/start', { turn: 1 })
    w.fire('tool/call', { arguments: '{}', callId: 'r2', name: 'read', step: 1, turn: 1 })
    w.fire('tool/result', {
      error: { code: 'FS_DENIED', name: 'FsError' },
      message: { content: [{ content: [], isError: true, toolCallId: 'r2', type: 'tool-result' }] },
      step: 1,
      turn: 1
    })

    const done = w.events.at(-1) as Extract<GatewayEvent, { type: 'tool.complete' }>

    expect(done.payload.error).toBe('Error: FsError: FS_DENIED')
  })

  it('treats a non-zero exit as a failed call, status first then the command’s output', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.events.length = 0

    w.fire('turn/start', { turn: 1 })
    w.fire('tool/call', { arguments: '{"command":"ls nope"}', callId: 'b9', name: 'failing_bash', step: 1, turn: 1 })
    w.fire('tool/result', {
      message: { content: [{ content: [{ text: 'raw', type: 'text' }], toolCallId: 'b9', type: 'tool-result' }] },
      step: 1,
      turn: 1
    })

    const done = w.events.at(-1) as Extract<GatewayEvent, { type: 'tool.complete' }>

    expect(done.payload.error).toBe('Error: Exit code 1\nls: nope: No such file or directory')
  })

  it('names the signal when a command was killed rather than exiting', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.events.length = 0

    w.fire('turn/start', { turn: 1 })
    w.fire('tool/call', { arguments: '{"command":"sleep 99"}', callId: 'b8', name: 'killed_bash', step: 1, turn: 1 })
    w.fire('tool/result', {
      message: { content: [{ content: [{ text: 'raw', type: 'text' }], toolCallId: 'b8', type: 'tool-result' }] },
      step: 1,
      turn: 1
    })

    const done = w.events.at(-1) as Extract<GatewayEvent, { type: 'tool.complete' }>

    expect(done.payload.error).toBe('Error: Killed by SIGTERM\npartial')
  })

  it('unwraps a generic card’s fenced body, which the ⎿ row renders literally', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.events.length = 0

    w.fire('turn/start', { turn: 1 })
    w.fire('tool/call', { arguments: '{}', callId: 'g1', name: 'fenced', step: 1, turn: 1 })
    w.fire('tool/result', {
      message: { content: [{ content: [{ text: 'raw', type: 'text' }], toolCallId: 'g1', type: 'tool-result' }] },
      step: 1,
      turn: 1
    })

    const done = w.events.at(-1) as Extract<GatewayEvent, { type: 'tool.complete' }>

    expect(done.payload.result_text).toBe('boom')
  })

  const runTool = async (name: string, args = '{}') => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.events.length = 0
    w.fire('turn/start', { turn: 1 })
    w.fire('tool/call', { arguments: args, callId: 'x1', name, step: 1, turn: 1 })
    w.fire('tool/result', {
      message: { content: [{ content: [{ text: 'raw model-facing text', type: 'text' }], toolCallId: 'x1', type: 'tool-result' }] },
      step: 1,
      turn: 1
    })

    return w.events.at(-1) as Extract<GatewayEvent, { type: 'tool.complete' }>
  }

  it('summarises a read as its line count, keeping the text for ctrl+o', async () => {
    const done = await runTool('read_window', '{"file_path":"src/y.ts","offset":8}')

    // upstream renders `⎿ Read 3 lines` and stops — the file's text is what the
    // MODEL was handed, and repeating it inline would bury the turn.
    expect(done.payload.result_text).toBe('Read 3 lines')
    expect(done.payload.result_raw).toBe(' 8  import x\n 9  \n10  export const y = 1')
  })

  it('counts a path search in files', async () => {
    const done = await runTool('glob', '{"pattern":"src/*.ts"}')

    expect(done.payload.result_text).toBe('Found 2 files\nsrc/a.ts\nsrc/b.ts')
  })

  it('counts a content search in lines, the way upstream words it', async () => {
    const done = await runTool('grep', '{"pattern":"const a"}')

    // a grep returns matched LINES, several of which may share a file
    expect(done.payload.result_text).toBe('Found 2 lines\nsrc/a.ts:3:const a = 1\nsrc/b.ts:7:const a = 2')
  })

  it('says how much of a capped search is on screen', async () => {
    const done = await runTool('glob_capped', '{"pattern":"**/*"}')

    // a partial list read as complete is how a reader concludes something is
    // not there when it is
    expect(done.payload.result_text).toBe('Found 9 files (showing 1)\nsrc/a.ts')
  })

  it('reports a fetch as the retrieval, not the page', async () => {
    const done = await runTool('web_fetch', '{"url":"https://example.com"}')

    // 'raw model-facing text' is 21 bytes; the page itself stays behind ctrl+o
    expect(done.payload.result_text).toBe('Received 21 bytes (200 OK)')
    expect(done.payload.result_raw).toBe('raw model-facing text')
  })

  it('names the status a fetch came back with', async () => {
    const done = await runTool('web_fetch_gone', '{"url":"https://example.com/x"}')

    expect(done.payload.result_text).toBe('Received 21 bytes (404 Not Found)')
  })

  it('accounts for a search’s round trip, keeping its sources for ctrl+o', async () => {
    const done = await runTool('web_search', '{"query":"deepseek harness"}')

    // what the search FOUND is the model's answer to give
    expect(done.payload.result_text).toMatch(/^Did 1 search in \d+s$/)
    expect(done.payload.result_raw).toBe(
      '2 sources\ndeepseek-harness — https://github.com/deepseek-ai/deepseek-harness\nhttps://example.com/untitled'
    )
  })

  it('marks a result flagged isError as failed even with no harness error identity', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.events.length = 0

    w.fire('turn/start', { turn: 1 })
    w.fire('tool/call', { arguments: '{}', callId: 'c9', name: 'read', step: 1, turn: 1 })
    w.fire('tool/result', {
      message: { content: [{ content: [{ text: 'boom', type: 'text' }], isError: true, toolCallId: 'c9', type: 'tool-result' }] },
      step: 1,
      turn: 1
    })

    const toolDone = w.events.at(-1) as Extract<GatewayEvent, { type: 'tool.complete' }>

    expect(toolDone.type).toBe('tool.complete')
    expect(toolDone.payload.error).toBe('Error: boom')
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

    // The requested id is freshly generated; the binding then adopts the
    // agent's own id (identical in a real harness, distinct in this fake).
    expect(String(createOpts.sessionId)).toMatch(/^cctui-/)
    expect(res.session_id).toBe(String(w.agent.id))
  })

  it('unmapped RPCs resolve to an empty object', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    await expect(w.client.request('billing.state', {})).resolves.toEqual({})
  })

  it('parks approval/request for its own agent and settles from approval.respond', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.fire('turn/start', { turn: 1 })
    w.fire('tool/call', { arguments: '{"command":"rm -rf x"}', callId: 'c1', name: 'bash', step: 1, turn: 1 })

    const handler = (w.listeners.get('approval/request') ?? [])[0]!
    const outcome = handler({ agent: w.agent, callId: 'c1', toolName: 'bash' }, () => Promise.resolve('unavailable')) as Promise<string>

    await settle()

    const ask = w.events.at(-1) as Extract<GatewayEvent, { type: 'approval.request' }>

    expect(ask.type).toBe('approval.request')
    expect(ask.payload).toMatchObject({ allow_permanent: false, command: 'rm -rf x', tool_name: 'bash' })

    await w.client.request('approval.respond', { choice: 'once' })
    await expect(outcome).resolves.toBe('allowed-once')

    // deny path
    const denied = handler({ agent: w.agent, callId: 'c1', toolName: 'bash' }, () => Promise.resolve('unavailable')) as Promise<string>

    await w.client.request('approval.respond', { choice: 'deny' })
    await expect(denied).resolves.toBe('rejected')
  })

  it('delegates approvals for other agents down the chain', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()

    const handler = (w.listeners.get('approval/request') ?? [])[0]!
    const outcome = await (handler({ agent: { other: true }, toolName: 'bash' }, () => Promise.resolve('unavailable')) as Promise<string>)

    expect(outcome).toBe('unavailable')
    expect(w.events.some(e => e.type === 'approval.request')).toBe(false)
  })

  it('serves user questions and maps answers back by question text', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()

    const provider = w.providers[0]!
    const answer = provider.ask({
      questions: [
        { id: 'q1', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }], question: 'Pick a color' },
        { id: 'q2', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }], question: 'Pick letters' }
      ]
    }) as Promise<{ answers: Array<{ custom?: string; id: string; selected: string[] }> }>

    await settle()

    const ask = w.events.at(-1) as Extract<GatewayEvent, { type: 'question.request' }>

    expect(ask.type).toBe('question.request')
    expect(ask.payload.questions).toHaveLength(2)

    await w.client.request('question.respond', {
      answers: { 'Pick a color': 'typed something', 'Pick letters': 'A, B, extra note' }
    })

    const got = await answer

    expect(got.answers).toEqual([
      { custom: 'typed something', id: 'q1', selected: [] },
      { custom: 'extra note', id: 'q2', selected: ['A', 'B'] }
    ])
  })

  it('maps plan-review intents onto plan.approval and honors approve/deny', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()

    const provider = w.providers[0]!
    const approve = provider.ask({
      questions: [{ detail: 'THE PLAN', id: 'p1', intent: { approve: 'Approve plan', kind: 'plan-review' }, options: [{ label: 'Approve plan' }, { label: 'Keep planning' }], question: 'Review' }]
    }) as Promise<{ answers: Array<{ id: string; selected: string[] }> }>

    await settle()

    const ask = w.events.at(-1) as Extract<GatewayEvent, { type: 'plan.approval' }>

    expect(ask.type).toBe('plan.approval')
    expect(ask.payload.plan).toBe('THE PLAN')

    await w.client.request('planApproval.respond', { choice: 'default' })

    const got = await approve

    expect(got.answers[0]).toEqual({ id: 'p1', selected: ['Approve plan'] })

    // deny with feedback
    const deny = provider.ask({
      questions: [{ detail: 'P2', id: 'p2', intent: { approve: 'Approve plan', kind: 'plan-review' }, question: 'Review' }]
    }) as Promise<{ answers: Array<{ custom?: string; id: string; selected: string[] }> }>

    await settle()
    await w.client.request('planApproval.respond', { choice: 'deny', feedback: 'tighten scope' })

    const rejected = await deny

    expect(rejected.answers[0]).toEqual({ custom: 'tighten scope', id: 'p2', selected: [] })
  })

  it('permission.cycle walks default → plan → bypassPermissions and drives services', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.events.length = 0

    await expect(w.client.request('permission.cycle', {})).resolves.toEqual({ mode: 'plan' })
    expect(w.planSets.at(-1)).toEqual([w.agent, true])

    await expect(w.client.request('permission.cycle', {})).resolves.toEqual({ mode: 'bypassPermissions' })
    expect(w.planSets.at(-1)).toEqual([w.agent, false])
    expect(w.policies.at(-1)).toEqual([w.agent, 'never'])

    await expect(w.client.request('permission.cycle', {})).resolves.toEqual({ mode: 'default' })
    expect(w.policies.at(-1)).toEqual([w.agent, 'ask'])
    expect(w.events.filter(e => e.type === 'permission.mode').map(e => (e as { payload: { mode: string } }).payload.mode)).toEqual([
      'plan',
      'bypassPermissions',
      'default'
    ])
  })

  it('session.resume rehydrates the stored log into transcript rows', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()

    const res = await w.client.request<{
      info?: { model: string }
      messages: Array<{ context?: string; name?: string; role: string; text?: string }>
      running: boolean
      session_id: string
    }>('session.resume', { session_id: 'cc-resumed-1' })

    expect((w.ctx.agents.resume as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect(res.session_id).toBe('cc-resumed-1')
    expect(res.running).toBe(false)
    expect(res.messages).toEqual([
      { role: 'user', text: 'old prompt' },
      { context: 'ls', name: 'bash', role: 'tool' },
      { role: 'assistant', text: 'old reply' }
    ])

    // the binding switched: submissions now reach the resumed agent
    await w.client.request('prompt.submit', { text: 'next' })
    expect(w.resumedAgent.followup).toHaveBeenCalledTimes(1)
  })

  it('session.active_list reflects live agents and the current binding', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    await w.client.request('session.resume', { session_id: 'cc-resumed-1' })

    const res = await w.client.request<{ sessions: Array<{ current?: boolean; id: string; status: string }> }>(
      'session.active_list',
      {}
    )

    const ids = res.sessions.map(s => s.id).sort()

    expect(ids).toEqual([String((w.ctx.agents.create as ReturnType<typeof vi.fn>).mock.calls[0]![0].sessionId), 'cc-resumed-1'].sort())
    expect(res.sessions.find(s => s.id === 'cc-resumed-1')?.current).toBe(true)
  })

  it('session.list serves persisted headers newest-first', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()

    const res = await w.client.request<{ sessions: Array<{ id: string; started_at: number }> }>('session.list', {})

    expect(res.sessions.map(s => s.id)).toEqual(['cc-old-2', 'cc-old-1'])
  })

  it('session.close disposes the live handle and session.title renames', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    await w.client.request('session.resume', { session_id: 'cc-resumed-1' })
    await w.client.request('session.close', { session_id: 'cc-resumed-1' })
    expect(w.resumedHandle.dispose).toHaveBeenCalledTimes(1)

    // rebind to the original agent for the title call
    const first = String((w.ctx.agents.create as ReturnType<typeof vi.fn>).mock.calls[0]![0].sessionId)

    await w.client.request('session.activate', { session_id: first })
    await expect(w.client.request('session.title', { title: 'My Task' })).resolves.toEqual({ title: 'My Task' })
    await expect(w.client.request('session.title', {})).resolves.toEqual({ title: 'existing title' })
  })

  it('merges harness commands into the catalog and completions', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()

    const catalog = await w.client.request<{ canon: Record<string, string>; hints: Record<string, string>; pairs: Array<[string, string]> }>('commands.catalog', {})

    expect(catalog.canon['/mycmd']).toBe('/mycmd')
    expect(catalog.hints['/mycmd']).toBe('<text>')
    expect(catalog.pairs.some(([n]) => n === '/mycmd')).toBe(true)

    const completion = await w.client.request<{ items: Array<{ text: string }> }>('complete.slash', { text: '/myc' })

    expect(completion.items.map(i => i.text)).toContain('/mycmd')
  })

  it('slash.exec bridges to harness commands and errors propagate', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()

    await expect(w.client.request('slash.exec', { command: 'mycmd ship it' })).resolves.toEqual({ output: 'mycmd ran: mycmd ship it' })
    await expect(w.client.request('slash.exec', { command: 'bad thing' })).rejects.toThrow('boom')
    await expect(w.client.request('slash.exec', { command: 'nosuch' })).rejects.toThrow('unknown command')
    await expect(w.client.request('command.dispatch', { arg: 'x', name: 'mycmd' })).resolves.toEqual({ output: 'mycmd ran: mycmd x', type: 'exec' })
  })

  it('slash.exec effort updates the live selection and session.info', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.events.length = 0

    await expect(w.client.request('slash.exec', { command: 'effort high' })).resolves.toEqual({ output: 'effort: high' })

    const info = w.events.find(e => e.type === 'session.info') as Extract<GatewayEvent, { type: 'session.info' }>

    expect(info.payload.reasoning_effort).toBe('high')
  })

  it('config.set model switches the route and reports provider', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.events.length = 0

    await expect(w.client.request('config.set', { key: 'model', value: 'mock-2' })).resolves.toMatchObject({
      ok: true,
      provider: 'mock',
      value: 'mock-2'
    })

    const info = w.events.find(e => e.type === 'session.info') as Extract<GatewayEvent, { type: 'session.info' }>

    expect(info.payload.model).toBe('mock-2')

    const opts = await w.client.request<{ model?: string; providers: Array<{ models: string[]; slug: string }> }>('model.options', {})

    expect(opts.model).toBe('mock-2')
    expect(opts.providers[0]).toMatchObject({ models: ['mock-1', 'mock-2'], slug: 'mock' })

    const efforts = await w.client.request<{ levels?: string[]; supported?: boolean }>('model.effort_options', {})

    expect(efforts).toMatchObject({ levels: ['low', 'high'], supported: true })
  })

  it('session.usage serves token-meter derived context numbers', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    await new Promise(resolve => setTimeout(resolve, 5))

    const usage = await w.client.request<{ context_max?: number; context_percent?: number; context_used?: number }>('session.usage', {})

    expect(usage.context_used).toBe(3200)
    expect(usage.context_max).toBe(64000)
    expect(usage.context_percent).toBe(5)
  })

  it('converts diff presentation views into structured_diff payloads', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.events.length = 0

    w.fire('turn/start', { turn: 1 })
    w.fire('tool/call', { arguments: '{"file_path":"notes.txt","content":"line one\\nline two\\n"}', callId: 'w1', name: 'write', step: 1, turn: 1 })
    w.fire('tool/result', {
      message: { content: [{ content: [{ text: 'wrote notes.txt', type: 'text' }], toolCallId: 'w1', type: 'tool-result' }] },
      step: 1,
      turn: 1
    })

    const done = w.events.at(-1) as Extract<GatewayEvent, { type: 'tool.complete' }>

    expect(done.type).toBe('tool.complete')
    expect(done.payload.structured_diff).toMatchObject({ filePath: 'notes.txt', kind: 'create' })
    expect(done.payload.structured_diff?.hunks[0]?.lines).toEqual(['+line one', '+line two'])
  })

  it('renders terminal presentation views and attaches pending todos', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.events.length = 0

    w.fire('turn/start', { turn: 1 })
    w.fire('tool/call', { arguments: '{"command":"true","description":"noop"}', callId: 'b1', name: 'bash', step: 1, turn: 1 })
    w.fire('todo/write', { todos: [{ content: 'first thing', status: 'pending' }] })
    w.fire('tool/result', {
      message: { content: [{ content: [{ text: 'raw', type: 'text' }], toolCallId: 'b1', type: 'tool-result' }] },
      step: 1,
      turn: 1
    })

    const done = w.events.at(-1) as Extract<GatewayEvent, { type: 'tool.complete' }>

    expect(done.payload.result_text).toBe('ran fine')
    expect(done.payload.todos).toEqual([{ content: 'first thing', status: 'pending' }])
  })

  it('announces tool.generating once per streamed call id', async () => {
    const w = makeWorld()

    w.client.start()
    await settle()
    w.events.length = 0

    w.fire('turn/start', { turn: 1 })
    w.fire('assistant/chunk', { chunk: { argumentsDelta: '{', id: 'g1', index: 0, name: 'bash', type: 'tool-call-delta' }, step: 1, turn: 1 })
    w.fire('assistant/chunk', { chunk: { argumentsDelta: '}', id: 'g1', index: 0, name: 'bash', type: 'tool-call-delta' }, step: 1, turn: 1 })

    expect(w.events.filter(e => e.type === 'tool.generating')).toHaveLength(1)
  })

  it('persists the /logo palette into the app config (not clawcodex\'s)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-cctui-logo-rpc-'))

    vi.stubEnv('DSH_CCTUI_HOME', home)

    try {
      const w = makeWorld()

      w.client.start()
      await settle()

      await expect(w.client.request('config.set', { key: 'logoColor', value: 'forest' })).resolves.toEqual({
        ok: true,
        value: 'forest'
      })

      const written = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { logoColor?: string }

      expect(written.logoColor).toBe('forest')

      const { readLogoColorSync } = await import('../lib/logoPalettes.js')

      expect(readLogoColorSync()).toBe('forest')

      // an unrelated key already in the file survives the write
      writeFileSync(join(home, 'config.json'), JSON.stringify({ keepMe: 1, logoColor: 'forest' }))
      await w.client.request('config.set', { key: 'logoColor', value: 'ocean' })

      const merged = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Record<string, unknown>

      expect(merged).toMatchObject({ keepMe: 1, logoColor: 'ocean' })
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { force: true, recursive: true })
    }
  })
})
