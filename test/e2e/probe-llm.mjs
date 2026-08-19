// Test-only cordis plugin: a scripted LLM that turns a `PROBE <tool> <json>`
// user prompt into exactly that tool call, so every harness tool can be driven
// through the real agent loop with no network and no credentials.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'probe-llm'
export const inject = ['llm']

const lastUserIndex = messages => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user' || (m.source && m.source.kind !== 'user')) continue
    const text = (m.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
    if (text) return i
  }
  return -1
}

const lastUserText = messages => {
  const i = lastUserIndex(messages)
  if (i < 0) return ''
  return (messages[i].content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
}

let seq = 0

class ProbeAdapter extends LlmAdapter {
  async *stream(options) {
    const msgs = options.messages ?? []
    const user = lastUserText(msgs)
    const hasToolResult = msgs
      .slice(lastUserIndex(msgs) + 1)
      .some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool-result'))

    const m = /^PROBE\s+(\S+)\s+([\s\S]*)$/.exec(user.trim())

    if (m && !hasToolResult) {
      const name = m[1]
      const args = m[2].trim() || '{}'
      const id = `probe-${++seq}`
      yield { blockType: 'tool-call', index: 0, type: 'block-start' }
      yield { argumentsDelta: args, id, name, type: 'tool-call-delta', index: 0 }
      yield { block: { arguments: args, id, name, type: 'tool-call' }, index: 0, type: 'block-end' }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { reason: { kind: 'tool-calls' }, type: 'finish' }
      return
    }

    const text = hasToolResult ? 'probe done.' : `echo: ${user}`
    yield { blockType: 'text', index: 0, type: 'block-start' }
    yield { index: 0, text, type: 'text-delta' }
    yield { block: { text, type: 'text' }, index: 0, type: 'block-end' }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } }
    yield { reason: { kind: 'stop' }, type: 'finish' }
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter(['mock'], new ProbeAdapter())
}
