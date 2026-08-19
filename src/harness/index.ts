// Cordis plugin surface for dsh-cctui. Kept minimal: the loader reads
// name/inject/Config synchronously; the heavy TUI wiring lives in plugin.ts
// behind a dynamic import so a boot failure surfaces as a plugin error
// instead of a module-load crash.
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-cctui'

// Code-level inject stays minimal (the agent registry is the one hard
// requirement); optional services are soft-probed with ctx.get so the plugin
// degrades instead of deadlocking when a profile lacks them.
export const inject = ['agents']

export interface Config {
  /** Working directory for the agent session (defaults to process.cwd()). */
  cwd?: string
  /** Model id; defaults to the profile's agent-default-model selection. */
  model?: string
  /** Provider route; defaults to the profile's agent-default-model selection. */
  provider?: string
  /** Resume/attach to a fixed session id instead of generating one. */
  sessionId?: string
  /** Allow running without a TTY (headless tests only). */
  allowNoTty?: boolean
}

export const Config: Schema<Config> = Schema.object({
  allowNoTty: Schema.boolean(),
  cwd: Schema.string(),
  model: Schema.string(),
  provider: Schema.string(),
  sessionId: Schema.string()
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  const mod = await import('./plugin.js')

  await mod.mountCcTui(ctx, config)
}
