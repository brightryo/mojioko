import { describe, it, expect } from 'vitest'
import { applyFontPolicy } from '../../src/shared/font-tier'
import { DEFAULT_FONT_ID, type FontId } from '../../src/shared/fonts'
import { detectFontSubstitutions } from '../../src/main/cli/no-op-warnings'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-0509 — a font whose file is not on disk must cost that cue its typeface,
 * not the whole render.
 *
 * Measured before the fix (paid tier, `anton` directory moved aside):
 * `mojioko burn` and `mojioko export_frame` both returned
 * `BURN_FAILED` / **exit 7** with no output file, from `stageFontsDir`'s
 * `copyFile` ENOENT. The pixel proof that it now completes lives in
 * `cli-smoke`; this file pins the policy, the reason split, and the warning.
 */

const cue = (over: Partial<SubtitleEntry> = {}): SubtitleEntry => ({
  id: over.id ?? 'c1',
  startSec: 0,
  endSec: 1,
  text: 'hello',
  ...over,
}) as SubtitleEntry

/** Everything present except the ids listed. */
const allBut = (...missing: FontId[]) => (id: FontId): boolean => !missing.includes(id)
const ALL_INSTALLED = (): boolean => true

const PAID = { tier: 'paid', isPaid: true, source: 'msix' } as const
const FREE = { tier: 'free', isPaid: false, source: 'not-packaged' } as const

describe('REQ-0509 §1-2 — a missing font is substituted, not fatal', () => {
  it('paid tier, missing paid font → DEFAULT_FONT_ID, reason "missing"', () => {
    const r = applyFontPolicy({
      isPaid: true,
      isInstalled: allBut('anton'),
      defaultFontId: DEFAULT_FONT_ID,
      entries: [cue({ fontId: 'anton' })],
    })
    expect(r.entries[0].fontId).toBe(DEFAULT_FONT_ID)
    expect(r.substitutions).toEqual([
      { from: 'anton', to: DEFAULT_FONT_ID, cueCount: 1, reason: 'missing' },
    ])
  })

  it('the project DEFAULT font can be the missing one', () => {
    const r = applyFontPolicy({
      isPaid: true,
      isInstalled: allBut('dela-gothic-one'),
      defaultFontId: 'dela-gothic-one',
      entries: [cue()],
    })
    expect(r.defaultFontId).toBe(DEFAULT_FONT_ID)
    expect(r.defaultSubstituted).toBe(true)
  })

  it('a missing BUNDLED weight is handled too (damaged install, not a download)', () => {
    // Bundled fonts can go missing if the installer payload is incomplete.
    // Before REQ-0509 this was equally fatal.
    const r = applyFontPolicy({
      isPaid: true,
      isInstalled: allBut('noto-sans-jp-black'),
      defaultFontId: DEFAULT_FONT_ID,
      entries: [cue({ fontId: 'noto-sans-jp-black' })],
    })
    expect(r.entries[0].fontId).not.toBe('noto-sans-jp-black')
    expect(r.substitutions[0].reason).toBe('missing')
  })

  it('§1-2 keeps the REQ-0508 split: WEIGHT-matching is for tier only', () => {
    // `poppins-bold` (700) missing in the PAID tier must NOT become Noto Bold —
    // that ladder step belongs to tier rejections, where the substitute is
    // permanent. A missing download is temporary, so it lands on the default.
    const missing = applyFontPolicy({
      isPaid: true,
      isInstalled: allBut(...(['poppins-bold', 'poppins', 'poppins-thin', 'poppins-extralight',
        'poppins-light', 'poppins-medium', 'poppins-semibold', 'poppins-extrabold',
        'poppins-black'] as FontId[])),
      defaultFontId: DEFAULT_FONT_ID,
      entries: [cue({ fontId: 'poppins-bold' })],
    })
    expect(missing.entries[0].fontId).toBe(DEFAULT_FONT_ID)

    // Same font, rejected by TIER instead: weight-matched, per REQ-0508 §1-2.
    const tiered = applyFontPolicy({
      isPaid: false,
      isInstalled: ALL_INSTALLED,
      defaultFontId: DEFAULT_FONT_ID,
      entries: [cue({ fontId: 'poppins-bold' })],
    })
    expect(tiered.entries[0].fontId).toBe('noto-sans-jp-bold')
  })

  it('§1-4 keeps the ladder: an installed same-family weight wins over Noto', () => {
    // Pre-existing REQ-0269 D-1 behaviour, still what the renderer does. The
    // substitute is "Poppins at a weight you have", not "not Poppins at all".
    const r = applyFontPolicy({
      isPaid: true,
      isInstalled: allBut('poppins-bold'),
      defaultFontId: DEFAULT_FONT_ID,
      entries: [cue({ fontId: 'poppins-bold' })],
    })
    expect(r.entries[0].fontId).toBe('poppins-semibold')
  })

  it('nothing missing, paid tier → no substitution at all', () => {
    const entries = [cue({ fontId: 'anton' })]
    const r = applyFontPolicy({ isPaid: true, isInstalled: ALL_INSTALLED, defaultFontId: DEFAULT_FONT_ID, entries })
    expect(r.substitutions).toEqual([])
    expect(r.entries[0]).toBe(entries[0])
  })
})

describe('REQ-0509 §1-3 — tier and missing never double-report one cue', () => {
  it('free tier + paid font that is ALSO missing → one substitution, reason "tier"', () => {
    // Both conditions hold. Downloading would not make it usable in a free
    // build, so "buy the paid edition" is the only remedy that leads anywhere.
    const r = applyFontPolicy({
      isPaid: false,
      isInstalled: allBut('anton'),
      defaultFontId: DEFAULT_FONT_ID,
      entries: [cue({ fontId: 'anton' })],
    })
    expect(r.substitutions).toHaveLength(1)
    expect(r.substitutions[0].reason).toBe('tier')
    expect(r.entries[0].fontId).toBe('noto-sans-jp-regular')
  })

  it('the same cue produces exactly one WARNING, not two', () => {
    const w = detectFontSubstitutions([cue({ fontId: 'anton' })], DEFAULT_FONT_ID, FREE, allBut('anton'))
    expect(w.map((x) => x.code)).toEqual(['FONT_TIER_SUBSTITUTED'])
  })

  it('a burn hitting BOTH causes on DIFFERENT cues reports both, separately', () => {
    const w = detectFontSubstitutions(
      [cue({ id: 'a', fontId: 'anton' }), cue({ id: 'b', fontId: 'noto-sans-jp-black' })],
      DEFAULT_FONT_ID,
      FREE,
      allBut('noto-sans-jp-black'),
    )
    expect(w.map((x) => x.code).sort()).toEqual(['FONT_TIER_SUBSTITUTED', 'FONT_UNAVAILABLE'])
    // Each warning counts only its own cues — 1 and 1, not 2 and 2.
    for (const x of w) expect((x.detail as Record<string, unknown>).substitutedCueCount).toBe(1)
  })
})

describe('REQ-0509 §2 — the FONT_UNAVAILABLE warning', () => {
  it('names the font, the substitute, the cue count and the reason', () => {
    const w = detectFontSubstitutions([cue({ fontId: 'anton' })], DEFAULT_FONT_ID, PAID, allBut('anton'))
    expect(w).toHaveLength(1)
    expect(w[0].code).toBe('FONT_UNAVAILABLE')
    expect(w[0].message).toContain('Anton')
    expect(w[0].message).toContain('見つからない')
    const detail = w[0].detail as Record<string, unknown>
    expect(detail.substitutedCueCount).toBe(1)
    expect(detail.substitutions).toEqual([
      { from: 'anton', fromName: 'Anton', to: DEFAULT_FONT_ID, toName: 'Noto Sans JP SemiBold', cueCount: 1 },
    ])
  })

  it('§2-4 the remedy is something the user can act on, and names the id', () => {
    const w = detectFontSubstitutions([cue({ fontId: 'anton' })], DEFAULT_FONT_ID, PAID, allBut('anton'))
    const remedy = String((w[0].detail as Record<string, unknown>).remedy)
    expect(remedy).toContain('ダウンロード')
    // The display name ("Anton") is not what the download row is keyed by.
    expect(remedy).toContain('anton')
    // ...and it must NOT be the tier remedy: nothing here is for sale.
    expect(remedy).not.toContain('有料版')
  })

  it('§3-2 does NOT fire when every font is present', () => {
    expect(detectFontSubstitutions([cue({ fontId: 'anton' })], DEFAULT_FONT_ID, PAID, ALL_INSTALLED)).toEqual([])
  })

  it('the two codes carry DIFFERENT remedies (§2-2: different causes, different fixes)', () => {
    const missing = detectFontSubstitutions([cue({ fontId: 'anton' })], DEFAULT_FONT_ID, PAID, allBut('anton'))
    const tiered = detectFontSubstitutions([cue({ fontId: 'anton' })], DEFAULT_FONT_ID, FREE, ALL_INSTALLED)
    const remedyOf = (w: typeof missing): string => String((w[0].detail as Record<string, unknown>).remedy)
    expect(remedyOf(missing)).not.toBe(remedyOf(tiered))
    expect(remedyOf(tiered)).toContain('有料版')
  })

  it('deleted cues do not raise it (the warning describes visible output)', () => {
    expect(
      detectFontSubstitutions([cue({ fontId: 'anton', isDeleted: true })], DEFAULT_FONT_ID, PAID, allBut('anton')),
    ).toEqual([])
  })
})

describe('REQ-0509 §1-5 — the bundled fallback itself missing', () => {
  it('terminates instead of searching forever, and returns DEFAULT_FONT_ID', () => {
    // Nothing at all on disk. The ladder's last step is unconditional, so this
    // returns the default and lets `stageFontsDir` throw — the honest outcome
    // when there is no font left to render with. What it must NOT do is loop.
    const r = applyFontPolicy({
      isPaid: true,
      isInstalled: () => false,
      defaultFontId: 'anton',
      entries: [cue({ fontId: 'poppins-bold' })],
    })
    expect(r.defaultFontId).toBe(DEFAULT_FONT_ID)
    expect(r.entries[0].fontId).toBe(DEFAULT_FONT_ID)
  })
})
