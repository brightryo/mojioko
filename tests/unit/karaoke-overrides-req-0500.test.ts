import { describe, it, expect } from 'vitest'
import {
  applyStyleOverrides,
  isEmptyStyleOverrides,
  parseStyleOverrides,
  type StyleOverrides,
} from '../../src/main/cli/style-overrides'
import { summarizeSubtitleStyle } from '../../src/main/cli/subtitle-style'
import { CliError } from '../../src/main/cli/output'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-0500 §2 — karaoke must be controllable from a headless run.
 *
 * Cues seeded from `TranscriptionDefaults` inherit `karaokeEnabled` from the app
 * settings, so on a karaoke-ON machine EVERY CLI/MCP burn came out with a sweep
 * and no flag could remove it (RES-0498 proved it in real pixels: the highlight
 * colour was present in the exported frame). The only escape was a saved preset
 * with karaoke off — which cannot be authored headlessly. That made it a defect.
 *
 * The real-pixel proof lives in `verify:cli-smoke` (highlight-colour pixel count
 * must drop to zero with `--karaoke off`). These are the cheap invariants.
 */

const FONT = 'noto-sans-jp-semibold' as const

function cue(over: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base = {
    startSec: 0, endSec: 1, text: 'hello', fadeDurationSec: 0,
    fontSizePx: 100, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
    outlineThicknessPx: 4, horizontalPosition: 'center' as const,
    verticalPosition: 'bottom' as const, verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black' as const, opacityPercent: 50 },
  }
  return { id: 'a', isDeleted: false, isEdited: false, ...base, ...over, original: { ...base } } as SubtitleEntry
}

describe('REQ-0500 §2 — karaoke override flags', () => {
  it('--karaoke off turns karaoke OFF on a cue that inherited it ON', () => {
    const ov = parseStyleOverrides({ karaoke: 'off' }, FONT)
    expect(ov.karaokeEnabled).toBe(false)
    const [out] = applyStyleOverrides([cue({ karaokeEnabled: true })], ov)
    expect(out.karaokeEnabled).toBe(false)
    // The whole point: the resolved summary an agent reads must agree.
    expect(summarizeSubtitleStyle(out, true).karaoke.enabled).toBe(false)
  })

  it('--karaoke on turns it ON', () => {
    const [out] = applyStyleOverrides([cue({ karaokeEnabled: false })], parseStyleOverrides({ karaoke: 'on' }, FONT))
    expect(out.karaokeEnabled).toBe(true)
  })

  it('--karaoke-color and --karaoke-style land on every cue', () => {
    const ov = parseStyleOverrides({ 'karaoke-color': '#FF00FF', 'karaoke-style': 'switch' }, FONT)
    const out = applyStyleOverrides([cue(), cue({ id: 'b' })], ov)
    for (const e of out) {
      expect(e.karaokeHighlightColor).toBe('#FF00FF')
      expect(e.karaokeStyle).toBe('switch')
    }
  })

  it('omitting the flags leaves the cue untouched (KARAOKE_STYLE_DEFAULT fallback intact)', () => {
    // REQ-0500 §2-5 — an omitted flag must not write a value, or every headless
    // burn would freeze today's default into the file.
    const ov = parseStyleOverrides({}, FONT)
    expect(ov.karaokeEnabled).toBeUndefined()
    expect(ov.karaokeStyle).toBeUndefined()
    const before = cue({ karaokeEnabled: true })
    const [after] = applyStyleOverrides([before], ov)
    expect(after.karaokeStyle).toBeUndefined()
    expect(summarizeSubtitleStyle(after, true).karaoke.style).toBe('sweep')
  })

  it.each([
    ['karaoke', 'yes'],
    ['karaoke-style', 'fade'],
    ['karaoke-color', 'magenta'],
  ])('rejects a malformed --%s (USAGE, not a silent ignore)', (key, value) => {
    expect(() => parseStyleOverrides({ [key]: value }, FONT)).toThrow(CliError)
  })

  it('deleted cues are skipped, as with every other override', () => {
    const [out] = applyStyleOverrides([cue({ isDeleted: true, karaokeEnabled: true })], parseStyleOverrides({ karaoke: 'off' }, FONT))
    expect(out.karaokeEnabled).toBe(true)
  })

  /**
   * ★ Negative control for `isEmptyStyleOverrides`.
   *
   * The old hand-listed chain silently ignored any field added to the interface
   * without a matching clause — exactly the optional-field-plus-manual-list trap
   * that `style-defaults-to-entry.ts` documents four instances of. If the karaoke
   * fields were not counted, a karaoke-only invocation would take the
   * "no overrides at all" early return and `--karaoke off` would do NOTHING while
   * still reporting success.
   */
  it('karaoke-only overrides are not treated as "empty" (negative control)', () => {
    expect(isEmptyStyleOverrides({})).toBe(true)
    for (const ov of [
      { karaokeEnabled: false },
      { karaokeHighlightColor: '#FF00FF' },
      { karaokeStyle: 'switch' as const },
    ] satisfies StyleOverrides[]) {
      expect(isEmptyStyleOverrides(ov), JSON.stringify(ov)).toBe(false)
      // ...and the apply must actually change the cue, not early-return it.
      const [out] = applyStyleOverrides([cue({ karaokeEnabled: true })], ov)
      expect(out).not.toBe(undefined)
      expect(JSON.stringify(out)).not.toBe(JSON.stringify(cue({ karaokeEnabled: true })))
    }
  })
})
