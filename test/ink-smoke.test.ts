// Stage 2 acceptance: the vendored @dsh-cctui/ink fork builds and renders headlessly.
import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

const ESC = '\u001b'
const ansiPattern = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}\\][^${ESC}\u0007]*(?:\u0007|${ESC}\\\\)|${ESC}[=>]`, 'g')

describe('vendored @dsh-cctui/ink fork', () => {
  it('renders Box/Text synchronously into a fake TTY', async () => {
    const { Box, Text, renderSync } = await import('@dsh-cctui/ink')
    const stdout = Object.assign(new PassThrough(), { columns: 40, rows: 12, isTTY: true })
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} })
    let output = ''
    stdout.on('data', chunk => {
      output += String(chunk)
    })
    const instance = renderSync(
      createElement(
        Box,
        { borderStyle: 'round', paddingX: 1 },
        createElement(Text, { color: 'green' }, 'dsh-cctui smoke')
      ),
      // @ts-expect-error test streams stand in for process streams
      { stdout, stdin, stderr: new PassThrough(), exitOnCtrlC: false, patchConsole: false }
    )
    instance.unmount()
    // The renderer may emit padding as cursor moves rather than literal spaces,
    // so assert word-by-word rather than on exact spacing.
    const plain = output.replace(ansiPattern, '')
    expect(plain).toContain('dsh-cctui')
    expect(plain).toContain('smoke')
    expect(plain).toContain('╭')
  })
})
