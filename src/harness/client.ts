// HarnessGatewayClient — the deepseek-harness replacement for the clawcodex
// gateway subprocess. It subclasses GatewayClient so the entire app keeps its
// exact `gw` contract (EventEmitter of GatewayEvent + request()), but start()
// creates an in-process harness Agent instead of spawning Python, and every
// emission is translated from harness `session/event` records.
//
// Boundary rule: src/harness/ is the ONLY directory allowed to import
// @deepseek-ai/* (see docs/ARCHITECTURE.md).
import { randomUUID } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, type ContentBlock, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'

import { GatewayClient, SLASHES } from '../gatewayClient.js'
import type { SessionInfo, Usage } from '../types.js'

export interface HarnessClientOptions {
  cwd?: string
  model?: string
  provider?: string
  sessionId?: string
}

type ModelRoute = ModelSelection

const textOf = (blocks: readonly ContentBlock[] | undefined, kinds: ReadonlyArray<ContentBlock['type']> = ['text']): string => {
  if (!blocks) {
    return ''
  }

  const out: string[] = []

  for (const b of blocks) {
    if ((kinds as readonly string[]).includes(b.type) && 'text' in b && typeof b.text === 'string') {
      out.push(b.text)
    }
  }

  return out.join('')
}

const prettyArgs = (raw: string): string => {
  try {
    const parsed = JSON.parse(raw)

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>)

      if (entries.length === 1 && typeof entries[0]![1] === 'string') {
        return entries[0]![1] as string
      }

      return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')
    }

    return raw
  } catch {
    return raw
  }
}

export class HarnessGatewayClient extends GatewayClient {
  private readonly ctx: Context
  private readonly opts: HarnessClientOptions

  private agent: Agent | null = null
  private handle: AgentHandle | null = null
  private disposers: Array<() => void> = []
  private selection: ModelSelectionRef = { current: undefined, assembled: undefined }

  private harnessReady: Promise<void>
  private harnessReadyResolve!: () => void
  private startFailed: string | null = null

  private sid = ''
  private info: SessionInfo | null = null

  // per-turn accumulation
  private turnStarted = false
  private turnText: string[] = []
  private turnReasoning: string[] = []
  private msgStartedHarness = false
  private callNames = new Map<string, string>()
  private callStarted = new Map<string, number>()
  private usageTotals: Usage = { calls: 0, input: 0, output: 0, total: 0 }
  private turnCount = 0
  private permissionMode = 'default'

  constructor(ctx: Context, opts: HarnessClientOptions = {}) {
    super()
    this.ctx = ctx
    this.opts = opts
    this.harnessReady = new Promise<void>(resolve => {
      this.harnessReadyResolve = resolve
    })
  }

  // ── lifecycle ──────────────────────────────────────────────────────────
  override start(): void {
    void this.init().catch(err => {
      this.startFailed = err instanceof Error ? err.message : String(err)
      this.publishLocalEvent({ payload: { message: `harness agent failed to start: ${this.startFailed}` }, type: 'error' })
      this.harnessReadyResolve()
    })
  }

  private async init(): Promise<void> {
    const loader = this.ctx.get('loader') as { await?: () => Promise<unknown> } | undefined

    await loader?.await?.()

    const route = this.resolveRoute()
    const cwd = this.opts.cwd ?? process.env.CLAWCODEX_WORKSPACE ?? process.env.CLAWCODEX_CWD ?? process.cwd()
    const sessionId = SessionId(this.opts.sessionId ?? `cc-tui-${randomUUID()}`)

    this.selection = { assembled: undefined, current: route }

    const handle = await this.ctx.agents.create({
      agentOptions: route ? { model: route.model, provider: route.provider } : {},
      meta: { cwd },
      sessionId,
      setup: agentCtx => {
        installModelSelection(agentCtx, this.selection)
      }
    })

    this.handle = handle
    this.agent = handle.agent
    this.sid = String(sessionId)
    this.bindAgent(handle.agent)
    this.info = this.buildSessionInfo(route, cwd)
    this.harnessReadyResolve()
    this.publishLocalEvent({ session_id: this.sid, type: 'gateway.ready' })
    this.publishLocalEvent({ payload: this.info, session_id: this.sid, type: 'session.info' })
  }

  private resolveRoute(): ModelRoute | undefined {
    if (this.opts.provider && this.opts.model) {
      return { model: this.opts.model, provider: this.opts.provider }
    }

    const defaults = this.ctx.get('agentDefaultModel') as
      | { currentSelection?: () => { model?: string; provider?: string; reasoningEffort?: string } | undefined }
      | undefined
    const sel = defaults?.currentSelection?.()

    if (sel?.provider && sel.model) {
      return { model: sel.model, provider: sel.provider, reasoningEffort: sel.reasoningEffort } as ModelRoute
    }

    return undefined
  }

  private buildSessionInfo(route: ModelRoute | undefined, cwd: string): SessionInfo {
    let toolNames: string[] = []

    try {
      const tools = this.ctx.get('tools') as { schemas?: (scope?: unknown) => Array<{ name: string }> } | undefined

      toolNames = (tools?.schemas?.() ?? []).map(t => t.name).sort()
    } catch {
      toolNames = []
    }

    return {
      cwd,
      model: route ? route.model : '(default)',
      permission_mode: this.permissionMode,
      reasoning_effort: route?.reasoningEffort,
      skills: {},
      tools: toolNames.length ? { harness: toolNames } : {},
      version: 'dsh'
    }
  }

  private bindAgent(agent: Agent): void {
    this.disposers.push(
      this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
        if (session !== agent.session) {
          return
        }

        this.onSessionEvent(event)
      }) as () => void
    )
    this.disposers.push(
      this.ctx.on('agent/status', ({ agent: subject, status }: { agent: Agent; status: 'idle' | 'running' }) => {
        if (subject !== agent) {
          return
        }

        if (status === 'idle' && this.turnStarted) {
          // Safety net: a turn that ends without a turn/end record (dispose,
          // hard error) still has to release the composer.
          this.finishTurn()
        }
      }) as () => void
    )
  }

  // ── session/event → GatewayEvent translation ──────────────────────────
  private onSessionEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start': {
        this.turnStarted = true
        this.turnText = []
        this.turnReasoning = []
        this.msgStartedHarness = false
        break
      }

      case 'assistant/chunk': {
        const { chunk } = (event as SessionEvent<'assistant/chunk'>).data

        this.onChunk(chunk)
        break
      }

      case 'assistant/message': {
        const { message, usage } = (event as SessionEvent<'assistant/message'>).data
        const text = textOf(message.content, ['text'])

        if (text) {
          this.turnText.push(text)
        }

        const reasoning = textOf(message.content, ['reasoning'])

        if (reasoning) {
          this.turnReasoning.push(reasoning)
        }

        if (usage) {
          this.addUsage(usage)
        }

        break
      }

      case 'tool/call': {
        const { callId, name, arguments: rawArgs } = (event as SessionEvent<'tool/call'>).data
        const id = String(callId)

        this.callNames.set(id, name)
        this.callStarted.set(id, Date.now())
        this.publishLocalEvent({
          payload: { args_text: prettyArgs(rawArgs), name, tool_id: id },
          session_id: this.sid,
          type: 'tool.start'
        })
        break
      }

      case 'tool/result': {
        const { message, error } = (event as SessionEvent<'tool/result'>).data
        const block = message.content[0]
        const id = String(block.toolCallId)
        const resultText = textOf(block.content, ['text'])
        const startedAt = this.callStarted.get(id)

        this.publishLocalEvent({
          payload: {
            duration_s: startedAt ? Math.max(0, Date.now() - startedAt) / 1000 : undefined,
            error: error ? `${error.name}: ${error.code}` : block.isError ? resultText || 'tool failed' : undefined,
            name: this.callNames.get(id),
            result_text: resultText,
            tool_id: id
          },
          session_id: this.sid,
          type: 'tool.complete'
        })
        this.callStarted.delete(id)
        break
      }

      case 'turn/end': {
        this.finishTurn()
        break
      }

      default:
        break
    }
  }

  private onChunk(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'text-delta': {
        if (!chunk.text) {
          return
        }

        if (!this.msgStartedHarness) {
          this.msgStartedHarness = true
          this.publishLocalEvent({ session_id: this.sid, type: 'message.start' })
        }

        this.publishLocalEvent({ payload: { text: chunk.text }, session_id: this.sid, type: 'message.delta' })
        break
      }

      case 'reasoning-delta': {
        if (!chunk.text) {
          return
        }

        this.publishLocalEvent({ payload: { text: chunk.text }, session_id: this.sid, type: 'thinking.delta' })
        break
      }

      case 'usage': {
        break
      }

      default:
        break
    }
  }

  private addUsage(usage: TokenUsage): void {
    this.usageTotals.calls += 1
    this.usageTotals.input += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    this.usageTotals.output += usage.outputTokens
    this.usageTotals.reasoning = (this.usageTotals.reasoning ?? 0) + (usage.reasoningTokens ?? 0)
    this.usageTotals.total = this.usageTotals.input + this.usageTotals.output
  }

  private finishTurn(): void {
    if (!this.turnStarted) {
      return
    }

    this.turnStarted = false
    this.turnCount += 1
    this.publishLocalEvent({
      payload: {
        permission_mode: this.permissionMode,
        reasoning: this.turnReasoning.join('') || undefined,
        session_turns: this.turnCount,
        text: this.turnText.join(''),
        usage: { ...this.usageTotals }
      },
      session_id: this.sid,
      type: 'message.complete'
    })
    this.msgStartedHarness = false
  }

  // ── outbound ───────────────────────────────────────────────────────────
  private deliver(text: string, placement: 'followup' | 'steer'): void {
    const agent = this.agent

    if (!agent) {
      this.publishLocalEvent({ payload: { message: 'agent not ready yet' }, type: 'error' })

      return
    }

    const message = createUserMessage({ content: [{ text, type: 'text' }], source: { kind: 'user' } })

    if (placement === 'steer') {
      agent.steer(message)
    } else {
      agent.followup(message)
    }
  }

  override kill(_reason = 'requested'): void {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // disposal is best effort during teardown
      }
    }

    const handle = this.handle

    this.handle = null
    this.agent = null

    if (handle) {
      void handle.dispose().catch(() => {})
    }
  }

  // ── RPCs ───────────────────────────────────────────────────────────────
  override request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const p = (params ?? {}) as Record<string, unknown>

    switch (method) {
      case 'setup.status':
        return Promise.resolve({ provider_configured: true } as T)

      case 'session.create':
        return this.harnessReady.then(() => {
          if (this.startFailed || !this.agent) {
            throw new Error(this.startFailed ?? 'agent unavailable')
          }

          return { info: this.info ?? undefined, session_id: this.sid } as T
        })

      case 'prompt.submit': {
        this.deliver(String(p.text ?? ''), 'followup')

        return Promise.resolve({ ok: true } as T)
      }

      case 'session.steer': {
        this.deliver(String(p.text ?? ''), 'steer')

        return Promise.resolve({ ok: true } as T)
      }

      case 'session.interrupt': {
        this.agent?.cancel({ kind: 'user' })

        return Promise.resolve({ ok: true } as T)
      }

      case 'session.active_list':
      case 'session.list':
        return Promise.resolve({ sessions: [] } as T)

      case 'commands.catalog': {
        const pairs = SLASHES.map(s => [s.name, s.desc] as [string, string])
        const canon: Record<string, string> = {}
        const hints: Record<string, string> = {}

        for (const s of SLASHES) {
          canon[s.name] = s.name

          if (s.hint) {
            hints[s.name] = s.hint
          }
        }

        return Promise.resolve({ canon, categories: [], hints, pairs, skill_count: 0, sub: {} } as T)
      }

      case 'complete.slash': {
        const text = String(p.text ?? '').toLowerCase() || '/'
        const items = SLASHES.filter(s => s.name.toLowerCase().startsWith(text)).map(s => ({
          display: s.name,
          hint: s.hint,
          meta: s.desc,
          text: s.name
        }))

        return Promise.resolve({ items, replace_from: 1 } as T)
      }

      // Local filesystem completion is backend-free in the parent class.
      case 'complete.path':
        return super.request(method, params)

      case 'session.usage':
      case 'session.status':
      case 'config.get':
      case 'terminal.resize':
        return Promise.resolve({} as T)

      default:
        // Anything not yet mapped degrades gracefully, exactly like the
        // original client's contract for older backends.
        return Promise.resolve({} as T)
    }
  }
}
