/**
 * REQ-0525 §3-3 — every surface that means "edited" draws from ONE token, and
 * the surfaces that mean "warning" do not.
 *
 * The failure this exists to prevent is drift: there are four places that say
 * 編集済み (timeline clip, inspector badge, list row tint, list pencil chip)
 * and before REQ-0525 they were three different colours — yellow, neutral
 * grey, and a 4 % amber borrowed from the warning family. Recolouring one and
 * forgetting the others is the obvious way to end up back there, so this spec
 * reads all four off the rendered DOM and requires the same RGB triple.
 *
 * Why RGB triples and not class names: `--row-edited` is consumed at four
 * different alphas (1.0 / 1.0 / 0.70 / 0.10) against three different
 * backdrops, so "same colour" cannot mean "same computed pixel". It means the
 * same SOURCE — and `getComputedStyle` reports `rgba(r, g, b, a)` with the
 * token's rgb intact, so comparing the triples pins the token while leaving
 * every call site free to pick its own weight. A hardcoded literal fails it
 * too, which is the other half of the requirement.
 *
 * ★ Negative control (CLAUDE.md §18 "負の対照に git checkout を使わない"):
 * `repointOneSurface` writes the OLD amber onto exactly one of the four live
 * elements — the list row, i.e. the one that really was amber — and re-runs
 * the identical checker. No source is swapped and no ref is checked out; it
 * reports whether the write landed so it fails loudly instead of quietly
 * becoming a no-op.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'

/** `"236 73% 54%"` → `{r,g,b}`. Mirrors the CSS colour the browser resolves. */
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

/** `"rgba(52, 63, 223, 0.7)"` → `"52,63,223"`; alpha deliberately dropped. */
function rgbTriple(css: string): string {
  const m = css.match(/-?[\d.]+/g)
  if (!m || m.length < 3) throw new Error(`cannot parse colour: ${css}`)
  return `${Math.round(+m[0])},${Math.round(+m[1])},${Math.round(+m[2])}`
}

function alphaOf(css: string): number {
  const m = css.match(/-?[\d.]+/g)
  return m && m.length > 3 ? +m[3] : 1
}

/** What one "edited" surface reports. */
interface Surface {
  name: string
  backgroundColor: string
}

/**
 * The contract, as data rather than bare `expect`s, so the negative control can
 * run the IDENTICAL check against a perturbed DOM and assert it complains.
 */
function checkUnified(surfaces: Surface[], tokenRgb: string): string[] {
  const v: string[] = []
  for (const s of surfaces) {
    const got = rgbTriple(s.backgroundColor)
    if (got !== tokenRgb) {
      v.push(`${s.name}: draws rgb(${got}) but --row-edited is rgb(${tokenRgb}) — it is not reading the shared token`)
    }
    if (alphaOf(s.backgroundColor) <= 0) {
      v.push(`${s.name}: fully transparent — the edited state is invisible here`)
    }
  }
  return v
}

test('every "edited" surface reads one token, and warnings do not — REQ-0525', async () => {
  const electronApp = await electron.launch({
    args: [path.resolve(__dirname, '../../out/main/index.js')],
    timeout: 30_000,
  })
  const window = await electronApp.firstWindow()
  const indexFile = path.resolve(__dirname, '../../out/renderer/index.html')
  await window.goto('file:///' + indexFile.replace(/\\/g, '/') + '?seed=demo&start=step2')
  await window.waitForFunction(() => Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1600, 900)
  })

  const MARKER = 'ZZEDITEDBOTH'

  /*
   * Seed one entry that is BOTH edited and overlapping, so the inspector shows
   * the blue 編集済み badge and the amber 時間重複 badge side by side — the
   * pairing REQ-0525 exists to keep distinguishable.
   *
   * `setState` rather than `updateEntry`: the store recomputes `isEdited` from
   * `entry.original` on every update, so the flag has to be written directly.
   * The other fields are chosen to keep the OTHER badges away (endSec >
   * startSec avoids timeInvalid, non-empty short text avoids emptyText and
   * overflow) so the shot shows exactly two pills.
   */
  const targetId = await window.evaluate((marker: string) => {
    const t = (window as unknown as {
      __mojioko_test: {
        project: { getState: () => { entries: Record<string, unknown>[] }; setState: (s: unknown) => void }
        ui: { setState: (s: unknown) => void }
      }
    }).__mojioko_test
    const entries = t.project.getState().entries.map((e) => ({ ...e }))
    entries[0] = { ...entries[0], isDeleted: false, isEdited: false, startSec: 0, endSec: 10, text: 'ZZPLAIN' }
    entries[1] = {
      ...entries[1],
      isDeleted: false,
      isEdited: true,
      startSec: 5, // < entries[0].endSec → warnings.overlap
      endSec: 12,
      text: marker,
    }
    t.project.setState({ entries })
    t.ui.setState({
      editorViewMode: 'timeline',
      // Selection is set LATER, not here: a selected clip wears the green
      // selection frame, and the frame is one of the surfaces under test.
      selectedEntryId: null,
      selectedRowIds: new Set(),
      timelinePixelsPerSec: 100,
    })
    return entries[1].id as string
  }, MARKER)
  expect(targetId, 'seed did not produce a target entry').toBeTruthy()
  await window.waitForTimeout(700)

  const token = await window.evaluate(() => ({
    rowEdited: getComputedStyle(document.documentElement).getPropertyValue('--row-edited'),
    warningSoft: getComputedStyle(document.documentElement).getPropertyValue('--warning-soft'),
  }))
  const t = hslTripleToRgb(token.rowEdited)
  const tokenRgb = `${t.r},${t.g},${t.b}`

  // --- surface 1: the timeline clip -----------------------------------------
  const clip = await window.evaluate((marker: string) => {
    const el = Array.from(document.querySelectorAll('div[style*="height: 64px"] > button'))
      .find((b) => (b.textContent || '').includes(marker))
    if (!el) throw new Error('timeline clip not found for ' + marker)
    const cs = getComputedStyle(el)
    return { backgroundColor: cs.backgroundColor, borderColor: cs.borderTopColor }
  }, MARKER)

  // §2-5 — the green 1px selection frame has to survive on top of the blue
  // fill. Read it while the clip IS selected, then put the selection back for
  // the inspector. Reported as a number rather than asserted blind: the
  // REQ-0524 bright-yellow candidate failed exactly here.
  await window.evaluate((id: string) => {
    const tt = (window as unknown as { __mojioko_test: { ui: { setState: (s: unknown) => void } } }).__mojioko_test
    tt.ui.setState({ selectedEntryId: id })
  }, targetId)
  await window.waitForTimeout(400)
  const selectedClip = await window.evaluate((marker: string) => {
    const el = Array.from(document.querySelectorAll('div[style*="height: 64px"] > button'))
      .find((b) => (b.textContent || '').includes(marker))
    if (!el) throw new Error('selected timeline clip not found')
    const cs = getComputedStyle(el)
    return { backgroundColor: cs.backgroundColor, borderColor: cs.borderTopColor }
  }, MARKER)
  expect(rgbTriple(selectedClip.backgroundColor),
    'selecting an edited clip replaced its blue fill — the state colour must survive selection')
    .toBe(rgbTriple(clip.backgroundColor))
  expect(rgbTriple(selectedClip.borderColor),
    'a selected edited clip does not wear the green selection frame')
    .not.toBe(rgbTriple(clip.borderColor))

  // --- surfaces 2 + the warning it must not resemble ------------------------
  // Located structurally: the inspector's badge row is the only `.min-h-5`
  // flex-wrap container, and the badges are its children. Reading them by
  // position rather than by localised text keeps this locale-independent.
  const badges = await window.evaluate(() => {
    const row = document.querySelector('div.min-h-5')
    if (!row) throw new Error('inspector badge row not found — is the inspector in single-entry mode?')
    const pills = Array.from(row.children) as HTMLElement[]
    return pills.map((p) => {
      const cs = getComputedStyle(p)
      return { text: (p.textContent || '').trim(), backgroundColor: cs.backgroundColor, color: cs.color }
    })
  })
  expect(badges.length, `expected the 編集済み + 時間重複 pair, got ${JSON.stringify(badges)}`).toBe(2)
  const editedBadge = badges[0]
  const warningBadge = badges[1]

  // --- surfaces 3 & 4: the list row tint and the pencil chip -----------------
  await window.evaluate(() => {
    const tt = (window as unknown as { __mojioko_test: { ui: { setState: (s: unknown) => void } } }).__mojioko_test
    tt.ui.setState({ editorViewMode: 'list' })
  })
  await window.waitForTimeout(700)

  const listSurfaces = await window.evaluate((marker: string) => {
    // Walk up from the marker text to the row root — the only ancestor that
    // carries the row's left-marker border utility.
    const all = Array.from(document.querySelectorAll('*')) as HTMLElement[]
    const leaf = all.find(
      (e) => e.children.length === 0 && (e.textContent || '').includes(marker),
    )
    if (!leaf) throw new Error('list row not found for ' + marker)
    let row: HTMLElement | null = leaf
    while (row && !row.className.toString().includes('border-l-2')) row = row.parentElement
    if (!row) throw new Error('row root (border-l-2) not found above the marker')
    // The pencil chip is the only filled element inside the row whose
    // background is opaque and not a surface token; find it by its rounded chip
    // + fixed 16px box.
    const chip = Array.from(row.querySelectorAll('span[role="img"]')).find((s) => {
      const bg = getComputedStyle(s).backgroundColor
      const m = bg.match(/-?[\d.]+/g)
      return Boolean(m && (m.length < 4 || +m[3] > 0))
    })
    return {
      rowBg: getComputedStyle(row).backgroundColor,
      chipBg: chip ? getComputedStyle(chip).backgroundColor : null,
      chipCount: row.querySelectorAll('span[role="img"]').length,
    }
  }, MARKER)
  expect(listSurfaces.chipBg, 'no filled status chip found in the edited row — the pencil indicator is missing').not.toBeNull()

  // --- the contract ---------------------------------------------------------
  const surfaces: Surface[] = [
    // The clip is read UNSELECTED — a selected clip's frame is the green
    // selection colour by design, which is checked separately above.
    { name: 'timeline clip fill', backgroundColor: clip.backgroundColor },
    { name: 'timeline clip frame', backgroundColor: clip.borderColor },
    { name: 'inspector 編集済み badge', backgroundColor: editedBadge.backgroundColor },
    { name: 'list row tint', backgroundColor: listSurfaces.rowBg },
    { name: 'list pencil chip', backgroundColor: listSurfaces.chipBg as string },
  ]
  const report = {
    token,
    tokenRgb,
    surfaces: Object.fromEntries(surfaces.map((s) => [s.name, s.backgroundColor])),
    editedBadge,
    warningBadge,
  }
  // eslint-disable-next-line no-console
  console.log('\n[REQ-0525] edited surfaces:', JSON.stringify(report, null, 2))

  expect(checkUnified(surfaces, tokenRgb), 'edited surfaces disagree on the token').toEqual([])

  // §1-4 — and the warning next to it must stay in the warning family. Without
  // this, "unify the edited colour" could be satisfied by recolouring
  // everything blue, which is the mistake the REQ explicitly warns against.
  const w = hslTripleToRgb(token.warningSoft)
  expect(rgbTriple(warningBadge.backgroundColor),
    'the 時間重複 badge is no longer the warning colour — warnings must not follow "edited"')
    .toBe(`${w.r},${w.g},${w.b}`)
  expect(rgbTriple(warningBadge.backgroundColor),
    'the warning badge and the edited badge now draw the same colour — their roles are indistinguishable')
    .not.toBe(tokenRgb)

  // -------------------------------------------------------------------------
  // Negative control — repoint ONE surface back to the old amber on the live
  // DOM and prove the checker rejects it. No git, no source swap.
  // -------------------------------------------------------------------------
  const applied = await window.evaluate((marker: string) => {
    const all = Array.from(document.querySelectorAll('*')) as HTMLElement[]
    const leaf = all.find((e) => e.children.length === 0 && (e.textContent || '').includes(marker))
    if (!leaf) return 0
    let row: HTMLElement | null = leaf
    while (row && !row.className.toString().includes('border-l-2')) row = row.parentElement
    if (!row) return 0
    // Exactly what this row carried before REQ-0525: warning-soft at 4 %.
    row.style.backgroundColor = 'hsl(var(--warning-soft) / 0.04)'
    return rgbTriple(getComputedStyle(row).backgroundColor) !== '' ? 1 : 0

    function rgbTriple(css: string): string {
      const m = css.match(/-?[\d.]+/g)
      return m && m.length >= 3 ? `${Math.round(+m[0])},${Math.round(+m[1])},${Math.round(+m[2])}` : ''
    }
  }, MARKER)
  expect(applied, 'the negative control wrote nothing — it has stopped perturbing the surface under test').toBe(1)

  await window.waitForTimeout(150)
  const perturbedRowBg = await window.evaluate((marker: string) => {
    const all = Array.from(document.querySelectorAll('*')) as HTMLElement[]
    const leaf = all.find((e) => e.children.length === 0 && (e.textContent || '').includes(marker))
    let row: HTMLElement | null = leaf as HTMLElement
    while (row && !row.className.toString().includes('border-l-2')) row = row.parentElement
    return getComputedStyle(row as HTMLElement).backgroundColor
  }, MARKER)

  const caught = checkUnified(
    surfaces.map((s) => (s.name === 'list row tint' ? { ...s, backgroundColor: perturbedRowBg } : s)),
    tokenRgb,
  )
  // eslint-disable-next-line no-console
  console.log('\n[REQ-0525] negative control caught:', JSON.stringify(caught, null, 2))
  expect(caught.join(' | '), 'putting the old amber back on the list row did not fail the check')
    .toContain('list row tint')

  await electronApp.close()
})
