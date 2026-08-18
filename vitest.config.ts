import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**', 'reference_projects/**', 'packages/clawcodex-ink/dist/**', 'packages/clawcodex-ink/node_modules/**'],
    // The upstream suites assume fast hardware; the cursor-drift regression walks
    // every typing prefix through a real Ink render and needs >5s on WSL2.
    testTimeout: 120000
  }
})
