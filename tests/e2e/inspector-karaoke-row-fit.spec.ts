/**
 * REQ-0336 §2-7 — the karaoke row now carries TWO switches (発話色 and
 * 発話タイミング) plus the colour swatch inside `StyleRow`'s single fixed
 * control column.  This spec measures the real geometry inside Electron at the
 * startup window size (1280x820, main/index.ts — startup == minimum) instead of
 * trusting the width arithmetic in `style-row.tsx`'s budget comment.
 *
 * Same technique and same reason as `inspector-opacity-fit.spec.ts`
 * (REQ-0311 §1): the inspector scroll wrapper is `overflow-x-hidden`, so a
 * control cluster that declares more width than the column does not produce a
 * scrollbar — it is silently CLIPPED, and the last control on the row loses
 * its right-hand pixels with nothing on screen to say so.
 *
 * Kept as a permanent gate rather than deleted as a one-off measurement: the
 * next control added to any StyleRow needs exactly this check (CLAUDE.md §18,
 * 「次に同種の機能を足すとき、また同じものを書くか」).
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'

const INDEX_MAIN = path.resolve(__dirname, '../../out/main/index.js')
const INDEX_HTML = path.resolve(__dirname, '../../out/renderer/index.html')

interface KaraokeRowProbe {
  scrollWrapperClientW: number
  scrollWrapperScrollW: number
  controlColW: number
  clusterW: number
  switchWidths: number[]
  labelW: number
  labelScrollW: number
  labelClientW: number
  labelText: string
  /** > 0 means the cluster is clipped by the wrapper's right edge. */
  overhangPx: number
}

async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ args: [INDEX_MAIN], timeout: 30_000 })
  const win = await app.firstWindow()
  await win.goto('file:///' + INDEX_HTML.replace(/\\/g, '/') + '?seed=demo&start=step2')
  await win.waitForFunction(() =>
    Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test),
  )
  return { app, win }
}

/**
 * Locates the karaoke row STRUCTURALLY — the only control column holding two
 * `role=switch` elements — so the probe does not depend on i18n strings.
 */
async function probeKaraokeRow(win: Page): Promise<KaraokeRowProbe> {
  return win.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>('.overflow-y-auto.overflow-x-hidden')
    if (!wrapper) throw new Error('inspector scroll wrapper not found')
    const wrapRect = wrapper.getBoundingClientRect()
    const visibleRight = wrapRect.left + wrapper.clientWidth

    // The karaoke cluster is the flex box holding BOTH switches directly (the
    // second one sits one level deeper, inside its tooltip trigger).  Taking
    // `parentElement` of the FIRST switch lands on it exactly; walking further
    // up would land on the control column and make the width comparison below
    // vacuous.
    const switches = Array.from(wrapper.querySelectorAll<HTMLElement>('[role=switch]'))
    const cluster = switches
      .map((s) => s.parentElement)
      .find(
        (c): c is HTMLElement =>
          c !== null && c.querySelectorAll('[role=switch]').length === 2,
      )
    if (!cluster) throw new Error('karaoke row cluster (2 switches) not found')
    const controlCol = cluster.parentElement as HTMLElement
    const label = cluster.querySelector<HTMLElement>('span.truncate')
    if (!label) throw new Error('speech-timing inline label not found')
    const cRect = cluster.getBoundingClientRect()

    return {
      scrollWrapperClientW: wrapper.clientWidth,
      scrollWrapperScrollW: wrapper.scrollWidth,
      controlColW: controlCol.getBoundingClientRect().width,
      clusterW: cRect.width,
      switchWidths: Array.from(cluster.querySelectorAll<HTMLElement>('[role=switch]')).map(
        (s) => s.getBoundingClientRect().width,
      ),
      labelW: label.getBoundingClientRect().width,
      labelScrollW: label.scrollWidth,
      labelClientW: label.clientWidth,
      labelText: label.textContent ?? '',
      overhangPx: cRect.right - visibleRight,
    }
  })
}

test('REQ-0336 §2-7 — the two-switch karaoke row fits the inspector at the startup window size', async () => {
  const { app, win } = await launch()
  try {
    const size = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    expect(size.w, 'startup content width').toBe(1280)
    expect(size.h, 'startup content height').toBe(820)

    // Single-select the first entry → TimelineBlockInspector.
    await win.evaluate(() => {
      const t = (
        window as unknown as {
          __mojioko_test: {
            project: { getState: () => { entries: { id: string }[] } }
            ui: { setState: (s: unknown) => void }
          }
        }
      ).__mojioko_test
      const first = t.project.getState().entries[0]
      t.ui.setState({ selectedRowIds: new Set<string>(), selectedEntryId: first.id })
    })
    await win.waitForSelector('.overflow-y-auto.overflow-x-hidden [role=switch]')

    const p = await probeKaraokeRow(win)
    // eslint-disable-next-line no-console
    console.log('\n[REQ-0336 §2-7] karaoke row @1280x820:', JSON.stringify(p, null, 2))

    expect(p.switchWidths.length, 'two switches on the karaoke row').toBe(2)
    for (const w of p.switchWidths) expect(w, 'switch width').toBeGreaterThan(0)
    expect(
      p.overhangPx,
      `karaoke cluster clipped by overflow-x-hidden (overhang ${p.overhangPx.toFixed(1)}px)`,
    ).toBeLessThanOrEqual(0)
    expect(
      p.clusterW,
      `cluster (${p.clusterW}) wider than its control column (${p.controlColW})`,
    ).toBeLessThanOrEqual(p.controlColW + 0.5)
    expect(
      p.scrollWrapperScrollW,
      'inspector gained horizontal overflow',
    ).toBeLessThanOrEqual(p.scrollWrapperClientW)
    // The inline label may truncate on a very narrow pane, but at the STARTUP
    // size it must be fully legible — otherwise the two switches are
    // indistinguishable, which is the whole point of adding it.
    expect(
      p.labelScrollW,
      `speech-timing label truncated at startup size ("${p.labelText}": ` +
        `scrollW ${p.labelScrollW} > clientW ${p.labelClientW})`,
    ).toBeLessThanOrEqual(p.labelClientW)
  } finally {
    await app.close()
  }
})

test('REQ-0336 §2-7 — the bulk-edit bar renders the same row in the same column', async () => {
  const { app, win } = await launch()
  try {
    // A multi-selection swaps the right pane to the BulkEditBar (step2.tsx:
    // bulk > single > empty), which reuses the SAME StyleRow columns.
    await win.evaluate(() => {
      const t = (
        window as unknown as {
          __mojioko_test: {
            project: { getState: () => { entries: { id: string }[] } }
            ui: { setState: (s: unknown) => void }
          }
        }
      ).__mojioko_test
      const ids = t.project.getState().entries.slice(0, 2).map((e) => e.id)
      t.ui.setState({ selectedRowIds: new Set<string>(ids), selectedEntryId: null })
    })
    await win.waitForSelector('.overflow-y-auto.overflow-x-hidden [role=switch]')

    const p = await probeKaraokeRow(win)
    // eslint-disable-next-line no-console
    console.log('\n[REQ-0336 §2-7] bulk karaoke row @1280x820:', JSON.stringify(p, null, 2))

    expect(p.switchWidths.length, 'two switches on the bulk karaoke row').toBe(2)
    expect(p.overhangPx, 'bulk karaoke cluster clipped').toBeLessThanOrEqual(0)
    expect(p.scrollWrapperScrollW, 'bulk pane gained horizontal overflow')
      .toBeLessThanOrEqual(p.scrollWrapperClientW)
    expect(p.labelScrollW, `bulk speech-timing label truncated ("${p.labelText}")`)
      .toBeLessThanOrEqual(p.labelClientW)
  } finally {
    await app.close()
  }
})
