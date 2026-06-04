import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Minimal Vitest config — resolves the `@/` alias used throughout
 * `src/renderer/*` so unit tests importing renderer modules can find
 * sibling files.  Tests live under `tests/unit/` and import via either
 * the alias or a relative path; both resolve through this config.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer')
    }
  },
  test: {
    include: ['tests/unit/**/*.test.ts']
  }
})
