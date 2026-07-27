/**
 * REQ-0311 §4 — karaoke SWEEP (`\kf`) emitter.
 *
 * ## Deliberately isolated
 *
 * This is an experimental alternative to the shipping `\k` (instant switch)
 * path in `karaoke-ass.ts`, which this module does not touch.  Everything the
 * sweep needs lives here or behind an `if` guarded by the `karaokeStyle`
 * setting.  To drop the feature entirely: delete this file, its test, the
 * `karaokeStyle` settings key, the two `if` branches (ass-generator +
 * subtitle-overlay), the rAF branch in video-preview-panel, and the one UI row.
 * Nothing in the `\k` path changes.
 *
 * ## `\k` vs `\kf`
 *
 *   `\k`  — the syllable flips from Secondary to Primary the instant its slot
 *           starts.  Sticky, one-way.
 *   `\kf` — the syllable FILLS left-to-right across its slot's duration.
 *
 * ## Why the durations differ from the `\k` path (the trap the REQ flagged)
 *
 * `buildKaraokeAssText` gives each word `words[i+1].startSec - words[i].startSec`
 * so inter-word silence is absorbed by the preceding word.  That is right for
 * `\k`: the word is already fully lit, and holding it lit through the pause is
 * exactly what should happen.
 *
 * Reusing it for `\kf` would be wrong — the fill would keep creeping across the
 * word during the silence, so the sweep would visibly lag behind the voice and
 * a long pause would make one word crawl.  Instead:
 *
 *   - each word sweeps over its OWN speech duration (`endSec - startSec`)
 *   - each silence is emitted as a separate, TEXTLESS `{\k<gap>}` block that
 *     advances the karaoke clock without painting anything
 *
 * The textless-`\k`-advances-the-clock mechanism is not new: the `\k` path
 * already uses it for the cue's leading offset, so it is proven in shipping
 * output.
 *
 * A word whose `endSec <= startSec` (or which is missing timing) falls back to
 * the gap-absorbing duration, so degenerate input still produces a monotonic
 * timeline rather than a zero-length sweep.
 *
 * ## Emphasis
 *
 * Runs after the first carry no `\k*` tag, so they stay part of the SAME `\kf`
 * syllable and the fill crosses them continuously — matching the `\k` path,
 * where every run of a word lights together.
 *
 * ## Override-tag enclosure
 *
 * Every tag is wrapped in braces.  A bare `\kf` in the text field renders as
 * literal characters and desynchronises the whole line (REQ-0291).
 */
import type { WordSpan } from './types'
import { computeKaraokeBreaks } from './karaoke-ass'
import { splitTextByLocalRanges, type EmphasisRange } from './emphasis'

export interface KaraokeSweepEmphasis {
  /** word index -> local (within-word) emphasised ranges */
  ranges: ReadonlyMap<number, readonly EmphasisRange[]>
  openTag: string
  closeTag: string
}

const toCs = (sec: number): number => Math.max(0, Math.round(sec * 100))

/**
 * The textless `{\k<gap>}` block that advances the karaoke clock across a
 * silence without painting anything.
 *
 * Returns `''` for a non-positive gap (words that abut, or overlap).
 *
 * REQ-0330 §1 — extracted so the ass-generator can emit the silence that
 * precedes a display line at the END of the PREVIOUS line's body, which is
 * where the single-body emitter used to put it (the gap block is pushed
 * before the `\N`, not after it).  Building the block by hand at the call
 * site would have duplicated the centisecond rounding, which is exactly the
 * kind of second source this codebase keeps getting bitten by.
 */
export function buildSweepGapBlock(gapSec: number): string {
  return gapSec > 0 ? `{\\k${toCs(gapSec)}}` : ''
}

/**
 * Builds the `\kf` body for one cue.  Signature mirrors `buildKaraokeAssText`
 * so the two are drop-in alternatives at the call site.
 */
export function buildKaraokeSweepAssText(
  words: readonly WordSpan[],
  cueStartSec: number,
  cueEndSec: number,
  escapeText: (s: string) => string,
  cueText?: string,
  emphasis?: KaraokeSweepEmphasis,
): string {
  if (words.length === 0) return ''

  const breaks =
    cueText !== undefined ? computeKaraokeBreaks(cueText, words) : new Set<number>()

  const parts: string[] = []

  for (let i = 0; i < words.length; i++) {
    const w = words[i]

    // Silence before this word: from the cue start (i === 0) or from the
    // previous word's END.  Emitted as its own textless block so the sweep
    // never stretches across it.
    const prevEndSec = i === 0 ? cueStartSec : words[i - 1].endSec
    const gapBlock = buildSweepGapBlock(w.startSec - prevEndSec)
    if (gapBlock) parts.push(gapBlock)

    // Sweep duration = the word's own speech length.  Degenerate timings fall
    // back to the gap-absorbing rule so the line still advances.
    const speechSec = w.endSec - w.startSec
    const fallbackSec =
      (i + 1 < words.length ? words[i + 1].startSec : cueEndSec) - w.startSec
    const durationSec = Math.max(0, speechSec > 0 ? speechSec : fallbackSec)
    const kfTag = `\\kf${toCs(durationSec)}`

    if (breaks.has(i)) parts.push('\\N')
    const rawWordText = breaks.has(i) ? w.text.replace(/^\s+/, '') : w.text

    const localRanges = emphasis?.ranges.get(i)
    if (!localRanges || localRanges.length === 0) {
      parts.push(`{${kfTag}}${escapeText(rawWordText)}`)
      continue
    }
    const runs = splitTextByLocalRanges(rawWordText, localRanges)
    if (runs.length === 0) {
      parts.push(`{${kfTag}}`)
      continue
    }
    let opened = false
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r]
      if (run.emphasized) {
        parts.push(r === 0 ? `{${kfTag}${emphasis!.openTag}}` : `{${emphasis!.openTag}}`)
        parts.push(escapeText(run.text))
        opened = true
      } else {
        if (r === 0) parts.push(`{${kfTag}}`)
        if (opened) {
          parts.push(`{${emphasis!.closeTag}}`)
          opened = false
        }
        parts.push(escapeText(run.text))
      }
    }
    if (opened) parts.push(`{${emphasis!.closeTag}}`)
  }

  return parts.join('')
}

/**
 * Per-word sweep timing for the PREVIEW, derived from exactly the same rules as
 * the emitter above so the two cannot drift.  The overlay stamps these onto the
 * word spans and the rAF loop turns them into a gradient stop.
 */
export function sweepWordTimings(
  words: readonly WordSpan[],
  cueStartSec: number,
  cueEndSec: number,
): { startSec: number; durationSec: number }[] {
  return words.map((w, i) => {
    const speechSec = w.endSec - w.startSec
    const fallbackSec =
      (i + 1 < words.length ? words[i + 1].startSec : cueEndSec) - w.startSec
    void cueStartSec
    return {
      startSec: w.startSec,
      durationSec: Math.max(0, speechSec > 0 ? speechSec : fallbackSec),
    }
  })
}
