/**
 * REQ-0356 §4 — the paid families stay VISIBLE, and locked, on the editing
 * surfaces.
 *
 * ## What this pins that nothing else did
 *
 * REQ-0353's gates fixed what the free tier can SELECT. They passed while the
 * free tier's font list showed a single row, because "Noto is the only
 * selectable family" and "Noto is the only family the user can SEE" are the
 * same sentence to a test that only asks about selectability. The second one
 * is a product bug: a one-row dropdown says "this app has one font", and the
 * only paid upsell in the whole free edition sat behind it.
 *
 * The upsell was not missing by design. `RowFontSelector` carried it and
 * shipped that way in v1.3.5; REQ-0275 (`b3c8093`) swapped the inspector and
 * bulk-edit bar onto `FamilyWeightSelector`, which never had the lock UI, and
 * REQ-0341 §4 deleted the orphaned component afterwards. So this asserts the
 * VISIBLE state of an unselectable family, which is the half nobody held.
 *
 * ## Negative control (how to prove the gate still works)
 *
 * There is no env-var seam here — this is React in the built bundle, and a
 * production switch that disables the padlocks would be a worse liability than
 * the bug. To re-validate, delete the `lockedFamilies.length > 0` block in
 * `family-weight-selector.tsx`, `npm run build`, and run this file: the free
 * cases MUST fail (13 → 1 row, 12 → 0 locks). Restore and rebuild after.
 * Measured that way on the REQ-0356 run; see RES-0356 §4.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { FONT_REGISTRY, getFontFamilies } from '../../src/shared/fonts'

const INDEX_MAIN = path.resolve(__dirname, '../../out/main/index.js')
const INDEX_HTML = path.resolve(__dirname, '../../out/renderer/index.html')

const ALL_FONT_IDS = FONT_REGISTRY.map((m) => m.id)
const FAMILY_COUNT = getFontFamilies().length
/** Every family except the bundled one is paid-only. */
const PAID_FAMILY_COUNT = FAMILY_COUNT - 1

interface Row {
  label: string
  locked: boolean
  nameScrollW: number
  nameClientW: number
  badges: number
  faceLoaded: boolean
}

/**
 * Launch with a tier injected.
 *
 * Every font is marked installed on disk so the ONLY thing that can remove a
 * family from the list is the tier gate — otherwise a machine with nothing
 * downloaded would show one row in both tiers and the gate would pass on a
 * coincidence. This is the same injection `font-popover-list-fit.spec.ts`
 * uses, for the same reason.
 */
async function launch(isMsix: boolean): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ args: [INDEX_MAIN], timeout: 60_000 })
  const win = await app.firstWindow()
  await win.goto('file:///' + INDEX_HTML.replace(/\\/g, '/') + '?seed=demo&start=step2')
  await win.waitForFunction(() =>
    Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test),
  )
  await win.evaluate(([ids, msix]) => {
    const t = (window as unknown as {
      __mojioko_test: {
        project: { getState: () => { entries: { id: string }[] } }
        ui: { setState: (s: unknown) => void }
        appEnv: { setState: (s: unknown) => void }
        installedFonts: { setState: (s: unknown) => void }
      }
    }).__mojioko_test
    t.appEnv.setState({ isMsix: msix as boolean })
    t.installedFonts.setState({ ids: new Set(ids as string[]), loadedCount: 1 })
    const first = t.project.getState().entries[0]
    t.ui.setState({ selectedRowIds: new Set<string>(), selectedEntryId: first.id })
  }, [ALL_FONT_IDS, isMsix] as [string[], boolean])
  return { app, win }
}

/** Open the inspector's family dropdown and measure every row in it. */
async function openFamilyList(win: Page): Promise<Row[]> {
  const size = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  expect(size.w, 'startup content width').toBe(1280)
  expect(size.h, 'startup content height').toBe(820)

  await win.waitForSelector('.overflow-y-auto.overflow-x-hidden')
  await win.click('.overflow-y-auto.overflow-x-hidden button[aria-haspopup="dialog"]')
  await win.waitForSelector('[data-radix-popper-content-wrapper]')
  await win.waitForTimeout(700) // let each row paint in its own face

  return win.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper]')
    if (!wrapper) throw new Error('popover did not open')
    return Array.from(wrapper.querySelectorAll<HTMLElement>('button'))
      .map((btn) => {
        const name = btn.querySelector<HTMLElement>('span.truncate')
        if (!name) return null
        const family = (name.style.fontFamily || '').replace(/['"]/g, '')
        return {
          label: name.textContent ?? '',
          locked: btn.getAttribute('data-font-locked') === 'true',
          nameScrollW: name.scrollWidth,
          nameClientW: name.clientWidth,
          badges: btn.querySelectorAll('[data-font-badge]').length,
          // A fallback face would make every width optimistic.
          faceLoaded: family ? document.fonts.check(`400 14px '${family}'`) : true,
        }
      })
      .filter((r): r is Row => r !== null)
  })
}

test('REQ-0356 — FREE tier lists all 13 families, 12 of them locked', async () => {
  const { app, win } = await launch(false)
  try {
    const rows = await openFamilyList(win)
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `[REQ-0356 free] ${r.label.padEnd(18)} locked=${String(r.locked).padEnd(5)} ` +
        `scrollW=${String(r.nameScrollW).padStart(4)} clientW=${String(r.nameClientW).padStart(4)} face=${r.faceLoaded}`,
      )
    }

    expect(rows.length, 'every family is visible, pickable or not').toBe(FAMILY_COUNT)
    expect(rows.filter((r) => r.locked).length, 'the paid families carry a padlock').toBe(PAID_FAMILY_COUNT)
    expect(
      rows.filter((r) => !r.locked).map((r) => r.label),
      'exactly the bundled family is pickable',
    ).toEqual(['Noto Sans JP'])

    // The pickable row comes first: what the user can actually use must not be
    // buried under twelve things they cannot.
    expect(rows[0].locked, 'the pickable family is listed first').toBe(false)

    const unloaded = rows.filter((r) => !r.faceLoaded).map((r) => r.label)
    expect(unloaded, 'families in a FALLBACK face — widths would be optimistic').toEqual([])

    // REQ-0344 / REQ-0356 §3-1 — the padlock eats horizontal space, and this
    // list already lost family names to a 240px popover once.
    const clipped = rows
      .filter((r) => r.nameScrollW > r.nameClientW)
      .map((r) => `${r.label} (${r.nameScrollW} > ${r.nameClientW})`)
    expect(clipped, 'family names elided by `truncate` once the padlock is added').toEqual([])

    // REQ-0348 §1 still holds: the lock is the only thing added back.
    expect(rows.filter((r) => r.badges > 0).map((r) => r.label), 'no coverage chips here').toEqual([])
  } finally {
    await app.close()
  }
})

test('REQ-0356 — clicking a locked family opens the Store upsell', async () => {
  const { app, win } = await launch(false)
  try {
    await openFamilyList(win)
    await win.click('[data-radix-popper-content-wrapper] button[data-font-locked="true"]')
    // The upsell is a Radix dialog; the popover closes as it opens.
    await win.waitForSelector('[role="dialog"]', { timeout: 5_000 })
    const open = await win.evaluate(() => document.querySelectorAll('[role="dialog"]').length)
    expect(open, 'the Store upsell dialog is on screen').toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})

test('REQ-0356 — PAID tier shows no padlocks at all', async () => {
  const { app, win } = await launch(true)
  try {
    const rows = await openFamilyList(win)
    expect(rows.length, 'every family is listed').toBe(FAMILY_COUNT)
    expect(
      rows.filter((r) => r.locked).map((r) => r.label),
      'the paid edition must not grow padlocks',
    ).toEqual([])
    const clipped = rows
      .filter((r) => r.nameScrollW > r.nameClientW)
      .map((r) => `${r.label} (${r.nameScrollW} > ${r.nameClientW})`)
    expect(clipped, 'family names elided by `truncate`').toEqual([])
  } finally {
    await app.close()
  }
})
