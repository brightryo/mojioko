/**
 * REQ-0344 §1 — the family names in the font popover LIST are not truncated.
 *
 * ## Why this gate exists, and why the trigger-side one was not enough
 *
 * REQ-0341 added coverage chips to the font selector and pinned the closed
 * TRIGGER with `inspector-font-badge-fit.spec.ts`.  That gate passes, and the
 * owner still saw clipped family names — because the clipping was in the open
 * POPOVER, which that gate never opens.
 *
 * The reason it never opened it is the interesting part.  The list is filtered
 * twice by machine state a test cannot assume:
 *
 *   - `selectableFamilies()` hides anything not installed ON DISK, and
 *   - `canSelectFontInTier()` hides the paid families in a free build.
 *
 * On a machine with nothing downloaded, the popover therefore contains Noto
 * and nothing else, and one short name fits any width.  RES-0341 §1-6 said as
 * much in writing — the additional font set was not installed — and the
 * conclusion drawn at the time was that the list could not be measured.  So
 * the 240 px width went in reasoned rather than measured, with a comment
 * asserting the chips "keep their label here", and only the owner's machine
 * (paid tier, set downloaded) could show otherwise.
 *
 * This gate closes that by INJECTING both conditions: `appEnv.isMsix = true`
 * and every registry weight into `installedFonts`, via the `?seed=demo` test
 * hook.  It then measures all 13 families in one pass.  A gate that only runs
 * correctly on a fully provisioned paid machine is not a gate.
 *
 * ## What is measured
 *
 * `scrollWidth > clientWidth` on the name span — i.e. `truncate` is actually
 * eliding, which is what the owner sees as "the name is cut off".  Measured in
 * a real Electron window at the startup size (1280x820), not derived from
 * class names.
 *
 * NOTE ON FIDELITY: the family label is rendered in the family's OWN face, so
 * these widths are only meaningful when the real font files are present.  The
 * spec asserts that the faces actually loaded and fails loudly if they did not,
 * rather than passing on fallback-font measurements that would be optimistic —
 * a silent pass on the wrong metrics is exactly the failure this gate exists
 * to prevent.
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

async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ args: [INDEX_MAIN], timeout: 60_000 })
  const win = await app.firstWindow()
  await win.goto('file:///' + INDEX_HTML.replace(/\\/g, '/') + '?seed=demo&start=step2')
  await win.waitForFunction(() =>
    Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test),
  )
  return { app, win }
}

test('REQ-0344 §1 — every family name in the font popover fits its row', async () => {
  const { app, win } = await launch()
  try {
    const size = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    expect(size.w, 'startup content width').toBe(1280)
    expect(size.h, 'startup content height').toBe(820)

    // Inject the two conditions that otherwise reduce the list to one row.
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

    await win.waitForSelector('.overflow-y-auto.overflow-x-hidden')
    // Open the family popover — the first popover trigger in the inspector.
    await win.click('.overflow-y-auto.overflow-x-hidden button[aria-haspopup="dialog"]')
    await win.waitForSelector('[data-radix-popper-content-wrapper]')
    // Give the faces a moment to paint in their own family.
    await win.waitForTimeout(600)

    const rows: Measured[] = await win.evaluate(() => {
      const wrapper = document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper]')
      if (!wrapper) throw new Error('popover not open')
      return Array.from(wrapper.querySelectorAll<HTMLElement>('button')).map((btn) => {
        const name = btn.querySelector<HTMLElement>('span.truncate')
        if (!name) throw new Error('row has no name span')
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
          faceLoaded: document.fonts.check(`400 14px '${family}'`),
        }
      })
    })

    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `[REQ-0344 §1] ${r.label.padEnd(18)} scrollW=${String(r.nameScrollW).padStart(4)} ` +
        `clientW=${String(r.nameClientW).padStart(4)} ` +
        `over=${String(r.nameScrollW - r.nameClientW).padStart(4)} ` +
        `badges=[${r.badges.join(',')}] face=${r.faceLoaded}`,
      )
    }

    expect(rows.length, 'popover lists every family — injection worked').toBe(FAMILY_COUNT)

    // Fidelity guard: these widths only mean anything in the real faces.
    const unloaded = rows.filter((r) => !r.faceLoaded).map((r) => r.label)
    expect(
      unloaded,
      'families rendering in a FALLBACK face — widths would be optimistic and this ' +
      'gate would pass on metrics that are not the ones the user sees. Run ' +
      '`npm run build` and make sure the additional font set is installed.',
    ).toEqual([])

    const clipped = rows
      .filter((r) => r.nameScrollW > r.nameClientW)
      .map((r) => `${r.label} (${r.nameScrollW} > ${r.nameClientW})`)
    expect(clipped, 'family names elided by `truncate` in the popover list').toEqual([])

    // The row itself must not overflow either — a chip pushed past the popover
    // edge is the same defect one element out.
    const overflowing = rows
      .filter((r) => r.rowScrollW > r.rowClientW)
      .map((r) => `${r.label} (${r.rowScrollW} > ${r.rowClientW})`)
    expect(overflowing, 'popover rows wider than the popover').toEqual([])
  } finally {
    await app.close()
  }
})
