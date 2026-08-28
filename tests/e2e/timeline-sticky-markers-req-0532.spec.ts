/**
 * REQ-0532 §2 — the scissor marker and the playhead head stay visible when the
 * timeline is scrolled.
 *
 * ## The defect
 *
 * The ruler has been `position: sticky` since REQ-20260613-010, so the time
 * labels already survived a scroll. The scissor marker and the playhead are
 * NOT in the ruler — they are absolutely positioned in the time-content column
 * with `top-0 bottom-0`, so their vertical LINES span the whole column (fine at
 * any scroll offset) but the scissor ICON and the playhead ARROW HEAD sat at
 * the top of the CONTENT. Once three or more layers made the content taller
 * than the viewport, scrolling down carried both out of sight — the owner's
 * report ("the scissors are only there if I scroll up").
 *
 * ## What is asserted
 *
 * With 4 layers and the timeline scrolled to the BOTTOM:
 *   1. the scissor icon is inside the scrollport,
 *   2. the playhead arrow head is inside the scrollport,
 *   3. both vertical lines still cross the full visible height (§2-3),
 *   4. both are still at the correct TIME position — sticky must pin them
 *      vertically without detaching them from the time axis (§2-4),
 *   5. a clip underneath the scissor column can still be grabbed (§2-6).
 *
 * ★ NEGATIVE CONTROL (§3-3, CLAUDE.md §18 "負の対照に git checkout を使わない"):
 * `unstick` sets `position: static` on the very nodes this REQ made sticky and
 * re-runs the SAME probe. It perturbs the one decision under test, reports how
 * many nodes it touched (so it fails loudly instead of silently becoming a
 * no-op if the markup is restructured), and touches neither git nor source.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

const SHOTS = path.resolve(__dirname, '..', '..', 'dev-docs', 'reports', 'req-0532')

interface Rect { x: number; y: number; w: number; h: number }
interface Probe {
  port: Rect
  scissorIcon: Rect | null
  scissorLine: Rect | null
  playheadArrow: Rect | null
  playheadLine: Rect | null
  scrollTop: number
  scrollableBy: number
  layerRows: number
}

/**
 * Read the scrollport and the four marks out of the live DOM.
 *
 * Located structurally rather than by test id: the scissor is the only
 * `<button>` carrying a `title` from the cut-marker i18n key, and the playhead
 * is the only element painted in `--playhead`. Adding ids purely for the test
 * would let the production markup drift away from what is measured.
 */
const PROBE = `(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect()
    return { x: b.x, y: b.y, w: b.width, h: b.height } }
  const port = document.querySelector('div.flex-1.overflow-auto')
  // The port's CLIENT box, not its border box: the timeline also scrolls
  // horizontally, and the horizontal scrollbar occupies ~17px that
  // getBoundingClientRect() includes but no content can ever reach.  Measuring
  // "does the line reach the bottom" against the border box fails by exactly
  // the scrollbar height, which is a measurement bug, not a layout one.
  const portClient = port
    ? { x: port.getBoundingClientRect().x, y: port.getBoundingClientRect().y,
        w: port.clientWidth, h: port.clientHeight }
    : null
  const scissorBtn = [...document.querySelectorAll('button')]
    .find((b) => b.querySelector('svg.lucide-scissors'))
  const scissorIcon = scissorBtn ? scissorBtn.firstElementChild : null
  const scissorLine = scissorBtn ? scissorBtn.lastElementChild : null
  const playheadLine = [...document.querySelectorAll('div[aria-hidden]')]
    .find((d) => (d.style.background || '').includes('--playhead'))
  const playheadArrow = playheadLine ? playheadLine.firstElementChild : null
  return {
    port: portClient,
    scissorIcon: r(scissorIcon),
    scissorLine: r(scissorLine),
    playheadArrow: r(playheadArrow),
    playheadLine: r(playheadLine),
    scrollTop: port ? port.scrollTop : -1,
    scrollableBy: port ? port.scrollHeight - port.clientHeight : -1,
    layerRows: document.querySelectorAll('button svg.lucide-scissors').length,
  }
})()`

/** Fully inside the scrollport, vertically. */
function insidePort(m: Rect, port: Rect): boolean {
  return m.y >= port.y - 1 && m.y + m.h <= port.y + port.h + 1
}

test('REQ-0532 §2 — scissor + playhead head stay visible when scrolled to the bottom', async () => {
  fs.mkdirSync(SHOTS, { recursive: true })
  const indexFile = path.resolve(__dirname, '..', '..', 'out', 'renderer', 'index.html')
  const electronApp = await electron.launch({
    args: [path.resolve(__dirname, '..', '..', 'out', 'main', 'index.js')],
  })
  const window = await electronApp.firstWindow()
  await window.goto('file:///' + indexFile.replace(/\\/g, '/') + '?seed=demo&start=step2')
  await window.waitForTimeout(800)

  // 4 layers forces the content taller than the pane — the condition the bug
  // needs. Stated explicitly rather than relying on the demo fixture's shape
  // (CLAUDE.md §18: no assertions that assume this machine's state).
  await window.evaluate(() => {
    const t = (window as unknown as {
      __mojioko_test: {
        ui: { setState: (s: unknown) => void }
        project: { setState: (s: unknown) => void; getState: () => { entries: unknown[] } }
      }
    }).__mojioko_test
    t.ui.setState({ editorViewMode: 'timeline', videoCurrentTimeSec: 9 })
    const base = t.project.getState().entries as Array<Record<string, unknown>>
    const seed = base.slice(0, 4)
    t.project.setState({
      entries: seed.map((e, i) => ({
        ...e,
        layer: i,
        startSec: 1 + i * 0.6,
        endSec: 3 + i * 0.6,
        isDeleted: false,
      })),
      // A confirmed cut, so a scissor marker exists to look for.
      cuts: [{ id: 'cut-req0532', startSec: 5, endSec: 7 }],
    })
  })
  await window.waitForTimeout(600)

  // Scroll the timeline to the very bottom — the state the owner reported.
  await window.evaluate(() => {
    const port = document.querySelector('div.flex-1.overflow-auto') as HTMLElement | null
    if (port) port.scrollTop = port.scrollHeight
  })
  await window.waitForTimeout(400)

  const after = await window.evaluate(PROBE) as Probe
  await window.screenshot({ path: path.join(SHOTS, 'scrolled-bottom-FIXED.png') })

  // The fixture must actually be in the failing condition, or the test proves
  // nothing: there has to be something to scroll, and we have to be at the end
  // of it.
  expect(after.scrollableBy, 'the timeline must actually overflow (4 layers)').toBeGreaterThan(20)
  expect(after.scrollTop, 'must be scrolled to the bottom').toBeGreaterThan(after.scrollableBy - 5)
  expect(after.scissorIcon, 'a scissor marker must be rendered').not.toBeNull()
  expect(after.playheadArrow, 'the playhead must be rendered').not.toBeNull()

  const port = after.port
  // (1) + (2) — both heads inside the scrollport.
  expect(insidePort(after.scissorIcon!, port), `scissor icon y=${after.scissorIcon!.y} port=${port.y}..${port.y + port.h}`).toBe(true)
  expect(insidePort(after.playheadArrow!, port), `playhead arrow y=${after.playheadArrow!.y} port=${port.y}..${port.y + port.h}`).toBe(true)

  // (3) — the lines still cross the whole visible height (§2-3).  Both are
  // full-content-height elements, so what matters is that the visible slice
  // covers the port rather than the element's own box being port-sized.
  for (const [name, line] of [['scissor', after.scissorLine!], ['playhead', after.playheadLine!]] as const) {
    expect(line.y, `${name} line starts at/above the port top`).toBeLessThanOrEqual(port.y + 1)
    expect(line.y + line.h, `${name} line reaches the port bottom`).toBeGreaterThanOrEqual(port.y + port.h - 1)
  }

  // (4) — sticky pinned them VERTICALLY only: each head must still sit on its
  // own line's time column (§2-4).  A head that had come loose from the time
  // axis would drift horizontally away from its line.
  expect(Math.abs(after.scissorIcon!.x + after.scissorIcon!.w / 2 - (after.scissorLine!.x + after.scissorLine!.w / 2)))
    .toBeLessThan(2)
  expect(Math.abs(after.playheadArrow!.x + after.playheadArrow!.w / 2 - (after.playheadLine!.x + after.playheadLine!.w / 2)))
    .toBeLessThan(7)

  // (5) §2-6 — a clip under the scissor column is still grabbable.  The marker
  // spans the full height at z-20; before this REQ the <button> itself was
  // `pointer-events-auto`, so every press in that 14 px strip hit the scissors.
  const hit = await window.evaluate(() => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => b.querySelector('svg.lucide-scissors')) as HTMLElement | undefined
    if (!btn) return { ok: false, reason: 'no scissor button' }
    const b = btn.getBoundingClientRect()
    // Well below the icon, where the marker is only a 1 px line over the tracks.
    const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height - 24)
    if (!el) return { ok: false, reason: 'nothing at the point' }
    const onScissor = !!(el.closest && el.closest('button') === btn)
    return { ok: !onScissor, reason: onScissor ? 'the scissor button swallowed the press' : el.tagName }
  })
  expect(hit.ok, `hit test under the scissor column: ${hit.reason}`).toBe(true)

  /* ------------------------------------------------------------------ */
  /* ★ NEGATIVE CONTROL — un-stick the two heads and re-probe.           */
  /* ------------------------------------------------------------------ */
  const applied = await window.evaluate(() => {
    let n = 0
    const btn = [...document.querySelectorAll('button')]
      .find((b) => b.querySelector('svg.lucide-scissors'))
    const icon = btn?.firstElementChild as HTMLElement | undefined
    if (icon && getComputedStyle(icon).position === 'sticky') { icon.style.position = 'static'; n++ }
    const line = [...document.querySelectorAll('div[aria-hidden]')]
      .find((d) => ((d as HTMLElement).style.background || '').includes('--playhead'))
    const arrow = line?.firstElementChild as HTMLElement | undefined
    if (arrow && getComputedStyle(arrow).position === 'sticky') { arrow.style.position = 'static'; n++ }
    return n
  })
  // If the markup is restructured so these nodes are no longer sticky, the
  // control silently stops perturbing anything — so it says so.
  expect(applied, 'negative control must find BOTH sticky heads to perturb').toBe(2)
  await window.waitForTimeout(200)

  const pre = await window.evaluate(PROBE) as Probe
  await window.screenshot({ path: path.join(SHOTS, 'scrolled-bottom-NEGATIVE-CONTROL.png') })

  // Both must now be OUT of the scrollport — i.e. the assertions above are
  // actually capable of failing.
  expect(insidePort(pre.scissorIcon!, pre.port), `control: scissor icon should have scrolled out (y=${pre.scissorIcon!.y}, port top=${pre.port.y})`).toBe(false)
  expect(insidePort(pre.playheadArrow!, pre.port), `control: playhead arrow should have scrolled out (y=${pre.playheadArrow!.y}, port top=${pre.port.y})`).toBe(false)

  // (§2-5) — with a SINGLE layer nothing overflows, so the look must be
  // unchanged: the heads sit at the top of the content, which is also the top
  // of the port.  This is the majority case and must not have moved.
  await window.evaluate(() => {
    const t = (window as unknown as {
      __mojioko_test: { project: { setState: (s: unknown) => void; getState: () => { entries: unknown[] } } }
    }).__mojioko_test
    const base = t.project.getState().entries as Array<Record<string, unknown>>
    t.project.setState({ entries: base.map((e) => ({ ...e, layer: 0 })) })
    const icon = document.querySelector('button svg.lucide-scissors')?.parentElement as HTMLElement | null
    if (icon) icon.style.position = ''
    const line = [...document.querySelectorAll('div[aria-hidden]')]
      .find((d) => ((d as HTMLElement).style.background || '').includes('--playhead'))
    const arrow = line?.firstElementChild as HTMLElement | null
    if (arrow) arrow.style.position = ''
  })
  await window.waitForTimeout(500)
  const single = await window.evaluate(PROBE) as Probe
  await window.screenshot({ path: path.join(SHOTS, 'single-layer.png') })
  expect(single.scissorIcon, 'single-layer scissor still rendered').not.toBeNull()
  expect(insidePort(single.scissorIcon!, single.port), 'single layer: scissor icon visible').toBe(true)
  expect(Math.abs(single.scissorIcon!.y - single.port.y), 'single layer: icon still sits at the top of the port').toBeLessThan(4)

  await electronApp.close()
})
