/**
 * REQ-0341 §1 → REQ-0348 §1 — the inspector's font trigger shows a family
 * NAME, in full, and nothing else.
 *
 * ## What this file has been for, and what it is for now
 *
 * REQ-0341 added coverage chips (EN / JA / rare-kanji) to this trigger and
 * used this gate to prove they did not cost the family name.  The hazard it
 * was written against is real and still here: the trigger sits in `StyleRow`'s
 * control column inside an `overflow-x-hidden` wrapper, so a cluster that
 * declares more width than the column does NOT produce a scrollbar — it is
 * silently CLIPPED, with nothing on screen to say so.  Same trap as
 * `inspector-opacity-fit` (REQ-0311 §1) and `inspector-karaoke-row-fit`
 * (REQ-0336 §2-7).
 *
 * REQ-0348 §1 removed the chips from this surface: the owner decided a font
 * menu should read like every other editor's — names only — and kept the chips
 * on Settings ▸ Fonts, where fonts are compared rather than picked mid-edit.
 *
 * So the gate is repointed rather than deleted.  It now asserts BOTH halves of
 * that decision, which together are stronger than what it checked before:
 *
 *   1. the trigger carries NO badge at all, so a future change cannot quietly
 *      put them back on the editing surface, and
 *   2. the family name is still not truncated — the property this file has
 *      always existed to defend, and which stays worth measuring because the
 *      column is 182.7 px at the startup window size (1280x820, right pane
 *      367 px), not the 224 px basis the classes suggest.
 *
 * Measured in a real window, not derived from class names.  The chips'
 * surviving home is covered by `font-popover-list-fit.spec.ts`.
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'

const INDEX_MAIN = path.resolve(__dirname, '../../out/main/index.js')
const INDEX_HTML = path.resolve(__dirname, '../../out/renderer/index.html')

/**
 * The same four families REQ-0341 used, chosen because they covered all three
 * chip states — EN-only, rare-kanji, and neither.  They are kept precisely
 * because they used to differ here: if any of them still renders a chip, the
 * removal was partial.
 */
const CASES = ['noto-sans-jp-semibold', 'anton', 'hachi-maru-pop', 'potta-one']

interface TestApi {
  project: {
    getState: () => { entries: { id: string }[]; updateEntry: (id: string, patch: unknown) => void }
  }
  ui: { setState: (s: unknown) => void }
}

async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ args: [INDEX_MAIN], timeout: 60_000 })
  const win = await app.firstWindow()
  await win.goto('file:///' + INDEX_HTML.replace(/\\/g, '/') + '?seed=demo&start=step2')
  await win.waitForFunction(() =>
    Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test),
  )
  await win.evaluate(() => {
    const t = (window as unknown as { __mojioko_test: TestApi }).__mojioko_test
    const first = t.project.getState().entries[0]
    t.ui.setState({ selectedRowIds: new Set<string>(), selectedEntryId: first.id })
  })
  await win.waitForSelector('.overflow-y-auto.overflow-x-hidden')
  return { app, win }
}

test('REQ-0348 §1 — the font trigger shows the family name alone, unclipped', async () => {
  const { app, win } = await launch()
  try {
    const size = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    expect(size.w, 'startup content width').toBe(1280)
    expect(size.h, 'startup content height').toBe(820)

    for (const fontId of CASES) {
      await win.evaluate((id) => {
        const t = (window as unknown as { __mojioko_test: TestApi }).__mojioko_test
        const st = t.project.getState()
        st.updateEntry(st.entries[0].id, { fontId: id })
      }, fontId)
      await win.waitForTimeout(250)

      const p = await win.evaluate(() => {
        const wrapper = document.querySelector<HTMLElement>('.overflow-y-auto.overflow-x-hidden')
        if (!wrapper) throw new Error('inspector scroll wrapper not found')
        const visibleRight = wrapper.getBoundingClientRect().left + wrapper.clientWidth
        // Locate the family trigger STRUCTURALLY — first popover trigger in
        // the inspector — rather than by an i18n string.
        const trigger = Array.from(
          wrapper.querySelectorAll<HTMLElement>('button[aria-haspopup="dialog"]'),
        )[0]
        if (!trigger) throw new Error('family trigger not found')
        const name = trigger.querySelector<HTMLElement>('span.truncate')
        if (!name) throw new Error('family name span not found')
        const tRect = trigger.getBoundingClientRect()
        return {
          wrapperClientW: wrapper.clientWidth,
          wrapperScrollW: wrapper.scrollWidth,
          controlColW: (trigger.parentElement as HTMLElement).getBoundingClientRect().width,
          triggerW: tRect.width,
          overhangPx: tRect.right - visibleRight,
          nameText: name.textContent ?? '',
          nameScrollW: name.scrollWidth,
          nameClientW: name.clientWidth,
          badges: Array.from(trigger.querySelectorAll<HTMLElement>('[data-font-badge]')).map(
            (b) => b.getAttribute('data-font-badge') ?? '',
          ),
        }
      })

      // eslint-disable-next-line no-console
      console.log(`[REQ-0348 §1 trigger] ${fontId}:`, JSON.stringify(p))

      // REQ-0348 §1 — the editing surface carries no coverage vocabulary.
      expect(p.badges, `${fontId}: trigger must show no badges`).toEqual([])
      expect(
        p.overhangPx,
        `${fontId}: trigger clipped by overflow-x-hidden (overhang ${p.overhangPx.toFixed(1)}px)`,
      ).toBeLessThanOrEqual(0)
      expect(
        p.wrapperScrollW,
        `${fontId}: inspector gained horizontal overflow`,
      ).toBeLessThanOrEqual(p.wrapperClientW)
      // The property this file has always defended.
      expect(
        p.nameScrollW,
        `${fontId}: family name truncated ("${p.nameText}": ` +
          `scrollW ${p.nameScrollW} > clientW ${p.nameClientW})`,
      ).toBeLessThanOrEqual(p.nameClientW)
    }
  } finally {
    await app.close()
  }
})
