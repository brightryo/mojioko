/**
 * REQ-0519 — the timeline toolbar's ARRANGEMENT, measured on real pixels.
 *
 * REQ-0519 moved four things and deleted one:
 *
 *   Row 1: [zoom] [snap] [trim] ...............................[how-to-use]
 *   Row 2: .....................[|< < > >|].....................
 *
 * — snap + trim came up from row 2, the how-to-use button went from the LEFT
 *   end of row 1 to the right end, the playhead arrows went down to row 2 and
 *   centred, and the "Tools" toggle that used to hide snap + trim behind a
 *   collapsed row 2 is gone (they are always visible now).
 *
 * The reason this is a gate and not a one-off measurement (CLAUDE.md §18
 * 追記2): row 1 grew from four controls to eight, and the thing that used to
 * keep it from wrapping at the minimum pane width was the collapse toggle.
 * That safety net is gone, so "row 1 still fits" has to be *measured* on every
 * run — in BOTH locales, because the English labels ("How to use", "Previous
 * boundary") are materially wider than the Japanese ones, and with the trim
 * chips SET, because a pending in/out point widens the trim cluster by the
 * width of a timecode each. Any of those is how a regression would actually
 * reach the owner.
 *
 * ★ Negative control (REQ-0519 §3-4, CLAUDE.md §18 "負の対照に git checkout を
 * 使わない"): `applyOldArrangement` perturbs THE ONE DECISION under test — it
 * moves the live DOM nodes back to where REQ-0519 found them (help to the head
 * of row 1 without `ml-auto`, arrows back up into row 1) and re-runs the very
 * same `checkLayout`. Nothing is checked out, no source is swapped, and the
 * perturbation reports how many nodes it actually moved so it fails loudly
 * rather than silently becoming a no-op if the markup is restructured again.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'

/** Box in viewport coordinates. */
interface Box { x: number; y: number; w: number; h: number }

interface RowChild extends Box { kind: string; label: string }

interface Layout {
  row1: Box & { childTops: number[]; scrollW: number; clientW: number }
  row2: Box & { scrollW: number; clientW: number }
  row1Children: RowChild[]
  navButtons: Box[]
  navGroup: Box | null
  toolbarH: number
  /** True when a "Tools" collapse toggle still exists (it must not). */
  hasToolsToggle: boolean
}

/**
 * Classify row 1's direct children structurally rather than by aria-label,
 * because the labels are localised and this spec runs in two locales.
 *
 *   zoom  — the only child containing the pps <input type=range>
 *   help  — the Popover trigger (Radix stamps aria-haspopup="dialog")
 *   snap  — a bare <button aria-pressed> child (In/Out also carry aria-pressed
 *           but they are nested inside the trim cluster, not direct children)
 *   trim  — a container child holding 3+ buttons
 */
const PROBE = `(() => {
  const box = (el) => {
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
  }
  const slider = Array.from(document.querySelectorAll('input[type=range]'))
    .find((el) => Number(el.min) === 10)
  if (!slider) throw new Error('zoom slider not found — cannot locate the timeline toolbar')
  let wrap = slider.parentElement
  while (wrap && !(wrap.className.includes('flex-col') && wrap.className.includes('border-b'))) {
    wrap = wrap.parentElement
  }
  if (!wrap) throw new Error('timeline toolbar wrapper not found')
  const rows = Array.from(wrap.children)
  if (rows.length !== 2) throw new Error('expected exactly 2 toolbar rows, got ' + rows.length)
  const [row1, row2] = rows

  const classify = (el) => {
    if (el.querySelector('input[type=range]') || el.matches('input[type=range]')) return 'zoom'
    if (el.matches('[aria-haspopup="dialog"]')) return 'help'
    if (el.matches('button[aria-pressed]')) return 'snap'
    if (el.querySelectorAll('button').length >= 3) return 'trim'
    return 'other:' + el.tagName.toLowerCase()
  }

  const navGroup = row2.querySelector('div')
  const navButtons = Array.from(row2.querySelectorAll('button'))

  return {
    row1: { ...box(row1), childTops: Array.from(row1.children).map((c) => Math.round(c.getBoundingClientRect().top)), scrollW: row1.scrollWidth, clientW: row1.clientWidth },
    row2: { ...box(row2), scrollW: row2.scrollWidth, clientW: row2.clientWidth },
    row1Children: Array.from(row1.children).map((el) => ({
      kind: classify(el),
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24),
      ...box(el),
    })),
    navGroup: navGroup ? box(navGroup) : null,
    navButtons: navButtons.map(box),
    toolbarH: Math.round(wrap.getBoundingClientRect().height),
    hasToolsToggle: Boolean(wrap.querySelector('[aria-expanded]:not([aria-haspopup="dialog"])')),
  }
})()`

/**
 * The arrangement contract. Returns a list of violations — empty means the
 * layout is as REQ-0519 specified. Written as data (not bare `expect`s) so the
 * negative control can run the IDENTICAL check against a perturbed DOM and
 * assert that it complains.
 */
function checkLayout(L: Layout, ctx: string, opts: { wideSeparation: boolean } = { wideSeparation: true }): string[] {
  const v: string[] = []
  const kinds = L.row1Children.map((c) => c.kind)

  // --- §1-1 the collapse toggle is gone -------------------------------------
  if (L.hasToolsToggle) v.push(`${ctx}: a collapse toggle still exists in the toolbar`)

  // --- §1-3 row 1 order: zoom → snap → trim → help --------------------------
  if (kinds.join(',') !== 'zoom,snap,trim,help') {
    v.push(`${ctx}: row 1 order is [${kinds.join(', ')}], expected [zoom, snap, trim, help]`)
  }

  // --- §1-3 "How to use" is right-aligned and set apart ---------------------
  const help = L.row1Children.find((c) => c.kind === 'help')
  const trim = L.row1Children.find((c) => c.kind === 'trim')
  if (help) {
    // Flush right: its right edge sits at the row's content edge (the row has
    // px-3 = 12px padding, so allow that plus a pixel of rounding).
    const rightGap = L.row1.x + L.row1.w - (help.x + help.w)
    if (rightGap > 14) v.push(`${ctx}: "how to use" is ${rightGap}px from the right edge — not right-aligned`)
    // Set apart from the trim cluster, not merely last in line. `ml-auto`
    // absorbs every spare pixel, so normally the gap is >100px and 48 is a
    // loose floor that still fails a plain `gap-3` neighbour.
    //
    // The exception is measured, not assumed: at the 1280px minimum width WITH
    // a trim range mid-set, both In and Out render a timecode inside the button
    // and row 1 is exactly full — there is no spare pixel for `ml-auto` to
    // distribute, so the gap falls back to the row's own `gap-3` (12px). That
    // is a genuinely full row, not a broken one: the "how to use" button is
    // still flush right (the rightGap check above still applies) and still
    // last, and nothing overflows or wraps. Asserting ≥48px there would demand
    // width that does not exist; asserting ≥12 everywhere keeps the real
    // invariant — the button is never overlapped or pushed out of the row.
    if (trim) {
      const sep = help.x - (trim.x + trim.w)
      const floor = opts.wideSeparation ? 48 : 12
      if (sep < floor) v.push(`${ctx}: only ${sep}px between trim and "how to use" — not visually separated`)
    }
  } else {
    v.push(`${ctx}: no "how to use" trigger among row 1's direct children`)
  }

  // --- §3-1 row 1 fits: no wrap, no horizontal overflow ---------------------
  if (L.row1.scrollW > L.row1.clientW + 1) {
    v.push(`${ctx}: row 1 overflows horizontally (scrollWidth ${L.row1.scrollW} > clientWidth ${L.row1.clientW})`)
  }
  const tops = L.row1.childTops
  if (tops.length && Math.max(...tops) - Math.min(...tops) > 12) {
    v.push(`${ctx}: row 1 wrapped — child tops span ${Math.max(...tops) - Math.min(...tops)}px`)
  }

  // --- §2-1 arrows live in row 2 and are centred there ----------------------
  if (L.navButtons.length !== 4) {
    v.push(`${ctx}: row 2 holds ${L.navButtons.length} buttons, expected the 4 playhead arrows`)
  }
  if (L.navGroup) {
    const navCentre = L.navGroup.x + L.navGroup.w / 2
    const rowCentre = L.row2.x + L.row2.w / 2
    if (Math.abs(navCentre - rowCentre) > 2) {
      v.push(`${ctx}: arrows off-centre by ${Math.round(Math.abs(navCentre - rowCentre))}px`)
    }
  } else {
    v.push(`${ctx}: no arrow group found in row 2`)
  }

  // --- §2-2 row 2 is short, §2-4 without shrinking the hit targets ----------
  if (L.row2.h > 36) v.push(`${ctx}: row 2 is ${L.row2.h}px tall, expected ≤36 (was 51 before REQ-0519)`)
  for (const b of L.navButtons) {
    if (b.w < 28 || b.h < 28) v.push(`${ctx}: an arrow shrank to ${b.w}x${b.h}px — hit target must stay ≥28x28`)
  }

  return v
}

test('timeline toolbar arrangement — REQ-0519 rows, right-aligned help, centred arrows', async () => {
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
  await window.waitForTimeout(400)

  const probe = (): Promise<Layout> => window.evaluate(PROBE) as Promise<Layout>
  const setLang = (lang: string) =>
    window.evaluate((l) => (window as unknown as { __mojioko_test: { i18n: { changeLanguage: (l: string) => Promise<unknown> } } }).__mojioko_test.i18n.changeLanguage(l), lang)
  const setSize = (width: number, height: number) =>
    electronApp.evaluate(({ BrowserWindow }, s) => {
      BrowserWindow.getAllWindows()[0].setContentSize(s.width, s.height)
    }, { width, height })

  const violations: string[] = []
  const measured: Record<string, { row1H: number; row2H: number; toolbarH: number; slackPx: number }> = {}

  // 1280px is the minimum window width the app supports; 1600 is a typical
  // one. Both locales, and with the trim chips both clear and SET — a pending
  // in/out point renders a timecode inside the button, which is the widest the
  // trim cluster ever gets.
  for (const [wName, width, height] of [['normal', 1600, 900], ['min', 1280, 800]] as const) {
    await setSize(width, height)
    for (const lang of ['ja', 'en']) {
      await setLang(lang)
      for (const chips of [false, true]) {
        await window.evaluate((set) => {
          const t = (window as unknown as { __mojioko_test: { ui: { setState: (s: unknown) => void } } }).__mojioko_test
          t.ui.setState(set
            ? { pendingCutInSec: 3661.5, pendingCutOutSec: 3725.25 }
            : { pendingCutInSec: null, pendingCutOutSec: null })
        }, chips)
        await window.waitForTimeout(300)

        const ctx = `${wName}/${lang}/${chips ? 'chips-set' : 'chips-clear'}`
        const L = await probe()
        // Wide separation is required except in the one measured worst case:
        // narrowest pane + both trim chips rendered. See checkLayout.
        violations.push(...checkLayout(L, ctx, { wideSeparation: !(wName === 'min' && chips) }))
        const help = L.row1Children.find((c) => c.kind === 'help')
        const trim = L.row1Children.find((c) => c.kind === 'trim')
        measured[ctx] = {
          row1H: L.row1.h,
          row2H: L.row2.h,
          toolbarH: L.toolbarH,
          // How much room row 1 has left over — the number that would go
          // negative first if someone adds a ninth control or a longer label.
          slackPx: help && trim ? help.x - (trim.x + trim.w) : -1,
        }
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log('\n[REQ-0519] toolbar geometry:', JSON.stringify(measured, null, 2))
  expect(violations, 'toolbar arrangement violations').toEqual([])

  // -------------------------------------------------------------------------
  // Negative control — put the OLD arrangement back into the live DOM and
  // prove `checkLayout` rejects it. No git, no source swap: the perturbation
  // touches only the placement decision this spec exists to defend.
  // -------------------------------------------------------------------------
  await setSize(1600, 900)
  await setLang('ja')
  await window.waitForTimeout(300)

  const applied = await window.evaluate(() => {
    const slider = Array.from(document.querySelectorAll('input[type=range]'))
      .find((el) => Number((el as HTMLInputElement).min) === 10) as HTMLElement | undefined
    if (!slider) return 0
    let wrap: HTMLElement | null = slider.parentElement
    while (wrap && !(wrap.className.includes('flex-col') && wrap.className.includes('border-b'))) {
      wrap = wrap.parentElement
    }
    if (!wrap) return 0
    const [row1, row2] = Array.from(wrap.children) as HTMLElement[]
    let n = 0
    // (a) help back to the head of row 1, without the `ml-auto` that right-aligns it
    const help = row1.querySelector('[aria-haspopup="dialog"]') as HTMLElement | null
    if (help) {
      help.classList.remove('ml-auto')
      row1.insertBefore(help, row1.firstElementChild)
      n++
    }
    // (b) the arrow group back up into row 1, where it sat before REQ-0519
    const nav = row2.querySelector('div') as HTMLElement | null
    if (nav) { row1.appendChild(nav); n++ }
    return n
  })

  // If the markup is restructured so the perturbation no longer lands, this
  // control silently stops proving anything — so it must fail here instead.
  expect(applied, 'the negative control moved nothing — it has stopped perturbing the layout under test').toBe(2)

  await window.waitForTimeout(300)
  const perturbed = await probe()
  const caught = checkLayout(perturbed, 'negative-control')
  // eslint-disable-next-line no-console
  console.log('\n[REQ-0519] negative control caught:', JSON.stringify(caught, null, 2))

  expect(caught.length, 'the old arrangement passed the layout check — the check proves nothing').toBeGreaterThan(0)
  // Name the specific regressions it must catch, so a check that merely
  // stumbles over something incidental does not count as a pass.
  expect(caught.join(' | '), 'the check must catch the old row-1 order').toContain('row 1 order is')
  expect(caught.join(' | '), 'the check must catch the arrows leaving row 2').toMatch(/row 2 holds 0 buttons|no arrow group/)

  await electronApp.close()
})
