#!/usr/bin/env node
// Bundles the cordis plugin (src/harness/index.ts) into dist/plugin.js.
// Everything except @deepseek-ai/* is bundled in (React, the vendored ink
// fork, the whole app), so a dsh profile needs no extra node_modules to load
// the plugin — the harness packages resolve from the profile itself.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const out = resolve(root, 'dist/plugin.js')

const stubDevtools = {
  name: 'stub-react-devtools-core',
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, args => ({
      path: args.path,
      namespace: 'stub-devtools'
    }))
    b.onLoad({ filter: /.*/, namespace: 'stub-devtools' }, () => ({
      contents: 'export default { initialize() {}, connectToDevTools() {} }',
      loader: 'js'
    }))
  }
}

await build({
  entryPoints: [resolve(root, 'src/harness/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  jsx: 'automatic',
  jsxImportSource: 'react',
  // The harness framework and services must be shared with the host process —
  // never bundled — so cordis instanceof/service identities stay unified.
  external: ['@deepseek-ai/*'],
  // Bundle the ink fork from source (the prebuilt bundle's __esm helper breaks
  // lazy-initialized exports like `render`).
  alias: { '@dsh-cctui/ink': resolve(root, 'packages/dsh-cctui-ink/src/entry-exports.ts') },
  plugins: [stubDevtools],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  },
  logLevel: 'info'
})

console.log(`built ${out}`)
