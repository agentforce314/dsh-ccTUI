// HarnessGatewayClient — the deepseek-harness replacement for the clawcodex
// gateway subprocess. It subclasses GatewayClient so the entire app keeps its
// exact `gw` contract (EventEmitter of GatewayEvent + request()), but start()
// creates an in-process harness Agent instead of spawning Python, and every
// emission is translated from harness `session/event` records.
//
// Boundary rule: src/harness/ is the ONLY directory allowed to import
// @deepseek-ai/* (see docs/ARCHITECTURE.md).
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { createUserMessage, type ContentBlock, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
// Type-only: activates the 'plan/mode' SessionEventMap augmentation.
import type {} from '@deepseek-ai/dsh-plan-mode'

import { GatewayClient, SLASHES } from '../gatewayClient.js'
import { structuredPatch } from 'diff'

import type { GatewayTranscriptMessage, StructuredDiffPayload } from '../gatewayTypes.js'
import type { SessionInfo, Usage } from '../types.js'

const PLUGIN_VERSION = (() => {
  const require = createRequire(import.meta.url)

  // '../package.json' from the built dist/plugin.js; '../../package.json'
  // when running from src (tsx, vitest).
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = require(rel) as { name?: string; version?: string }

      if (pkg.name === 'dsh-cctui' && pkg.version) {
        return pkg.version
      }
    } catch {
      // try the next candidate
    }
  }

  return ''
})()

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
  private live = new Map<string, AgentHandle>()
  private disposers: Array<() => void> = []
  private agentDisposers: Array<() => void> = []
  private selection: ModelSelectionRef = { current: undefined, assembled: undefined }

  private harnessReady: Promise<void>
  private harnessReadyResolve!: () => void
  private startFailed: string | null = null

  private sid = ''
  private info: SessionInfo | null = null
  private sessionCreateConsumed = false

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
  private callArgs = new Map<string, string>()
  private callRawArgs = new Map<string, string>()
  private pendingTodos: unknown[] | null = null
  private generatingAnnounced = new Set<string>()
  private gateApproval: { resolve: (o: ApprovalOutcome) => void } | null = null
  private gateQuestion: {
    items: AskUserQuestionItem[]
    planApprove?: string
    resolve: (a: AskUserQuestionAnswer) => void
  } | null = null

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

    const handle = await this.createAgent(this.opts.sessionId)

    this.attach(handle)
    this.installGates()
    void this.refreshContextWindow()
    this.harnessReadyResolve()
    this.publishLocalEvent({ session_id: this.sid, type: 'gateway.ready' })

    if (this.info) {
      this.publishLocalEvent({ payload: this.info, session_id: this.sid, type: 'session.info' })
    }
  }

  private workingDir(): string {
    return this.opts.cwd ?? process.env.CLAWCODEX_WORKSPACE ?? process.env.CLAWCODEX_CWD ?? process.cwd()
  }

  private async createAgent(fixedSessionId?: string): Promise<AgentHandle> {
    const route = this.resolveRoute()
    const sessionId = SessionId(fixedSessionId ?? `cctui-${randomUUID()}`)

    this.selection = { assembled: undefined, current: route }

    const handle = await this.ctx.agents.create({
      agentOptions: route ? { model: route.model, provider: route.provider } : {},
      meta: { cwd: this.workingDir() },
      sessionId,
      setup: agentCtx => {
        installModelSelection(agentCtx, this.selection)
      }
    })

    this.live.set(String(sessionId), handle)

    return handle
  }

  private async resumeAgent(sessionId: string): Promise<AgentHandle> {
    const route = this.resolveRoute()

    this.selection = { assembled: undefined, current: route }

    const handle = await this.ctx.agents.resume({
      agentOptions: route ? { model: route.model, provider: route.provider } : {},
      resumeSessionId: SessionId(sessionId),
      setup: agentCtx => {
        installModelSelection(agentCtx, this.selection)
      }
    })

    this.live.set(sessionId, handle)

    return handle
  }

  /** Bind the UI to one live agent: event subscriptions, info, turn odometer. */
  private attach(handle: AgentHandle): void {
    for (const dispose of this.agentDisposers.splice(0)) {
      try {
        dispose()
      } catch {
        // best effort
      }
    }

    this.handle = handle
    this.agent = handle.agent
    this.sid = String(handle.agent.id)
    this.bindAgent(handle.agent)

    const events = handle.agent.session.events

    this.turnCount = events.filter(e => e.type === 'turn/end').length
    this.turnStarted = false
    this.turnText = []
    this.turnReasoning = []
    this.msgStartedHarness = false
    this.usageTotals = { calls: 0, input: 0, output: 0, total: 0 }
    this.info = this.buildSessionInfo(this.selection.current, handle.agent.session.header.cwd ?? this.workingDir())
  }

  /** Fold a session event log into resume-transcript rows. */
  private rehydrate(events: readonly SessionEvent[]): GatewayTranscriptMessage[] {
    const rows: GatewayTranscriptMessage[] = []

    for (const event of events) {
      switch (event.type) {
        case 'user/message': {
          const message = (event as SessionEvent<'user/message'>).data

          if (message.source.kind !== 'user') {
            break
          }

          const text = textOf(message.content, ['text'])

          if (text) {
            rows.push({ role: 'user', text })
          }

          break
        }

        case 'assistant/message': {
          const { message } = (event as SessionEvent<'assistant/message'>).data
          const text = textOf(message.content, ['text'])

          if (text) {
            rows.push({ role: 'assistant', text })
          }

          break
        }

        case 'tool/call': {
          const { name, arguments: rawArgs } = (event as SessionEvent<'tool/call'>).data

          rows.push({ context: prettyArgs(rawArgs), name, role: 'tool' })
          break
        }

        default:
          break
      }
    }

    return rows
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
      version: PLUGIN_VERSION || 'dsh'
    }
  }

  private bindAgent(agent: Agent): void {
    this.agentDisposers.push(
      this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
        if (session !== agent.session) {
          return
        }

        this.onSessionEvent(event)
      }) as () => void
    )
    this.agentDisposers.push(
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
        this.callArgs.set(id, prettyArgs(rawArgs))
        this.callRawArgs.set(id, rawArgs)
        this.publishLocalEvent({
          payload: { args_text: prettyArgs(rawArgs), name, tool_id: id },
          session_id: this.sid,
          type: 'tool.start'
        })
        break
      }

      case 'tool/result': {
        const { message, error, meta } = (event as SessionEvent<'tool/result'>).data
        const block = message.content[0]
        const id = String(block.toolCallId)
        const startedAt = this.callStarted.get(id)
        const view = this.presentResult(id, block.content, Boolean(block.isError), meta)
        const todos = this.pendingTodos

        this.pendingTodos = null
        this.publishLocalEvent({
          payload: {
            duration_s: startedAt ? Math.max(0, Date.now() - startedAt) / 1000 : undefined,
            error: error ? `${error.name}: ${error.code}` : block.isError ? view.resultText || 'tool failed' : undefined,
            name: this.callNames.get(id),
            result_text: view.resultText,
            structured_diff: view.structuredDiff,
            todos: todos ?? undefined,
            tool_id: id
          },
          session_id: this.sid,
          type: 'tool.complete'
        })
        this.callStarted.delete(id)
        this.generatingAnnounced.delete(id)
        break
      }

      case 'turn/end': {
        this.finishTurn()
        break
      }

      case 'todo/write': {
        this.pendingTodos = (event as SessionEvent<'todo/write'>).data.todos as unknown[]
        break
      }

      case 'plan/mode': {
        const active = Boolean((event as SessionEvent<'plan/mode'>).data.active)
        const mode = active ? 'plan' : this.permissionMode === 'plan' ? 'default' : this.permissionMode

        if (mode !== this.permissionMode) {
          this.permissionMode = mode
          this.publishLocalEvent({ payload: { mode }, session_id: this.sid, type: 'permission.mode' })
        }

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

      case 'tool-call-delta': {
        const id = String(chunk.id)

        if (chunk.name && !this.generatingAnnounced.has(id)) {
          this.generatingAnnounced.add(id)
          this.publishLocalEvent({ payload: { name: chunk.name }, session_id: this.sid, type: 'tool.generating' })
        }

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
        usage: { ...this.usageTotals, ...this.usageSnapshot() }
      },
      session_id: this.sid,
      type: 'message.complete'
    })
    this.msgStartedHarness = false
  }


  // ── interaction gates (approvals / questions / plan review) ────────────
  private installGates(): void {
    if (this.ctx.get('approval') !== undefined) {
      this.disposers.push(
        this.ctx.on('approval/request', (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
          if (req.agent !== this.agent) {
            return next()
          }

          return this.parkApproval(req)
        }) as () => void
      )
    }

    const userQuestions = this.ctx.get('userQuestions') as
      | { registerProvider: (p: { ask: (r: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer> }) => () => void }
      | undefined

    if (userQuestions) {
      try {
        this.disposers.push(userQuestions.registerProvider({ ask: request => this.parkQuestion(request) }))
      } catch {
        // A composed profile may already carry a provider (DUPLICATE_PROVIDER);
        // yield rather than crash the boot — the other surface answers.
      }
    }
  }

  private parkApproval(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const id = req.callId ? String(req.callId) : ''
    const command = (id ? this.callArgs.get(id) : undefined) ?? req.reason ?? req.toolName

    return new Promise<ApprovalOutcome>(resolve => {
      this.gateApproval = { resolve }
      req.signal?.addEventListener(
        'abort',
        () => {
          if (this.gateApproval?.resolve === resolve) {
            this.gateApproval = null
            resolve('cancelled')
          }
        },
        { once: true }
      )
      this.publishLocalEvent({
        payload: {
          allow_permanent: false,
          command,
          tool_name: req.toolName,
          warning: req.reason ?? null
        },
        session_id: this.sid,
        type: 'approval.request'
      })
    })
  }

  private parkQuestion(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const items = request.questions

    return new Promise<AskUserQuestionAnswer>(resolve => {
      const planItem = items.length === 1 && items[0]!.intent?.kind === 'plan-review' ? items[0]! : undefined

      this.gateQuestion = { items: [...items], planApprove: planItem?.intent?.approve, resolve }

      if (planItem) {
        this.publishLocalEvent({
          payload: { bypass_available: true, plan: planItem.detail ?? planItem.question, plan_file_path: null },
          session_id: this.sid,
          type: 'plan.approval'
        })

        return
      }

      this.publishLocalEvent({
        payload: {
          questions: items.map(q => ({
            header: q.header,
            multiSelect: q.multiSelect,
            options: q.options?.map(o => ({ description: o.description, label: o.label })),
            question: q.question
          }))
        },
        session_id: this.sid,
        type: 'question.request'
      })
    })
  }

  private applyPermissionMode(mode: string): void {
    const agent = this.agent

    if (!agent) {
      return
    }

    const planMode = this.ctx.get('planMode') as { set?: (a: Agent, active: boolean) => unknown } | undefined
    const approval = this.ctx.get('approval') as { setPolicy?: (a: Agent, policy: 'ask' | 'never') => void } | undefined

    planMode?.set?.(agent, mode === 'plan')
    approval?.setPolicy?.(agent, mode === 'bypassPermissions' ? 'never' : 'ask')
    this.permissionMode = mode

    if (this.info) {
      this.info = { ...this.info, permission_mode: mode }
    }

    this.publishLocalEvent({ payload: { mode }, session_id: this.sid, type: 'permission.mode' })
  }


  /** Refine a tool result through the tool's own presentation view. */
  private presentResult(
    callId: string,
    content: readonly ContentBlock[],
    isError: boolean,
    meta: unknown
  ): { resultText: string; structuredDiff?: StructuredDiffPayload } {
    const fallback = textOf(content, ['text'])
    const name = this.callNames.get(callId)
    const rawArgs = this.callRawArgs.get(callId)

    this.callRawArgs.delete(callId)

    if (!name) {
      return { resultText: fallback }
    }

    let view: { card?: string } | undefined

    try {
      const tools = this.ctx.get('tools') as
        | { get?: (n: string, scope?: unknown) => { presentResult?: (a: unknown, r: unknown) => unknown } | undefined }
        | undefined
      const definition = tools?.get?.(name, this.agent as unknown)
      let args: unknown

      try {
        args = rawArgs ? JSON.parse(rawArgs) : undefined
      } catch {
        args = undefined
      }

      view = definition?.presentResult?.(args, { content: [...content], isError, meta }) as { card?: string } | undefined
    } catch {
      view = undefined
    }

    if (!view) {
      return { resultText: fallback }
    }

    if (view.card === 'diff') {
      const diffs = (view as { diffs?: Array<{ newText: string; oldText: null | string; path: string }> }).diffs ?? []
      const first = diffs[0]

      if (first) {
        const patch = structuredPatch(first.path, first.path, first.oldText ?? '', first.newText, '', '', { context: 3 })
        const structuredDiff: StructuredDiffPayload = {
          filePath: first.path,
          hunks: patch.hunks.map(h => ({
            lines: h.lines,
            newLines: h.newLines,
            newStart: h.newStart,
            oldLines: h.oldLines,
            oldStart: h.oldStart
          })),
          kind: first.oldText === null ? 'create' : 'update'
        }

        if (first.oldText === null) {
          structuredDiff.content = first.newText
          structuredDiff.firstLine = first.newText.split(String.fromCharCode(10))[0] ?? null
        }

        const extra = diffs.length > 1 ? ` (+${diffs.length - 1} more file${diffs.length > 2 ? 's' : ''})` : ''

        return { resultText: fallback || `updated ${first.path}${extra}`, structuredDiff }
      }
    }

    if (view.card === 'terminal') {
      const terminal = view as { exitCode?: number; output?: string }
      const lines = [terminal.output ?? '']

      if (typeof terminal.exitCode === 'number' && terminal.exitCode !== 0) {
        lines.push(`[exit code: ${terminal.exitCode}]`)
      }

      const output = lines.filter(Boolean).join(String.fromCharCode(10))

      return { resultText: output || fallback }
    }

    if (view.card === 'search') {
      const search = view as { paths?: string[]; total?: number }

      if (Array.isArray(search.paths)) {
        return { resultText: search.paths.join(String.fromCharCode(10)) || fallback }
      }
    }

    return { resultText: fallback }
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
    for (const dispose of [...this.agentDisposers.splice(0), ...this.disposers.splice(0)]) {
      try {
        dispose()
      } catch {
        // disposal is best effort during teardown
      }
    }

    this.handle = null
    this.agent = null

    for (const handle of this.live.values()) {
      void handle.dispose().catch(() => {})
    }

    this.live.clear()
  }


  private async listPersisted(): Promise<SessionHeader[]> {
    const persistence = this.ctx.get('sessionPersistence') as
      | { list?: (signal?: AbortSignal) => Promise<SessionHeader[]> }
      | undefined

    try {
      const headers = (await persistence?.list?.()) ?? []

      return [...headers].sort((a, b) => b.createdAt - a.createdAt)
    } catch {
      return []
    }
  }

  private cachedTitle(header: SessionHeader): string | undefined {
    const cache = this.ctx.get('sessionProjectionCache') as
      | { cachedSnapshot?: (meta: SessionHeader) => { values?: { title?: { title?: string } } } | undefined }
      | undefined

    try {
      return cache?.cachedSnapshot?.(header)?.values?.title?.title
    } catch {
      return undefined
    }
  }

  private titleOf(session: Session): string | undefined {
    const titles = this.ctx.get('sessionTitle') as { get?: (s: Session) => { title: string } | undefined } | undefined

    try {
      return titles?.get?.(session)?.title
    } catch {
      return undefined
    }
  }


  private harnessCommands(): Array<{ description: string; hint?: string; name: string }> {
    const agent = this.agent
    const commands = this.ctx.get('commands') as
      | { list?: (agent: Agent) => Array<{ description: string; input?: { hint: string }; name: string }> }
      | undefined

    if (!agent || !commands?.list) {
      return []
    }

    try {
      return commands.list(agent).map(c => ({ description: c.description, hint: c.input?.hint, name: `/${c.name}` }))
    } catch {
      return []
    }
  }

  private async runHarnessCommand(line: string): Promise<{ output?: string }> {
    const agent = this.agent
    const commands = this.ctx.get('commands') as
      | {
          execute?: (
            agent: Agent,
            line: string,
            signal: AbortSignal
          ) => Promise<{ result: { kind: string; text?: string } } | undefined>
        }
      | undefined

    if (!agent || !commands?.execute) {
      throw new Error('commands unavailable')
    }

    const normalized = line.startsWith('/') ? line : `/${line}`
    const execution = await commands.execute(agent, normalized, new AbortController().signal)

    if (!execution) {
      throw new Error(`unknown command: ${normalized.split(/\s+/)[0] ?? ''}`)
    }

    if (execution.result.kind === 'error') {
      throw new Error(execution.result.text || 'command failed')
    }

    return { output: execution.result.text ?? '' }
  }

  private usageSnapshot(): { context_max?: number; context_percent?: number; context_used?: number } {
    const agent = this.agent
    const meter = this.ctx.get('tokenMeter') as
      | { measure?: (session: Session) => { totalTokens: number } }
      | undefined

    if (!agent || !meter?.measure) {
      return {}
    }

    try {
      const used = meter.measure(agent.session).totalTokens
      const max = this.contextWindow

      return {
        context_max: max,
        context_percent: max ? Math.min(100, Math.round((used / max) * 100)) : undefined,
        context_used: used
      }
    } catch {
      return {}
    }
  }

  private contextWindow: number | undefined

  private async refreshContextWindow(): Promise<void> {
    const route = this.selection.current

    if (!route) {
      return
    }

    const llm = this.ctx.get('llm') as
      | { resolveModelInfo?: (p: string, m: string) => Promise<{ context?: { contextWindow?: number } }> }
      | undefined

    try {
      const info = await llm?.resolveModelInfo?.(route.provider, route.model)

      this.contextWindow = info?.context?.contextWindow
    } catch {
      this.contextWindow = undefined
    }
  }

  private async applyModelSwitch(rawValue: string): Promise<{ ok: boolean; provider?: string; value?: string; error?: string }> {
    const raw = rawValue.trim()

    if (!raw) {
      return { error: 'no model given', ok: false }
    }

    let provider = this.selection.current?.provider
    let model = raw

    const flagMatch = raw.match(/^(\S+)\s+--provider\s+(\S+)$/)

    if (flagMatch) {
      model = flagMatch[1]!
      provider = flagMatch[2]!
    } else if (raw.includes(':')) {
      const idx = raw.indexOf(':')

      provider = raw.slice(0, idx)
      model = raw.slice(idx + 1)
    }

    if (!provider) {
      return { error: 'no provider selected', ok: false }
    }

    const route = { model, provider, reasoningEffort: this.selection.current?.reasoningEffort } as ModelRoute

    this.selection.current = route
    void this.refreshContextWindow()

    const defaults = this.ctx.get('agentDefaultModel') as
      | { saveSelection?: (next: ModelRoute) => Promise<void> }
      | undefined

    void defaults?.saveSelection?.(route).catch(() => {})

    if (this.info) {
      this.info = { ...this.info, model, profile_name: provider }
      this.publishLocalEvent({ payload: this.info, session_id: this.sid, type: 'session.info' })
    }

    return { ok: true, provider, value: model }
  }

  // ── RPCs ───────────────────────────────────────────────────────────────
  override request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const p = (params ?? {}) as Record<string, unknown>

    switch (method) {
      case 'setup.status':
        return Promise.resolve({ provider_configured: true } as T)

      case 'session.create':
        return this.harnessReady.then(async () => {
          if (this.startFailed) {
            throw new Error(this.startFailed)
          }

          // Boot uses the agent created by start(); later calls (/new, /clear)
          // spin up a fresh session and switch the binding to it.
          if (this.agent && !this.sessionCreateConsumed) {
            this.sessionCreateConsumed = true

            return { info: this.info ?? undefined, session_id: this.sid } as T
          }

          const handle = await this.createAgent()

          this.attach(handle)
          this.sessionCreateConsumed = true

          return { info: this.info ?? undefined, session_id: this.sid } as T
        })

      case 'session.close': {
        const id = String(p.session_id ?? '')
        const handle = this.live.get(id)

        if (handle) {
          this.live.delete(id)

          if (this.handle === handle) {
            for (const dispose of this.agentDisposers.splice(0)) {
              try {
                dispose()
              } catch {
                // best effort
              }
            }

            this.handle = null
            this.agent = null
          }

          void handle.dispose().catch(() => {})
        }

        return Promise.resolve({ ok: true } as T)
      }

      case 'session.resume':
      case 'session.activate': {
        const id = String(p.session_id ?? '')

        return (async () => {
          let handle = this.live.get(id)

          if (!handle) {
            handle = await this.resumeAgent(id)
          }

          this.attach(handle)

          const messages = this.rehydrate(handle.agent.session.events)
          const running = handle.agent.status === 'running'

          this.publishLocalEvent({ payload: this.info!, session_id: this.sid, type: 'session.info' })
          this.publishLocalEvent({ payload: { session_turns: this.turnCount }, session_id: this.sid, type: 'session.stats' })

          return {
            info: this.info ?? undefined,
            message_count: messages.length,
            messages,
            running,
            session_id: id,
            started_at: handle.agent.session.header.createdAt,
            status: running ? 'working' : 'idle'
          } as T
        })()
      }

      case 'session.most_recent': {
        return this.listPersisted().then(headers => {
          const latest = headers[0]

          return (latest ? { session_id: String(latest.id) } : {}) as T
        })
      }

      case 'session.title': {
        const agent = this.agent
        const titles = this.ctx.get('sessionTitle') as
          | {
              get?: (s: unknown) => { title: string } | undefined
              rename?: (s: unknown, t: string) => { title: string }
            }
          | undefined

        if (!agent || !titles) {
          return Promise.resolve({} as T)
        }

        const requested = typeof p.title === 'string' ? p.title.trim() : ''

        try {
          if (requested) {
            const snap = titles.rename?.(agent.session, requested)

            return Promise.resolve({ title: snap?.title ?? requested } as T)
          }

          return Promise.resolve({ title: titles.get?.(agent.session)?.title } as T)
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)))
        }
      }

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

      case 'session.active_list': {
        const sessions = [...this.live.entries()].map(([id, handle]) => ({
          current: id === this.sid,
          id,
          last_active: undefined,
          message_count: handle.agent.session.events.filter(e => e.type === 'user/message').length,
          model: this.selection.current?.model,
          started_at: handle.agent.session.header.createdAt,
          status: handle.agent.status === 'running' ? 'working' : 'idle',
          title: this.titleOf(handle.agent.session)
        }))

        return Promise.resolve({ sessions } as T)
      }

      case 'session.list':
        return this.listPersisted().then(headers => {
          const sessions = headers.slice(0, 50).map(header => ({
            id: String(header.id),
            message_count: 0,
            preview: this.cachedTitle(header) ?? '',
            source: 'harness',
            started_at: header.createdAt,
            title: this.cachedTitle(header) ?? String(header.id)
          }))

          return { sessions } as T
        })

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

        for (const c of this.harnessCommands()) {
          if (canon[c.name]) {
            continue
          }

          canon[c.name] = c.name
          pairs.push([c.name, c.description])

          if (c.hint) {
            hints[c.name] = c.hint
          }
        }

        return Promise.resolve({ canon, categories: [], hints, pairs, skill_count: 0, sub: {} } as T)
      }

      case 'complete.slash': {
        const text = String(p.text ?? '').toLowerCase() || '/'
        const entries = [
          ...SLASHES,
          ...this.harnessCommands()
            .filter(c => !SLASHES.some(s => s.name === c.name))
            .map(c => ({ desc: c.description, hint: c.hint, name: c.name }))
        ]
        const items = entries.filter(s => s.name.toLowerCase().startsWith(text)).map(s => ({
          display: s.name,
          hint: s.hint,
          meta: s.desc,
          text: s.name
        }))

        return Promise.resolve({ items, replace_from: 1 } as T)
      }

      case 'slash.exec': {
        const line = String(p.command ?? '').trim()
        const name = line.split(/\s+/)[0]?.toLowerCase() ?? ''
        const rest = line.slice(name.length).trim()

        if (name === 'effort') {
          if (!this.selection.current) {
            return Promise.reject(new Error('no model selected'))
          }

          const level = rest || undefined

          this.selection.current = {
            ...this.selection.current,
            reasoningEffort: level && level !== 'auto' ? level : undefined
          } as ModelRoute

          if (this.info) {
            this.info = { ...this.info, reasoning_effort: this.selection.current.reasoningEffort as string | undefined }
            this.publishLocalEvent({ payload: this.info, session_id: this.sid, type: 'session.info' })
          }

          return Promise.resolve({ output: `effort: ${level ?? 'auto'}` } as T)
        }

        if (name === 'context') {
          const usage = this.usageSnapshot()
          const used = usage.context_used ?? 0
          const max = usage.context_max

          return Promise.resolve({
            output: max
              ? `context: ${used.toLocaleString()} of ${max.toLocaleString()} tokens (${usage.context_percent ?? 0}%)`
              : `context: ~${used.toLocaleString()} tokens used (window unknown)`
          } as T)
        }

        return this.runHarnessCommand(line).then(r => r as T)
      }

      case 'command.dispatch': {
        const name = String(p.name ?? '').trim()
        const arg = typeof p.arg === 'string' && p.arg.trim() ? ` ${p.arg.trim()}` : ''

        return this.runHarnessCommand(`${name}${arg}`).then(r => ({ output: r.output, type: 'exec' }) as T)
      }

      case 'model.options': {
        return (async () => {
          const llm = this.ctx.get('llm') as
            | {
                listModels?: (provider: string) => Promise<ReadonlyArray<{ id: string }>>
                listProviders?: () => Array<{ id: string; name: string }>
              }
            | undefined
          const current = this.selection.current
          const providers = await Promise.all(
            (llm?.listProviders?.() ?? []).map(async info => {
              let models: string[] = []

              try {
                models = ((await llm?.listModels?.(info.id)) ?? []).map(m => m.id)
              } catch {
                models = []
              }

              return {
                authenticated: true,
                is_current: info.id === current?.provider,
                models,
                name: info.name,
                slug: info.id,
                total_models: models.length
              }
            })
          )

          return { model: current?.model, provider: current?.provider, providers } as T
        })()
      }

      case 'model.effort_options': {
        return (async () => {
          const route = this.selection.current

          if (!route) {
            return { supported: false } as T
          }

          const llm = this.ctx.get('llm') as
            | {
                resolveModelInfo?: (
                  p: string,
                  m: string
                ) => Promise<{ reasoning?: { defaultEffort?: string; efforts: ReadonlyArray<{ id: string }> } }>
              }
            | undefined

          try {
            const info = await llm?.resolveModelInfo?.(route.provider, route.model)
            const levels = (info?.reasoning?.efforts ?? []).map(e => e.id)

            return {
              current: (route.reasoningEffort as string | undefined) ?? '',
              levels,
              supported: levels.length > 0
            } as T
          } catch {
            return { supported: false } as T
          }
        })()
      }

      case 'approval.respond': {
        const choice = String(p.choice ?? 'deny')
        const pending = this.gateApproval

        this.gateApproval = null
        pending?.resolve(choice === 'deny' ? 'rejected' : 'allowed-once')

        return Promise.resolve({ ok: true } as T)
      }

      case 'planApproval.respond': {
        const choice = String(p.choice ?? 'deny')
        const feedback = typeof p.feedback === 'string' && p.feedback.trim() ? p.feedback.trim() : undefined
        const pending = this.gateQuestion

        this.gateQuestion = null

        if (pending?.planApprove !== undefined) {
          const item = pending.items[0]!

          if (choice === 'deny') {
            pending.resolve({
              answers: [{ custom: feedback ?? 'Keep planning — the user rejected this plan.', id: item.id, selected: [] }]
            })
          } else {
            pending.resolve({ answers: [{ id: item.id, selected: [pending.planApprove] }] })

            if (choice === 'bypass') {
              this.applyPermissionMode('bypassPermissions')
            } else if (choice === 'default' || choice === 'accept-edits') {
              this.applyPermissionMode('default')
            }
          }
        }

        return Promise.resolve({ ok: true } as T)
      }

      case 'question.respond': {
        const answers = (p.answers ?? null) as null | Record<string, string>
        const pending = this.gateQuestion

        this.gateQuestion = null

        if (pending) {
          if (!answers) {
            pending.resolve({ answers: pending.items.map(q => ({ id: q.id, selected: [] })) })
          } else {
            pending.resolve({
              answers: pending.items.map(q => {
                const raw = answers[q.question]

                if (typeof raw !== 'string' || raw === '') {
                  return { id: q.id, selected: [] }
                }

                const labels = new Set((q.options ?? []).map(o => o.label))
                const parts = q.multiSelect ? raw.split(', ') : [raw]
                const selected = parts.filter(part => labels.has(part))
                const custom = parts.filter(part => !labels.has(part)).join(', ')

                return { custom: custom || undefined, id: q.id, selected }
              })
            })
          }
        }

        return Promise.resolve({ ok: true } as T)
      }

      case 'permission.cycle': {
        const order = ['default', 'plan', 'bypassPermissions']
        const next = order[(order.indexOf(this.permissionMode) + 1) % order.length]!

        this.applyPermissionMode(next)

        return Promise.resolve({ mode: next } as T)
      }

      case 'config.set': {
        if (String(p.key ?? '') === 'model') {
          return this.applyModelSwitch(String(p.value ?? '')).then(r => r as T)
        }

        if (String(p.key ?? '') === 'permission_mode') {
          const value = String(p.value ?? 'default')
          const mode = value === 'acceptEdits' ? 'default' : value

          this.applyPermissionMode(mode)

          return Promise.resolve({ mode, ok: true, persisted: false } as T)
        }

        return Promise.resolve({} as T)
      }

      // Local filesystem completion is backend-free in the parent class.
      case 'complete.path':
        return super.request(method, params)

      case 'session.usage': {
        const usage = this.usageSnapshot()

        return Promise.resolve(
          {
            calls: this.usageTotals.calls,
            context_max: usage.context_max,
            context_percent: usage.context_percent,
            context_used: usage.context_used,
            input: this.usageTotals.input,
            model: this.selection.current?.model,
            output: this.usageTotals.output,
            total: this.usageTotals.total
          } as T
        )
      }

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
