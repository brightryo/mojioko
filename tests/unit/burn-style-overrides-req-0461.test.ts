import { describe, it, expect } from 'vitest'
import {
  applyStyleOverrides,
  resolveWeightFontId,
  weightLabelToClass,
  isHexColor,
  isEmptyStyleOverrides,
} from '../../src/main/cli/style-overrides'
import { generateAssLegacyFont as generateAss } from '../helpers/legacy-ass-font-name'
import { getFontMeta, DEFAULT_FONT_ID } from '../../src/shared/fonts'
import type { SubtitleEntry, VideoInfo, BurninPosition } from '../../src/shared/types'

/**
 * REQ-0461 — the `mojioko burn` per-cue style flags (`--weight` / `--font-size`
 * / `--text-color` / `--outline-color` / `--outline` / `--margin-v`) were
 * advertised but never read, so passing them did nothing.  These tests pin the
 * two halves of the fix: (1) the pure resolvers/appliers, and (2) that an
 * override actually lands in the emitted ASS (`\fs` / `\c` / `\3c` / `\bord` /
 * `\fn`, and the vertical margin moves the self-positioned `\pos` anchor).
 */

const video: VideoInfo = {
  path: 'x.mp4', hasVideoStream: true, widthPx: 1920, heightPx: 1080,
  durationSec: 10, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 0,
}
const burnin: BurninPosition = { horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40 }

function makeEntry(patch: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base: SubtitleEntry = {
    id: 'e1',
    startSec: 0, endSec: 2,
    text: 'Hello',
    fontSizePx: 100,
    textColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    outlineThicknessPx: 3,
    fadeDurationSec: 0,
    horizontalPosition: 'center',
    verticalPosition: 'bottom',
    verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    isDeleted: false,
    isEdited: false,
    original: {
      startSec: 0, endSec: 2, text: 'Hello',
      fontSizePx: 100, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
      outlineThicknessPx: 3, fadeDurationSec: 0,
      horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40,
      subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    },
  }
  return { ...base, ...patch }
}

const dialogueLineOf = (ass: string) => ass.split('\n').find((l) => l.startsWith('Dialogue:'))!

// -----------------------------------------------------------------
// §1 pure resolvers
// -----------------------------------------------------------------
describe('REQ-0461 — weight/color resolvers', () => {
  it('weightLabelToClass maps ascending labels to OpenType classes, case-insensitively', () => {
    expect(weightLabelToClass('Thin')).toBe(100)
    expect(weightLabelToClass('Regular')).toBe(400)
    expect(weightLabelToClass('SemiBold')).toBe(600)
    expect(weightLabelToClass('bold')).toBe(700)
    expect(weightLabelToClass('  black  ')).toBe(900)
    expect(weightLabelToClass('Heavy')).toBeUndefined()
  })

  it('resolveWeightFontId picks the same-family face at the requested weight', () => {
    // Default family is Noto Sans JP, which registers all nine weights.
    expect(resolveWeightFontId(DEFAULT_FONT_ID, 'Bold')).toBe('noto-sans-jp-bold')
    expect(resolveWeightFontId(DEFAULT_FONT_ID, 'Thin')).toBe('noto-sans-jp-thin')
    expect(resolveWeightFontId(DEFAULT_FONT_ID, 'SemiBold')).toBe('noto-sans-jp-semibold')
  })

  it('resolveWeightFontId returns undefined for an invalid label (caller rejects it)', () => {
    expect(resolveWeightFontId(DEFAULT_FONT_ID, 'Heavy')).toBeUndefined()
  })

  it('isHexColor accepts #RRGGBB only', () => {
    expect(isHexColor('#FFEE00')).toBe(true)
    expect(isHexColor('#ffee00')).toBe(true)
    expect(isHexColor('#FFF')).toBe(false)
    expect(isHexColor('FFEE00')).toBe(false)
    expect(isHexColor('red')).toBe(false)
  })
})

// -----------------------------------------------------------------
// §2 applyStyleOverrides
// -----------------------------------------------------------------
describe('REQ-0461 — applyStyleOverrides', () => {
  it('is a no-op for an empty override set (same array reference)', () => {
    const entries = [makeEntry()]
    expect(isEmptyStyleOverrides({})).toBe(true)
    expect(applyStyleOverrides(entries, {})).toBe(entries)
  })

  it('applies every field to non-deleted cues and leaves deleted cues untouched', () => {
    const alive = makeEntry({ id: 'a' })
    const dead = makeEntry({ id: 'b', isDeleted: true })
    const bold = resolveWeightFontId(DEFAULT_FONT_ID, 'Bold')
    const out = applyStyleOverrides([alive, dead], {
      fontSizePx: 64,
      textColorHex: '#FFEE00',
      outlineColorHex: '#112233',
      outlineThicknessPx: 5,
      fontId: bold,
      verticalMarginPx: 120,
    })
    expect(out[0]).toMatchObject({
      fontSizePx: 64,
      textColorHex: '#FFEE00',
      outlineColorHex: '#112233',
      outlineThicknessPx: 5,
      fontId: bold,
      verticalMarginPx: 120,
    })
    // Deleted cue is passed through by identity.
    expect(out[1]).toBe(dead)
  })
})

// -----------------------------------------------------------------
// §3 overrides reach the emitted ASS
// -----------------------------------------------------------------
describe('REQ-0461 — overrides land in the ASS', () => {
  it('font-size / text-color / outline-color / outline / weight emit the matching tags', () => {
    const bold = resolveWeightFontId(DEFAULT_FONT_ID, 'Bold')!
    const [entry] = applyStyleOverrides([makeEntry()], {
      fontSizePx: 64,
      textColorHex: '#FFEE00',
      outlineColorHex: '#112233',
      outlineThicknessPx: 5,
      fontId: bold,
    })
    const line = dialogueLineOf(generateAss([entry], video, burnin))
    expect(line).toContain('\\fs64')
    // #FFEE00 → ASS &H00BBGGRR& = &H0000EEFF&
    expect(line).toContain('\\c&H0000EEFF&')
    // #112233 → &H00332211&
    expect(line).toContain('\\3c&H00332211&')
    expect(line).toContain('\\bord5')
    // Per-row \fn carries the bold family (differs from the Style default).
    expect(line).toContain(`\\fn${getFontMeta(bold).assFontName}`)
  })

  it('--margin-v moves the self-positioned vertical anchor', () => {
    const near = applyStyleOverrides([makeEntry()], { verticalMarginPx: 40 })
    const far = applyStyleOverrides([makeEntry()], { verticalMarginPx: 400 })
    const yOf = (ass: string) => {
      const m = /\\pos\(\s*[\d.]+\s*,\s*([\d.]+)\s*\)/.exec(dialogueLineOf(ass))
      return m ? Number(m[1]) : NaN
    }
    const yNear = yOf(generateAss(near, video, burnin))
    const yFar = yOf(generateAss(far, video, burnin))
    expect(Number.isFinite(yNear)).toBe(true)
    expect(Number.isFinite(yFar)).toBe(true)
    // A larger bottom margin lifts the text UP the frame → smaller Y.
    expect(yFar).toBeLessThan(yNear)
  })
})
