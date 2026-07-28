/**
 * REQ-0344 §1 → REQ-0348 §1 — family names are never truncated in a font
 * list, on either of the two surfaces that show one.
 *
 * ## Why this gate exists at all
 *
 * REQ-0341 added coverage chips to the font selector and pinned the closed
 * TRIGGER.  That gate passed, and the owner still saw clipped family names —
 * because the clipping was in the open POPOVER, which that gate never opened.
 *
 * The reason it never opened it is the part worth keeping.  The list is
 * filtered twice by machine state a test cannot assume: `selectableFamilies()`
 * hides anything not installed ON DISK, and `canSelectFontInTier()` hides the
 * paid families in a free build.  On a machine with nothing downloaded the
 * popover therefore contains Noto and nothing else, and one short name fits
 * any width.  RES-0341 §1-6 said as much in writing, and the conclusion drawn
 * then was that the list could not be measured — so the 240 px width went in
 * reasoned rather than measured, and only the owner's machine could show
 * otherwise.  Measured later with the chips inline, "Hachi Maru Pop" and
 * "Potta One" had clientWidth **0**: the row named no font at all.
 *
 * So this file INJECTS both conditions — `appEnv.isMsix` and the full
 * installed set — and measures all 13 real families.  A gate that only runs
 * correctly on a fully provisioned paid machine is not a gate.
 *
 * ## REQ-0348 §1 — two surfaces now, not one
 *
 * The owner split the behaviour: the editing surfaces (inspector, bulk-edit)
 * show plain names, and Settings ▸ Fonts keeps the chips.  Both are checked
 * here, because "the name fits" has to hold for both and the two get there
 * differently — one by having nothing beside the name, the other by putting
 * the chips on a second line.
 *
 * NOTE ON FIDELITY: the label is rendered in the family's OWN face, so these
 * widths only mean something when the real font files are present.  The spec
 * asserts the faces actually loaded and fails loudly if they did not, rather
 * than passing on fallback-font metrics that would be optimistic — a silent
 * pass on the wrong numbers is the exact failure this gate exists to prevent.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { FONT_REGISTRY, getFontFamilies } from '../../src/shared/fonts'

const INDEX_MAIN = path.resolve(__dirname, '../../out/main/index.js')
const INDEX_HTML = path.resolve(__dirname, '../../out/renderer/index.html')

/** Every weight in the registry — what a paid machine with the set installed has. */
const ALL_FONT_IDS = FONT_REGISTRY.map((m) => m.id)
const FAMILY_COUNT = getFontFamilies().length

interface Measured {
  label: string
  nameScrollW: number
  nameClientW: number
  rowScrollW: number
  rowClientW: number
  badges: string[]
  faceLoaded: boolean
}

/**
 * Measure every row of a font list.
 *
 * The row selector is a parameter because the two surfaces are built
 * differently: the popover's rows are `<button>`s, while Settings ▸ Fonts
 * renders each family as a `<div>` that only becomes `role="button"` when the
 * family is tier-locked.  Selecting on `button` alone silently found zero rows
 * there — which the "lists every family" assertion caught, and is exactly why
 * that assertion is checked before the width ones.
 */
const MEASURE = ([rootSelector, rowSelector]: [string, string]): Measured[] => {
  const wrapper = document.querySelector<HTMLElement>(rootSelector)
  if (!wrapper) throw new Error(`container not found: ${rootSelector}`)
  return Array.from(wrapper.querySelectorAll<HTMLElement>(rowSelector))
    .map((btn) => {
      const name = btn.querySelector<HTMLElement>('span.truncate')
      if (!name) return null
      const family = (name.style.fontFamily || '').replace(/['"]/g, '')
      return {
        label: name.textContent ?? '',
        nameScrollW: name.scrollWidth,
        nameClientW: name.clientWidth,
        rowScrollW: btn.scrollWidth,
        rowClientW: btn.clientWidth,
        badges: Array.from(btn.querySelectorAll<HTMLElement>('[data-font-badge]')).map(
          (b) => b.getAttribute('data-font-badge') ?? '',
        ),
        // `document.fonts.check` answers "would text in this family render in
        // it?" — false means we would be measuring the fallback face.
        faceLoaded: family ? document.fonts.check(`400 14px '${family}'`) : true,
      }
    })
    .filter((r): r is Measured => r !== null)
}

async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ args: [INDEX_MAIN], timeout: 60_000 })
  const win = await app.firstWindow()
  await win.goto('file:///' + INDEX_HTML.replace(/\\/g, '/') + '?seed=demo&start=step2')
  await win.waitForFunction(() =>
    Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test),
  )
  // Inject the two conditions that otherwise reduce every font list to one row.
  await win.evaluate((ids) => {
    const t = (window as unknown as {
      __mojioko_test: {
        project: { getState: () => { entries: { id: string }[] } }
        ui: { setState: (s: unknown) => void }
        appEnv: { setState: (s: unknown) => void }
        installedFonts: { setState: (s: unknown) => void }
      }
    }).__mojioko_test
    t.appEnv.setState({ isMsix: true })
    t.installedFonts.setState({ ids: new Set(ids), loadedCount: 1 })
    const first = t.project.getState().entries[0]
    t.ui.setState({ selectedRowIds: new Set<string>(), selectedEntryId: first.id })
  }, ALL_FONT_IDS)
  return { app, win }
}

/** Shared assertions: the list is complete, in real faces, and nothing elides. */
function expectAllNamesFit(rows: Measured[], label: string) {
  expect(rows.length, `${label}: lists every family — injection worked`).toBe(FAMILY_COUNT)

  const unloaded = rows.filter((r) => !r.faceLoaded).map((r) => r.label)
  expect(
    unloaded,
    `${label}: families rendering in a FALLBACK face — widths would be optimistic ` +
    'and this gate would pass on metrics that are not the ones the user sees. ' +
    'Run `npm run build` and make sure the additional font set is installed.',
  ).toEqual([])

  const clipped = rows
    .filter((r) => r.nameScrollW > r.nameClientW)
    .map((r) => `${r.label} (${r.nameScrollW} > ${r.nameClientW})`)
  expect(clipped, `${label}: family names elided by \`truncate\``).toEqual([])

  const overflowing = rows
    .filter((r) => r.rowScrollW > r.rowClientW)
    .map((r) => `${r.label} (${r.rowScrollW} > ${r.rowClientW})`)
  expect(overflowing, `${label}: rows wider than their container`).toEqual([])
}

test('REQ-0348 §1 — the inspector font popover lists plain names, none truncated', async () => {
  const { app, win } = await launch()
  try {
    const size = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    expect(size.w, 'startup content width').toBe(1280)
    expect(size.h, 'startup content height').toBe(820)

    await win.waitForSelector('.overflow-y-auto.overflow-x-hidden')
    await win.click('.overflow-y-auto.overflow-x-hidden button[aria-haspopup="dialog"]')
    await win.waitForSelector('[data-radix-popper-content-wrapper]')
    await win.waitForTimeout(600) // let the faces paint in their own family

    const rows: Measured[] = await win.evaluate(
      MEASURE, ['[data-radix-popper-content-wrapper]', 'button'] as [string, string],
    )
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `[REQ-0348 §1 inspector] ${r.label.padEnd(18)} scrollW=${String(r.nameScrollW).padStart(4)} ` +
        `clientW=${String(r.nameClientW).padStart(4)} badges=[${r.badges.join(',')}] face=${r.faceLoaded}`,
      )
    }

    expectAllNamesFit(rows, 'inspector popover')
    // REQ-0348 §1 — the editing surface carries no coverage vocabulary.
    const withBadges = rows.filter((r) => r.badges.length > 0).map((r) => r.label)
    expect(withBadges, 'inspector popover must show no badges').toEqual([])
  } finally {
    await app.close()
  }
})

test('REQ-0348 §1 — Settings ▸ Fonts keeps its badges, and still fits the names', async () => {
  const { app, win } = await launch()
  try {
    // Open Settings and switch to the Fonts tab.  The dialog's open state is
    // in the ui-store; the tab is local, so it is clicked like a user would.
    await win.evaluate(() => {
      const t = (window as unknown as { __mojioko_test: { ui: { setState: (s: unknown) => void } } }).__mojioko_test
      t.ui.setState({ isSettingsDialogOpen: true })
    })
    await win.waitForSelector('[role="dialog"]')
    // Radix names its trigger `radix-:rNN:-trigger-<value>`.  Matching the
    // suffix is locale-independent (the label is "フォント" by default) and
    // does not collide with the editor's own list/timeline `role="tab"`
    // buttons, which carry no id.
    await win.click('[role="tab"][id$="-trigger-fonts"]')
    await win.waitForTimeout(800)

    // The family list is the bordered, scrollable panel inside the tab.
    const rows: Measured[] = await win.evaluate(
      MEASURE, ['[role="dialog"] .divide-y', ':scope > div'] as [string, string],
    )
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `[REQ-0348 §1 settings] ${r.label.padEnd(18)} scrollW=${String(r.nameScrollW).padStart(4)} ` +
        `clientW=${String(r.nameClientW).padStart(4)} badges=[${r.badges.join(',')}] face=${r.faceLoaded}`,
      )
    }

    expectAllNamesFit(rows, 'settings font list')
    // The chips survive here — this is the surface the owner kept, and the
    // legend on it is what teaches the vocabulary.
    const withBadges = rows.filter((r) => r.badges.length > 0)
    expect(
      withBadges.length,
      'Settings ▸ Fonts must still carry coverage badges',
    ).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})
