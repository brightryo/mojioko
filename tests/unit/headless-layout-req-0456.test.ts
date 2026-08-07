import { describe, it, expect } from 'vitest'
import type { SubtitleEntry } from '../../src/shared/types'
import type { LineBreakMetrics } from '../../src/shared/line-break-core'
import {
  autoLineBreakEntries,
  autoLineBreakTranscribedEntries,
  applyVerticalOverflowGuard,
  layoutForBurn,
  type LayoutOptions,
} from '../../src/main/services/headless-layout'

/**
 * REQ-0456 — headless auto line-break + vertical overflow guard.
 *
 * Uses the character-class fallback metrics (`font: null`) via the injectable
 * `metricsFor`, so the test needs no font files and no Electron.  With
 * `FALLBACK_LIBASS_SCALE = 0.6906`, a wide (CJK) glyph measures
 * `fontSizePx × 0.6906`; at `fontSizePx = 100` that is 69.06px per「あ」.
 */
const FALLBACK: LineBreakMetrics = { font: null, libassScale: 0.6906, cmap: null, tofu: null }
const metricsFor = (): LineBreakMetrics => FALLBACK

function makeEntry(patch: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const text = patch.text ?? 'あ'
  const base = {
    id: 'e1',
    startSec: 0,
    endSec: 2,
    text,
    fontSizePx: 100,
    textColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    outlineThicknessPx: 0,
    fadeDurationSec: 0,
    horizontalPosition: 'center',
    verticalPosition: 'bottom',
    verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    isDeleted: false,
    isEdited: false,
    keywordEmphasisEnabled: false,
    ...patch,
  }
  return {
    ...base,
    original: { ...base, subtitleBackground: { ...base.subtitleBackground } },
  } as unknown as SubtitleEntry
}

/** Narrow frame so「あ」×N wraps: effective width 400 − 20 = 380 ⇒ 5 glyphs/line (5·69=345 ≤ 380 < 6·69). */
function opts(patch: Partial<LayoutOptions> = {}): LayoutOptions {
  return {
    videoWidthPx: 400,
    videoHeightPx: 100000,
    marginLrPx: 10,
    marginYPx: 0,
    emphasisTierAllowed: false,
    metricsFor,
    ...patch,
  }
}

describe('REQ-0456 — autoLineBreakEntries (horizontal)', () => {
  it('wraps a long single-line CJK cue so no line exceeds the effective width', () => {
    const [out] = autoLineBreakEntries([makeEntry({ text: 'あ'.repeat(20) })], opts())
    expect(out.text).toContain('\\N')
    const lines = out.text.split('\\N')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(line.length).toBeGreaterThanOrEqual(1)
      expect(line.length).toBeLessThanOrEqual(5) // 5 wide glyphs fit in 380px
    }
  })

  it('leaves a cue that already fits unchanged (same reference)', () => {
    const e = makeEntry({ text: 'あい' })
    const [out] = autoLineBreakEntries([e], opts())
    expect(out).toBe(e)
    expect(out.text).toBe('あい')
  })

  it('never touches a deleted cue', () => {
    const e = makeEntry({ text: 'あ'.repeat(30), isDeleted: true })
    const [out] = autoLineBreakEntries([e], opts())
    expect(out).toBe(e)
    expect(out.text).not.toContain('\\N')
  })

  it('preserves existing \\N (idempotent on a second pass)', () => {
    const once = autoLineBreakEntries([makeEntry({ text: 'あ'.repeat(20) })], opts())
    const twice = autoLineBreakEntries(once, opts())
    expect(twice[0].text).toBe(once[0].text)
  })

  it('transcribed helper mirrors the break into original.text', () => {
    const [out] = autoLineBreakTranscribedEntries([makeEntry({ text: 'あ'.repeat(20) })], opts())
    expect(out.text).toContain('\\N')
    expect(out.original.text).toBe(out.text)
  })
})

describe('REQ-0456 — vertical overflow guard', () => {
  // A cue that wraps to many lines: 「あ」×60 at width 400 ⇒ 12 lines × 100px ≈ 1200px,
  // which exceeds a 1080px frame (budget 1080 − 2·10 = 1060).
  const tall = () => makeEntry({ text: 'あ'.repeat(60) })
  const frame = (): LayoutOptions => opts({ videoHeightPx: 1080, marginYPx: 10, videoWidthPx: 400 })

  it('warn: counts the overflowing cue but leaves it unchanged', () => {
    const wrapped = autoLineBreakEntries([tall()], frame())
    const r = applyVerticalOverflowGuard(wrapped, 'warn', frame())
    expect(r.overflowCueCount).toBe(1)
    expect(r.remainingOverflowCount).toBe(1)
    expect(r.entries[0].fontSizePx).toBe(100) // untouched
    expect(r.entries[0].text).toBe(wrapped[0].text)
  })

  it('shrink: reduces the font (re-wrapping) until the cue fits', () => {
    const wrapped = autoLineBreakEntries([tall()], frame())
    const r = applyVerticalOverflowGuard(wrapped, 'shrink', frame())
    expect(r.overflowCueCount).toBe(1)
    expect(r.remainingOverflowCount).toBe(0)
    expect(r.entries[0].fontSizePx).toBeLessThan(100)
  })

  it('error mode: detects the overflow (count > 0) without mutating', () => {
    const wrapped = autoLineBreakEntries([tall()], frame())
    const r = applyVerticalOverflowGuard(wrapped, 'error', frame())
    expect(r.overflowCueCount).toBe(1)
    expect(r.entries[0].fontSizePx).toBe(100)
  })

  it('a cue that fits vertically is not counted', () => {
    const r = applyVerticalOverflowGuard([makeEntry({ text: 'あ' })], 'warn', frame())
    expect(r.overflowCueCount).toBe(0)
  })
})

describe('REQ-0456 — layoutForBurn', () => {
  it('wraps then guards, returning an overflow report', () => {
    const video = {
      path: 'x.mp4', hasVideoStream: true, widthPx: 400, heightPx: 1080,
      durationSec: 10, fps: 30, container: 'mp4', videoCodec: 'h264',
      audioTracks: [], fileSizeBytes: 0,
    }
    const r = layoutForBurn({
      entries: [makeEntry({ text: 'あ'.repeat(60) })],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      video: video as any,
      marginX: 10,
      marginY: 10,
      overflowMode: 'shrink',
      emphasisTierAllowed: false,
    // metricsFor is injected through opts inside layoutForBurn only via LayoutOptions;
    // layoutForBurn builds its own options, so we exercise the real (node) resolver
    // path here — which, with no font on disk in the test env, falls back to null
    // metrics identical to FALLBACK.  The report shape is what we assert.
    })
    expect(r.overflow.mode).toBe('shrink')
    expect(r.overflow.marginX).toBe(10)
    expect(r.overflow.marginY).toBe(10)
    expect(r.overflow.overflowCueCount).toBeGreaterThanOrEqual(1)
    expect(r.entries[0].text).toContain('\\N')
  })
})
