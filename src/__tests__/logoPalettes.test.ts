import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { logo, whale, wordmarkGradient } from '../banner.js'
import {
  DEFAULT_LOGO_PALETTE,
  gradientStopForRow,
  isLogoPaletteName,
  LOGO_PALETTE_LABELS,
  LOGO_PALETTE_NAMES,
  LOGO_PALETTES,
  readLogoColorSync,
  rgbStr
} from '../lib/logoPalettes.js'
import { DEFAULT_THEME } from '../theme.js'

const C = DEFAULT_THEME.color

// The shipped brand ramp (banner.ts LOGO_BRAND) — the default look that unset
// AND explicit "whale" must both keep.
const BRAND_TOP = 'rgb(150,180,255)'

describe('logo palette table (StartupScreen.palettes.ts parity)', () => {
  it('carries the five palettes with six gradient stops each', () => {
    expect(LOGO_PALETTE_NAMES).toEqual(['whale', 'sunset', 'forest', 'ocean', 'monochrome'])

    for (const name of LOGO_PALETTE_NAMES) {
      expect(LOGO_PALETTES[name].gradient).toHaveLength(6)
    }

    expect(DEFAULT_LOGO_PALETTE).toBe('whale')
    expect(LOGO_PALETTE_LABELS.whale).toBe('Whale (default)')
    expect(LOGO_PALETTE_LABELS.sunset).toBe('Sunset')
    expect(LOGO_PALETTE_LABELS.forest).toBe('Forest green')
    expect(LOGO_PALETTE_LABELS.ocean).toBe('Ocean blue')
    expect(LOGO_PALETTE_LABELS.monochrome).toBe('Monochrome')
  })

  it('spot-checks verbatim TS gradient values', () => {
    expect(LOGO_PALETTES.whale.gradient[2]).toEqual([77, 107, 254])
    expect(LOGO_PALETTES.sunset.gradient[0]).toEqual([255, 180, 100])
    expect(LOGO_PALETTES.forest.gradient[5]).toEqual([25, 80, 45])
    expect(LOGO_PALETTES.ocean.gradient[2]).toEqual([80, 150, 220])
    expect(LOGO_PALETTES.monochrome.gradient[3]).toEqual([125, 125, 125])
  })

  it('validates palette names', () => {
    expect(isLogoPaletteName('ocean')).toBe(true)
    expect(isLogoPaletteName('lava')).toBe(false)
    expect(isLogoPaletteName('')).toBe(false)
    expect(isLogoPaletteName(undefined)).toBe(false)
    // hasOwnProperty guard: prototype keys must not validate.
    expect(isLogoPaletteName('constructor')).toBe(false)
  })
})

describe('gradientStopForRow', () => {
  const stops = LOGO_PALETTES.ocean.gradient

  it('maps a 6-row block onto 6 stops one-to-one', () => {
    for (let i = 0; i < 6; i++) {
      expect(gradientStopForRow(stops, i, 6)).toEqual(stops[i])
    }
  })

  it('samples ends for other row counts and degenerate inputs', () => {
    expect(gradientStopForRow(stops, 0, 3)).toEqual(stops[0])
    expect(gradientStopForRow(stops, 2, 3)).toEqual(stops[5])
    expect(gradientStopForRow(stops, 0, 1)).toEqual(stops[0])
  })
})

describe('banner painting with /logo palettes', () => {
  it('keeps the shipped brand ramp for unset and explicit whale', () => {
    expect(wordmarkGradient(undefined)[0]).toBe(BRAND_TOP)
    expect(wordmarkGradient('')[0]).toBe(BRAND_TOP)
    expect(wordmarkGradient('whale')[0]).toBe(BRAND_TOP)
    expect(wordmarkGradient('not-a-palette')[0]).toBe(BRAND_TOP)

    const rows = logo(C, undefined, 'whale')
    expect(rows[0]![0]).toBe(BRAND_TOP)
  })

  it('paints wordmark rows from a non-default palette gradient', () => {
    const rows = logo(C, undefined, 'ocean')
    expect(rows).toHaveLength(6)
    rows.forEach((row, i) => expect(row[0]).toBe(rgbStr(LOGO_PALETTES.ocean.gradient[i]!)))
  })

  it('paints whale rows from the active palette (default: whale blues)', () => {
    const themed = whale(C, undefined, undefined)
    const explicit = whale(C, undefined, 'whale')
    expect(explicit).toEqual(themed)
    themed.forEach((row, i) =>
      expect(row[0]).toBe(rgbStr(gradientStopForRow(LOGO_PALETTES.whale.gradient, i, 6)))
    )

    const forest = whale(C, undefined, 'forest')
    expect(forest).toHaveLength(6)
    forest.forEach((row, i) =>
      expect(row[0]).toBe(rgbStr(gradientStopForRow(LOGO_PALETTES.forest.gradient, i, 6)))
    )
  })

  it('lets a skin banner override win over the palette', () => {
    const rows = logo(C, '[#ff0000]X[/]', 'ocean')
    expect(rows).toEqual([['#ff0000', 'X']])

    const hero = whale(C, '[#00ff00]Y[/]', 'ocean')
    expect(hero).toEqual([['#00ff00', 'Y']])
  })
})

describe('readLogoColorSync', () => {
  const prevHome = process.env.CLAWCODEX_HOME
  let dir = ''

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.CLAWCODEX_HOME
    } else {
      process.env.CLAWCODEX_HOME = prevHome
    }

    if (dir) {
      rmSync(dir, { force: true, recursive: true })
      dir = ''
    }
  })

  const home = (config?: string) => {
    dir = mkdtempSync(join(tmpdir(), 'clawcodex-logo-'))
    mkdirSync(dir, { recursive: true })

    if (config !== undefined) {
      writeFileSync(join(dir, 'config.json'), config)
    }

    process.env.CLAWCODEX_HOME = dir
  }

  it('reads a valid persisted palette name', () => {
    home(JSON.stringify({ logoColor: 'forest' }))
    expect(readLogoColorSync()).toBe('forest')
  })

  it("returns '' for unset, invalid, malformed, and missing config", () => {
    home(JSON.stringify({ default_provider: 'anthropic' }))
    expect(readLogoColorSync()).toBe('')

    home(JSON.stringify({ logoColor: 'lava' }))
    expect(readLogoColorSync()).toBe('')

    home('{not json')
    expect(readLogoColorSync()).toBe('')

    home(undefined)
    expect(readLogoColorSync()).toBe('')
  })
})
