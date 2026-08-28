/**
 * REQ-20260615-072 / **REQ-0422** — STEP1 initial accordion state, end to end.
 *
 * The pure helper `pickInitialOpenSection` is unit-tested in
 * `tests/unit/step1-initial-open.test.ts`.  This spec covers the wiring: does
 * `WhisperModelManager`'s listModels callback actually reach the step1 route
 * and drive `openSection`, and does the DOM reflect it?
 *
 * ## What changed, and why this file was red (REQ-0512)
 *
 * Until REQ-0512 this spec asserted "**exactly one** accordion is expanded",
 * and its own docstring explained the installed-model branch as "the
 * input-video accordion opens".  **REQ-0422 removed the input-video accordion
 * from STEP1** — file selection moved into the setup drawer — and with it the
 * must-touch section that justified auto-opening anything on the happy path.
 * `step1-drawer-restructure.md` §6 states the replacement rule outright:
 *
 *   > `pickInitialOpenSection` の `'inputVideo'` 分岐 → モデル導入済みは
 *   > **all-collapsed (`null`)**
 *
 * `step1-initial-open.ts` implements exactly that. So the product was right and
 * this spec was guarding the pre-REQ-0422 contract — on any machine with a
 * Whisper model installed it demanded an expanded accordion that is not
 * supposed to be there, and failed.  Nobody saw it because `npm run test:e2e`
 * was not in the standard gate list until REQ-0512 (RES-0511 §3.3).
 *
 * ## Why it still watches `aria-expanded`
 *
 * The accordions did not go away — Whisper / device / translation are still
 * there; only the input-video one was removed.  So the attribute remains the
 * honest observation point for "what is open on first paint"; what needed
 * replacing was the *expected value*, not the probe.
 *
 * ## Live-state caveat (unchanged)
 *
 * The Electron main process resolves `%APPDATA%\\MOJIOKO\\models\\` through
 * `app.getPath('appData')` with no override hook, so this asserts ONE of the
 * two branches depending on what is installed:
 *
 *   - a model IS active  → **every** STEP1 accordion collapsed (REQ-0422)
 *   - no model is active → the **Whisper** accordion opens (the REQ-072 fix)
 *
 * Both branches share one wiring path, so whichever runs guards the other by
 * transitivity.  The branch taken is logged.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import path from 'path'

/** The transcription-tool section's header label, in every shipped locale. */
function whisperHeaderLabels(): string[] {
  return ['ja', 'en'].map((lang) => {
    const file = path.resolve(__dirname, `../../src/renderer/locales/${lang}/step1.json`)
    const label = JSON.parse(readFileSync(file, 'utf8'))?.whisperModel?.label
    expect(typeof label, `${lang} step1.json is missing whisperModel.label`).toBe('string')
    return label as string
  })
}

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

  /**
   * Wait for the listModels IPC to have LANDED before judging anything.
   *
   * This matters more than it looks. On a machine with a model installed the
   * expected end state is "nothing expanded", which is also what the route
   * shows before the IPC returns (`useState(null)`) — so asserting it too
   * early would pass without the wiring ever running, the same "zero means
   * both things" trap REQ-0511 M1 removed from `timeline-perf`. Two mutually
   * exclusive signals prove the round-trip finished:
   *
   *   - the Whisper header renders the active model's displayName (installed), or
   *   - some accordion is expanded (not installed → Whisper auto-opens).
   */
  await window.waitForFunction(() => {
    const headers = Array.from(document.querySelectorAll('[role="button"][aria-expanded]'))
    const anyExpanded = headers.some((h) => h.getAttribute('aria-expanded') === 'true')
    // The active-model chip is the only font-mono span inside a header.
    const modelShown = headers.some((h) => h.querySelector('span.font-mono') !== null)
    return anyExpanded || modelShown
  }, undefined, { timeout: 5_000 })

  const observed = await window.evaluate(() => {
    const headers = Array.from(document.querySelectorAll('[role="button"][aria-expanded]'))
    return {
      headers: headers.map((h) => ({
        expanded: h.getAttribute('aria-expanded'),
        // Identified against the i18n bundle below, not a hardcoded word:
        // the inherited comment here claimed "the Whisper header always
        // carries the i18n 'Whisper' label", which is false in BOTH locales
        // (文字起こしツール / "Transcription tool") — a stale claim in a branch
        // this machine cannot run, so it would have gone on being believed.
        label: (h.textContent ?? '').slice(0, 40).trim(),
      })),
      modelActive: headers.some((h) => h.querySelector('span.font-mono') !== null),
    }
  })

  // Guard against a vacuous pass: if STEP1 rendered no accordions at all, every
  // "collapsed" assertion below would hold trivially.
  expect(observed.headers.length, 'STEP1 should render its accordion headers').toBeGreaterThanOrEqual(2)

  const expanded = observed.headers.filter((h) => h.expanded === 'true')
  // eslint-disable-next-line no-console
  console.log(`[REQ-0422 e2e] branch = ${observed.modelActive ? 'model installed' : 'no model'}`,
    ' expanded =', expanded, ' all =', observed.headers)

  if (observed.modelActive) {
    // REQ-0422 — the happy path has no must-touch section, so first paint is
    // fully collapsed and the user just presses [文字起こし開始].
    expect(expanded, 'with a model installed every STEP1 accordion must start collapsed').toEqual([])
  } else {
    // REQ-072 — the one case that still auto-opens: the user has no model and
    // the download flow is what they need to reach first.
    expect(expanded.length, 'with no model exactly the Whisper accordion should open').toBe(1)
    const labels = whisperHeaderLabels()
    expect(
      labels.some((l) => expanded[0].label.includes(l)),
      `the opened accordion should be the transcription-tool one (expected one of ${labels.join(' / ')}, got "${expanded[0].label}")`,
    ).toBe(true)
  }

  await app.close()
})
