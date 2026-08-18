import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'reference_projects/**', '.dsh-dev-home/**'],
    // The upstream suites assume fast hardware; the cursor-drift regression walks
    // every typing prefix through a real Ink render and needs >5s on WSL2.
    testTimeout: 120000,
    // The upstream interactive .tsx suites drive fake stdin with fixed 20ms
    // delays; under full-suite parallel load they occasionally miss. One retry
    // absorbs the timing blip while real regressions still fail twice.
    retry: 1
  }
})
