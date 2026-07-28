import { describe, it, expect } from 'vitest'
// REQ-0340 §3 — `generateAss` no longer defaults `assFontName`.  This file's
// subject is tag composition, not font resolution, so it goes through the
// shim that supplies the historical name.  See the helper for why.
import { generateAssLegacyFont as generateAss } from '../helpers/legacy-ass-font-name'
import { resolveKaraokeStyle, coerceKaraokeStyle, KARAOKE_STYLE_DEFAULT } from '../../src/shared/karaoke-style'
import { buildDuplicateEntry } from '../../src/renderer/lib/duplicate-entry'
import type { SubtitleEntry, VideoInfo } from '../../src/shared/types'
import type { BurninPosition } from '../../src/shared/types'

/**
 * REQ-0322 §3 — `karaokeStyle` is per-cue.
 *
 * REQ-0320 §1 was a wiring bug: the renderer built the burn-in IPC payload
 * by hand and dropped `karaokeStyle`, so the preview (which reads the store
 * directly) looked correct while the MP4 was wrong for a whole release.
 * REQ-0321 §1 closed that hole with a type-exhaustive payload — but the
 * per-cue value takes a DIFFERENT route: it rides inside `entries`, which
 * `BURNIN_FIELD_DISPOSITION` classifies as `derived` (glyph substitution
 * rewrites it).  These tests pin that route.
 */

const BS = String.fromCharCode(92) // backslash, kept out of string literals

const video: VideoInfo = {
  path: 'C:/x.mp4', widthPx: 1920, heightPx: 1080,
  durationSec: 10, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 0,
}
const burnin: BurninPosition = {
  horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40,
}

function karaokeEntry(id: string, startSec: number, style?: 'switch' | 'sweep'): SubtitleEntry {
  const original = {
    startSec, endSec: startSec + 2,
    text: 'one two',
    fontSizePx: 100,
    textColorHex: '#FFFFFF', outlineColorHex: '#000000', outlineThicknessPx: 3,
    fadeDurationSec: 0,
    horizontalPosition: 'center' as const, verticalPosition: 'bottom' as const,
    verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black' as const, opacityPercent: 50 },
    karaokeEnabled: true,
    karaokeHighlightColor: '#FFCC00',
    words: [
      { startSec, endSec: startSec + 1, text: 'one' },
      { startSec: startSec + 1, endSec: startSec + 2, text: ' two' },
    ],
    ...(style === undefined ? {} : { karaokeStyle: style }),
  }
  return { id, ...original, isDeleted: false, isEdited: false, original: structuredClone(original) }
}

/** Karaoke tag lines only, in document order. */
function karaokeLines(ass: string): string[] {
  return ass.split(/\r?\n/).filter((l) => l.startsWith('Dialogue:') && l.includes(BS + 'k'))
}

describe('REQ-0322 §3 — resolveKaraokeStyle', () => {
  it('a cue value wins over the default', () => {
    expect(resolveKaraokeStyle('switch', 'sweep')).toBe('switch')
    expect(resolveKaraokeStyle('sweep', 'switch')).toBe('sweep')
  })

  it('undefined follows the supplied default — it does NOT hard-code one', () => {
    expect(resolveKaraokeStyle(undefined, 'switch')).toBe('switch')
    expect(resolveKaraokeStyle(undefined, 'sweep')).toBe('sweep')
    // This is the `coerceKaraokeStyle` trap REQ-0322 §3 names: coerce
    // collapses undefined to a fixed default, which for a CUE would freeze
    // today's KARAOKE_STYLE_DEFAULT into every untouched row.
    expect(coerceKaraokeStyle(undefined)).toBe(KARAOKE_STYLE_DEFAULT)
    expect(resolveKaraokeStyle(undefined, 'switch')).not.toBe(coerceKaraokeStyle(undefined))
  })

  it('a garbage value (hand-edited project file) falls back, never throws', () => {
    expect(resolveKaraokeStyle('SWEEP', 'switch')).toBe('switch')
    expect(resolveKaraokeStyle(null, 'sweep')).toBe('sweep')
    expect(resolveKaraokeStyle(7, 'switch')).toBe('switch')
  })
})

describe('REQ-0322 §3 — the per-cue value reaches the ASS writer', () => {
  it('★ MIXED project: one switch cue and one sweep cue in ONE ASS file', () => {
    const ass = generateAss(
      [karaokeEntry('a', 0, 'switch'), karaokeEntry('b', 4, 'sweep')],
      video, burnin, undefined, undefined, true, 'switch',
    )
    const lines = karaokeLines(ass)
    expect(lines).toHaveLength(2)

    // Cue A pinned to switch → plain \k, no \kf anywhere on its line.
    expect(lines[0]).toContain(BS + 'k')
    expect(lines[0]).not.toContain(BS + 'kf')
    // Cue B pinned to sweep → \kf.
    expect(lines[1]).toContain(BS + 'kf')

    // The two cues genuinely differ — a no-op flag would produce identical
    // bodies and this is the assertion that catches it.
    expect(lines[0]).not.toBe(lines[1])
  })

  it('the request-level value is only the DEFAULT for cues with no choice', () => {
    const unset = [karaokeEntry('a', 0, undefined)]
    const asSwitch = karaokeLines(generateAss(unset, video, burnin, undefined, undefined, true, 'switch'))[0]
    const asSweep = karaokeLines(generateAss(unset, video, burnin, undefined, undefined, true, 'sweep'))[0]
    expect(asSwitch).not.toContain(BS + 'kf')
    expect(asSweep).toContain(BS + 'kf')
  })

  it('a cue that chose a style ignores the default entirely', () => {
    const pinned = [karaokeEntry('a', 0, 'sweep')]
    const underSwitch = karaokeLines(generateAss(pinned, video, burnin, undefined, undefined, true, 'switch'))[0]
    const underSweep = karaokeLines(generateAss(pinned, video, burnin, undefined, undefined, true, 'sweep'))[0]
    expect(underSwitch).toBe(underSweep)
    expect(underSwitch).toContain(BS + 'kf')
  })

  it('pre-REQ-0322 project files need no migration: absent key → default', () => {
    const legacy = karaokeEntry('a', 0, undefined)
    expect('karaokeStyle' in legacy).toBe(false)
    const line = karaokeLines(generateAss([legacy], video, burnin, undefined, undefined, true, 'sweep'))[0]
    expect(line).toContain(BS + 'kf')
  })
})

describe('REQ-0322 §3 × §2 — the new field survives duplication', () => {
  it('a duplicated cue keeps its per-cue style (the §2 gate made this mandatory)', () => {
    const src = karaokeEntry('a', 0, 'switch')
    const dup = buildDuplicateEntry(src, 'dup-a')
    expect(dup.karaokeStyle).toBe('switch')
    expect(dup.original.karaokeStyle).toBe('switch')

    const ass = generateAss([dup], video, burnin, undefined, undefined, true, 'sweep')
    expect(karaokeLines(ass)[0]).not.toContain(BS + 'kf')
  })

  it('a duplicated cue with no style stays unset (absence preserved)', () => {
    const dup = buildDuplicateEntry(karaokeEntry('a', 0, undefined), 'dup-b')
    expect('karaokeStyle' in dup).toBe(false)
  })
})
