export function isMouseClicksDisabled(): boolean {
  return /^(1|true|yes|on)$/.test((process.env.DSH_CCTUI_DISABLE_MOUSE_CLICKS ?? '').trim().toLowerCase())
}
