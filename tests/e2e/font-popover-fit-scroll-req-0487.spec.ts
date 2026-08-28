/**
 * REQ-0487 — the FamilyWeightSelector family popover, on the surface that
 * carries coverage chips (Settings ▸ Fonts section 1 / the setup drawer's
 * 文字スタイル tab), must:
 *
 *   §1  put every item on ONE line (name + EN/JA/rare-kanji chips) with NO
 *       horizontal scrollbar, in BOTH locales — English drives the width
 *       because "Rare kanji unsupported" ≫ 稀な漢字非対応, so a JA-only measure
 *       would pass while EN regressed;
 *   §2  scroll on the mouse wheel while open.  The list portals to <body>,
 *       OUTSIDE the settings-dialog's react-remove-scroll subtree, so without
 *       Popover `modal` the wheel is preventDefault-ed (arrow keys and
 *       scrollbar-drag still work — the reported asymmetry).  A SYNTHETIC
 *       wheel never scrolls anything, so this uses a real trusted
 *       `mouse.wheel`.
 *
 * Why this file and not font-popover-list-fit.spec.ts: that gate opens the
 * INSPECTOR popover (chips off) and the Settings section-2 family LIST — never
 * the section-1 selector popover WITH chips, which is exactly the surface
 * REQ-0487 fixed.  A gate that never opens the broken surface is how the two-
 * line wrap + dead wheel shipped.
 *
 * Faces are injected as installed + isMsix so all 13 families list (see
 * font-popover-list-fit.spec.ts for the full rationale on that injection).
 */
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { FONT_REGISTRY, getFontFamilies } from '../../src/shared/fonts'

const INDEX_MAIN = path.resolve(__dirname, '../../out/main/index.js')
const INDEX_HTML = path.resolve(__dirname, '../../out/renderer/index.html')
const ALL_FONT_IDS = FONT_REGISTRY.map((m) => m.id)
const FAMILY_COUNT = getFontFamilies().length

/** Single-line row height ceiling.  A two-line row (the pre-0487 layout) was
 *  ~59 px; a single line is ~36.  44 leaves headroom without admitting a wrap. */
const ONE_LINE_MAX_H = 44

async function launch(lang: 'ja' | 'en'): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ args: [INDEX_MAIN], timeout: 60_000 })
  const win = await app.firstWindow()
  await win.goto('file:///' + INDEX_HTML.replace(/\\/g, '/') + '?seed=demo&start=step2')
  await win.waitForFunction(() => Boolean((window as unknown as { __mojioko_test?: unknown }).__mojioko_test))
  await win.evaluate(({ ids, lang }) => {
    const t = (window as unknown as {
      __mojioko_test: {
        ui: { setState: (s: unknown) => void }
        appEnv: { setState: (s: unknown) => void }
        installedFonts: { setState: (s: unknown) => void }
        i18n: { changeLanguage: (l: string) => void }
      }
    }).__mojioko_test
    t.appEnv.setState({ isMsix: true })
    t.installedFonts.setState({ ids: new Set(ids), loadedCount: 1 })
    t.i18n.changeLanguage(lang)
    t.ui.setState({ isSettingsDialogOpen: true })
  }, { ids: ALL_FONT_IDS, lang })
  await win.waitForSelector('[role="dialog"]')
  await win.click('[role="tab"][id$="-trigger-fonts"]')
  await win.waitForTimeout(300)
  // Section-1 FamilyWeightSelector family trigger = first popover trigger.
  await win.locator('[role="dialog"] button[aria-haspopup="dialog"]').first().click()
  await win.waitForSelector('[data-radix-popper-content-wrapper]')
  await win.waitForTimeout(600) // faces paint in their own family
  return { app, win }
}

for (const lang of ['ja', 'en'] as const) {
  test(`REQ-0487 §1 — family popover items are one line, no h-scroll (${lang})`, async () => {
    const { app, win } = await launch(lang)
    try {
      const m = await win.evaluate(() => {
        const wrap = document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper]')
        const content = wrap?.querySelector<HTMLElement>('[class*="overflow-y-auto"]')
        if (!content) throw new Error('popover scroll container not found')
        const rows = Array.from(content.querySelectorAll<HTMLElement>('button'))
        return {
          hScroll: content.scrollWidth - content.clientWidth,
          overflowX: getComputedStyle(content).overflowX,
          rows: rows.map((b) => {
            const name = b.querySelector<HTMLElement>('span.truncate')
            return {
              label: b.textContent?.trim() ?? '',
              h: b.clientHeight,
              rowOverflow: b.scrollWidth - b.clientWidth,
              nameClipped: name ? name.scrollWidth - name.clientWidth : 0,
              badges: b.querySelectorAll('[data-font-badge]').length,
            }
          }),
        }
      })

      expect(m.rows.length, 'lists every family — injection worked').toBe(FAMILY_COUNT)
      // §1 no horizontal scrollbar.
      expect(m.hScroll, `no horizontal scroll (overflowX=${m.overflowX})`).toBeLessThanOrEqual(1)
      // §1 every row a single line, nothing clipped, chips present.
      const twoLine = m.rows.filter((r) => r.h > ONE_LINE_MAX_H).map((r) => `${r.label} h=${r.h}`)
      expect(twoLine, 'rows that wrapped to 2 lines').toEqual([])
      const overflow = m.rows.filter((r) => r.rowOverflow > 1).map((r) => `${r.label} +${r.rowOverflow}`)
      expect(overflow, 'rows wider than the panel').toEqual([])
      const clipped = m.rows.filter((r) => r.nameClipped > 1).map((r) => `${r.label} +${r.nameClipped}`)
      expect(clipped, 'family names elided by truncate').toEqual([])
      // The chips are the whole reason this surface is wide — they must survive.
      expect(m.rows.some((r) => r.badges > 0), 'coverage chips present on this surface').toBe(true)
    } finally {
      await app.close()
    }
  })
}

test('REQ-0487 §2 — the open family list scrolls on the mouse wheel', async () => {
  const { app, win } = await launch('ja')
  try {
    // Single-line rows fit at the 820 px min window, so force an overflow to
    // have something to scroll, then drive a REAL (trusted) wheel.
    const rect = await win.evaluate(async () => {
      const wrap = document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper]')
      const content = wrap?.querySelector<HTMLElement>('[class*="overflow-y-auto"]')
      if (!content) throw new Error('popover scroll container not found')
      content.style.maxHeight = '150px'
      await new Promise((r) => setTimeout(r, 40))
      const r = content.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height, before: content.scrollTop, canScroll: content.scrollHeight > content.clientHeight }
    })
    expect(rect.canScroll, 'forced overflow so there is something to scroll').toBe(true)

    await win.mouse.move(rect.x + rect.w / 2, rect.y + rect.h / 2)
    await win.mouse.wheel(0, 300)
    await win.waitForTimeout(150)

    const after = await win.evaluate(() => {
      const wrap = document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper]')
      const content = wrap?.querySelector<HTMLElement>('[class*="overflow-y-auto"]')
      return content?.scrollTop ?? -1
    })
    // Without Popover `modal` this stays 0 (the dialog's RemoveScroll eats the
    // wheel); with it, the wheel scrolls the list.
    expect(after, `wheel moved scrollTop (${rect.before} -> ${after})`).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})
