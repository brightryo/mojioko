import { defineConfig } from '@playwright/test'

/**
 * REQ-0506 §3 — config for `tests/measure/`, which holds MEASUREMENT HARNESSES,
 * not gates.
 *
 * They are kept out of `playwright.config.ts` (`testDir: './tests/e2e'`) on
 * purpose: `npm run test:e2e` must contain only things that can fail
 * meaningfully. These print numbers, so they get their own entry point and are
 * never part of a green/red verdict.
 *
 * Run:  npm run measure:timeline   /   npm run measure:list
 * See:  tests/measure/README.md
 */
export default defineConfig({
  testDir: './tests/measure',
  testMatch: '**/*.measure.ts',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: { actionTimeout: 15_000 },
  timeout: 120_000,
})
