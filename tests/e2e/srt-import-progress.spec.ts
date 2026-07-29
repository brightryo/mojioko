/**
 * REQ-0346 §1-5 — the SRT import shows a modal, and cancelling it leaves the
 * project untouched.
 *
 * ## What is actually being pinned
 *
 * Two properties, and they are different in kind:
 *
 * 1. **The dialog is visible WHILE the work runs.** That is not automatic:
 *    every phase of the import is synchronous, so a dialog opened without
 *    handing the frame back to the browser would only paint after the work it
 *    announces had finished. `yieldToPaint` in `runSrtImport` is what makes it
 *    appear, and this spec fails if that yield is removed.
 *
 * 2. **Cancel is all-or-nothing** (REQ-0346 §1-3). A half-imported project is
 *    the worst outcome, worse than a slow one: the user cannot tell which rows
 *    are theirs. The import builds its entries in a local array and writes the
 *    store exactly once at the end, so abandoning the array IS the rollback —
 *    this asserts the store still holds the pre-import entries.
 *
 * The import is driven through `__mojioko_test.importSrtForTest`, which runs
 * the real `runSrtImport` with the file dialog stubbed; there is no way to
 * drive a native file picker from Playwright, and re-implementing the pipeline
 * in the test would pin the copy rather than the code that ships.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'
import { readFileSync } from 'fs'

const INDEX_MAIN = path.resolve(__dirname, '../../out/main/index.js')
const INDEX_HTML = path.resolve(__dirname, '../../out/renderer/index.html')
const SRT_10K = path.resolve(__dirname, '../../dev-docs/loadtest/loadtest-mixed-10000.srt')

test('REQ-0346 §1 — import shows a modal, and cancel imports nothing', async () => {
  test.setTimeout(300_000)
  const raw = readFileSync(SRT_10K, 'utf8')
  const app = await electron.launch({ args: [INDEX_MAIN], timeout: 60_000 })
  try {
    const win = await app.firstWindow()
    await win.goto('file:///' + INDEX_HTML.replace(/\\/g, '/') + '?seed=demo&start=step2')
    await win.waitForFunction(() =>
      Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))

    // The load-test SRT describes a 3-hour timeline, and the import DROPS any
    // cue past the loaded video's duration (RES-0223 §5).  The seed fixture's
    // video is 872 s, so without this only ~807 of the 10,000 cues would
    // survive — a correct result, but not the owner's scenario.  Give the
    // fixture the 3-hour duration the file was generated for.
    const before = await win.evaluate(() => {
      const t = (window as unknown as {
        __mojioko_test: {
          project: {
            getState: () => { entries: unknown[]; video: Record<string, unknown> | null }
            setState: (s: unknown) => void
          }
        }
      }).__mojioko_test
      const v = t.project.getState().video
      t.project.setState({ video: { ...v, durationSec: 10_800 } })
      return t.project.getState().entries.length
    })
    expect(before, 'seed fixtures are loaded, so a failed rollback would be visible').toBeGreaterThan(0)

    // ---- Cancel path -------------------------------------------------
    const cancelled = await win.evaluate(async (raw) => {
      const w = window as unknown as {
        __mojioko_test: {
          importSrtForTest: (raw: string) => Promise<void>
          project: { getState: () => { entries: unknown[] } }
        }
      }
      const run = w.__mojioko_test.importSrtForTest(raw)
      // Let the dialog paint, then hit its Cancel button the way a user does.
      await new Promise((r) => setTimeout(r, 60))
      const dialog = document.querySelector('[role="dialog"]')
      const dialogVisibleDuringWork = Boolean(dialog)
      const dialogText = (dialog?.textContent ?? '').trim()
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      const cancelBtn = buttons.find((b) => !b.disabled)
      cancelBtn?.click()
      await run
      return {
        dialogVisibleDuringWork,
        dialogText,
        clickedCancel: Boolean(cancelBtn),
        entriesAfter: w.__mojioko_test.project.getState().entries.length,
      }
    }, raw)

    // eslint-disable-next-line no-console
    console.log(`[REQ-0346 cancel] ${JSON.stringify(cancelled)}`)

    expect(
      cancelled.dialogVisibleDuringWork,
      'the progress dialog must be on screen WHILE the import runs, not after',
    ).toBe(true)
    expect(cancelled.clickedCancel, 'a Cancel button was offered').toBe(true)
    // i18next renders a missing key as the key itself, which looks like a
    // populated dialog in a screenshot and reads as gibberish to a user.
    // This shipped once during REQ-0346 and was only caught by eye.
    expect(
      cancelled.dialogText,
      `dialog is showing raw i18n keys — a translation is missing ("${cancelled.dialogText}")`,
    ).not.toMatch(/dialog\.|toast\.|common\./)
    expect(cancelled.dialogText.length, 'dialog has visible text').toBeGreaterThan(0)
    expect(
      cancelled.entriesAfter,
      'cancel is all-or-nothing: the project must be exactly as it was',
    ).toBe(before)

    // ---- Success path ------------------------------------------------
    const done = await win.evaluate(async (raw) => {
      const w = window as unknown as {
        __mojioko_test: {
          importSrtForTest: (raw: string) => Promise<void>
          project: { getState: () => { entries: unknown[] } }
        }
      }
      const t0 = performance.now()
      await w.__mojioko_test.importSrtForTest(raw)
      const totalMs = Math.round(performance.now() - t0)
      return {
        totalMs,
        entriesAfter: w.__mojioko_test.project.getState().entries.length,
      }
    }, raw)

    // eslint-disable-next-line no-console
    console.log(`[REQ-0346 import] ${JSON.stringify(done)}`)

    expect(done.entriesAfter, 'all 10,000 cues imported').toBe(10_000)
    // Polled rather than sampled once: the dialog is dismissed by a React
    // state update that lands after a very heavy commit, and Radix plays an
    // exit transition on top of that.  A single immediate check would be
    // asserting on the animation, not on whether the modal releases the UI.
    await expect(
      win.locator('[role="dialog"]'),
      'the dialog closes when the import finishes',
    ).toHaveCount(0, { timeout: 15_000 })
  } finally {
    await app.close()
  }
})
