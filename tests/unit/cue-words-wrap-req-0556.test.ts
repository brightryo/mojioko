import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyCueEdit, collectCueEditWarnings, validateCueEdits } from '../../src/shared/cue-edit'
import { wrapCueText } from '../../src/shared/cue-wrap'
import { WIDTH_AFFECTING_PATHS, needsLineBreakRecheck } from '../../src/shared/cue-edit'
import { applyAutoLineBreakCore, type LineBreakMetrics } from '../../src/shared/line-break-core'
import {
  clampEmphasisScalePercent,
  mapRangesAcrossBreakCollapse,
  resolveEmphasisRanges,
} from '../../src/shared/emphasis'
import { areWordsValidForText } from '../../src/shared/words-validity'
import type { RenderNotice } from '../../src/shared/render-notice'
import type { SubtitleEntry, WordSpan } from '../../src/shared/types'

/**
 * REQ-0556 — the third wave: word timings and the wrap operations.
 *
 * §1 makes `words` writable, closing the read/write symmetry
 * (`read_subtitle --with-words` could show them; nothing could set them).
 * §2 makes the two wrap buttons reachable, through the same code the buttons
 * use.
 */

/** Metrics that need no font files: every glyph one em wide. */
const FIXED_METRICS: LineBreakMetrics = {
  font: null,
  libassScale: 1,
  cmap: null,
  tofu: null,
} as unknown as LineBreakMetrics

function cue(over: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base = {
    id: 'c-1', startSec: 0, endSec: 2, text: 'ここが重要です',
    fontSizePx: 60, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
    outlineThicknessPx: 8, fadeDurationSec: 0,
    horizontalPosition: 'center' as const, verticalPosition: 'bottom' as const,
    verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black' as const, opacityPercent: 50 },
    isDeleted: false, isEdited: false,
    ...over,
  }
  return { ...base, original: { ...base } } as unknown as SubtitleEntry
}

const WORDS: WordSpan[] = [
  { text: 'ここが', startSec: 0, endSec: 0.5 },
  { text: '重要', startSec: 0.5, endSec: 1 },
  { text: 'です', startSec: 1, endSec: 1.5 },
] as unknown as WordSpan[]

const warnFor = (before: SubtitleEntry, edit: Parameters<typeof applyCueEdit>[1]) => {
  const { entry, changed } = applyCueEdit(before, edit)
  const out: RenderNotice[] = []
  collectCueEditWarnings(before, entry, changed, true, out)
  return { entry, changed, notices: out, codes: out.map((w) => w.code) }
}

// ---------------------------------------------------------------------------
// §1 — words
// ---------------------------------------------------------------------------

describe('REQ-0556 §1 — word timings are writable', () => {
  it('★ writes the words a caller supplies', () => {
    const { entry, changed } = applyCueEdit(cue(), { select: { id: 'c-1' }, words: [...WORDS] })
    expect(entry.words).toEqual(WORDS)
    expect(changed).toContain('words')
  })

  it('★ what read_subtitle --with-words shows can be written straight back', () => {
    // The symmetry this REQ is about: the read shape IS the write shape.
    const source = cue({ words: WORDS })
    const readBack = (source.words ?? []).map((w) => ({ text: w.text, startSec: w.startSec, endSec: w.endSec }))
    const { entry, changed } = applyCueEdit(cue(), { select: { id: 'c-1' }, words: readBack })
    expect(entry.words).toEqual(WORDS)
    expect(changed).toEqual(['words'])
  })

  it('re-writing identical words is a no-op', () => {
    const { changed } = applyCueEdit(cue({ words: WORDS }), { select: { id: 'c-1' }, words: [...WORDS] })
    expect(changed).toEqual([])
  })

  it('★ words that do not spell the text are STORED, and warned about', () => {
    // The defensive rule (REQ-0288 / REQ-0555 §1): keeping a mismatch costs a
    // fallback to the even split; discarding it costs a re-transcription.
    const r = warnFor(cue(), {
      select: { id: 'c-1' },
      words: [{ text: 'まったく', startSec: 0, endSec: 1 }],
    })
    expect(r.entry.words).toHaveLength(1)
    expect(r.codes).toContain('KARAOKE_NO_WORD_TIMING')
  })

  it('★ …and the warning says WHICH situation it is', () => {
    // Karaoke is off here, so the old message ("karaoke is enabled, but…")
    // would have been simply untrue.
    const r = warnFor(cue(), { select: { id: 'c-1' }, words: [{ text: 'ちがう', startSec: 0, endSec: 1 }] })
    const notice = r.notices.find((w) => w.code === 'KARAOKE_NO_WORD_TIMING')
    expect((notice?.detail as Record<string, unknown>)?.source).toBe('patch')
    expect((notice?.detail as Record<string, unknown>)?.karaokeEnabled).toBe(false)
  })

  it('matching words produce no warning', () => {
    expect(warnFor(cue(), { select: { id: 'c-1' }, words: [...WORDS] }).codes).toEqual([])
  })

  it('★ text and words in ONE patch are judged against the NEW text', () => {
    // REQ-0556 §1: the state the cue ends in is the only one worth validating.
    // Words matching the OLD text must be reported as mismatched…
    const stale = warnFor(cue(), { select: { id: 'c-1' }, text: '別の文です', words: [...WORDS] })
    expect(stale.codes).toContain('KARAOKE_NO_WORD_TIMING')

    // …and words matching the NEW text must NOT be.
    const fresh = warnFor(cue(), {
      select: { id: 'c-1' },
      text: '別の文です',
      words: [{ text: '別の', startSec: 0, endSec: 1 }, { text: '文です', startSec: 1, endSec: 2 }],
    })
    expect(fresh.codes).not.toContain('KARAOKE_NO_WORD_TIMING')
    expect(areWordsValidForText(fresh.entry.words, fresh.entry.text)).toBe(true)
  })

  it('★ order matters: words written against the OLD text would have passed', () => {
    // The negative control for the rule above — if validation ran against the
    // pre-patch text, this exact patch would have been judged VALID.
    const before = cue()
    expect(areWordsValidForText(WORDS, before.text)).toBe(true)          // old text: valid
    const after = applyCueEdit(before, { select: { id: 'c-1' }, text: '別の文です', words: [...WORDS] }).entry
    expect(areWordsValidForText(after.words, after.text)).toBe(false)    // new text: not
  })
})

describe('REQ-0556 §1 — validation of words', () => {
  const problems = (edits: unknown): string[] => validateCueEdits(edits).problems.map((p) => p.message)

  it('rejects an unknown field inside a word', () => {
    expect(problems([{ select: { id: 'a' }, words: [{ text: 'x', startSec: 0, endSec: 1, conf: 0.9 }] }]).join())
      .toContain('conf')
  })

  it('rejects a non-array', () => {
    expect(problems([{ select: { id: 'a' }, words: 'nope' }]).join()).toContain('words は配列')
  })

  it('rejects a missing or non-numeric time', () => {
    expect(problems([{ select: { id: 'a' }, words: [{ text: 'x', startSec: 0 }] }]).length).toBeGreaterThan(0)
    expect(problems([{ select: { id: 'a' }, words: [{ text: 'x', startSec: '0', endSec: 1 }] }]).length).toBeGreaterThan(0)
  })

  it('★ rejects a zero-length word — unlike a text mismatch, it has no fallback', () => {
    // `\kf` consumes a duration; a non-positive one makes the highlight jump
    // rather than sweep, and there is no sensible degraded behaviour to pick.
    expect(problems([{ select: { id: 'a' }, words: [{ text: 'x', startSec: 1, endSec: 1 }] }]).join())
      .toContain('endSec > startSec')
  })

  it('accepts a well-formed list', () => {
    expect(validateCueEdits([{ select: { id: 'a' }, words: [{ text: 'x', startSec: 0, endSec: 1 }] }]).problems)
      .toEqual([])
  })
})

// ---------------------------------------------------------------------------
// §2 — wrap
// ---------------------------------------------------------------------------

describe('REQ-0556 §2 — the two wrap modes', () => {
  const long = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ'

  it('pack inserts breaks in text that overflows', () => {
    const out = wrapCueText(cue({ text: long, fontSizePx: 100 }), 'pack',
      { videoWidthPx: 640, marginLrPx: 10, metrics: FIXED_METRICS })
    expect(out).toContain('\\N')
  })

  it('★ pack DISCARDS the manual breaks; overflow KEEPS them', () => {
    // The one thing that distinguishes the two buttons.
    const manual = 'あい\\Nうえお'
    const packed = wrapCueText(cue({ text: manual, fontSizePx: 10 }), 'pack',
      { videoWidthPx: 1920, marginLrPx: 10, metrics: FIXED_METRICS })
    const kept = wrapCueText(cue({ text: manual, fontSizePx: 10 }), 'overflow',
      { videoWidthPx: 1920, marginLrPx: 10, metrics: FIXED_METRICS })
    expect(packed).toBe('あいうえお')     // small font ⇒ fits on one line once collapsed
    expect(kept).toBe(manual)             // nothing overflows ⇒ untouched
  })

  it('text that already fits is returned unchanged ("no change" is a real answer)', () => {
    const e = cue({ text: 'みじかい', fontSizePx: 10 })
    expect(wrapCueText(e, 'overflow', { videoWidthPx: 1920, marginLrPx: 10, metrics: FIXED_METRICS }))
      .toBe(e.text)
  })

  it('★ a free build measures emphasis the way it will RENDER it', () => {
    // Measuring enlarged glyphs that will not be drawn would wrap text that
    // does not overflow — the wrap must agree with the burn, not with the
    // project's intent.
    const e = cue({
      text: long, fontSizePx: 60,
      keywordEmphasisEnabled: true, emphasisScalePercent: 200,
      emphasisSpans: [{ start: 0, end: 10, text: long.slice(0, 10) }],
    })
    const opts = { videoWidthPx: 1280, marginLrPx: 10, metrics: FIXED_METRICS }
    const measured = wrapCueText(e, 'pack', { ...opts, emphasisTierAllowed: true })
    const notMeasured = wrapCueText(e, 'pack', { ...opts, emphasisTierAllowed: false })
    expect(measured).not.toBe(notMeasured)
  })
})

/**
 * ★ REQ-0556 §3-1 — "the CLI wrap equals the GUI wrap".
 *
 * Both surfaces now call `wrapCueText`, so the honest way to check the claim is
 * to reconstruct what the GUI used to do inline — the pack/overflow input prep
 * and the emphasis-range mapping that lived in `entry-row-actions.ts` — and show
 * the shared function reproduces it exactly, on the cue shapes where the prep
 * actually matters (manual breaks + emphasis).
 *
 * If the extraction had dropped `mapRangesAcrossBreakCollapse`, the emphasised
 * cases below would diverge while every plain case still matched — which is
 * precisely the divergence that would otherwise reach a burn unnoticed.
 */
describe('REQ-0556 §3-1 — the shared wrap reproduces the GUI composition', () => {
  /** Verbatim reconstruction of the pre-extraction `wrapRow` body. */
  const legacyWrap = (entry: SubtitleEntry, mode: 'pack' | 'overflow', widthPx = 960): string => {
    const input = mode === 'pack' ? entry.text.replace(/\\N/g, '') : entry.text
    const emphasis = entry.keywordEmphasisEnabled === true
      ? {
          ranges: mode === 'pack'
            ? mapRangesAcrossBreakCollapse(entry.text, resolveEmphasisRanges(entry), 0)
            : resolveEmphasisRanges(entry),
          scale: clampEmphasisScalePercent(entry.emphasisScalePercent) / 100,
        }
      : undefined
    return applyAutoLineBreakCore(
      input, entry.fontSizePx, entry.outlineThicknessPx, widthPx, 10, FIXED_METRICS, emphasis,
    )
  }

  const CASES: { name: string; entry: SubtitleEntry }[] = [
    { name: 'plain', entry: cue({ text: 'あいうえおかきくけこさしすせそたちつてと', fontSizePx: 80 }) },
    { name: 'with manual breaks', entry: cue({ text: 'あいうえお\\Nかきくけこさしすせそたちつてと', fontSizePx: 80 }) },
    {
      name: 'emphasised after a manual break',
      entry: cue({
        text: 'あいうえお\\Nかきくけこさしすせそ', fontSizePx: 80,
        keywordEmphasisEnabled: true, emphasisScalePercent: 180,
        emphasisSpans: [{ start: 7, end: 11, text: 'きくけこ' }],
      }),
    },
    {
      name: 'emphasised before a manual break',
      entry: cue({
        text: 'あいうえお\\Nかきくけこさしすせそ', fontSizePx: 80,
        keywordEmphasisEnabled: true, emphasisScalePercent: 180,
        emphasisSpans: [{ start: 0, end: 3, text: 'あいう' }],
      }),
    },
  ]

  for (const mode of ['pack', 'overflow'] as const) {
    for (const c of CASES) {
      it(`${mode} — ${c.name}`, () => {
        expect(wrapCueText(c.entry, mode, {
          videoWidthPx: 960, marginLrPx: 10, metrics: FIXED_METRICS, emphasisTierAllowed: true,
        })).toBe(legacyWrap(c.entry, mode))
      })
    }
  }

  it('★ negative control: dropping the range remapping measures the wrong glyphs', () => {
    /*
     * Without this, every equivalence test above could pass on a `wrapCueText`
     * that never remapped anything. This shows the remapping is load-bearing:
     * the span sits AFTER the manual break, so collapsing the two `\N`
     * characters shifts it two places left.
     */
    const shifted = cue({
      text: 'あいうえお\\Nかきくけこさしすせそ', fontSizePx: 80,
      keywordEmphasisEnabled: true, emphasisScalePercent: 200,
      emphasisSpans: [{ start: 7, end: 11, text: 'かきくけ' }],
    })
    const raw = resolveEmphasisRanges(shifted)
    const mapped = mapRangesAcrossBreakCollapse(shifted.text, raw, 0)
    // The ranges really do move — otherwise the rest of this test proves nothing.
    expect(raw).toEqual([[7, 11]])
    expect(mapped).toEqual([[5, 9]])

    const WIDTH = 700
    const withMapping = wrapCueText(shifted, 'pack',
      { videoWidthPx: WIDTH, marginLrPx: 10, metrics: FIXED_METRICS, emphasisTierAllowed: true })
    // The un-remapped ranges: the enlarged glyphs are measured two characters
    // to the right of where they actually are.
    const withoutMapping = applyAutoLineBreakCore(
      shifted.text.replace(/\\N/g, ''), shifted.fontSizePx, shifted.outlineThicknessPx,
      WIDTH, 10, FIXED_METRICS, { ranges: raw, scale: 2 },
    )
    expect(withMapping).not.toBe(withoutMapping)
    expect(withMapping).toBe(legacyWrap(shifted, 'pack', WIDTH))
  })
})

describe('REQ-0556 §2 — one implementation, reached by both callers', () => {
  const read = (p: string) => readFileSync(join(__dirname, '../..', p), 'utf8')
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('★ the GUI wrap buttons call the shared wrap', () => {
    const src = stripComments(read('src/renderer/lib/entry-row-actions.ts'))
    expect(src).toContain('wrapCueText')
    // The inline prep is gone — if it came back, the button and the CLI could
    // wrap the same cue differently.
    expect(src).not.toContain('mapRangesAcrossBreakCollapse')
  })

  it('★ the CLI wrap calls it too, and does not re-derive the mode difference', () => {
    const src = stripComments(read('src/main/cli/commands/edit-cues.ts'))
    expect(src).toContain('wrapCueText')
    expect(src).not.toContain('mapRangesAcrossBreakCollapse')
    expect(src).not.toContain('applyAutoLineBreakCore')
  })
})

/**
 * ★ REQ-0563 — tell the agent its line breaks may have gone stale.
 *
 * Observed for real: an agent set emphasis at 145–160%, and the `\`N positions
 * computed at transcription time no longer fitted the enlarged glyphs, so the
 * burn split words mid-token. One `wrap:'pack'` fixed it, but nothing had said
 * so — and an agent cannot look at the output and notice.
 *
 * The risk with any hint is that it fires so often it stops being read
 * (REQ-0502). These tests are mostly about the cases where it must STAY QUIET.
 */
describe('REQ-0563 §1 — the stale-line-break hint', () => {
  const multi = (over: Partial<SubtitleEntry> = {}) =>
    cue({ text: '一行目\\N二行目', ...over })
  const single = (over: Partial<SubtitleEntry> = {}) =>
    cue({ text: '一行だけ', ...over })

  describe('fires when a width-affecting field changed on a multi-line cue', () => {
    it('★ text', () => {
      expect(needsLineBreakRecheck(['text'], multi(), false)).toBe(true)
    })
    it('★ font size', () => {
      expect(needsLineBreakRecheck(['style.fontSizePx'], multi(), false)).toBe(true)
    })
    it('★ emphasis turned ON', () => {
      expect(needsLineBreakRecheck(['style.emphasis.enabled'],
        multi({ keywordEmphasisEnabled: true }), false)).toBe(true)
    })
    it('★ emphasis scale changed — the case actually observed', () => {
      expect(needsLineBreakRecheck(['style.emphasis.scalePercent'],
        multi({ keywordEmphasisEnabled: true }), false)).toBe(true)
    })
    it('★ emphasis spans changed while emphasis is on', () => {
      expect(needsLineBreakRecheck(['emphasisSpans'],
        multi({ keywordEmphasisEnabled: true }), false)).toBe(true)
    })
  })

  describe('stays quiet otherwise', () => {
    it('★ a colour-only change cannot alter width', () => {
      expect(needsLineBreakRecheck(['style.textColorHex'], multi(), false)).toBe(false)
    })
    it('★ a timing-only change cannot alter width', () => {
      expect(needsLineBreakRecheck(['startSec', 'endSec'], multi(), false)).toBe(false)
    })
    it('★ the caller already re-wrapped in the same call', () => {
      // Suggesting the fix someone just applied is noise.
      expect(needsLineBreakRecheck(['text'], multi(), true)).toBe(false)
    })
    it('★ a SINGLE-line cue has no stored breaks to go stale', () => {
      expect(needsLineBreakRecheck(['text', 'style.fontSizePx'], single(), false)).toBe(false)
    })
    it('★ spans changed but emphasis is OFF — nothing is drawn bigger', () => {
      // That combination has its own warning (EMPHASIS_SPANS_WITHOUT_ENABLE);
      // it does not change any width.
      expect(needsLineBreakRecheck(['emphasisSpans'],
        multi({ keywordEmphasisEnabled: false }), false)).toBe(false)
    })
    it('emphasis scale changed while emphasis is OFF', () => {
      expect(needsLineBreakRecheck(['style.emphasis.scalePercent'],
        multi({ keywordEmphasisEnabled: false }), false)).toBe(false)
    })
    it('nothing changed at all', () => {
      expect(needsLineBreakRecheck([], multi(), false)).toBe(false)
    })
  })

  it('★ negative control: without the multi-line guard, a plain cue would fire', () => {
    /*
     * The three conditions are ANDed, and each one suppresses a real case. This
     * shows the single-line guard is load-bearing rather than decorative: the
     * same change on a cue WITH breaks does fire.
     */
    expect(needsLineBreakRecheck(['text'], single(), false)).toBe(false)
    expect(needsLineBreakRecheck(['text'], multi(), false)).toBe(true)
  })

  it('the width-affecting list is the one the warning reports from', () => {
    // The detail names which of the caller's changes triggered the hint; a
    // second hand-written list would drift from the predicate.
    expect([...WIDTH_AFFECTING_PATHS].sort()).toEqual(
      ['emphasisSpans', 'style.emphasis.enabled', 'style.emphasis.scalePercent',
        'style.fontSizePx', 'text'].sort(),
    )
  })

  it('★ the command emits it, gated on the wrap requested in the same edit', () => {
    const src = readFileSync(join(__dirname, '../../src/main/cli/commands/edit-cues.ts'), 'utf8')
    expect(src).toContain('LINE_BREAKS_MAY_BE_STALE')
    expect(src).toContain('needsLineBreakRecheck(changed, final, Boolean(edit.wrap))')
  })
})
