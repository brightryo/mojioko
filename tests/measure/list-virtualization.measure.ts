/**
 * REQ-0345 §1 / §2-2 — list-view cost as a function of entry count.
 *
 * Measures the three operations the owner reported as slow, plus the DOM node
 * count that explains them, at the five sizes REQ-0345 §2-2 names.  Same
 * method as REQ-0342: drive the real component in a real Electron window
 * through the `?seed=demo` hook, force a flush, and time the whole
 * setState → paint round trip rather than just the store write.
 *
 * Kept as a permanent harness rather than deleted as a one-off (CLAUDE.md §18):
 * the next question about list cost — "did virtualization regress?", "is the
 * inspector still O(1)?" — starts by needing exactly these numbers, and
 * `list-node-budget.spec.ts` asserts against the shape this file measures.
 *
 * Run it directly to print the table:
 *   npx playwright test tests/e2e/list-virtualization-perf.spec.ts
 */
import { _electron as electron, test } from '@playwright/test'
import path from 'path'

const INDEX_MAIN = path.resolve(__dirname, '../../out/main/index.js')
const INDEX_HTML = path.resolve(__dirname, '../../out/renderer/index.html')

/** The sizes REQ-0343 generated load-test SRTs for, and REQ-0345 §2-2 asks about. */
const COUNTS = [250, 1000, 3000, 6000, 10000]

interface Row {
  count: number
  switchToTimelineMs: number
  selectOneRowTimelineMs: number
  switchToListMs: number
  selectOneRowMs: number
  bulkFontSizeMs: number
  domNodesList: number
  domNodesTimeline: number
  rowsRendered: number
}

test('REQ-0345 — list view cost vs entry count', async () => {
  test.setTimeout(15 * 60_000)
  const app = await electron.launch({ args: [INDEX_MAIN], timeout: 60_000 })
  const win = await app.firstWindow()
  await win.goto('file:///' + INDEX_HTML.replace(/\\/g, '/') + '?seed=demo&start=step2')
  await win.waitForFunction(() =>
    Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))

  const rows: Row[] = []
  for (const count of COUNTS) {
    const r: Row = await win.evaluate(async (n) => {
      const w = window as unknown as {
        __mojioko_test: {
          ui: { setState: (s: unknown) => void }
          project: {
            setState: (s: unknown) => void
            getState: () => {
              entries: ReadonlyArray<Record<string, unknown>>
              updateEntriesBatch: (patches: ReadonlyMap<string, unknown>) => void
            }
          }
        }
      }
      const t = w.__mojioko_test
      /** Two rAFs ≈ "React has committed and the browser has laid out". */
      const settle = () => new Promise((res) =>
        requestAnimationFrame(() => requestAnimationFrame(res)))

      // ---- Build N entries from the seed's first row -------------------
      // Same technique as timeline-perf.spec.ts: clone a real fixture so
      // every field the row renderer touches is present and realistic.
      const sample = t.project.getState().entries[0]
      const TEXTS = [
        'この動画では Whisper を使って文字起こしします。',
        'まず MP4 ファイルを読み込んでください。',
        'GPU があれば CUDA で高速に処理されます。',
        'SRT や MP4 で書き出すことができます。',
      ]
      const entries = Array.from({ length: n }, (_, i) => ({
        ...sample,
        id: `req-0345-${i}`,
        startSec: i * 1.08,
        endSec: i * 1.08 + 0.88,
        text: TEXTS[i % TEXTS.length],
        original: { ...(sample.original as object) },
      }))

      // Start from the timeline, deselected — the state the owner is in
      // right after an SRT import.
      t.ui.setState({
        editorViewMode: 'timeline',
        selectedRowIds: new Set<string>(),
        selectedEntryId: null,
        focusedRowId: null,
      })
      t.project.setState({ entries })
      await settle()
      await settle()
      const domNodesTimeline = document.getElementsByTagName('*').length

      // ---- 0. the SAME two operations on the timeline, for comparison --
      // REQ-0345 §1-4 asks whether the timeline needs virtualization too.
      // It renders every entry as well, so the question is whether its much
      // smaller per-item cost keeps it usable at the same counts.
      t.ui.setState({ editorViewMode: 'list' })
      await settle()
      const tA = performance.now()
      t.ui.setState({ editorViewMode: 'timeline' })
      await settle()
      const switchToTimelineMs = Math.round(performance.now() - tA)
      const tB = performance.now()
      t.ui.setState({
        selectedEntryId: entries[0].id as string,
        focusedRowId: entries[0].id as string,
      })
      await settle()
      const selectOneRowTimelineMs = Math.round(performance.now() - tB)
      t.ui.setState({ selectedEntryId: null, focusedRowId: null })
      await settle()

      // ---- 1. switch to the list view ---------------------------------
      const t0 = performance.now()
      t.ui.setState({ editorViewMode: 'list' })
      await settle()
      const switchToListMs = Math.round(performance.now() - t0)
      const domNodesList = document.getElementsByTagName('*').length
      // How many rows actually exist in the DOM — the direct virtualization
      // signal.  Counted via the time-edit chip, which every non-frozen row
      // renders exactly once (`data-testid="adjust-time"`, subtitle-table.tsx);
      // using an existing attribute keeps this measurement honest about the
      // component as it ships rather than requiring a hook added for the test.
      const rowsRendered = document.querySelectorAll('[data-testid="adjust-time"]').length

      // ---- 2. select ONE row ------------------------------------------
      const firstId = entries[0].id as string
      const t1 = performance.now()
      t.ui.setState({ selectedEntryId: firstId, focusedRowId: firstId })
      await settle()
      const selectOneRowMs = Math.round(performance.now() - t1)

      // ---- 3. select all, then bump every font size by one step -------
      // Uses `updateEntriesBatch` — the ONE store write REQ-0342 §3 replaced
      // the per-row loop with — so this measures the bulk-edit bar's real
      // path and stays comparable with RES-0342's numbers.
      t.ui.setState({ selectedRowIds: new Set(entries.map((e) => e.id as string)) })
      await settle()
      const st = t.project.getState()
      const patches = new Map(
        st.entries.map((e) => [
          e.id as string,
          { fontSizePx: ((e as { fontSizePx: number }).fontSizePx ?? 100) + 4 },
        ]),
      )
      const t2 = performance.now()
      st.updateEntriesBatch(patches)
      await settle()
      const bulkFontSizeMs = Math.round(performance.now() - t2)

      // Reset selection so the next size starts clean.
      t.ui.setState({
        selectedRowIds: new Set<string>(),
        selectedEntryId: null,
        focusedRowId: null,
      })
      await settle()

      return {
        count: n,
        switchToTimelineMs,
        selectOneRowTimelineMs,
        switchToListMs,
        selectOneRowMs,
        bulkFontSizeMs,
        domNodesList,
        domNodesTimeline,
        rowsRendered,
      }
    }, count)
    rows.push(r)
    // eslint-disable-next-line no-console
    console.log(`[REQ-0345] ${JSON.stringify(r)}`)
  }

  // eslint-disable-next-line no-console
  console.log('\n[REQ-0345] count |  →list | sel1 | bulk | →timeline | sel1(TL) | DOM(list) | DOM(TL) | rows')
  for (const r of rows) {
    // eslint-disable-next-line no-console
    console.log(
      `[REQ-0345] ${String(r.count).padStart(5)} | ${String(r.switchToListMs).padStart(6)} | ` +
      `${String(r.selectOneRowMs).padStart(4)} | ${String(r.bulkFontSizeMs).padStart(4)} | ` +
      `${String(r.switchToTimelineMs).padStart(9)} | ${String(r.selectOneRowTimelineMs).padStart(8)} | ` +
      `${String(r.domNodesList).padStart(9)} | ${String(r.domNodesTimeline).padStart(7)} | ` +
      `${String(r.rowsRendered).padStart(4)}`,
    )
  }

  await app.close()
})
