// Test-only cordis plugin: a scripted LLM adapter on provider route "mock".
// Lets e2e runs exercise the full agent loop (stream → assemble → turn end)
// with no network and no credentials.
//
// Script behavior: replies with a fixed preamble + the last user text. When
// the user text contains "USE-TOOL", the first step requests a todo_write
// tool call before a closing text step (used by later stages).
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'mock-llm'
export const inject = ['llm', 'commands']

const lastUserIndex = messages => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]

    if (m.role !== 'user' || (m.source && m.source.kind !== 'user')) { continue }

    const text = (m.content ?? [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')

    if (text) { return i }
  }

  return -1
}

const lastUserText = messages => {
  const i = lastUserIndex(messages)

  if (i < 0) { return '(no user text)' }

  return (messages[i].content ?? [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
}

const pieces = (text, size = 8) => {
  const out = []

  for (let i = 0; i < text.length; i += size) { out.push(text.slice(i, i + size)) }

  return out
}

class MockAdapter extends LlmAdapter {
  async *stream(options) {
    const user = lastUserText(options.messages ?? [])
    // Only tool results from the CURRENT turn count — history keeps old ones.
    const msgs = options.messages ?? []
    const hasToolResult = msgs
      .slice(lastUserIndex(msgs) + 1)
      .some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool-result'))

    if (user.includes('USE-WRITE') && !hasToolResult) {
      const args = JSON.stringify({ content: 'alpha line\n' + 'beta line\n', file_path: 'e2e-scratch/e2e-write-probe.txt' })

      yield { blockType: 'tool-call', index: 0, type: 'block-start' }
      yield { argumentsDelta: args, id: 'mock-write-1', name: 'write', type: 'tool-call-delta', index: 0 }
      yield { block: { arguments: args, id: 'mock-write-1', name: 'write', type: 'tool-call' }, index: 0, type: 'block-end' }
      yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 5 } }
      yield { reason: { kind: 'tool-calls' }, type: 'finish' }

      return
    }

    if (user.includes('USE-BASH') && !hasToolResult) {
      const args = JSON.stringify({ command: 'echo e2e-bash-ok', description: 'e2e echo probe', justification: 'e2e approval flow test', sandbox_permissions: 'danger-full-access' })

      yield { blockType: 'tool-call', index: 0, type: 'block-start' }
      yield { argumentsDelta: args, id: 'mock-bash-1', name: 'bash', type: 'tool-call-delta', index: 0 }
      yield { block: { arguments: args, id: 'mock-bash-1', name: 'bash', type: 'tool-call' }, index: 0, type: 'block-end' }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 6 } }
      yield { reason: { kind: 'tool-calls' }, type: 'finish' }

      return
    }

    if (hasToolResult) {
      const text = 'TOOL-STEP-DONE'

      yield { blockType: 'text', index: 0, type: 'block-start' }
      yield { index: 0, text, type: 'text-delta' }
      yield { block: { text, type: 'text' }, index: 0, type: 'block-end' }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } }
      yield { reason: { kind: 'stop' }, type: 'finish' }

      return
    }

    if (user.includes('USE-TOOL')) {
      const args = JSON.stringify({ todos: [{ content: 'mock todo item', status: 'pending' }] })

      yield { blockType: 'tool-call', index: 0, type: 'block-start' }
      yield { argumentsDelta: args, id: 'mock-call-1', name: 'todo_write', type: 'tool-call-delta', index: 0 }
      yield { block: { arguments: args, id: 'mock-call-1', name: 'todo_write', type: 'tool-call' }, index: 0, type: 'block-end' }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 6 } }
      yield { reason: { kind: 'tool-calls' }, type: 'finish' }

      return
    }

    const text = `MOCK-REPLY: ${user}`

    yield { blockType: 'text', index: 0, type: 'block-start' }

    for (const piece of pieces(text)) {
      yield { index: 0, text: piece, type: 'text-delta' }
      await new Promise(r => setTimeout(r, 5))
    }

    yield { block: { text, type: 'text' }, index: 0, type: 'block-end' }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
    yield { reason: { kind: 'stop' }, type: 'finish' }
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter(['mock'], new MockAdapter())

  // A harness-registered slash command for the command-bridge e2e.
  ctx.commands.register({
    description: 'e2e bridge probe',
    handler: () => ({ kind: 'success', text: 'EPROBE-BRIDGE-OK' }),
    name: 'e2eprobe'
  })
}
