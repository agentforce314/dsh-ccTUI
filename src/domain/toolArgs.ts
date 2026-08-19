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
 * One rule produces all four shapes: render the arguments as `key: value`
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
 * Two refinements keep that rule honest against real argument shapes: a
 * `description` is held back until nothing sharper survives (see LABEL_KEYS),
 * and an object argument is identified by its own `name` (see identify).
 *
 * Deliberately derived from the raw arguments rather than the harness's own
 * `presentCall` title: the title restates the tool's verb ("Read src/a.ts"),
 * which the row already prints, and a shell command that happens to start with
 * `bash ` would lose its head to any verb-stripping rule.
 */

/**
 * Arguments that never identify a call. Bulk payloads (a file body, an edit's
 * before/after, a checklist, a delegation's brief, a plan under review, a
 * workflow's script) and policy/qualifier fields (why a command may escalate,
 * which window of a file to read) both make the row longer and less
 * distinguishable, which is the opposite of the point.
 */
const NOISE_KEYS: ReadonlySet<string> = new Set([
  // bulk payloads
  'code',
  'content',
  'file_text',
  'items',
  'new_str',
  'new_string',
  'old_str',
  'old_string',
  'plan',
  'prompt',
  'script',
  'todos',
  // policy / qualifiers
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

/**
 * A human label the tool was handed for exactly this purpose — but only worth
 * showing when nothing sharper survived.
 *
 * A shell call carries both `command` and `description`, and the command is
 * what identifies the run: `Bash(ls -1 src)`, not `Bash(list src)`. A
 * delegation carries `description` and `prompt`, and the prompt is bulk — so
 * the description is all that is left, and it is precisely what the original
 * puts in the parens: `Task(Review the diff)`, never the brief itself.
 */
const LABEL_KEYS: ReadonlySet<string> = new Set(['description'])

const renderValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }

  const json = JSON.stringify(value)

  // undefined/functions/symbols stringify to nothing; show the coerced form
  // rather than a hole in the middle of a `key: , key: ` list.
  return json === undefined ? String(value) : json
}

/**
 * An object argument that carries its own `name` IS that name — a workflow's
 * `meta` block, a bridge's descriptor. Rendered as JSON it would put the
 * identity behind a brace and two quotes, and the row's 64 columns then lose
 * it to the truncation ellipsis, which is the one thing the parens exist to
 * prevent.
 */
const identify = (value: unknown): unknown => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const name = (value as { name?: unknown }).name

    if (typeof name === 'string' && name) {
      return name
    }
  }

  return value
}

const project = (entries: [string, unknown][]): string => {
  const named = entries.map(([key, value]) => [key, identify(value)] as [string, unknown])

  // A single surviving argument IS the call's identity — `Read(src/a.ts)`, not
  // `Read(file_path: src/a.ts)`. More than one needs its keys to stay legible.
  if (named.length === 1 && typeof named[0]![1] === 'string') {
    return named[0]![1] as string
  }

  return named.map(([key, value]) => `${key}: ${renderValue(value)}`).join(', ')
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
  const salient = entries.filter(([key]) => !NOISE_KEYS.has(key) && !LABEL_KEYS.has(key))

  if (salient.length) {
    return project(salient)
  }

  // A call whose every argument is bulk or policy has nothing to put in the
  // parens, and that is the right answer, not a failure: `formatToolCall`
  // renders a preview-less call as a bare label, which is exactly what the
  // original shows for `⏺ TodoWrite` and `⏺ ExitPlanMode` — both of which draw
  // their real content (the checklist, the plan under review) below the row.
  return project(entries.filter(([key]) => LABEL_KEYS.has(key)))
}
