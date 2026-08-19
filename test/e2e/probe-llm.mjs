// Test-only cordis plugin: a scripted LLM that turns a `PROBE <tool> <json>`
// user prompt into exactly that tool call, so every harness tool can be driven
// through the real agent loop with no network and no credentials.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'probe-llm'
export const inject = ['llm', 'web']

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

    // `PROBE <tool> <json>`, or several separated by ` ;; ` to exercise the
    // collapsed brief, which only reads right across a RUN of calls.
    const calls = user
      .trim()
      .split(' ;; ')
      .map(part => /^PROBE\s+(\S+)\s*([\s\S]*)$/.exec(part.trim()))
      .filter(Boolean)

    if (calls.length && !hasToolResult) {
      for (const [index, m] of calls.entries()) {
        const name = m[1]
        const args = m[2].trim() || '{}'
        const id = `probe-${++seq}`
        yield { blockType: 'tool-call', index, type: 'block-start' }
        yield { argumentsDelta: args, id, name, type: 'tool-call-delta', index }
        yield { block: { arguments: args, id, name, type: 'tool-call' }, index, type: 'block-end' }
      }

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

// Canned web providers. dsh-base ships no local fetch provider and its search
// provider wants a DeepSeek key, so probing the web tools' cards would
// otherwise need the network and a credential. These keep the gallery offline
// and its captures byte-stable.
const PAGE = [
  '# Example Domain',
  '',
  'This domain is for use in illustrative examples in documents.',
  ''
].join('\n')

const fetchProvider = {
  id: 'probe',
  available: () => true,
  fetch: async request => ({
    body: { content: PAGE, kind: 'text' },
    statusCode: request.url.includes('missing') ? 404 : 200,
    truncated: false,
    url: request.url
  })
}

const searchProvider = {
  id: 'probe',
  available: () => true,
  search: async request => ({
    content: `answer for ${request.query}`,
    sources: [
      { snippet: 'the harness itself', title: 'deepseek-harness', url: 'https://github.com/deepseek-ai/deepseek-harness' },
      { title: 'dsh-ccTUI', url: 'https://github.com/agentforce314/dsh-ccTUI' }
    ],
    truncated: false
  })
}

export function apply(ctx) {
  ctx.llm.registerAdapter(['mock'], new ProbeAdapter())
  ctx.web.registerFetchProvider(fetchProvider)
  ctx.web.registerSearchProvider(searchProvider)
}
