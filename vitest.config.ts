import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**', 'reference_projects/**', 'packages/clawcodex-ink/dist/**', 'packages/clawcodex-ink/node_modules/**']
  }
})
