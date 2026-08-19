/**
 * The `(args)` half of a `⏺ Tool(args)` trail row.
 *
 * The original never prints a call's whole argument object on that row — it
 * prints the one thing that says WHICH call this is:
 *
 *   ⏺ Read(src/domain/usage.ts)
 *   ⏺ Bash(ls -1 src | head -12)
 *   ⏺ Search(pattern: "presentResult", path: "src")
 *   ⏺ Write(notes.txt)
 *
 * Two rules produce all four shapes. Render the arguments as `key: value`
 * pairs, and collapse to the bare value when only one pair survives. What
 * "survives" is the interesting part: an argument carrying BULK (a file's new
 * content, an edit's replacement text, a todo list) or POLICY (a sandbox
 * escalation, a justification, a read window) says nothing about which call
 * this is, and a 4 kB `content` in the parens would push the identifying path
 * off the line entirely. Those keys drop out, which is exactly how
 * `write(file_path, content)` reduces to `Write(notes.txt)` and
 * `bash(command, description, sandbox_permissions, justification)` reduces to
 * `Bash(ls -1 src)` — no per-tool table, no tool names hard-coded here.
 *
 * Deliberately derived from the raw arguments rather than the harness's own
 * `presentCall` title: the title restates the tool's verb ("Read src/a.ts"),
 * which the row already prints, and a shell command that happens to start with
 * `bash ` would lose its head to any verb-stripping rule.
 */

/**
 * Arguments that never identify a call. Bulk payloads (a file body, an edit's
 * before/after, a checklist) and policy/qualifier fields (why a command may
 * escalate, which window of a file to read) both make the row longer and less
 * distinguishable, which is the opposite of the point.
 */
const NOISE_KEYS: ReadonlySet<string> = new Set([
  // bulk payloads
  'content',
  'file_text',
  'items',
  'new_str',
  'new_string',
  'old_str',
  'old_string',
  'todos',
  // policy / qualifiers
  'description',
  'justification',
  'limit',
  'max_goal_rounds',
  'offset',
  'replace_all',
  'run_in_background',
  'sandbox_permissions',
  'timeout_ms',
  'view_range',
  'wait'
])

const renderValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }

  const json = JSON.stringify(value)

  // undefined/functions/symbols stringify to nothing; show the coerced form
  // rather than a hole in the middle of a `key: , key: ` list.
  return json === undefined ? String(value) : json
}

const project = (entries: [string, unknown][]): string => {
  // A single surviving argument IS the call's identity — `Read(src/a.ts)`, not
  // `Read(file_path: src/a.ts)`. More than one needs its keys to stay legible.
  if (entries.length === 1 && typeof entries[0]![1] === 'string') {
    return entries[0]![1] as string
  }

  return entries.map(([key, value]) => `${key}: ${renderValue(value)}`).join(', ')
}

/**
 * `{"file_path":"a.ts","content":"…"}` → `a.ts`.
 * `{"pattern":"foo","path":"src"}` → `pattern: foo, path: src`.
 *
 * Non-object arguments (or unparseable JSON) pass through untouched — the
 * caller's `compactPreview` still bounds the row.
 */
export const toolArgsPreview = (raw: string): string => {
  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return raw
  }

  const entries = Object.entries(parsed as Record<string, unknown>).filter(([, value]) => value !== undefined)
  const salient = entries.filter(([key]) => !NOISE_KEYS.has(key))

  // A call whose every argument is bulk (a bare `todo_write`) still deserves a
  // row that says something; falling back to the unfiltered projection beats
  // rendering `⏺ Todo Write()`.
  return project(salient.length ? salient : entries)
}
