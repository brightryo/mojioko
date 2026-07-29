import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
// REQ-0340 §3 — `generateAss` no longer defaults `assFontName`.  This file's
// subject is tag composition, not font resolution, so it goes through the
// shim that supplies the historical name.  See the helper for why.
import { generateAssLegacyFont as generateAss } from '../helpers/legacy-ass-font-name'
import {
  clampOpacityPercent,
  isFullyOpaque,
  opacityPercentToAssAlpha,
  hexWithOpacity,
  OPACITY_DEFAULT_PERCENT,
} from '../../src/shared/alpha'
import { SubtitleOverlay } from '../../src/renderer/components/subtitle-overlay/subtitle-overlay'
import { sampleEntries } from '../../src/renderer/lib/fixtures'
import type { SubtitleEntry, VideoInfo, BurninPosition, WordSpan } from '../../src/shared/types'

/**
 * REQ-0310 — per-cue opacity for the text fill and the outline.
 *
 * The headline requirement is the karaoke composition: with the text opacity at
 * 0 % and karaoke on, the UNSPOKEN half must be invisible while the spoken half
 * stays opaque, so each word appears as it is spoken.  That falls out of
 * targeting `\2a` (SecondaryColour) rather than `\1a` when karaoke is active,
 * and never giving the spoken colour an alpha.
 */

const VIDEO: VideoInfo = {
  path: 'x.mp4', hasVideoStream: true, widthPx: 1920, heightPx: 1080,
  durationSec: 10, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 0,
}
const BURNIN: BurninPosition = {
  horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40,
}
const WORDS: WordSpan[] = [
  { startSec: 0, endSec: 0.5, text: 'hello' },
  { startSec: 0.5, endSec: 1.0, text: ' world' },
]

function makeEntry(patch: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base = {
    startSec: 0, endSec: 1, text: 'hello world',
    fontSizePx: 50, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
    outlineThicknessPx: 3, fadeDurationSec: 0,
    horizontalPosition: 'center' as const, verticalPosition: 'bottom' as const,
    verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black' as const, opacityPercent: 50 },
  }
  return {
    id: 'e1', ...base, isDeleted: false, isEdited: false, original: { ...base }, ...patch,
  } as SubtitleEntry
}

function dialogueOf(e: SubtitleEntry): string {
  const ass = generateAss([e], VIDEO, BURNIN, undefined, undefined, true, 'switch')
  const line = ass.split('\n').find((l) => l.startsWith('Dialogue:'))
  expect(line).toBeDefined()
  return line!
}

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

describe('REQ-0310 — opacity ↔ ASS alpha conversion', () => {
  it('inverts the sense: 100 % → 00, 0 % → FF', () => {
    expect(opacityPercentToAssAlpha(100)).toBe('00')
    expect(opacityPercentToAssAlpha(50)).toBe('80')
    expect(opacityPercentToAssAlpha(0)).toBe('FF')
  })

  it('undefined resolves to fully opaque', () => {
    expect(clampOpacityPercent(undefined)).toBe(OPACITY_DEFAULT_PERCENT)
    expect(isFullyOpaque(undefined)).toBe(true)
    expect(opacityPercentToAssAlpha(undefined)).toBe('00')
  })

  it('clamps out-of-range and non-finite values but NOT 0', () => {
    expect(clampOpacityPercent(0)).toBe(0)        // 0 is legal (REQ-0310 §2)
    expect(isFullyOpaque(0)).toBe(false)
    expect(clampOpacityPercent(-20)).toBe(0)
    expect(clampOpacityPercent(140)).toBe(100)
    expect(clampOpacityPercent(NaN)).toBe(100)
    expect(clampOpacityPercent(33.4)).toBe(33)
  })

  it('hexWithOpacity returns the plain hex when fully opaque', () => {
    // Keeps the emitted CSS unchanged for every untouched cue.
    expect(hexWithOpacity('#FFFFFF', undefined)).toBe('#FFFFFF')
    expect(hexWithOpacity('#FFFFFF', 100)).toBe('#FFFFFF')
    expect(hexWithOpacity('#FF2E88', 50)).toBe('rgba(255, 46, 136, 0.5)')
    expect(hexWithOpacity('#FFFFFF', 0)).toBe('rgba(255, 255, 255, 0)')
  })
})

// ---------------------------------------------------------------------------
// §7 — the default must not change any existing output
// ---------------------------------------------------------------------------

describe('REQ-0310 §7 — 100 % / absent is byte-identical to pre-REQ-0310', () => {
  it('emits no alpha tag at all when the fields are absent', () => {
    const line = dialogueOf(makeEntry())
    expect(line).not.toContain('\\1a')
    expect(line).not.toContain('\\2a')
    expect(line).not.toContain('\\3a')
  })

  it('an explicit 100 % is identical to the field being absent', () => {
    const absent = dialogueOf(makeEntry())
    expect(dialogueOf(makeEntry({ textAlpha: 100, outlineAlpha: 100 }))).toBe(absent)
  })

  it('holds with karaoke on, and with emphasis on', () => {
    const karaoke = dialogueOf(makeEntry({ karaokeEnabled: true, words: WORDS }))
    expect(dialogueOf(makeEntry({ karaokeEnabled: true, words: WORDS, textAlpha: 100 }))).toBe(karaoke)
    expect(karaoke).not.toContain('\\2a')

    const emph = makeEntry({
      keywordEmphasisEnabled: true,
      emphasisSpans: [{ start: 0, end: 5, text: 'hello' }],
    })
    const emphLine = dialogueOf(emph)
    expect(dialogueOf({ ...emph, textAlpha: 100 })).toBe(emphLine)
    expect(emphLine).not.toContain('\\1a')
  })
})

// ---------------------------------------------------------------------------
// §3 — the semantics
// ---------------------------------------------------------------------------

describe('REQ-0310 §3 — fill alpha targets `\\1a` / `\\2a` by karaoke state', () => {
  it('karaoke OFF → `\\1a` (PrimaryColour is the fill)', () => {
    const line = dialogueOf(makeEntry({ textAlpha: 50 }))
    expect(line).toContain('\\1a&H80&')
    expect(line).not.toContain('\\2a')
  })

  it('karaoke ON → `\\2a` (SecondaryColour is the UNSPOKEN half)', () => {
    const line = dialogueOf(makeEntry({ karaokeEnabled: true, words: WORDS, textAlpha: 50 }))
    expect(line).toContain('\\2a&H80&')
    expect(line).not.toContain('\\1a')
  })

  it('outline alpha is always `\\3a`, karaoke or not', () => {
    expect(dialogueOf(makeEntry({ outlineAlpha: 40 }))).toContain('\\3a&H99&')
    expect(
      dialogueOf(makeEntry({ karaokeEnabled: true, words: WORDS, outlineAlpha: 40 })),
    ).toContain('\\3a&H99&')
  })

  it('0 % reaches the ASS as &HFF& and is never clamped away', () => {
    const line = dialogueOf(makeEntry({ textAlpha: 0, outlineAlpha: 0 }))
    expect(line).toContain('\\1a&HFF&')
    expect(line).toContain('\\3a&HFF&')
  })

  it('hollow text: fill 0 % with an opaque outline emits only `\\1a`', () => {
    const line = dialogueOf(makeEntry({ textAlpha: 0 }))
    expect(line).toContain('\\1a&HFF&')
    expect(line).not.toContain('\\3a')
  })

  it('a background-box row keeps its OWN `\\3a` (box opacity untouched)', () => {
    const line = dialogueOf(makeEntry({
      outlineAlpha: 0,
      subtitleBackground: { enabled: true, color: 'black', opacityPercent: 80 },
    }))
    // Both appear, but the box's alpha is emitted LAST so libass uses it.
    const outlineAt = line.indexOf('\\3a&HFF&')
    const boxAt = line.lastIndexOf('\\3a&H33&')
    expect(outlineAt).toBeGreaterThan(-1)
    expect(boxAt).toBeGreaterThan(outlineAt)
  })
})

describe('REQ-0310 §4 — karaoke + fill 0 % makes words appear as they are spoken', () => {
  it('the unspoken half is transparent while the spoken colour stays opaque', () => {
    const line = dialogueOf(makeEntry({
      karaokeEnabled: true,
      words: WORDS,
      textAlpha: 0,
      karaokeHighlightColor: '#B4FF39',
    }))
    // Unspoken (SecondaryColour) fully transparent …
    expect(line).toContain('\\2a&HFF&')
    // … spoken (PrimaryColour) present and given NO alpha override.
    expect(line).toContain('\\c&H0039FFB4&')
    expect(line).not.toContain('\\1a')
    // The `\k` sweep itself is untouched, so the reveal is driven by timing.
    expect(line).toContain('{\\k50}hello')
    expect(line).toContain('{\\k50} world')
  })
})

describe('REQ-0310 §5 — emphasis stays opaque under a translucent fill', () => {
  it('karaoke OFF: the run resets `\\1a` to opaque and restores it after', () => {
    const line = dialogueOf(makeEntry({
      keywordEmphasisEnabled: true,
      emphasisSpans: [{ start: 0, end: 5, text: 'hello' }],
      textAlpha: 50,
    }))
    expect(line).toContain('\\1a&H00&')   // opaque inside the emphasised run
    expect(line).toContain('\\1a&H80&')   // cue value restored after it
    expectWellFormedOverrides(line)
  })

  it('karaoke ON: `\\2a` already governs the unspoken half uniformly', () => {
    const line = dialogueOf(makeEntry({
      karaokeEnabled: true,
      words: WORDS,
      keywordEmphasisEnabled: true,
      emphasisSpans: [{ start: 0, end: 5, text: 'hello' }],
      textAlpha: 0,
    }))
    expect(line).toContain('\\2a&HFF&')
    // No per-run `\1a` juggling is needed on this path.
    expect(line).not.toContain('\\1a')
    expectWellFormedOverrides(line)
  })
})

// ---------------------------------------------------------------------------
// Preview ↔ burn-in correspondence
// ---------------------------------------------------------------------------

describe('REQ-0310 — the CSS preview matches the burn-in', () => {
  function markup(patch: Partial<SubtitleEntry>): string {
    const entry = { ...sampleEntries[0], text: 'hello world', ...patch } as SubtitleEntry
    return renderToStaticMarkup(
      React.createElement(SubtitleOverlay, { entry, videoWidthPx: 1920, containerWidthPx: 400 }),
    )
  }

  it('the FILL becomes rgba() at partial opacity', () => {
    const html = markup({ textColorHex: '#FFFFFF', outlineColorHex: '#000000', textAlpha: 50, outlineAlpha: 25 })
    expect(html).toContain('color:rgba(255, 255, 255, 0.5)')
  })

  it('stays plain hex at the default, so existing previews are unchanged', () => {
    const html = markup({ textColorHex: '#FFFFFF', outlineColorHex: '#000000' })
    expect(html).toContain('color:#FFFFFF')
    expect(html).not.toContain('rgba(255, 255, 255')
  })

  /**
   * REQ-0313 — the outline left the DOM entirely.  It used to be a CSS
   * `-webkit-text-stroke`, whose centred geometry only read correctly while an
   * opaque fill masked its inner half; that assumption broke under this REQ's
   * own opacity feature and again under REQ-0311's `\kf` sweep.  It is now a
   * canvas ring painted behind the text, so `a` lives on the canvas element's
   * opacity rather than in a CSS colour.
   *
   * This assertion is the structural guard: if a CSS stroke ever comes back,
   * the fill technique can silently break the outline for a third time.
   */
  it('REQ-0313 — the DOM carries NO text stroke at any opacity', () => {
    for (const patch of [
      { textAlpha: 100, outlineAlpha: 100 },
      { textAlpha: 50, outlineAlpha: 25 },
      { textAlpha: 0, outlineAlpha: 100 },
    ]) {
      const html = markup({ textColorHex: '#FFFFFF', outlineColorHex: '#000000', ...patch })
      expect(html).not.toContain('-webkit-text-stroke')
      expect(html).not.toContain('WebkitTextStroke')
      expect(html).not.toContain('paint-order')
    }
  })

  it('REQ-0313 — the shadow left the DOM too, so it cannot paint over the ring', () => {
    const html = markup({ shadowDepth: 8, shadowColor: '#000000', shadowAlpha: 100 })
    expect(html).not.toContain('text-shadow')
  })

  it('karaoke: the unspoken spans carry the opacity, matching `\\2a`', () => {
    const html = markup({
      textColorHex: '#FFFFFF',
      karaokeEnabled: true,
      words: WORDS,
      startSec: 0,
      endSec: 1,
      textAlpha: 0,
    })
    // Word spans render at the base (unspoken) colour before the rAF loop runs.
    expect(html).toContain('data-karaoke-word-idx')
    expect(html).toContain('rgba(255, 255, 255, 0)')
  })

  it('emphasis runs stay opaque in the preview too (matches the `\\1a` reset)', () => {
    const html = markup({
      textColorHex: '#FFFFFF',
      keywordEmphasisEnabled: true,
      emphasisColorHex: '#FF2E88',
      emphasisSpans: [{ start: 0, end: 5, text: 'hello' }],
      textAlpha: 0,
    })
    // The emphasised run keeps a solid colour …
    expect(html).toContain('color:#FF2E88')
    // … while the surrounding fill is transparent.
    expect(html).toContain('rgba(255, 255, 255, 0)')
  })
})

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

describe('REQ-0310 — existing projects and SRT are unaffected', () => {
  it('an entry with no alpha fields renders and burns in unchanged', () => {
    const legacy = makeEntry()
    expect('textAlpha' in legacy).toBe(false)
    expect('outlineAlpha' in legacy).toBe(false)
    const line = dialogueOf(legacy)
    expect(line).toContain('\\c&H00FFFFFF&')
    expect(line).toContain('\\3c&H00000000&')
    expect(line).not.toMatch(/\\[123]a/)
  })

  it('a corrupt / hand-edited alpha never throws and degrades to opaque', () => {
    for (const bad of [NaN, Infinity, undefined]) {
      expect(() => dialogueOf(makeEntry({ textAlpha: bad as number }))).not.toThrow()
    }
    expect(dialogueOf(makeEntry({ textAlpha: NaN }))).toBe(dialogueOf(makeEntry()))
  })
})

/** Every ASS override must sit inside its own `{}` block (REQ-0291). */
function expectWellFormedOverrides(line: string): void {
  const body = line.slice(line.indexOf(',,') + 2)
  expect((body.match(/\{/g) ?? []).length).toBe((body.match(/\}/g) ?? []).length)
  expect(body).not.toContain('{{')
  expect(body).not.toContain('}}')
  const outsideBraces = body.replace(/\{[^}]*\}/g, '')
  expect(outsideBraces.replace(/\\N/g, '')).not.toContain('\\')
}
