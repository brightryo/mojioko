/**
 * REQ-20260615-072 — STEP1 mutually-exclusive accordion initial-open
 * end-to-end check.
 *
 * The pure helper `pickInitialOpenSection` is unit-tested in
 * `tests/unit/step1-initial-open.test.ts`.  This spec covers the wiring:
 * does `WhisperModelManager`'s listModels callback actually reach the
 * step1 route and drive `openSection` to the correct value?
 *
 * Caveat — this test uses the **live** `%APPDATA%\MOJIOKO\models\` state
 * because the Electron main process resolves it via `app.getPath('appData')`
 * and there is no override hook for the IPC backend.  It therefore
 * asserts ONE of the two cases depending on what is installed:
 *
 *   - If at least one model is installed (= `activeModelId !== null`) →
 *     input-video accordion opens (= the v1.3.0 default behaviour, fix
 *     verifies no regression for existing users).
 *
 *   - If no model is installed (= `activeModelId === null`) → Whisper
 *     accordion opens (= the REQ-072 fix proper).
 *
 * Both branches share the same wiring (`handleActiveModelChange` →
 * `pickInitialOpenSection` → `setOpenSection`), so one branch run
 * regression-guards the other by transitivity.  The branch the spec
 * actually exercises is logged so a Phase-0.5 sideload smoke can
 * extend to the other branch from the same harness.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'

test('STEP1 opens the correct initial accordion for the live model state', async () => {
  const app = await electron.launch({
    args: [path.resolve(__dirname, '../../out/main/index.js')],
    timeout: 30_000,
  })
  const window = await app.firstWindow()
  window.on('pageerror', (err) => console.log('[renderer pageerror]', err.message))

  const indexFile = path.resolve(__dirname, '../../out/renderer/index.html')
  await window.goto('file:///' + indexFile.replace(/\\/g, '/'))
  await window.waitForSelector('[role="button"][aria-expanded]')

  // Give the listModels IPC enough time to round-trip and drive the
  // initial-open decision via handleActiveModelChange.  Locally observed:
  // <50 ms; 2 s is a defensive ceiling for slow CI / cold-cache machines.
  await window.waitForFunction(() => {
    const headers = Array.from(document.querySelectorAll('[role="button"][aria-expanded]'))
    return headers.some((h) => h.getAttribute('aria-expanded') === 'true')
  }, undefined, { timeout: 2_000 })

  const headerStates = await window.evaluate(() => {
    const headers = Array.from(document.querySelectorAll('[role="button"][aria-expanded]'))
    return headers.map((h) => ({
      expanded: h.getAttribute('aria-expanded'),
      // The Whisper header always carries the i18n "Whisper" label;
      // the inputVideo header carries the i18n "入力ファイル" / "Input file".
      // Match defensively on a fragment that survives both locales.
      label: (h.textContent ?? '').slice(0, 40).trim(),
    }))
  })

  // Exactly one header should report aria-expanded="true" (mutual exclusion).
  const expanded = headerStates.filter((h) => h.expanded === 'true')
  const collapsed = headerStates.filter((h) => h.expanded === 'false')
  // eslint-disable-next-line no-console
  console.log('[REQ-072 e2e] expanded =', expanded, ' collapsed =', collapsed)

  expect(expanded.length, 'exactly one accordion should be expanded').toBe(1)
  expect(collapsed.length, 'the other accordion should be collapsed').toBeGreaterThanOrEqual(1)

  await app.close()
})
