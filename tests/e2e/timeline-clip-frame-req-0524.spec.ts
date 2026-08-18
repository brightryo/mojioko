/**
 * REQ-0524 — the timeline clip's FRAME and STATE COLOURS, measured on the real
 * rendered element.
 *
 * What the owner reported and what it actually was (REQ-0524 §1-1 asked for the
 * cause, not a guess):
 *
 *   - "the green selection frame gets thicker when I click" — the selected
 *     branch carried `ring-2 ring-primary` ON TOP of the base `border`, and a
 *     Tailwind ring is a 2px OUTSET box-shadow, not a border.  So the clip's
 *     frame really was 1px at rest and 3px when selected.  Nothing to do with
 *     focus: `focus:outline-none focus-visible:outline-none` meant the clip had
 *     no focus indicator at all.
 *   - "the corners are rounded" — `rounded-md`, which the REQ-0177 radius
 *     flattening remaps to 3px.
 *   - "edited clips look beige" — `bg-warning-soft/15`, i.e. amber-400 at 15%
 *     over a near-black lane, which composites to #3C331C.
 *
 * Why this is a GATE and not a one-off measurement (CLAUDE.md §18 追記2): the
 * regression is invisible in a screenshot diff of a static state — it only
 * appears when you compare states, and there was no test of any kind on the
 * clip's colours or frame before this one (RES-0524 §1).  Every future change
 * to BLOCK_TONE or to the clip's className runs through here.
 *
 * ★ Negative control (CLAUDE.md §18 "負の対照に git checkout を使わない"):
 * `applyPreFixFrame` puts the two pre-REQ-0524 declarations back onto the LIVE
 * element — the 2px outset ring and the 3px radius — and re-runs the very same
 * `checkFrame`.  No source is swapped, no ref is checked out, and it reports
 * how many properties it actually set so it fails loudly rather than silently
 * becoming a no-op.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'

/** One clip's frame geometry, read straight off `getComputedStyle`. */
interface Frame {
  /** border-{top,right,bottom,left}-width, in px. */
  borders: number[]
  /** border-*-radius, in px. */
  radii: number[]
  /**
   * Total px of OUTSET box-shadow ring around the border box — this is what a
   * Tailwind `ring-*` compiles to, and it is the thing that made the frame
   * look thicker on click.  Parsed as the spread of any non-inset shadow with
   * no offset and no blur.
   */
  ringPx: number
  outline: { width: number; style: string; offset: number }
  boxSizing: string
  /** Button border-box minus its positioned wrapper's box, per edge. */
  edgeDeltas: number[]
  /** The wrapper's own box, so we can prove it never moves. */
  wrapper: { x: number; y: number; w: number; h: number }
}

/**
 * Read the frame of the clip whose text starts with `marker`.
 *
 * Clips are located by their own text rather than by aria-label, because the
 * label is localised and interpolated; the markers are seeded by the test.
 */
const FRAME_PROBE = `((marker) => {
  const buttons = Array.from(document.querySelectorAll('div[style*="height: 64px"] > button'))
  const el = buttons.find((b) => (b.textContent || '').includes(marker))
  if (!el) throw new Error('no clip found for marker ' + marker + ' (' + buttons.length + ' clips in the DOM)')
  const cs = getComputedStyle(el)
  const num = (v) => Math.round(parseFloat(v) * 100) / 100

  // A Tailwind ring is "rgb(...) 0px 0px 0px 2px" — offset 0, blur 0, spread N,
  // not inset.  Sum the spreads of every shadow shaped like that.
  let ringPx = 0
  const shadow = cs.boxShadow
  if (shadow && shadow !== 'none') {
    for (const part of shadow.split(/,(?![^(]*\\))/)) {
      if (part.includes('inset')) continue
      const lengths = (part.match(/-?[\\d.]+px/g) || []).map(parseFloat)
      if (lengths.length >= 4 && lengths[0] === 0 && lengths[1] === 0 && lengths[2] === 0) {
        ringPx += lengths[3]
      }
    }
  }

  const r = el.getBoundingClientRect()
  const wrap = el.parentElement.getBoundingClientRect()
  return {
    borders: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(num),
    radii: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(num),
    ringPx,
    outline: { width: num(cs.outlineWidth), style: cs.outlineStyle, offset: num(cs.outlineOffset) },
    boxSizing: cs.boxSizing,
    edgeDeltas: [num(r.top - wrap.top), num(r.right - wrap.right), num(r.bottom - wrap.bottom), num(r.left - wrap.left)],
    wrapper: { x: num(wrap.x), y: num(wrap.y), w: num(wrap.width), h: num(wrap.height) },
  }
})`

/**
 * The frame contract, written as data (not bare `expect`s) so the negative
 * control can run the IDENTICAL check against a perturbed element.
 *
 * `EXPECTED_BORDER_PX` is 1 — deliberately the thinnest a border can be
 * (REQ-0524 §1-3 "細めにすること").  Before this REQ it was 1px at rest and
 * 3px selected.
 */
const EXPECTED_BORDER_PX = 1

function checkFrame(f: Frame, ctx: string): string[] {
  const v: string[] = []
  if (f.borders.some((b) => b !== EXPECTED_BORDER_PX)) {
    v.push(`${ctx}: border widths are [${f.borders.join(', ')}], expected all ${EXPECTED_BORDER_PX}`)
  }
  if (f.ringPx !== 0) {
    v.push(`${ctx}: an outset ring of ${f.ringPx}px sits around the border — the frame reads as ${EXPECTED_BORDER_PX + f.ringPx}px here`)
  }
  if (f.radii.some((r) => r !== 0)) {
    v.push(`${ctx}: corner radii are [${f.radii.join(', ')}], expected square (0)`)
  }
  // Layout immovability (§1-5): border-box means the 1px frame is drawn INSIDE
  // the wrapper's box, so widening it can never move the clip.  Both halves are
  // asserted — the box-sizing declaration and the measured result.
  if (f.boxSizing !== 'border-box') {
    v.push(`${ctx}: box-sizing is ${f.boxSizing} — a border width change would resize the clip`)
  }
  if (f.edgeDeltas.some((d) => d !== 0)) {
    v.push(`${ctx}: the clip body is offset from its positioned wrapper by [${f.edgeDeltas.join(', ')}]px`)
  }
  // An outline that sits OUTSIDE the box would add to the apparent frame width,
  // which is the thing this REQ exists to make constant.  Inset only.
  if (f.outline.style !== 'none' && f.outline.width > 0 && f.outline.offset >= 0) {
    v.push(`${ctx}: a ${f.outline.width}px outline sits at offset ${f.outline.offset} (outside the box) — it adds to the frame`)
  }
  return v
}

// --- colour helpers (run in Node, on values read from the renderer) ---------

function parseRgb(s: string): { r: number; g: number; b: number; a: number } {
  const m = s.match(/-?[\d.]+/g)
  if (!m || m.length < 3) throw new Error(`cannot parse colour: ${s}`)
  return { r: +m[0], g: +m[1], b: +m[2], a: m.length > 3 ? +m[3] : 1 }
}

function over(fg: { r: number; g: number; b: number; a: number }, bg: { r: number; g: number; b: number }) {
  return {
    r: fg.a * fg.r + (1 - fg.a) * bg.r,
    g: fg.a * fg.g + (1 - fg.a) * bg.g,
    b: fg.a * fg.b + (1 - fg.a) * bg.b,
  }
}

function relLuminance(c: { r: number; g: number; b: number }): number {
  const f = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}

function contrast(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const la = relLuminance(a)
  const lb = relLuminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

function hslTripleToRgb(triple: string): { r: number; g: number; b: number } {
  const m = triple.trim().match(/([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/)
  if (!m) throw new Error(`cannot parse HSL triple: ${triple}`)
  const h = +m[1]
  const s = +m[2] / 100
  const l = +m[3] / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const mm = l - c / 2
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return { r: Math.round((r + mm) * 255), g: Math.round((g + mm) * 255), b: Math.round((b + mm) * 255) }
}

// ---------------------------------------------------------------------------

test('timeline clip frame + state colours — REQ-0524', async () => {
  const electronApp = await electron.launch({
    args: [path.resolve(__dirname, '../../out/main/index.js')],
    timeout: 30_000,
  })
  const window = await electronApp.firstWindow()
  const indexFile = path.resolve(__dirname, '../../out/renderer/index.html')
  await window.goto('file:///' + indexFile.replace(/\\/g, '/') + '?seed=demo&start=step2')
  await window.waitForFunction(() => Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))
  await window.evaluate(() => {
    const t = (window as unknown as { __mojioko_test: { ui: { setState: (s: unknown) => void } } }).__mojioko_test
    t.ui.setState({ editorViewMode: 'timeline' })
  })

  // Seed four clips whose states we control outright.  `setState` is used
  // rather than `updateEntry` precisely because `updateEntry` recomputes
  // `isEdited` from the values — here the flag IS the fixture.
  //
  // The overflow clip carries a deliberately long line: `isOverflow` comes
  // from step2's `overflowMap`, which measures real glyph widths against the
  // video width, so it cannot be set directly.
  const MARKERS = { normal: 'ZZNORMAL', edited: 'ZZEDITED', overflow: 'ZZOVERFLOW', selected: 'ZZSELECTED' }
  await window.evaluate((M) => {
    const t = (window as unknown as {
      __mojioko_test: {
        project: { getState: () => { entries: Record<string, unknown>[] }; setState: (s: unknown) => void }
        ui: { setState: (s: unknown) => void }
      }
    }).__mojioko_test
    const entries = t.project.getState().entries.map((e) => ({ ...e }))
    entries[0] = { ...entries[0], text: M.normal, isEdited: false }
    entries[1] = { ...entries[1], text: M.edited, isEdited: true }
    entries[2] = { ...entries[2], text: M.overflow + ' ' + 'あ'.repeat(120), isEdited: false }
    entries[3] = { ...entries[3], text: M.selected, isEdited: false }
    t.project.setState({ entries })
    // Stated, not inherited (CLAUDE.md §18 "環境を仮定したアサーションを書かない"):
    // at 100 px/sec the four seed clips are 260–350 px wide, i.e. all above
    // TIME_ROW_MIN_BLOCK_WIDTH_PX (220), so the in-clip timecode row renders
    // and its contrast can be measured.  At a lower zoom it would not exist
    // and the measurement would silently report nothing.
    t.ui.setState({ selectedEntryId: null, timelinePixelsPerSec: 100 })
  }, MARKERS)
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1600, 900)
  })
  await window.waitForTimeout(500)

  const frameOf = (marker: string): Promise<Frame> =>
    window.evaluate(`(${FRAME_PROBE})(${JSON.stringify(marker)})`) as Promise<Frame>
  const centreOf = (marker: string) =>
    window.evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('div[style*="height: 64px"] > button'))
      const el = buttons.find((b) => (b.textContent || '').includes(${JSON.stringify(marker)}))
      if (!el) throw new Error('no clip for ' + ${JSON.stringify(marker)})
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`) as Promise<{ x: number; y: number }>

  const violations: string[] = []
  const measured: Record<string, Frame> = {}

  // --- §3-2 / §3-3: the frame in every state --------------------------------
  // Park the cursor somewhere harmless first so "resting" really is resting.
  await window.mouse.move(5, 5)
  await window.waitForTimeout(200)
  measured.resting = await frameOf(MARKERS.normal)

  const c = await centreOf(MARKERS.normal)
  await window.mouse.move(c.x, c.y)
  await window.waitForTimeout(250) // transition-colors duration-150
  measured.hover = await frameOf(MARKERS.normal)
  await window.mouse.move(5, 5)
  await window.waitForTimeout(250)

  // Selected — driven through the store, not a click, so this is selection
  // ALONE (a click would leave the cursor hovering and conflate the two).
  await window.evaluate((id) => {
    const t = (window as unknown as { __mojioko_test: { ui: { setState: (s: unknown) => void } } }).__mojioko_test
    t.ui.setState({ selectedEntryId: id })
  }, await window.evaluate((m: string) => {
    const t = (window as unknown as { __mojioko_test: { project: { getState: () => { entries: { id: string; text: string }[] } } } }).__mojioko_test
    return t.project.getState().entries.find((e) => e.text.includes(m))!.id
  }, MARKERS.normal))
  await window.waitForTimeout(250)
  measured.selected = await frameOf(MARKERS.normal)

  // Selected AND hovered — the REQ-089 case that used to lose the green.
  await window.mouse.move(c.x, c.y)
  await window.waitForTimeout(250)
  measured.selectedHover = await frameOf(MARKERS.normal)
  await window.mouse.move(5, 5)
  await window.waitForTimeout(250)

  // Keyboard focus is measured on an UNSELECTED clip: the focus mark is scoped
  // to unselected clips (a selected one is already the highlighted clip), so
  // leaving the selection set would measure the wrong thing.
  await window.evaluate(() => {
    const t = (window as unknown as { __mojioko_test: { ui: { setState: (s: unknown) => void } } }).__mojioko_test
    t.ui.setState({ selectedEntryId: null })
  })
  await window.waitForTimeout(250)
  const borderWhenResting = await window.evaluate((marker: string) => {
    const buttons = Array.from(document.querySelectorAll('div[style*="height: 64px"] > button'))
    const el = buttons.find((b) => (b.textContent || '').includes(marker)) as HTMLElement
    return getComputedStyle(el).borderTopColor
  }, MARKERS.normal)

  // The MOUSE-click case is measured FIRST, before any keyboard interaction
  // with this clip: Chromium keeps :focus-visible armed when you click an
  // element that already had it, so a click measured after the Tab round trip
  // below would report focus-visible for reasons that have nothing to do with
  // the click.  Clicking is half of what made the old highlight ambiguous, so
  // the check has to be honest about which gesture is under test.
  await window.mouse.click(c.x, c.y)
  await window.waitForTimeout(250)
  const mouseFocus = await window.evaluate((marker: string) => {
    const buttons = Array.from(document.querySelectorAll('div[style*="height: 64px"] > button'))
    const el = buttons.find((b) => (b.textContent || '').includes(marker)) as HTMLElement
    const cs = getComputedStyle(el)
    return {
      isActive: document.activeElement === el,
      focusVisible: el.matches(':focus-visible'),
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
    }
  }, MARKERS.normal)
  expect(mouseFocus.isActive, 'clicking a clip should focus it (otherwise the next check is vacuous)').toBe(true)
  expect(mouseFocus.focusVisible, 'a mouse click armed :focus-visible — the keyboard mark would show on click too').toBe(false)
  expect(mouseFocus.outlineStyle === 'none' || parseFloat(mouseFocus.outlineWidth) === 0,
    `a mouse click drew a ${mouseFocus.outlineWidth} outline`).toBe(true)
  // The click selected + seeked; undo the selection so the keyboard mark below
  // is measured on an unselected clip.
  await window.mouse.move(5, 5)
  await window.evaluate(() => {
    const t = (window as unknown as { __mojioko_test: { ui: { setState: (s: unknown) => void } } }).__mojioko_test
    t.ui.setState({ selectedEntryId: null })
  })
  await window.waitForTimeout(250)

  // Focusing programmatically does NOT arm :focus-visible in Chromium (the
  // last interaction has to be a keyboard one), so we focus the clip, Tab
  // away, then Shift+Tab back — the round trip is a real keyboard interaction
  // and lands on the same element.
  await window.evaluate((marker: string) => {
    const buttons = Array.from(document.querySelectorAll('div[style*="height: 64px"] > button'))
    const el = buttons.find((b) => (b.textContent || '').includes(marker)) as HTMLElement
    el.focus()
  }, MARKERS.normal)
  await window.keyboard.press('Tab')
  await window.keyboard.press('Shift+Tab')
  await window.waitForTimeout(200)
  const focusLanded = await window.evaluate((marker: string) => {
    const a = document.activeElement
    return Boolean(a && (a.textContent || '').includes(marker) && a.matches(':focus-visible'))
  }, MARKERS.normal)
  expect(focusLanded, 'the keyboard round-trip did not leave the clip in :focus-visible — the focus measurement below would prove nothing').toBe(true)
  measured.keyboardFocus = await frameOf(MARKERS.normal)

  // §1-4: keyboard focus must be VISIBLE, and it must be visible WITHOUT
  // adding width.  It is carried by the frame's colour because globals.css
  // zeroes every outline and every Tailwind ring app-wide with `!important`
  // (REQ-044) — so this asserts the colour, and separately asserts that the
  // suppression is still in force, since the day it is lifted is the day an
  // outline-based indicator would become the better mechanism.
  const focusFrame = await window.evaluate((marker: string) => {
    const buttons = Array.from(document.querySelectorAll('div[style*="height: 64px"] > button'))
    const el = buttons.find((b) => (b.textContent || '').includes(marker)) as HTMLElement
    const cs = getComputedStyle(el)
    return { borderColor: cs.borderTopColor, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth }
  }, MARKERS.normal)
  expect(focusFrame.borderColor,
    'a keyboard-focused clip looks exactly like an unfocused one — a Tab user cannot tell where they are')
    .not.toBe(borderWhenResting)
  // eslint-disable-next-line no-console
  console.log(`\n[REQ-0524] focus frame ${focusFrame.borderColor} vs resting ${borderWhenResting}`)

  // Every state gets the SAME check.
  for (const [name, f] of Object.entries(measured)) violations.push(...checkFrame(f, name))

  // §3-3 — cross-state: not one pixel of movement in position or size.
  const boxes = Object.entries(measured).map(([k, f]) => [k, f.wrapper] as const)
  const [, base] = boxes[0]
  for (const [name, b] of boxes) {
    if (b.x !== base.x || b.y !== base.y || b.w !== base.w || b.h !== base.h) {
      violations.push(`${name}: clip box ${JSON.stringify(b)} != resting ${JSON.stringify(base)}`)
    }
  }
  // And the frame width is literally identical across states, not merely
  // "each state happens to satisfy the contract".
  const widths = Object.values(measured).map((f) => Math.max(...f.borders) + f.ringPx)
  if (new Set(widths).size !== 1) {
    violations.push(`frame width varies across states: ${JSON.stringify(Object.fromEntries(Object.keys(measured).map((k, i) => [k, widths[i]])))}`)
  }

  // eslint-disable-next-line no-console
  console.log('\n[REQ-0524] clip frame per state:', JSON.stringify(measured, null, 2))
  expect(violations, 'clip frame violations').toEqual([])

  // --- §2-1: the state colours ----------------------------------------------
  // Drop the keyboard focus first, or the `normal` clip is still wearing the
  // focus frame and the table below would report it as its resting colour.
  await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await window.waitForTimeout(250)
  // Read each state's declared fill + the effective (composited) colour behind
  // the clip's text, so contrast is computed on what is actually on screen.
  const colours = await window.evaluate((M) => {
    const buttons = Array.from(document.querySelectorAll('div[style*="height: 64px"] > button'))
    const find = (marker: string) => {
      const el = buttons.find((b) => (b.textContent || '').includes(marker))
      if (!el) throw new Error('no clip for ' + marker)
      return el as HTMLElement
    }
    /**
     * The stack of backgrounds BEHIND the clip (its own fill excluded — the
     * caller composites that on top), from nearest to the first opaque one.
     */
    const effectiveBg = (el: HTMLElement) => {
      const stack: string[] = []
      let n: HTMLElement | null = el.parentElement
      while (n) {
        const bg = getComputedStyle(n).backgroundColor
        const m = bg.match(/-?[\d.]+/g)
        if (m && (m.length < 4 || +m[3] > 0)) {
          stack.push(bg)
          if (!m[3] || +m[3] === 1) break
        }
        n = n.parentElement
      }
      return stack
    }
    const read = (marker: string) => {
      const el = find(marker)
      const cs = getComputedStyle(el)
      const timecode = el.querySelector('.font-mono')
      return {
        fill: cs.backgroundColor,
        border: cs.borderTopColor,
        text: cs.color,
        timecodeText: timecode ? getComputedStyle(timecode).color : null,
        bgStack: effectiveBg(el),
      }
    }
    const root = getComputedStyle(document.documentElement)
    return {
      normal: read(M.normal),
      edited: read(M.edited),
      overflow: read(M.overflow),
      selected: read(M.selected),
      tokens: {
        rowEdited: root.getPropertyValue('--row-edited'),
        warningSoft: root.getPropertyValue('--warning-soft'),
        primary: root.getPropertyValue('--primary'),
      },
    }
  }, MARKERS)

  // Select the 4th clip so `selected` really is the green state.
  // (Done after the read above only for `normal`/`edited`/`overflow`; redo it
  // for the selected one.)
  await window.evaluate((m: string) => {
    const t = (window as unknown as { __mojioko_test: { project: { getState: () => { entries: { id: string; text: string }[] } }; ui: { setState: (s: unknown) => void } } }).__mojioko_test
    const e = t.project.getState().entries.find((x) => x.text.includes(m))!
    t.ui.setState({ selectedEntryId: e.id })
  }, MARKERS.selected)
  await window.waitForTimeout(250)
  const selectedFill = await window.evaluate((marker: string) => {
    const buttons = Array.from(document.querySelectorAll('div[style*="height: 64px"] > button'))
    const el = buttons.find((b) => (b.textContent || '').includes(marker)) as HTMLElement
    const cs = getComputedStyle(el)
    return { fill: cs.backgroundColor, border: cs.borderTopColor }
  }, MARKERS.selected)
  colours.selected = { ...colours.selected, ...selectedFill }

  // The edited fill must come from --row-edited, not from a literal and not
  // from --warning-soft (which is a different role: toolbar warnings).  This
  // is the "no hardcoding / single source" half of §2-1, checked against the
  // token's live value rather than against a copy of it.
  const rowEditedRgb = hslTripleToRgb(colours.tokens.rowEdited)
  const editedFill = parseRgb(colours.edited.fill)
  expect({ r: editedFill.r, g: editedFill.g, b: editedFill.b },
    'the edited clip fill is not --row-edited — it has been hardcoded or repointed').toEqual(rowEditedRgb)
  expect(colours.tokens.rowEdited.trim(),
    '--row-edited is back on amber-400; the owner reported that as "beige"').not.toBe('43 96% 56%')

  // Composite each state over what is actually behind it and check the four
  // are distinguishable and legible.
  const compositeOf = (state: { fill: string; bgStack: string[] }) => {
    // `bgStack` is the ancestor chain, nearest first; fold from the opaque end
    // back toward the clip, then put the clip's own fill on top.
    const layers = state.bgStack.map(parseRgb)
    let acc = { r: 0, g: 0, b: 0 }
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc)
    return over(parseRgb(state.fill), acc)
  }
  const composites = {
    normal: compositeOf(colours.normal),
    edited: compositeOf(colours.edited),
    overflow: compositeOf(colours.overflow),
  }
  const textRgb = parseRgb(colours.normal.text)
  const report = {
    tokens: colours.tokens,
    composites,
    textContrast: Object.fromEntries(Object.entries(composites).map(([k, v]) => [k, contrast(v, textRgb)])),
    timecodeContrast: Object.fromEntries(
      Object.entries(composites).map(([k, v]) => [
        k,
        colours[k as keyof typeof composites].timecodeText
          ? contrast(v, over(parseRgb(colours[k as keyof typeof composites].timecodeText as string), v))
          : null,
      ]),
    ),
    borders: {
      normal: colours.normal.border,
      edited: colours.edited.border,
      overflow: colours.overflow.border,
      selected: colours.selected.border,
    },
  }
  // eslint-disable-next-line no-console
  console.log('\n[REQ-0524] clip state colours:', JSON.stringify(report, null, 2))

  // §2-1 "文字とのコントラストを確認すること": BOTH rows of the clip stay AA on
  // every fill.  The edited fill's alpha is capped at exactly the value that
  // keeps this true, and the timecode row drops its dimming there — see
  // BLOCK_TONE.  Checking only the body row would have missed the timecode
  // row falling to 2.37:1 when the yellow was brightened.
  for (const [k, v] of Object.entries(report.textContrast)) {
    expect(v, `clip body text over the ${k} fill`).toBeGreaterThanOrEqual(4.5)
  }
  for (const [k, v] of Object.entries(report.timecodeContrast)) {
    expect(v, `clip timecode row over the ${k} fill (null = the row did not render, so nothing was measured)`)
      .not.toBeNull()
    expect(v as number, `clip timecode row over the ${k} fill`).toBeGreaterThanOrEqual(4.5)
  }
  // §2-1 "他の状態の色と混同しないこと": the fills are pairwise distinct.  ΔL
  // alone is not enough (amber and red can share a luminance), so distance is
  // taken in RGB.
  //
  // The floors differ, and the difference is reported rather than hidden
  // (CLAUDE.md §18 "no silent caps"):
  //   - anything involving `edited` must clear 60.  That is the tone REQ-0524
  //     changed, and it is the one the owner has to be able to pick out.
  //   - `normal` vs `overflow` gets 15.  It measures ~21 and REQ-0524 did not
  //     touch either of them: `bg-destructive/15` over the near-black lane is
  //     a genuinely faint red wash.  Gating it at 60 would fail this spec for
  //     a condition that predates it; gating it at 15 still catches the two
  //     tones collapsing onto each other.  The real number is in the log above
  //     and is called out in RES-0524 for the owner to decide on.
  const pairs: [string, string, number][] = [
    ['normal', 'edited', 60],
    ['edited', 'overflow', 60],
    ['normal', 'overflow', 15],
  ]
  for (const [a, b, floor] of pairs) {
    const ca = composites[a as keyof typeof composites]
    const cb = composites[b as keyof typeof composites]
    const dist = Math.round(Math.hypot(ca.r - cb.r, ca.g - cb.g, ca.b - cb.b))
    expect(dist, `${a} vs ${b} fills are too close (RGB distance ${dist}, floor ${floor})`).toBeGreaterThan(floor)
  }

  // ---------------------------------------------------------------------------
  // Negative control — put the pre-REQ-0524 frame back onto the LIVE element
  // and prove `checkFrame` rejects it.  No git, no source swap.
  // ---------------------------------------------------------------------------
  const applied = await window.evaluate((marker: string) => {
    const buttons = Array.from(document.querySelectorAll('div[style*="height: 64px"] > button'))
    const el = buttons.find((b) => (b.textContent || '').includes(marker)) as HTMLElement | undefined
    if (!el) return 0
    let n = 0
    // (a) what `ring-2 ring-primary` compiled to on the selected branch
    el.style.boxShadow = '0 0 0 2px rgb(63, 213, 133)'
    if (getComputedStyle(el).boxShadow.includes('2px')) n++
    // (b) what `rounded-md` compiled to after the REQ-0177 radius flattening
    el.style.borderRadius = '3px'
    if (parseFloat(getComputedStyle(el).borderTopLeftRadius) === 3) n++
    return n
  }, MARKERS.normal)
  expect(applied, 'the negative control changed nothing — it has stopped perturbing the frame under test').toBe(2)

  await window.waitForTimeout(100)
  const perturbed = await frameOf(MARKERS.normal)
  const caught = checkFrame(perturbed, 'negative-control')
  // eslint-disable-next-line no-console
  console.log('\n[REQ-0524] negative control caught:', JSON.stringify(caught, null, 2))

  // Name the two specific regressions, so a check that merely trips over
  // something incidental does not count as a pass.
  expect(caught.join(' | '), 'the check must catch the ring that made the frame look thicker').toContain('outset ring of 2px')
  expect(caught.join(' | '), 'the check must catch the rounded corners').toContain('corner radii are [3, 3, 3, 3]')

  await electronApp.close()
})
