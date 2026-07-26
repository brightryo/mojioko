/**
 * REQ-0311 §1 — the opacity readout ("100%") must be fully visible in the
 * inspector AND the bulk-edit bar at the STARTUP window size.
 *
 * The bug: the 透過率 readout showed only "1" because the cluster
 * `swatch + gap + OpacityPercentSlider(w-full)` declared more width than the
 * shared StyleRow control column, and `overflow-x-hidden` on the inspector
 * scroll wrapper (step2.tsx) clipped the excess instead of scrolling.
 *
 * This spec measures the real geometry inside Electron at 1280x820 (the app's
 * startup size == its minimum size, main/index.ts), rather than trusting the
 * width arithmetic in style-row.tsx's budget comment.  It asserts:
 *
 *   1. the readout is not internally truncated (scrollWidth <= clientWidth)
 *   2. the readout's right edge sits inside the scroll wrapper's client box
 *      (i.e. nothing is being cut off by `overflow-x-hidden`)
 *   3. the scroll wrapper has no horizontal overflow at all
 *
 * `100` is forced into both alpha fields first, because "100%" is the widest
 * string the readout can hold and the only one that reproduced the bug.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'

const INDEX_MAIN = path.resolve(__dirname, '../../out/main/index.js')
const INDEX_HTML = path.resolve(__dirname, '../../out/renderer/index.html')

interface RowProbe {
  label: string
  scrollWrapperClientW: number
  scrollWrapperScrollW: number
  controlColW: number
  clusterW: number
  sliderRootW: number
  rangeW: number
  readoutW: number
  readoutScrollW: number
  readoutClientW: number
  readoutText: string
  /** > 0 means the readout is clipped by the scroll wrapper's right edge. */
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
 * Measures every `OpacityPercentSlider` currently mounted inside the inspector
 * scroll wrapper.  Identified structurally (the readout is the slider root's
 * last child) so the probe does not depend on i18n strings.
 */
async function probeOpacityRows(win: Page): Promise<RowProbe[]> {
  return win.evaluate(() => {
    // The inspector scroll wrapper is the `overflow-x-hidden` box that clips.
    const wrapper = document.querySelector<HTMLElement>(
      '.overflow-y-auto.overflow-x-hidden',
    )
    if (!wrapper) throw new Error('inspector scroll wrapper not found')
    const wrapRect = wrapper.getBoundingClientRect()
    // Client box excludes the scrollbar gutter — that is the true visible edge.
    const visibleRight = wrapRect.left + wrapper.clientWidth

    const ranges = Array.from(
      wrapper.querySelectorAll<HTMLInputElement>('input[type=range]'),
    ).filter((r) => r.max === '100' && r.min === '0')

    return ranges.map((range) => {
      const sliderRoot = range.parentElement as HTMLElement
      const readout = sliderRoot.lastElementChild as HTMLElement
      const cluster = sliderRoot.parentElement as HTMLElement
      const controlCol = cluster.parentElement as HTMLElement
      const rRect = readout.getBoundingClientRect()
      return {
        label: range.getAttribute('aria-label') ?? '(no label)',
        scrollWrapperClientW: wrapper.clientWidth,
        scrollWrapperScrollW: wrapper.scrollWidth,
        controlColW: controlCol.getBoundingClientRect().width,
        clusterW: cluster.getBoundingClientRect().width,
        sliderRootW: sliderRoot.getBoundingClientRect().width,
        rangeW: range.getBoundingClientRect().width,
        readoutW: rRect.width,
        readoutScrollW: readout.scrollWidth,
        readoutClientW: readout.clientWidth,
        readoutText: readout.textContent ?? '',
        overhangPx: rRect.right - visibleRight,
      }
    })
  })
}

function assertRows(rows: RowProbe[], surface: string): void {
  expect(rows.length, `${surface}: expected 2 opacity sliders`).toBe(2)
  for (const r of rows) {
    expect(r.readoutText, `${surface} / ${r.label}: readout text`).toBe('100%')
    expect(
      r.readoutScrollW,
      `${surface} / ${r.label}: readout internally truncated ` +
        `(scrollW ${r.readoutScrollW} > clientW ${r.readoutClientW})`,
    ).toBeLessThanOrEqual(r.readoutClientW)
    expect(
      r.overhangPx,
      `${surface} / ${r.label}: readout clipped by overflow-x-hidden ` +
        `(overhang ${r.overhangPx.toFixed(1)}px)`,
    ).toBeLessThanOrEqual(0)
    expect(
      r.scrollWrapperScrollW,
      `${surface}: inspector gained horizontal overflow`,
    ).toBeLessThanOrEqual(r.scrollWrapperClientW)
  }
}

test('REQ-0311 §1 — 透過率 "100%" fits in the inspector at the startup window size', async () => {
  const { app, win } = await launch()
  try {
    const size = await win.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }))
    // Guards the premise: main/index.ts uses useContentSize with
    // width/height == minWidth/minHeight == 1280x820.
    expect(size.w, 'startup content width').toBe(1280)
    expect(size.h, 'startup content height').toBe(820)

    // Single-select the first entry -> TimelineBlockInspector, and force both
    // alphas to 100 so the readout holds its widest string.
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
    await win.waitForSelector('.overflow-y-auto.overflow-x-hidden input[type=range]')
    await win.evaluate(() => {
      const t = (
        window as unknown as {
          __mojioko_test: {
            project: {
              getState: () => {
                entries: { id: string }[]
                updateEntryPreview: (id: string, patch: unknown) => void
              }
            }
          }
        }
      ).__mojioko_test
      const st = t.project.getState()
      st.updateEntryPreview(st.entries[0].id, { textAlpha: 100, outlineAlpha: 100 })
    })

    const rows = await probeOpacityRows(win)
    // eslint-disable-next-line no-console
    console.log('\n[REQ-0311 §1] inspector @1280x820:', JSON.stringify(rows, null, 2))
    assertRows(rows, 'inspector')
  } finally {
    await app.close()
  }
})

test('REQ-0311 §2 — subtitle textarea resizes vertically only, bounded to [default, 2x default]', async () => {
  const { app, win } = await launch()
  try {
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
    const TEXTAREA = '.overflow-y-auto.overflow-x-hidden textarea'
    await win.waitForSelector(TEXTAREA)

    const probe = await win.evaluate((sel) => {
      const el = document.querySelector<HTMLTextAreaElement>(sel)!
      const wrapper = document.querySelector<HTMLElement>(
        '.overflow-y-auto.overflow-x-hidden',
      )!
      const cs = getComputedStyle(el)
      const natural = el.getBoundingClientRect().height
      const widthBefore = el.getBoundingClientRect().width
      // Drag far past the ceiling, exactly as the browser does on a user drag:
      // it writes an inline `height`.  `max-height` must win.
      el.style.height = '9999px'
      const clamped = el.getBoundingClientRect().height
      const widthAfter = el.getBoundingClientRect().width
      const overflowAtMax = wrapper.scrollWidth - wrapper.clientWidth
      // And drag far below the floor — `min-height` must win.
      el.style.height = '1px'
      const floored = el.getBoundingClientRect().height
      el.style.height = ''
      return {
        resize: cs.resize,
        minHeight: cs.minHeight,
        maxHeight: cs.maxHeight,
        natural,
        clamped,
        floored,
        widthBefore,
        widthAfter,
        overflowAtMax,
      }
    }, TEXTAREA)

    // eslint-disable-next-line no-console
    console.log('\n[REQ-0311 §2] textarea bounds:', JSON.stringify(probe, null, 2))

    expect(probe.resize, 'vertical-only resize').toBe('vertical')
    expect(probe.natural, 'natural height measured').toBeGreaterThan(0)
    // Floor == the shipped default height; ceiling == 2x that.
    expect(probe.floored).toBeCloseTo(probe.natural, 0)
    expect(probe.clamped).toBeCloseTo(probe.natural * 2, 0)
    // Width is untouched by a vertical resize, and the inspector never gains
    // horizontal overflow even at full extension.
    expect(probe.widthAfter).toBeCloseTo(probe.widthBefore, 1)
    expect(probe.overflowAtMax, 'horizontal overflow at max height').toBeLessThanOrEqual(0)
  } finally {
    await app.close()
  }
})

test('REQ-0311 §1 — 透過率 "100%" fits in the bulk-edit bar at the startup window size', async () => {
  const { app, win } = await launch()
  try {
    await win.evaluate(() => {
      const t = (
        window as unknown as {
          __mojioko_test: {
            project: { getState: () => { entries: { id: string }[] } }
            ui: { setState: (s: unknown) => void }
          }
        }
      ).__mojioko_test
      const ids = t.project.getState().entries.slice(0, 3).map((e) => e.id)
      t.ui.setState({ selectedEntryId: null, selectedRowIds: new Set<string>(ids) })
    })
    await win.waitForSelector('.overflow-y-auto.overflow-x-hidden input[type=range]')

    const rows = await probeOpacityRows(win)
    // eslint-disable-next-line no-console
    console.log('\n[REQ-0311 §1] bulk-edit @1280x820:', JSON.stringify(rows, null, 2))
    assertRows(rows, 'bulk-edit')
  } finally {
    await app.close()
  }
})
