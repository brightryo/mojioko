/**
 * REQ-0341 §1 — the font selector's trigger now carries coverage badges, and
 * it sits in `StyleRow`'s control column inside an `overflow-x-hidden`
 * wrapper.  Same hazard as `inspector-opacity-fit` (REQ-0311 §1) and
 * `inspector-karaoke-row-fit` (REQ-0336 §2-7): a control cluster that
 * declares more width than the column does NOT produce a scrollbar — it is
 * silently CLIPPED, with nothing on screen to say so.
 *
 * The badge is a warning about tofu, so clipping it is worse than not having
 * it: the user would see a truncated family name AND no warning.
 *
 * Measured here, not derived from the class names.  At the startup window
 * size (1280x820, main/index.ts — startup == minimum) the right pane is
 * 367px and the control column resolves to **182.7px**, not the 224px basis.
 *
 * This gate is why the trigger shows only the ACTIONABLE chips: with EN + JA
 * + rare-kanji all present, "Hachi Maru Pop" was measured collapsing to 54px
 * of the 119px it needs.  The rule is pinned in
 * `tests/unit/font-family-badges-req-0341.test.ts`; this file proves the
 * result actually fits real pixels.
 *
 * Kept as a permanent gate rather than deleted as a one-off measurement: the
 * next chip added to a font row needs exactly this check (CLAUDE.md §18).
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'

const INDEX_MAIN = path.resolve(__dirname, '../../out/main/index.js')
const INDEX_HTML = path.resolve(__dirname, '../../out/renderer/index.html')

/** Families chosen to cover all three trigger states. */
const CASES = [
  { fontId: 'noto-sans-jp-semibold', expectBadges: [] as string[] },
  { fontId: 'anton', expectBadges: ['lang-en'] },
  { fontId: 'hachi-maru-pop', expectBadges: ['rare-kanji'] },
  { fontId: 'potta-one', expectBadges: ['rare-kanji'] },
]

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

test('REQ-0341 §1 — the font trigger shows its warning badges without clipping the family name', async () => {
  const { app, win } = await launch()
  try {
    const size = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    expect(size.w, 'startup content width').toBe(1280)
    expect(size.h, 'startup content height').toBe(820)

    for (const c of CASES) {
      await win.evaluate((id) => {
        const t = (window as unknown as { __mojioko_test: TestApi }).__mojioko_test
        const st = t.project.getState()
        st.updateEntry(st.entries[0].id, { fontId: id })
      }, c.fontId)
      await win.waitForTimeout(250)

      const p = await win.evaluate(() => {
        const wrapper = document.querySelector<HTMLElement>('.overflow-y-auto.overflow-x-hidden')
        if (!wrapper) throw new Error('inspector scroll wrapper not found')
        const visibleRight = wrapper.getBoundingClientRect().left + wrapper.clientWidth
        // Locate the family trigger STRUCTURALLY: the first button in the
        // inspector that renders a font face on a truncating label inside a
        // popover trigger.  Falls back to the badge when one is present.
        const triggers = Array.from(
          wrapper.querySelectorAll<HTMLElement>('button[aria-haspopup="dialog"]'),
        )
        const trigger = triggers[0]
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
      console.log(`[REQ-0341 §1] ${c.fontId}:`, JSON.stringify(p))

      expect(p.badges, `${c.fontId} trigger badges`).toEqual(c.expectBadges)
      expect(
        p.overhangPx,
        `${c.fontId}: trigger clipped by overflow-x-hidden (overhang ${p.overhangPx.toFixed(1)}px)`,
      ).toBeLessThanOrEqual(0)
      expect(
        p.wrapperScrollW,
        `${c.fontId}: inspector gained horizontal overflow`,
      ).toBeLessThanOrEqual(p.wrapperClientW)
      // The whole point: the badge must not cost the user the family name.
      expect(
        p.nameScrollW,
        `${c.fontId}: family name truncated ("${p.nameText}": ` +
          `scrollW ${p.nameScrollW} > clientW ${p.nameClientW})`,
      ).toBeLessThanOrEqual(p.nameClientW)
    }
  } finally {
    await app.close()
  }
})
