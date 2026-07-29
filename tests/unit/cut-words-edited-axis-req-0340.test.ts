import { describe, it, expect } from 'vitest'
import { translateEntryToEditedAxis, origToEdited } from '../../src/shared/cuts'
import { karaokeWordTimingBlocker, resolveKaraokeTiming } from '../../src/shared/karaoke-timing'
import { areWordsValidForText } from '../../src/shared/words-validity'
import type { Cut } from '../../src/shared/cuts'
import type { SubtitleEntry, WordSpan } from '../../src/shared/types'

/**
 * REQ-0340 §2 — `words` and `original` on the Edited axis.
 *
 * Burn-in applies `subtitles=` to the CONCAT output, so every timestamp in
 * the ASS has to be a position on the edited timeline.  `ffmpeg-burnin` used
 * to translate `startSec` / `endSec` and nothing else, which left
 * `original.*` behind on the original axis — and `karaokeWordTimingBlocker`
 * decides "did the user move this cue?" by comparing the two.  So every cue
 * in a project with cuts read as time-edited, and karaoke burned from the
 * equal split no matter what the user had chosen (RES-0336 §5).
 *
 * These pin the three questions that fix has to answer:
 *   1. does an untouched cue still read as untouched after translation?
 *   2. where does a word go when a cut lands on it?
 *   3. does the cue still colour every character?
 */

const TEXT = 'abcde'

function words(spans: Array<[number, number]>): WordSpan[] {
  return spans.map(([s, e], i) => ({ startSec: s, endSec: e, text: [...TEXT][i] }))
}

function entry(p: Partial<SubtitleEntry> & { origStartSec?: number; origEndSec?: number } = {}): SubtitleEntry {
  const { origStartSec, origEndSec, ...rest } = p
  const base = {
    id: 'e1', startSec: 10, endSec: 20, text: TEXT,
    fontSizePx: 100, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
    outlineThicknessPx: 3, fadeDurationSec: 0,
    horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black', opacityPercent: 60 },
    isDeleted: false, isEdited: false,
    ...rest,
  } as SubtitleEntry
  return {
    ...base,
    original: {
      ...base,
      startSec: origStartSec ?? base.startSec,
      endSec: origEndSec ?? base.endSec,
    } as SubtitleEntry['original'],
  }
}

const cut = (startSec: number, endSec: number, id = 'c1'): Cut => ({ startSec, endSec, id })

describe('REQ-0340 §2 — cut translation puts words and original on the Edited axis', () => {
  it('an unedited cue does NOT read as time-edited after translation', () => {
    // The whole point.  A 5 s cut before the cue shifts it 5 s earlier; live
    // and original must land on the same two numbers, not just close ones.
    const e = entry({ words: words([[10, 12], [12, 14], [14, 16], [16, 18], [18, 20]]) })
    const cuts = [cut(0, 5)]
    expect(karaokeWordTimingBlocker(e)).toBeNull() // untouched before, too

    const out = translateEntryToEditedAxis(e, cuts)
    expect(out).not.toBeNull()
    const t = out!.entry
    expect(t.startSec).toBe(5)
    expect(t.endSec).toBe(15)
    expect(t.original.startSec).toBe(t.startSec)
    expect(t.original.endSec).toBe(t.endSec)
    expect(karaokeWordTimingBlocker(t)).toBeNull()
    expect(resolveKaraokeTiming(t).mode).toBe('words')
  })

  it('pre-fix behaviour is what it replaces: translating live alone reads as time-edited', () => {
    // Negative control, spelled out rather than described.  This is the exact
    // shape `ffmpeg-burnin` produced before REQ-0340.
    const e = entry({ words: words([[10, 12], [12, 14], [14, 16], [16, 18], [18, 20]]) })
    const cuts = [cut(0, 5)]
    const preFix: SubtitleEntry = {
      ...e,
      startSec: origToEdited(e.startSec, cuts),
      endSec: origToEdited(e.endSec, cuts),
    }
    expect(karaokeWordTimingBlocker(preFix)).toBe('time-edited')
    expect(resolveKaraokeTiming(preFix).mode).toBe('even')
  })

  it('a cue the user really did move still reads as time-edited', () => {
    // Translation must not launder a genuine edit into "untouched".
    const e = entry({
      startSec: 10, endSec: 20, origStartSec: 12, origEndSec: 22,
      words: words([[10, 12], [12, 14], [14, 16], [16, 18], [18, 20]]),
    })
    const out = translateEntryToEditedAxis(e, [cut(0, 5)])!
    expect(karaokeWordTimingBlocker(out.entry)).toBe('time-edited')
  })

  it('words shift with the cue and stay inside its window', () => {
    const e = entry({ words: words([[10, 12], [12, 14], [14, 16], [16, 18], [18, 20]]) })
    const out = translateEntryToEditedAxis(e, [cut(0, 5)])!
    expect(out.wordsDropped).toBe(false)
    expect(out.entry.words).toEqual(words([[5, 7], [7, 9], [9, 11], [11, 13], [13, 15]]))
    for (const w of out.entry.words!) {
      expect(w.startSec).toBeGreaterThanOrEqual(out.entry.startSec)
      expect(w.endSec).toBeLessThanOrEqual(out.entry.endSec)
    }
  })

  it('a word STRADDLING a cut boundary keeps both ends and compresses to its surviving audio', () => {
    // Cut removes [13,15) — 1 s out of word 2's [12,14) and 1 s out of word
    // 3's [14,16).  Neither word is split and neither is dropped: each keeps
    // exactly as much edited-axis time as it has audio left.
    const e = entry({ words: words([[10, 12], [12, 14], [14, 16], [16, 18], [18, 20]]) })
    const out = translateEntryToEditedAxis(e, [cut(13, 15)])!
    expect(out.wordsDropped).toBe(false)
    const w = out.entry.words!
    expect(w[0]).toMatchObject({ startSec: 10, endSec: 12 }) // untouched, before the cut
    expect(w[1]).toMatchObject({ startSec: 12, endSec: 13 }) // 2 s of audio -> 1 s survives
    expect(w[2]).toMatchObject({ startSec: 13, endSec: 14 }) // 2 s of audio -> 1 s survives
    expect(w[3]).toMatchObject({ startSec: 14, endSec: 16 }) // shifted by the 2 s removed
    expect(w[4]).toMatchObject({ startSec: 16, endSec: 18 })
    expect(out.entry.startSec).toBe(10)
    expect(out.entry.endSec).toBe(18)
  })

  it('a word ENTIRELY inside a cut collapses to zero duration at the splice, and is kept', () => {
    // Its audio is gone, so zero duration is the honest answer.  Keeping it is
    // not optional: cuts do not shorten a cue's TEXT, and dropping the span
    // would break the words<->text check that gates per-word rendering.
    const e = entry({ words: words([[10, 12], [12, 14], [14, 16], [16, 18], [18, 20]]) })
    const out = translateEntryToEditedAxis(e, [cut(14, 16)])!
    const w = out.entry.words!
    expect(w).toHaveLength(5)
    expect(w[2].startSec).toBe(w[2].endSec) // the swallowed word
    expect(w[2].startSec).toBe(14)
    expect(areWordsValidForText(w, out.entry.text)).toBe(true)
    expect(resolveKaraokeTiming(out.entry).mode).toBe('words')
  })

  it('words are clipped to a head-clamped window, not left reaching outside it', () => {
    // The cut eats the cue's first 2 s.  Word 1 lived entirely in that
    // region; word 2 half of it.  Both must land at or after the new start.
    const e = entry({ words: words([[10, 12], [12, 14], [14, 16], [16, 18], [18, 20]]) })
    const out = translateEntryToEditedAxis(e, [cut(9, 13)])!
    const t = out.entry
    expect(t.startSec).toBe(9)
    for (const w of t.words!) {
      expect(w.startSec).toBeGreaterThanOrEqual(t.startSec)
      expect(w.endSec).toBeGreaterThanOrEqual(w.startSec)
      expect(w.endSec).toBeLessThanOrEqual(t.endSec)
    }
    expect(out.wordsDropped).toBe(false)
  })

  it('the word list stays whole, so per-word rendering stays enabled', () => {
    // areWordsValidForText compares the word concatenation against the WHOLE
    // cue text.  Any strategy that removes spans fails this and silently
    // demotes the cue to the equal split.
    const e = entry({ words: words([[10, 12], [12, 14], [14, 16], [16, 18], [18, 20]]) })
    for (const cuts of [[cut(0, 5)], [cut(13, 15)], [cut(14, 16)], [cut(9, 13)], [cut(11, 12), cut(17, 19, 'c2')]]) {
      const out = translateEntryToEditedAxis(e, cuts)!
      expect(out.entry.words).toHaveLength(5)
      expect(areWordsValidForText(out.entry.words, out.entry.text)).toBe(true)
    }
  })

  it('every character is still coloured: words span the cue window end to end', () => {
    // The owner's invariant.  Whatever the cut does, the first word must not
    // start before the cue and the last must not end after it — the karaoke
    // clock is the cue's own window.
    const e = entry({ words: words([[10, 12], [12, 14], [14, 16], [16, 18], [18, 20]]) })
    for (const cuts of [[cut(0, 5)], [cut(13, 15)], [cut(14, 16)], [cut(9, 13)], [cut(19, 25)]]) {
      const out = translateEntryToEditedAxis(e, cuts)
      if (out === null) continue
      const w = out.entry.words!
      expect(w[0].startSec).toBeGreaterThanOrEqual(out.entry.startSec)
      expect(w[w.length - 1].endSec).toBeLessThanOrEqual(out.entry.endSec)
    }
  })

  it('an empty cut list is the identity — the no-cuts burn path cannot move', () => {
    // §2-3: a project with no cuts must produce byte-identical output.
    // `ffmpeg-burnin` reaches this function only when cuts exist, and this
    // pins that routing it through anyway would still change nothing.
    const e = entry({ words: words([[10, 12], [12, 14], [14, 16], [16, 18], [18, 20]]) })
    const out = translateEntryToEditedAxis(e, [])!
    expect(out.wordsDropped).toBe(false)
    expect(out.entry.startSec).toBe(e.startSec)
    expect(out.entry.endSec).toBe(e.endSec)
    expect(out.entry.original.startSec).toBe(e.original.startSec)
    expect(out.entry.original.endSec).toBe(e.original.endSec)
    expect(out.entry.words).toEqual(e.words)
  })

  it('a cue fully inside a cut is still dropped', () => {
    const e = entry({ words: words([[10, 12], [12, 14], [14, 16], [16, 18], [18, 20]]) })
    expect(translateEntryToEditedAxis(e, [cut(5, 25)])).toBeNull()
  })

  it('a cue with no words survives translation untouched in that respect', () => {
    const e = entry()
    const out = translateEntryToEditedAxis(e, [cut(0, 5)])!
    expect(out.entry.words).toBeUndefined()
    expect(out.wordsDropped).toBe(false)
    expect(karaokeWordTimingBlocker(out.entry)).toBe('no-words')
  })

  it('the user toggle still wins after translation', () => {
    const e = entry({
      words: words([[10, 12], [12, 14], [14, 16], [16, 18], [18, 20]]),
      karaokeUseWordTimings: false,
    })
    const out = translateEntryToEditedAxis(e, [cut(0, 5)])!
    expect(resolveKaraokeTiming(out.entry)).toEqual({ mode: 'even', reason: 'user-off' })
  })
})
