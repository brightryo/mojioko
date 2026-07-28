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
 * ## Emphasis — why every run gets its OWN `\kf` (REQ-0338 §1)
 *
 * Up to REQ-0337 a word was ONE `\kf` syllable and the emphasis open/close tags
 * were emitted inside it, on the premise that the fill would cross the runs
 * continuously.  **libass does not do that.**  Measured against the bundled
 * ffmpeg (lossless RGB burn, `\kf400` over 8 glyphs, sampled at 25/50/75 % of
 * the syllable):
 *
 *   `{\kf400}HHHHHHHH`                  → 0.250 / 0.502 / 0.750   (fills)
 *   `{\kf400}HHHH{\c&H0000FF&}HHHH`     → 0.250 / 0.502 / 0.750   (fills)
 *   `{\kf400}HHHH{\fs104}HHHH`          → 0.096 / 0.186 / 0.279   (does NOT)
 *   `{\kf400}HHHH{\fscx130\fscy130}HHHH`→ 0.096 / 0.186 / 0.279   (does NOT)
 *   `{\kf400}HHHH{\b1}HHHH`             → 0.104 / 0.205 / 0.307   (does NOT)
 *
 * A colour-only override is transparent to the fill; **any override that
 * changes glyph metrics ends it.**  Everything from that override to the end of
 * the syllable is left in SecondaryColour and flips to Primary only when the
 * syllable's time expires — i.e. it renders as `\k` (instant switch) no matter
 * what the user picked.  Two owner-visible symptoms, one cause:
 *
 *   1. the emphasised span switches instead of sweeping;
 *   2. when that syllable is the cue's LAST, its window ends with the cue, so
 *      the emphasised run and everything after it in the word never reach the
 *      spoken colour at all — the sweep appears to stop just before the
 *      emphasised characters and stay there.
 *
 * The emphasis size change is the whole point of the feature, so the fix is to
 * stop putting it INSIDE a syllable: each run opens its own `{\kf…}` block with
 * the style change folded in, so every syllable is metrically uniform.  Proven
 * by the same harness: `{\kf100}HHHH{\kf100\fs104}HHHH` → 0.186 / 0.372 / 0.687,
 * a continuous fill across the size change.
 *
 * The word's sweep time is apportioned across its runs **in proportion to their
 * code-point counts**, and by differencing a running cumulative total so the
 * per-run centiseconds sum EXACTLY to the centiseconds the un-split word would
 * have had.  Linear interpolation inside a word is the same approximation
 * `splitWordsAtHardBreaks` already makes when a `\N` cuts a unit, and it is the
 * best available here: the ASS writer has no glyph metrics, so it cannot know
 * that the emphasised run is also wider.  The sweep therefore crosses an
 * emphasised run slightly faster than a plain one; it no longer skips it.
 *
 * The `\k` (switch) path in `karaoke-ass.ts` is deliberately NOT changed: `\k`
 * has no partial fill, so the metric change costs it nothing (verified — a
 * `{\k…}` word with a mid-word `\fs` lights in full), and splitting it would
 * make an emphasised span light at a different instant from the rest of its
 * word, which is a behaviour change rather than a fix.
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
 * REQ-0338 §1 — split `totalCs` centiseconds across parts weighted by `weights`,
 * so that the parts sum EXACTLY to `totalCs`.
 *
 * Rounding each part independently would drift, and a karaoke body whose tags
 * sum to less than the cue leaves its tail unspoken forever — the failure mode
 * REQ-0336 was filed for.  Differencing a rounded RUNNING TOTAL cannot drift:
 * the last boundary is `totalCs` by construction.
 *
 * An all-zero (or empty) weight vector puts everything on the first part, which
 * is the degenerate case where no part has any characters to sweep across.
 */
export function apportionCs(totalCs: number, weights: readonly number[]): number[] {
  const out = new Array<number>(weights.length).fill(0)
  if (weights.length === 0) return out
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0) {
    out[0] = totalCs
    return out
  }
  let consumed = 0
  let emitted = 0
  for (let i = 0; i < weights.length; i++) {
    consumed += weights[i]
    const upto = i === weights.length - 1 ? totalCs : Math.round((totalCs * consumed) / sum)
    out[i] = Math.max(0, upto - emitted)
    emitted = upto
  }
  return out
}

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
    // REQ-0338 §1 — one `\kf` PER RUN (see the "Emphasis" docstring section).
    // A single run reproduces the pre-REQ-0338 output byte-for-byte because the
    // whole word's centiseconds land on it.
    const runCs = apportionCs(toCs(durationSec), runs.map((run) => [...run.text].length))
    let opened = false
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r]
      const tag = `\\kf${runCs[r]}`
      if (run.emphasized) {
        parts.push(`{${tag}${emphasis!.openTag}}`)
        opened = true
      } else {
        parts.push(`{${tag}${opened ? emphasis!.closeTag : ''}}`)
        opened = false
      }
      parts.push(escapeText(run.text))
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
