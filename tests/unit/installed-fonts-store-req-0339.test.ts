import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { resolveRenderableFontId, DEFAULT_FONT_ID, type FontId } from '../../src/shared/fonts'

/**
 * REQ-0339 §2 — the installed-font set must be APP-GLOBAL, not per-component.
 *
 * `useInstalledFontIds` used to hold the set in its own `useState` and fill it
 * from a `useEffect`.  Every consumer therefore began life with an EMPTY set,
 * and `SubtitleOverlay` feeds that set to `resolveRenderableFontId`, which
 * reads "empty" as "nothing is installed" and falls back to `DEFAULT_FONT_ID`.
 * Because `video-preview-panel` keys overlays by `entry.id`, a cue mounts fresh
 * every time it becomes visible — so every subtitle painted its first frame in
 * the wrong font.  Measured against the real component in a real Electron
 * window (first commit forced with `flushSync`): 2.26–2.53× the settled text
 * width for the Poppins weights, 2.47× for Bebas Neue, 1.80× for Montserrat.
 *
 * These tests pin the two halves of the cure: the value is fetched once and is
 * then readable SYNCHRONOUSLY, and the hook does not reintroduce local state.
 */

const listFonts = vi.fn()
vi.mock('@/services/font', () => ({ listFonts: () => listFonts() }))

const REPO = join(__dirname, '../..')

function fontsResult(ids: string[]) {
  return {
    ok: true as const,
    data: {
      fonts: ids.map((id) => ({ id, status: 'installed' })),
    },
  }
}

describe('REQ-0339 §2 — installed fonts are resolved once, app-wide', () => {
  beforeEach(() => {
    listFonts.mockReset()
  })

  it('an empty set makes resolveRenderableFontId collapse to the default — the reason this matters', () => {
    const requested: FontId = 'poppins'
    const collapsed = resolveRenderableFontId(requested, () => false, () => true)
    expect(collapsed).toBe(DEFAULT_FONT_ID)
    // …and with the same font known to be installed it resolves to itself.
    const correct = resolveRenderableFontId(requested, (id) => id === requested, () => true)
    expect(correct).toBe(requested)
  })

  it('is readable synchronously after one refresh, and one version costs one IPC', async () => {
    const { refreshInstalledFonts, getInstalledFontIds } =
      await import('@/stores/installed-fonts-store')

    listFonts.mockResolvedValue(fontsResult(['poppins', 'montserrat']))
    await refreshInstalledFonts(0)

    // The point of the whole exercise: a consumer mounting NOW gets the truth
    // without waiting for anything.
    expect(getInstalledFontIds().has('poppins' as FontId)).toBe(true)
    expect(getInstalledFontIds().has('montserrat' as FontId)).toBe(true)
    expect(listFonts).toHaveBeenCalledTimes(1)

    // N consumers calling from their own effects must not fan out into N IPCs.
    await refreshInstalledFonts(0)
    await refreshInstalledFonts(0)
    expect(listFonts).toHaveBeenCalledTimes(1)

    // A `fontInventoryVersion` bump (download / uninstall) still refetches.
    listFonts.mockResolvedValue(fontsResult(['poppins']))
    await refreshInstalledFonts(1)
    expect(listFonts).toHaveBeenCalledTimes(2)
    expect(getInstalledFontIds().has('montserrat' as FontId)).toBe(false)
  })

  it('the hook does not reintroduce component-local state for the set', () => {
    const src = readFileSync(join(REPO, 'src/renderer/lib/use-installed-fonts.ts'), 'utf8')
    // `useState` here is the regression itself: it restarts from an empty set
    // on every mount.  The set belongs to the store.
    // A CALL, so the prose in the header explaining the old shape is fine.
    expect(src).not.toMatch(/useState\s*[<(]/)
    expect(src).toMatch(/installed-fonts-store/)
  })
})
