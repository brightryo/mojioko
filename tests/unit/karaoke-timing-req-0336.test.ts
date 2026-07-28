import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import {
  karaokeWordTimingBlocker,
  resolveKaraokeTiming,
} from '../../src/shared/karaoke-timing'
import { generateAss } from '../../src/main/services/ass-generator'
import { buildFallbackKaraokeUnits } from '../../src/shared/karaoke-fallback'
import { activeWordCountAtTime } from '../../src/renderer/lib/karaoke-highlight'
import type { SubtitleEntry, VideoInfo, WordSpan } from '../../src/shared/types'

/**
 * REQ-0336 §1 — karaoke timings vs. time editing.
 *
 * `WordSpan` holds ABSOLUTE seconds, but validity was judged by
 * `areWordsValidForText` alone — a TEXT predicate.  Dragging a clip therefore
 * left `words` "valid" while its timestamps pointed outside the cue's own
 * window.  Measured on the real burn (RES-0336 §1-7): a 3.0 s cue trimmed to
 * 1.2 s coloured 2 of its 5 characters (spoken-colour area 0.406 just before
 * the cue ended); a cue dragged EARLIER coloured nothing at all (0.000 at
 * every sample).  After the fix: 1.000 and a 0.195 → 0.561 → 1.000 sweep.
 */

const video = {
  path: 'x.mp4', widthPx: 1280, heightPx: 720, durationSec: 20,
  fps: 30, audioTracks: [], hasVideoStream: true,
} as unknown as VideoInfo

const burnin = { horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40 } as const

const TEXT = 'テストです'

/** Five per-character spans evenly covering `[from, to]`. */
function evenWords(from: number, to: number): WordSpan[] {
  const chars = [...TEXT]
  const step = (to - from) / chars.length
  return chars.map((c, i) => ({
    startSec: from + i * step,
    endSec: from + (i + 1) * step,
    text: c,
  }))
}

function entry(p: Partial<SubtitleEntry> & { origStartSec?: number; origEndSec?: number }): SubtitleEntry {
  const { origStartSec, origEndSec, ...rest } = p
  const base = {
    id: 'e1', startSec: 0, endSec: 3,
    text: TEXT,
    fontSizePx: 100,
    textColorHex: '#FFFFFF', outlineColorHex: '#000000', outlineThicknessPx: 3,
    fadeDurationSec: 0,
    horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black', opacityPercent: 60 },
    isDeleted: false, isEdited: false, animationType: 'none',
    ...rest,
  } as SubtitleEntry
  return {
    ...base,
    original: {
      startSec: origStartSec ?? base.startSec,
      endSec: origEndSec ?? base.endSec,
    } as SubtitleEntry['original'],
  }
}

const dialogueOf = (ass: string): string =>
  ass.split('\n').find((l) => l.startsWith('Dialogue:')) ?? ''

describe('REQ-0336 §1-3 — the truth table', () => {
  it('untouched transcribed row → real word timings', () => {
    expect(resolveKaraokeTiming(entry({ words: evenWords(0, 3) }))).toEqual({ mode: 'words' })
  })

  it('no words at all → even split, reason `no-words`', () => {
    expect(resolveKaraokeTiming(entry({}))).toEqual({ mode: 'even', reason: 'no-words' })
    expect(resolveKaraokeTiming(entry({ words: [] })))
      .toEqual({ mode: 'even', reason: 'no-words' })
  })

  it('text edited out of alignment → even split, reason `text-edited`', () => {
    const e = entry({ words: evenWords(0, 3), text: 'ちがう文' })
    expect(resolveKaraokeTiming(e)).toEqual({ mode: 'even', reason: 'text-edited' })
  })

  it('★ start moved → even split, reason `time-edited`', () => {
    const e = entry({ startSec: 5, endSec: 8, words: evenWords(0, 3), origStartSec: 0, origEndSec: 3 })
    expect(resolveKaraokeTiming(e)).toEqual({ mode: 'even', reason: 'time-edited' })
  })

  it('★ end trimmed → even split, reason `time-edited` (resize is not special-cased)', () => {
    const e = entry({ endSec: 1.2, words: evenWords(0, 3), origEndSec: 3 })
    expect(resolveKaraokeTiming(e)).toEqual({ mode: 'even', reason: 'time-edited' })
  })

  it('`no-words` is reported ahead of `text-edited` (a row that never had data is not "your edit")', () => {
    expect(karaokeWordTimingBlocker(entry({ text: 'まったく別' }))).toBe('no-words')
  })

  it('★ non-destructive: the fix never clears `words`, so restoring the times restores the mode', () => {
    const words = evenWords(0, 3)
    const moved = entry({ startSec: 5, endSec: 8, words, origStartSec: 0, origEndSec: 3 })
    expect(moved.words).toBe(words)               // untouched
    expect(resolveKaraokeTiming(moved).mode).toBe('even')
    // Undo / "Reset row" put the times back — no data had to be restored.
    const back = { ...moved, startSec: 0, endSec: 3 }
    expect(resolveKaraokeTiming(back).mode).toBe('words')
  })
})

describe('REQ-0336 §1-7 — the burn honours it', () => {
  it('★ a trimmed cue emits an even split spanning its OWN window, not the stale one', () => {
    const trimmed = entry({
      karaokeEnabled: true, karaokeStyle: 'switch',
      endSec: 1.2, words: evenWords(0, 3), origEndSec: 3,
    })
    const line = dialogueOf(generateAss([trimmed], video, burnin, undefined, 'F', true, 'switch'))
    // Pre-fix this emitted `{\k60}` × 4 + `{\k0}` — 3.0 s of speech inside a
    // 1.2 s cue, so only the first two characters ever coloured.
    expect(line).toContain('{\\k24}テ{\\k24}ス{\\k24}ト{\\k24}で{\\k24}す')
  })

  it('★ a cue dragged earlier no longer emits a leading silence longer than itself', () => {
    const moved = entry({
      karaokeEnabled: true, karaokeStyle: 'switch',
      startSec: 5, endSec: 8, words: evenWords(10.2, 12.8),
      origStartSec: 10, origEndSec: 13,
    })
    const line = dialogueOf(generateAss([moved], video, burnin, undefined, 'F', true, 'switch'))
    // Pre-fix: `{\k520}` — 5.2 s of silence at the head of a 3.0 s cue, so
    // nothing coloured at any point in the burn.
    expect(line).not.toContain('{\\k520}')
    expect(line).toContain('{\\k60}テ{\\k60}ス{\\k60}ト{\\k60}で{\\k60}す')
  })

  it('★ preview and burn resolve the SAME word list at the same instants', () => {
    const moved = entry({
      karaokeEnabled: true, karaokeStyle: 'switch',
      startSec: 5, endSec: 8, words: evenWords(10.2, 12.8),
      origStartSec: 10, origEndSec: 13,
    })
    const resolved = resolveKaraokeTiming(moved)
    expect(resolved.mode).toBe('even')
    const previewWords = buildFallbackKaraokeUnits(moved.text, moved.startSec, moved.endSec)
    // Measured spoken-colour area in the MP4 at these instants (RES-0336 §1-7):
    // 0.195 / 0.561 / 1.000 — the per-character ink areas differ slightly, so
    // the fractions are not exactly 1/5 and 3/5.
    expect(activeWordCountAtTime(previewWords, 5.3)).toBe(1)
    expect(activeWordCountAtTime(previewWords, 6.5)).toBe(3)
    expect(activeWordCountAtTime(previewWords, 7.9)).toBe(5)
  })

  it('an untouched karaoke cue still burns from its Whisper timings (no behaviour change)', () => {
    const clean = entry({
      karaokeEnabled: true, karaokeStyle: 'switch',
      words: [
        { startSec: 0.5, endSec: 1.0, text: 'テス' },
        { startSec: 1.0, endSec: 3.0, text: 'トです' },
      ],
    })
    const line = dialogueOf(generateAss([clean], video, burnin, undefined, 'F', true, 'switch'))
    expect(line).toContain('{\\k50}{\\k50}テス{\\k200}トです')
  })
})

describe('REQ-0336 §1-6 — one decision surface', () => {
  /**
   * `fade-opacity.ts` claimed in its JSDoc to "mirror" the writer and then
   * re-derived the same judgement independently; the two drifted (RES-0323).
   * This pin makes the same drift a test failure: neither renderer may CALL
   * `areWordsValidForText` for the karaoke decision — both must go through
   * `resolveKaraokeTiming`.  (Prose references to the predicate are fine; the
   * pattern below matches a call, not a mention.)
   */
  const CONSUMERS = [
    'src/main/services/ass-generator.ts',
    'src/renderer/components/subtitle-overlay/subtitle-overlay.tsx',
  ]

  for (const rel of CONSUMERS) {
    it(`${rel} decides via resolveKaraokeTiming and nothing else`, () => {
      const src = readFileSync(path.join(process.cwd(), rel), 'utf8')
      expect(src).toContain('resolveKaraokeTiming(')
      expect(src).not.toMatch(/areWordsValidForText\s*\(/)
    })
  }
})
