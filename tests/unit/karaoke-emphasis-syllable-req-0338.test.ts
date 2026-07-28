import { describe, it, expect } from 'vitest'
import { generateAss } from '../../src/main/services/ass-generator'
import type { SubtitleEntry, VideoInfo, BurninPosition, WordSpan } from '../../src/shared/types'

/**
 * REQ-0338 §1 — karaoke × keyword emphasis must never put a metric-changing
 * override INSIDE a karaoke syllable.
 *
 * ## The rule this pins, and how it was established
 *
 * libass stops colouring a karaoke syllable at the first override that changes
 * glyph METRICS.  Measured against the bundled ffmpeg on a lossless RGB burn
 * (`\kf400` over 8 glyphs, spoken-colour area fraction at 25 / 50 / 75 % of the
 * syllable):
 *
 *   `{\kf400}HHHHHHHH`                   → 0.250 / 0.502 / 0.750   fills
 *   `{\kf400}HHHH{\c&H0000FF&}HHHH`      → 0.250 / 0.502 / 0.750   fills
 *   `{\kf400}HHHH{\fs104}HHHH`           → 0.096 / 0.186 / 0.279   does NOT
 *   `{\kf400}HHHH{\fscx130\fscy130}HHHH` → 0.096 / 0.186 / 0.279   does NOT
 *   `{\kf400}HHHH{\b1}HHHH`              → 0.104 / 0.205 / 0.307   does NOT
 *   `{\kf400}HHHH{\fsp10}HHHH`           → …    / …    / 0.375     does NOT
 *   `{\kf100}HHHH{\kf100\fs104}HHHH`     → 0.186 / 0.372 / 0.687   fills
 *
 * Colour is transparent to the fill; geometry is not.  Everything from the
 * metric change to the end of the syllable stays in SecondaryColour until the
 * syllable's time expires — so the emphasised span burned in as an instant
 * switch even when the cue asked for a sweep, and when that syllable was the
 * cue's LAST its window ended with the cue, so those characters never reached
 * the spoken colour at all.  Both owner symptoms, one cause.
 *
 * The preview does not go through libass, which is why it looked right the
 * whole time (the REQ-0320 §1 shape).
 *
 * ## Why a structural assertion rather than a golden string
 *
 * The defect is not "these bytes changed"; it is "a tag class ended up in the
 * wrong place".  Pinning the exact body would have to be rewritten for every
 * unrelated tag addition and would still not say what is actually forbidden.
 * `assertNoMetricChangeInsideSyllable` states the rule, so it keeps holding for
 * emphasis shapes nobody has written a fixture for yet.
 */

const video: VideoInfo = {
  path: 'x.mp4', hasVideoStream: true, widthPx: 1280, heightPx: 720,
  durationSec: 10, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 0,
}
const burnin: BurninPosition = { horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40 }

const HARD_BREAK = String.fromCharCode(92) + 'N'

/** Overrides that move glyphs and therefore terminate a karaoke syllable. */
const METRIC_TAGS = /\\(fs\d|fsp|fscx|fscy|b1|b\d{3}|i1|fn)/

function makeEntry(patch: Partial<SubtitleEntry>): SubtitleEntry {
  const base: SubtitleEntry = {
    id: 'e1', startSec: 0, endSec: 4, text: 'x',
    fontSizePx: 80, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
    outlineThicknessPx: 2, fadeDurationSec: 0,
    horizontalPosition: 'center', verticalPosition: 'middle', verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    isDeleted: false, isEdited: false,
    karaokeEnabled: true, karaokeHighlightColor: '#FF0000',
    keywordEmphasisEnabled: true, emphasisColorHex: '#FF00FF',
    original: {
      startSec: 0, endSec: 4, text: 'x',
      fontSizePx: 80, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
      outlineThicknessPx: 2, fadeDurationSec: 0,
      horizontalPosition: 'center', verticalPosition: 'middle', verticalMarginPx: 40,
      subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    },
  }
  return { ...base, ...patch }
}

const dialogueBodies = (ass: string): string[] =>
  ass.split('\n').filter((l) => l.startsWith('Dialogue:')).map((l) => l.split(',,').slice(1).join(',,'))

/**
 * A metric change is harmful exactly when GLYPHS follow it inside the same
 * syllable — those are the glyphs libass then refuses to colour.  A restore tag
 * emitted at the very end of a syllable (the emphasis close tag on a word whose
 * last run is emphasised) paints nothing and is therefore allowed to stay: it
 * is the baseline for whatever the NEXT syllable opens with.
 *
 * The cue's own leading style block, before the first karaoke tag, is exempt —
 * it establishes the baseline for the whole line.
 */
function assertNoMetricChangeInsideSyllable(body: string): void {
  const tokens = body.split(/(\{[^}]*\})/).filter((t) => t !== '')
  const isBlock = (t: string): boolean => t.startsWith('{')
  const opensSyllable = (t: string): boolean => /^\{\\kf?\d/.test(t)
  let seenKaraoke = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!isBlock(t)) continue
    if (opensSyllable(t)) { seenKaraoke = true; continue }
    if (!seenKaraoke || !METRIC_TAGS.test(t)) continue
    for (let j = i + 1; j < tokens.length; j++) {
      if (isBlock(tokens[j])) {
        if (opensSyllable(tokens[j])) break
        continue
      }
      if (tokens[j].replace(/\\N/g, '') !== '') {
        throw new Error(`metric change mid-syllable: ${t} then "${tokens[j]}" in ${body}`)
      }
    }
  }
}

/** Centiseconds the body's karaoke tags advance the clock by, per event. */
const clockCs = (body: string): number =>
  [...body.matchAll(/\\kf?(\d+)/g)].reduce((a, m) => a + Number(m[1]), 0)

const words: WordSpan[] = [
  { startSec: 0.0, endSec: 1.0, text: 'alpha' },
  { startSec: 1.0, endSec: 2.0, text: ' bravo' },
  { startSec: 2.0, endSec: 4.0, text: ' charlie' },
]
const oneLine = 'alpha bravo charlie'
const twoLine = 'alpha bravo' + HARD_BREAK + 'charlie'

const span = (text: string, s: string): { start: number; end: number; text: string } => ({
  start: text.indexOf(s), end: text.indexOf(s) + s.length, text: s,
})

const SHAPES: { name: string; text: string; sub: string }[] = [
  { name: 'emphasis mid-word', text: oneLine, sub: 'har' },
  { name: 'emphasis at a word head', text: oneLine, sub: 'charlie' },
  { name: 'emphasis at a word tail', text: oneLine, sub: 'lie' },
  { name: 'emphasis inside the LAST word of a 2-line cue', text: twoLine, sub: 'har' },
  { name: 'emphasis straddling the hard break', text: twoLine, sub: 'bravo' + HARD_BREAK + 'charlie' },
  { name: 'emphasis spanning two words', text: oneLine, sub: 'bravo charlie' },
]

for (const style of ['sweep', 'switch'] as const) {
  describe(`REQ-0338 §1 — ${style}: no metric change inside a karaoke syllable`, () => {
    for (const shape of SHAPES) {
      it(shape.name, () => {
        const entry = makeEntry({
          text: shape.text,
          words,
          emphasisSpans: [span(shape.text, shape.sub)],
          original: { ...makeEntry({}).original, text: shape.text },
        })
        for (const body of dialogueBodies(generateAss([entry], video, burnin, undefined, undefined, true, style))) {
          assertNoMetricChangeInsideSyllable(body)
        }
      })
    }

    it('splitting a word into runs does not change how far the clock advances', () => {
      const base = { text: oneLine, words, original: { ...makeEntry({}).original, text: oneLine } }
      const plain = makeEntry({ ...base, keywordEmphasisEnabled: false })
      const ass = (e: SubtitleEntry): string =>
        generateAss([e], video, burnin, undefined, undefined, true, style)
      const plainCs = dialogueBodies(ass(plain)).map(clockCs)
      for (const shape of SHAPES.filter((s) => s.text === oneLine)) {
        const emph = makeEntry({ ...base, emphasisSpans: [span(oneLine, shape.sub)] })
        expect(dialogueBodies(ass(emph)).map(clockCs), shape.name).toEqual(plainCs)
      }
    })
  })
}

describe('REQ-0338 §1 — the switch path still lights a whole word at one instant', () => {
  it('every run of an emphasised word activates at the same time', () => {
    const text = oneLine
    const entry = makeEntry({
      text, words,
      emphasisSpans: [span(text, 'har')],
      original: { ...makeEntry({}).original, text },
    })
    const body = dialogueBodies(generateAss([entry], video, burnin, undefined, undefined, true, 'switch'))[0]
    // "c" | "har" | "lie" — the first two runs must carry `\k0` so all three
    // become spoken together; the word's whole duration rides on the last.
    expect(body).toContain('{\\k0} c')
    expect(body).toMatch(/\{\\k0\\fs\d+\\c&H[0-9A-F]{8}&\}har/)
    expect(body).toMatch(/\{\\k200\\fs\d+\\c&H[0-9A-F]{8}&\}lie/)
  })
})
