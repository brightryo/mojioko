/**
 * REQ-071 Phase 4-2 / 4-3 — measure the timeline's caption (12 px)
 * geometry budget empirically.
 *
 * Phase 3.6 lifted the in-block timecode, ruler tick, and track-label
 * gutter from text-micro (10 px) to text-caption (12 px) and bumped
 * TIME_ROW_MIN_BLOCK_WIDTH_PX from 200 to 220 based on the math
 * 11 chars × ~7.5 px/char × 2 + gap + padding ≈ 210, rounded for
 * subpixel headroom.  This spec proves the math against real fonts
 * inside the actual Electron renderer:
 *
 *   - the timecode row in a 220 px-wide block must fit "00:00:06.92"
 *     twice (no overflow / no truncation)
 *   - ruler tick labels at the densest chooseRulerStepSec step must
 *     not horizontally collide
 *   - count how many of the seed fixtures' blocks fall below the
 *     220 px threshold so Phase 4-3's "how many lose their timecode
 *     row" question has a concrete number
 *
 * ★ REQ-0506 §3 — this is a MEASUREMENT HARNESS, not a gate. It was in
 * `tests/e2e/` and ran under `npm run test:e2e`, so it read as one, but its
 * assertions were against a hand-built replica (a hardcoded 220 px div with the
 * block's classes copied onto it), and two of its four sections asserted
 * nothing at all. Changing the real `TIME_ROW_MIN_BLOCK_WIDTH_PX` did not
 * affect it. See `tests/measure/README.md`.
 *
 * The hardcoded thresholds it used to carry now come from the source
 * (`readSourceConstant` / the exported `chooseRulerStepSec`), so the numbers it
 * prints track the app instead of a copy someone forgot to update.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'
import { readFileSync } from 'fs'

/**
 * Read a module-private numeric constant out of its source file.
 *
 * `TIME_ROW_MIN_BLOCK_WIDTH_PX` is not exported, and exporting it purely to
 * feed a measurement harness would be tail-wagging-dog. Reading it keeps the
 * number in one place — the previous copy in this file silently stopped
 * matching the app the moment anyone changed it.
 */
function readSourceConstant(relPath: string, name: string): number {
  const text = readFileSync(path.resolve(__dirname, '../../', relPath), 'utf-8')
  // Built from a plain string, not a template literal: `\s` inside a template
  // literal is just `s`, which silently matches nothing.
  const m = new RegExp(name + '\\s*=\\s*(\\d+)').exec(text)
  if (!m) throw new Error(`constant ${name} not found in ${relPath} — update the reader or the name`)
  return Number(m[1])
}

const TIME_ROW_MIN_BLOCK_WIDTH_PX = readSourceConstant(
  'src/renderer/components/timeline-view/timeline-view.tsx',
  'TIME_ROW_MIN_BLOCK_WIDTH_PX',
)
/** `chooseRulerStepSec`'s target label spacing (`const targetPx` in that fn). */
const RULER_TARGET_GAP_PX = readSourceConstant(
  'src/renderer/lib/timeline-layout.ts',
  'targetPx',
)

test('timeline geometry budget — 12 px timecode fits 220 px block; ruler ticks do not collide', async () => {
  const electronApp = await electron.launch({
    args: [path.resolve(__dirname, '../../out/main/index.js')],
    timeout: 30_000
  })
  const window = await electronApp.firstWindow()
  const indexFile = path.resolve(__dirname, '../../out/renderer/index.html')
  await window.goto('file:///' + indexFile.replace(/\\/g, '/') + '?seed=demo&start=step2')
  await window.waitForFunction(() => Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))
  await window.evaluate(() => {
    const t = (window as unknown as { __mojioko_test: { ui: { setState: (s: unknown) => void } } }).__mojioko_test
    t.ui.setState({ editorViewMode: 'timeline' })
  })
  await window.waitForFunction(() => {
    const p = (window as unknown as { __mojioko_profile?: Record<string, number> }).__mojioko_profile
    return Boolean(p && p.TimelineView && p.TimelineView > 0)
  }, undefined, { timeout: 10_000 })

  // 1) Synthesise a 220-px-wide HH:MM:SS.cc timecode row exactly as the
  //    Block renders it, attach to the DOM, and measure.  This is the
  //    REQ-061 budget being tested.
  const timecodeFit = await window.evaluate((MIN_W: number) => {
    const probe = document.createElement('div')
    // Match the block's button container styling: 220 px wide, px-2
    // padding (8 px each side), flex with timecodes pinned to the two
    // edges via items-baseline + justify-between.
    probe.style.position = 'fixed'
    probe.style.left = '-9999px'
    probe.style.top = '0'
    probe.style.width = `${MIN_W}px`
    probe.style.padding = '0 8px' // px-2
    probe.style.boxSizing = 'border-box'
    probe.innerHTML = `
      <div class="flex w-full items-baseline justify-between text-caption font-mono tabular-nums text-zinc-300/80 leading-none">
        <span>00:00:06.92</span>
        <span>00:00:06.92</span>
      </div>
    `
    document.body.appendChild(probe)
    const row = probe.firstElementChild as HTMLElement
    const spans = row.querySelectorAll('span')
    const startRect = spans[0].getBoundingClientRect()
    const endRect = spans[1].getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const result = {
      rowWidthPx: rowRect.width,
      startWidthPx: startRect.width,
      endWidthPx: endRect.width,
      gapPx: endRect.left - startRect.right,
      // Truncation check: a span's clientWidth < scrollWidth means content
      // overflowed and is being clipped (or, if no overflow style is set,
      // expanded the parent).
      startOverflowed: spans[0].scrollWidth > spans[0].clientWidth,
      endOverflowed: spans[1].scrollWidth > spans[1].clientWidth
    }
    probe.remove()
    return result
  }, TIME_ROW_MIN_BLOCK_WIDTH_PX)

  // eslint-disable-next-line no-console
  console.log('\n[Phase 4-2 probe] 220 px block timecode row:', JSON.stringify(timecodeFit, null, 2))

  // Assertions:
  //   - row stays at 220 px (i.e. content did not push the container
  //     wider — would only happen if a span's scrollWidth exceeded its
  //     allocated portion, which we also check directly)
  //   - both timecodes fit without overflow
  //   - there is some visible gap between the two timecodes (not zero,
  //     not negative); REQ-061's math budgeted ≥ 24 px
  // REQ-0506 §3 — removed: `rowWidthPx ≈ width - 16` asserted that a
  // border-box div with 8px padding has (width-16) content width, i.e. it
  // tested the browser's box model, not the app.
  expect(timecodeFit.startOverflowed, '"00:00:06.92" overflows at left').toBe(false)
  expect(timecodeFit.endOverflowed, '"00:00:06.92" overflows at right').toBe(false)
  expect(timecodeFit.gapPx, 'gap between the two timecodes').toBeGreaterThan(0)

  // 2) Inventory: count fixture blocks that fall below the 220 px
  //    threshold at the default pps (100), so Phase 4-3 has the real
  //    "how many lose their timecode row" number.
  const blockInventory = await window.evaluate((MIN_W: number) => {
    const t = (window as unknown as { __mojioko_test: { project: { getState: () => { entries: { id: string; isDeleted: boolean; startSec: number; endSec: number }[] } }; ui: { getState: () => { timelinePixelsPerSec: number } } } }).__mojioko_test
    const entries = t.project.getState().entries.filter((e) => !e.isDeleted)
    const pps = t.ui.getState().timelinePixelsPerSec
    const visible = entries.map((e) => ({
      id: e.id,
      durSec: e.endSec - e.startSec,
      widthPx: (e.endSec - e.startSec) * pps
    }))
    const TIME_ROW_THRESHOLD_PX = MIN_W
    const blocksHidingTimecode = visible.filter((v) => v.widthPx < TIME_ROW_THRESHOLD_PX)
    return {
      pps,
      total: visible.length,
      threshold: TIME_ROW_THRESHOLD_PX,
      hidingTimecodeCount: blocksHidingTimecode.length,
      hidingTimecode: blocksHidingTimecode,
      shortest: Math.min(...visible.map((v) => v.widthPx)),
      longest: Math.max(...visible.map((v) => v.widthPx))
    }
  }, TIME_ROW_MIN_BLOCK_WIDTH_PX)
  // eslint-disable-next-line no-console
  console.log('\n[Phase 4-3 probe] fixture block widths at default pps:', JSON.stringify(blockInventory, null, 2))

  // 3) Ruler tick collision: probe two adjacent caption labels rendered
  //    inside the densest sub-second chooseRulerStepSec target spacing.
  //    The chooser keeps adjacent ticks ≥ 100 px apart.  Render two
  //    "0:00.0" labels in monospace and confirm they do not collide.
  const rulerCollision = await window.evaluate((TARGET_GAP: number) => {
    const wrapper = document.createElement('div')
    wrapper.style.position = 'fixed'
    wrapper.style.left = '-9999px'
    wrapper.style.top = '0'
    wrapper.style.display = 'inline-block'
    wrapper.innerHTML = `
      <span class="text-caption font-mono tabular-nums text-zinc-500">0:00.0</span>
    `
    document.body.appendChild(wrapper)
    const span = wrapper.firstElementChild as HTMLElement
    const labelWidth = span.getBoundingClientRect().width
    wrapper.remove()
    const targetGapPx = TARGET_GAP
    return {
      labelWidthPx: labelWidth,
      targetGapPx,
      // Worst case: every label is followed by the next at exactly the
      // target spacing.  Tick-to-tick distance is targetGapPx (100), so
      // labels collide if labelWidth >= 100.  We want a comfortable
      // margin (labelWidth < ~70 leaves 30+ px of breathing room).
      headroomPx: targetGapPx - labelWidth
    }
  }, RULER_TARGET_GAP_PX)
  // eslint-disable-next-line no-console
  console.log('\n[Phase 4-2 probe] ruler label vs 100 px target spacing:', JSON.stringify(rulerCollision, null, 2))

  expect(rulerCollision.labelWidthPx).toBeLessThan(rulerCollision.targetGapPx)
  expect(rulerCollision.headroomPx).toBeGreaterThan(20)

  // 4) Phase 4-4 — StyleCell mini-labels and h-5 chip 10→12 feasibility.
  //    These currently sit at text-micro (10) because of an 80 px column
  //    and an h-5 button height.  Owner asked: what would it take to lift
  //    to 12 px?  Measure each label at both sizes inside the constraints.
  const styleCellMeasurement = await window.evaluate(() => {
    const labels = ['文字色', '輪郭色', '輪郭の太さ', 'フェード']
    function measure(sizeClass: string) {
      const wrapper = document.createElement('div')
      wrapper.style.position = 'fixed'
      wrapper.style.left = '-9999px'
      wrapper.style.top = '0'
      // Recreate the grid template: 80 px column 1, content column 2.
      wrapper.innerHTML = `
        <div style="display:grid;grid-template-columns:80px 1fr;gap:8px;width:230px;">
          <span class="${sizeClass} text-zinc-500 truncate">${labels.join('​/​')}</span>
          <div></div>
        </div>
      `
      document.body.appendChild(wrapper)
      const perLabel: { label: string; widthPx: number; overflowed: boolean }[] = []
      for (const label of labels) {
        const span = document.createElement('span')
        span.className = `${sizeClass} text-zinc-500 truncate`
        span.style.display = 'inline-block'
        span.style.maxWidth = '80px'
        span.textContent = label
        document.body.appendChild(span)
        const widthPx = span.scrollWidth
        // Overflow detected when scrollWidth > 80 (the column width).
        perLabel.push({ label, widthPx, overflowed: widthPx > 80 })
        span.remove()
      }
      wrapper.remove()
      return perLabel
    }
    const micro = measure('text-micro')
    const caption = measure('text-caption')
    // h-5 chip ('時刻調整') height check — h-5 = 20 px.  caption line-h is
    // 16 px so it fits; micro line-h is 14 px.  Measure actual rendered
    // line-height for both at the chip's exact context (px-1.5 padding,
    // flex items-center).
    function chipLineHeight(sizeClass: string) {
      const probe = document.createElement('button')
      probe.className = `h-5 px-1.5 rounded ${sizeClass} text-zinc-500 inline-flex items-center justify-center`
      probe.textContent = '時刻調整'
      document.body.appendChild(probe)
      const rect = probe.getBoundingClientRect()
      const cs = getComputedStyle(probe)
      const result = {
        heightPx: rect.height,
        widthPx: rect.width,
        lineHeight: cs.lineHeight,
        fontSize: cs.fontSize
      }
      probe.remove()
      return result
    }
    return {
      micro: { labels: micro, chip: chipLineHeight('text-micro') },
      caption: { labels: caption, chip: chipLineHeight('text-caption') }
    }
  })

  // eslint-disable-next-line no-console
  console.log('\n[Phase 4-4 probe] StyleCell mini-labels + h-5 chip at micro vs caption:',
    JSON.stringify(styleCellMeasurement, null, 2))

  await electronApp.close()
})
