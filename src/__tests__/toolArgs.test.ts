// The `(args)` half of a `⏺ Tool(args)` row: which argument identifies the
// call, and which ones are bulk/policy noise that would push it off the line.
import { describe, expect, it } from 'vitest'

import { toolArgsPreview } from '../domain/toolArgs.js'

describe('toolArgsPreview', () => {
  it('renders a lone argument bare, the way upstream shows Read(path)', () => {
    expect(toolArgsPreview('{"file_path":"src/domain/usage.ts"}')).toBe('src/domain/usage.ts')
  })

  it('keeps keys once more than one argument survives', () => {
    expect(toolArgsPreview('{"pattern":"presentResult","path":"src"}')).toBe('pattern: presentResult, path: src')
  })

  it('drops a write’s content so the path is what shows', () => {
    expect(toolArgsPreview('{"file_path":"notes.txt","content":"alpha\\nbeta\\n"}')).toBe('notes.txt')
  })

  it('drops an edit’s before/after strings', () => {
    const raw = '{"file_path":"notes.txt","old_string":"beta","new_string":"BETA","replace_all":false}'

    expect(toolArgsPreview(raw)).toBe('notes.txt')
  })

  it('drops a shell call’s description and escalation policy, leaving the command', () => {
    const raw =
      '{"command":"ls -1 src | head -12","description":"list src","sandbox_permissions":"danger-full-access","justification":"e2e"}'

    expect(toolArgsPreview(raw)).toBe('ls -1 src | head -12')
  })

  it('drops a read window so a paged read still reads as its path', () => {
    expect(toolArgsPreview('{"file_path":"a.ts","offset":60,"limit":30}')).toBe('a.ts')
  })

  it('keeps a sub-command alongside its path', () => {
    expect(toolArgsPreview('{"command":"str_replace","path":"a.txt","old_str":"x","new_str":"y"}')).toBe(
      'command: str_replace, path: a.txt'
    )
  })

  it('labels a delegation by its description, not the brief it was handed', () => {
    const raw = '{"description":"Review the diff","prompt":"Summarise what changed in src/ and stop.","run_in_background":false}'

    // upstream renders `⏺ Task(Review the diff)`; a delegation's prompt is bulk
    // the same way a write's content is
    expect(toolArgsPreview(raw)).toBe('Review the diff')
  })

  it('does not restate a plan the review box is already showing', () => {
    const raw = '{"plan":"# Close the gaps\\n\\n- read cards\\n- search cards"}'

    // the plan renders in full right below the row; squeezing it into 64
    // columns of parens shows it twice, once badly
    expect(toolArgsPreview(raw)).toBe('')
  })

  it('identifies a workflow by its meta name, not the script it runs', () => {
    const raw = '{"script":"log(\\"hi\\")\\nreturn 1","meta":{"name":"gap-probe","description":"one line"}}'

    // the script filled the parens and pushed the identity past the ellipsis
    expect(toolArgsPreview(raw)).toBe('gap-probe')
  })

  it('renders nothing when every argument is bulk, leaving a bare label', () => {
    // `⏺ Todo Write` with the checklist below it, the way upstream renders it —
    // formatToolCall drops the parens entirely for an empty preview
    expect(toolArgsPreview('{"todos":[{"content":"a","status":"pending"}]}')).toBe('')
  })

  it('renders non-string values as JSON', () => {
    expect(toolArgsPreview('{"job_id":"j1","tail":20}')).toBe('job_id: j1, tail: 20')
  })

  it('passes through arguments that are not a JSON object', () => {
    expect(toolArgsPreview('not json at all')).toBe('not json at all')
    expect(toolArgsPreview('["a","b"]')).toBe('["a","b"]')
  })

  it('renders an argumentless call as nothing, so the row stays a bare label', () => {
    expect(toolArgsPreview('{}')).toBe('')
  })
})
