export function logError(error: unknown): void {
  if (!process.env.DSH_CCTUI_INK_DEBUG_ERRORS) {
    return
  }

  console.error(error)
}
