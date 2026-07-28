/**
 * REQ-0345 §2-3 — the list view keeps a bounded DOM at any entry count.
 *
 * ## Why a budget, and why this one
 *
 * Virtualization is the kind of thing that gets removed by accident: someone
 * needs "just one more row visible", or replaces the windowed body with a
 * plain `.map` while fixing something else, and nothing fails.  The app still
 * works — it works exactly as it did before REQ-0345, which is to say it
 * takes 41 seconds to open a 10,000-row list.  There is no error to notice.
 *
 * So the invariant is asserted directly, in the only terms that cannot be
 * satisfied by accident: **the number of DOM elements must not grow with the
 * number of entries.**  Measured before the change, at 10,000 entries, the
 * list held 339,348 elements — about 34 per row, every row mounted.  After,
 * it holds ~530 regardless of the count.
 *
 * The budget is deliberately loose (`MAX_ELEMENTS`): a taller window renders
 * more rows, and the overscan is free to change.  It does not need to be
 * tight to do its job — anything that stops windowing overshoots it by two
 * orders of magnitude, and a budget nobody can bump into is a budget nobody
 * is tempted to "just raise a little".
 *
 * Companion to `timeline-budget.spec.ts`, which asserts the same shape of
 * property for the timeline.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'

const INDEX_MAIN = path.resolve(__dirname, '../../out/main/index.js')
const INDEX_HTML = path.resolve(__dirname, '../../out/renderer/index.html')

/** The extreme size REQ-0343 generated a load-test SRT for. */
const ENTRY_COUNT = 10_000

/**
 * Ceiling for `document.getElementsByTagName('*').length` with the list open
 * at ENTRY_COUNT.  Measured at ~530; the headroom absorbs window size,
 * overscan changes, and rows that wrap to more lines.  Un-virtualizing lands
 * at ~339,000, so this catches it by a factor of ~68.
 */
const MAX_ELEMENTS = 5_000

/**
 * Ceiling on mounted ROWS.  A second, independent statement of the same
 * property: element count could in principle be gamed by making rows
 * cheaper, but the row count is what windowing actually controls.
 */
const MAX_MOUNTED_ROWS = 120

test('REQ-0345 §2-3 — list DOM stays bounded at 10,000 entries', async () => {
  test.setTimeout(180_000)
  const app = await electron.launch({ args: [INDEX_MAIN], timeout: 60_000 })
  try {
    const win = await app.firstWindow()
    await win.goto('file:///' + INDEX_HTML.replace(/\\/g, '/') + '?seed=demo&start=step2')
    await win.waitForFunction(() =>
      Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))

    const measured = await win.evaluate(async (n) => {
      const t = (window as unknown as {
        __mojioko_test: {
          ui: { setState: (s: unknown) => void }
          project: {
            setState: (s: unknown) => void
            getState: () => { entries: ReadonlyArray<Record<string, unknown>> }
          }
        }
      }).__mojioko_test
      const settle = () => new Promise((res) =>
        requestAnimationFrame(() => requestAnimationFrame(res)))

      const sample = t.project.getState().entries[0]
      const entries = Array.from({ length: n }, (_, i) => ({
        ...sample,
        id: `budget-${i}`,
        startSec: i * 1.08,
        endSec: i * 1.08 + 0.88,
        text: 'この動画では Whisper を使って文字起こしします。',
        original: { ...(sample.original as object) },
      }))
      t.project.setState({ entries })
      t.ui.setState({
        editorViewMode: 'list',
        selectedRowIds: new Set<string>(),
        selectedEntryId: null,
        focusedRowId: null,
      })
      await settle()
      await settle()

      const scroller = document.querySelector<HTMLElement>('.flex-1.overflow-y-auto')
      return {
        elements: document.getElementsByTagName('*').length,
        // Every non-frozen row renders this chip exactly once.
        mountedRows: document.querySelectorAll('[data-testid="adjust-time"]').length,
        // Proof the list is not simply empty: the spacer must declare the
        // full scrollable height even though the rows are not there.
        scrollHeight: scroller?.scrollHeight ?? 0,
        clientHeight: scroller?.clientHeight ?? 0,
      }
    }, ENTRY_COUNT)

    // eslint-disable-next-line no-console
    console.log(`[REQ-0345 §2-3] ${JSON.stringify(measured)}`)

    // A blank list would trivially satisfy the budget, so establish first
    // that the list is real and scrollable before asserting the ceiling.
    expect(measured.mountedRows, 'rows are actually rendered').toBeGreaterThan(0)
    expect(
      measured.scrollHeight,
      'the spacer declares the full list height, so the scrollbar is honest',
    ).toBeGreaterThan(measured.clientHeight * 10)

    expect(
      measured.elements,
      `list DOM element count at ${ENTRY_COUNT} entries — virtualization off? ` +
      `(pre-REQ-0345 this was 339,348)`,
    ).toBeLessThanOrEqual(MAX_ELEMENTS)
    expect(
      measured.mountedRows,
      `mounted rows at ${ENTRY_COUNT} entries — the window should not grow with the list`,
    ).toBeLessThanOrEqual(MAX_MOUNTED_ROWS)
  } finally {
    await app.close()
  }
})
