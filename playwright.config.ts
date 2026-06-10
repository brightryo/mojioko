import { defineConfig } from '@playwright/test'

/**
 * Minimal Playwright config — REQ-071 Phase 3.8 introduced E2E for an
 * empirical colour-probe spec.  The renderer needs to be already built
 * (`npm run build`) before running these specs because Playwright
 * launches the Electron main process which loads `out/renderer/index.html`.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    actionTimeout: 15_000
  },
  timeout: 60_000
})
