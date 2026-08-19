import { stringWidth } from '@dsh-cctui/ink'

import {
  DEFAULT_LOGO_PALETTE,
  gradientStopForRow,
  isLogoPaletteName,
  LOGO_PALETTES,
  type LogoPaletteName,
  rgbStr
} from './lib/logoPalettes.js'
import type { ThemeColors } from './theme.js'

const RICH_RE = /\[(?:bold\s+)?(?:dim\s+)?(#(?:[0-9a-fA-F]{3,8}))\]([\s\S]*?)(\[\/\])/g

export function parseRichMarkup(markup: string): Line[] {
  const lines: Line[] = []

  for (const raw of markup.split('\n')) {
    const trimmed = raw.trimEnd()

    if (!trimmed) {
      lines.push(['', ' '])

      continue
    }

    const matches = [...trimmed.matchAll(RICH_RE)]

    if (!matches.length) {
      lines.push(['', trimmed])

      continue
    }

    let cursor = 0

    for (const m of matches) {
      const before = trimmed.slice(cursor, m.index)

      if (before) {
        lines.push(['', before])
      }

      lines.push([m[1]!, m[2]!])
      cursor = m.index! + m[0].length
    }

    if (cursor < trimmed.length) {
      lines.push(['', trimmed.slice(cursor)])
    }
  }

  return lines
}

const LOGO_ART = [
  '██████╗ ███████╗██╗  ██╗         ██████╗ ██████╗████████╗██╗   ██╗██╗',
  '██╔══██╗██╔════╝██║  ██║        ██╔════╝██╔════╝╚══██╔══╝██║   ██║██║',
  '██║  ██║███████╗███████║ █████╗ ██║     ██║        ██║   ██║   ██║██║',
  '██║  ██║╚════██║██╔══██║ ╚════╝ ██║     ██║        ██║   ██║   ██║██║',
  '██████╔╝███████║██║  ██║        ╚██████╗╚██████╗   ██║   ╚██████╔╝██║',
  '╚═════╝ ╚══════╝╚═╝  ╚═╝         ╚═════╝ ╚═════╝   ╚═╝    ╚═════╝ ╚═╝'
]

// dsh-ccTUI mascot — a blue whale, matching the DeepSeek brand. Painted from
// the active /logo gradient (default: ocean blues), beside the session panel.
const WHALE_ART = [
  '       : \' :',
  '    ___\'_______',
  '  /\'  o        \\--.',
  ' |              ___\\',
  '  \\____________/  \\/',
  '     \\__/  \\__/'
]

// The brand ramp: the "ocean" palette's stops — sky blue down to deep sea,
// matching DeepSeek's blue. Held here as strings (not read from LOGO_PALETTES)
// so the shipped wordmark look is pinned even if a palette entry is retuned;
// the two are kept identical and a test asserts it.
const LOGO_BRAND = [
  'rgb(170,220,255)',
  'rgb(125,185,240)',
  'rgb(80,150,220)',
  'rgb(55,115,190)',
  'rgb(40,85,150)',
  'rgb(25,55,110)'
] as const

export const LOGO_WIDTH = Math.max(...LOGO_ART.map(line => line.length))
export const WHALE_WIDTH = Math.max(...WHALE_ART.map(line => line.length))

// /logo palette → banner painting (applied at the banner's startup paint; the
// intro row is committed to scrollback, so a mid-session /logo shows on the
// NEXT launch, matching the original). The unset default AND an explicit
// "ocean" both keep the shipped look (brand LOGO_BRAND wordmark, ocean-blue
// whale): "Ocean blue (default)" IS dsh-ccTUI's default scheme, and picking
// it must return exactly to it. Only a non-default palette changes the paint —
// wordmark rows one gradient stop each, mascot rows sampled from the same
// gradient so the whale never clashes with the wordmark. Skin overrides
// (customLogo / customHero) win over the palette: a skin is a full rebrand,
// /logo recolors the default logo.
const nonDefaultPalette = (logoColor?: string): LogoPaletteName | null =>
  logoColor && logoColor !== DEFAULT_LOGO_PALETTE && isLogoPaletteName(logoColor) ? logoColor : null

/** The 6 wordmark row colors the banner will actually use for `logoColor` —
 *  also drives the /logo picker swatches so previews stay truthful. */
export const wordmarkGradient = (logoColor?: string): string[] => {
  const name = nonDefaultPalette(logoColor)

  return name ? LOGO_PALETTES[name].gradient.map(rgbStr) : [...LOGO_BRAND]
}

export const logo = (c: ThemeColors, customLogo?: string, logoColor?: string): Line[] => {
  if (customLogo) {
    return parseRichMarkup(customLogo)
  }

  const grad = wordmarkGradient(logoColor)

  return LOGO_ART.map((text, i) => [grad[i] ?? c.primary, text])
}

export const whale = (_c: ThemeColors, customHero?: string, logoColor?: string): Line[] => {
  if (customHero) {
    return parseRichMarkup(customHero)
  }

  const name = nonDefaultPalette(logoColor)
  const stops = name ? LOGO_PALETTES[name].gradient : LOGO_PALETTES[DEFAULT_LOGO_PALETTE].gradient

  return WHALE_ART.map((text, i) => [rgbStr(gradientStopForRow(stops, i, WHALE_ART.length)), text])
}

// Measured in columns, not code units: this feeds the header's left-column
// sizing (`optimalLeftWidth`), so a custom `bannerHero` skin with wide glyphs
// would otherwise under-size the column it has to fit inside.
export const artWidth = (lines: Line[]) => lines.reduce((m, [, t]) => Math.max(m, stringWidth(t)), 0)

type Line = [string, string]
