import { describe, it, expect } from 'vitest'
import {
  STYLE_FIELDS,
  applyCueEdit,
  collectCueEditWarnings,
  resolveSelection,
  validateCueEdits,
  type CueEdit,
} from '../../src/shared/cue-edit'
import { summarizeSubtitleStyle } from '../../src/main/cli/subtitle-style'
import { areWordsValidForText } from '../../src/shared/words-validity'
import { buildProjectFile, parseProjectFile, serializeProjectFile } from '../../src/shared/project-file'
import type { RenderNotice } from '../../src/shared/render-notice'
import type { SubtitleEntry, VideoInfo, WordSpan } from '../../src/shared/types'

/**
 * REQ-0554 (design: RES-0552) — the cue patch semantics.
 *
 * `edit_cues` is the first API that can reach per-cue style and — the reason it
 * exists — the emphasis spans, which no headless caller could set before
 * (`EMPHASIS_NO_SPANS`). What is pinned here is the MEANING of a patch, which
 * lives in `shared/cue-edit.ts` precisely so the CLI and MCP cannot disagree
 * about it.
 */

const WORDS: WordSpan[] = [
  { text: 'ここが', startSec: 0, endSec: 0.5 },
  { text: '重要', startSec: 0.5, endSec: 1 },
  { text: 'です', startSec: 1, endSec: 1.5 },
] as unknown as WordSpan[]

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

describe('REQ-0554 — selection', () => {
  const entries = [cue({ id: 'a' }), cue({ id: 'b', isDeleted: true }), cue({ id: 'c' })]

  it('by id', () => {
    expect(resolveSelection(entries, { id: 'c' })).toEqual({ positions: [2], missing: [] })
  })

  it('★ by index counts NON-DELETED cues, matching read_subtitle', () => {
    // An agent that read index 1 must be able to write index 1. `b` is deleted,
    // so visible index 1 is the cue at array position 2.
    expect(resolveSelection(entries, { index: 1 }).positions).toEqual([2])
  })

  it('by ids, de-duplicated and in array order', () => {
    expect(resolveSelection(entries, { ids: ['c', 'a', 'c'] }).positions).toEqual([0, 2])
  })

  it('★ an unknown id is reported, not silently skipped', () => {
    const r = resolveSelection(entries, { ids: ['a', 'nope'] })
    expect(r.missing).toEqual(['nope'])
  })

  it('an out-of-range index is reported', () => {
    expect(resolveSelection(entries, { index: 99 }).missing).toEqual(['index:99'])
  })
})

describe('REQ-0554 — patch semantics', () => {
  it('reports only what actually changed', () => {
    const { entry, changed } = applyCueEdit(cue(), { select: { id: 'c-1' }, style: { fontSizePx: 96 } })
    expect(entry.fontSizePx).toBe(96)
    expect(changed).toEqual(['style.fontSizePx'])
  })

  it('★ a patch that sets the value it already has changes nothing', () => {
    // This is what the response's `unchanged` count is built from. A patch that
    // reported success for a no-op would be the "no-op that lies".
    const { changed } = applyCueEdit(cue({ fontSizePx: 96 }), { select: { id: 'c-1' }, style: { fontSizePx: 96 } })
    expect(changed).toEqual([])
  })

  it('★ a nested group is MERGED, not replaced', () => {
    // Reading a cue, changing one field and writing it back must not reset the
    // siblings the caller did not mention.
    const before = cue({ karaokeEnabled: false, karaokeHighlightColor: '#B4FF39' })
    const { entry } = applyCueEdit(before, { select: { id: 'c-1' }, style: { karaoke: { enabled: true } } })
    expect(entry.karaokeEnabled).toBe(true)
    expect(entry.karaokeHighlightColor).toBe('#B4FF39')
  })

  it('the background object keeps untouched siblings too', () => {
    const before = cue({ subtitleBackground: { enabled: false, color: 'white', opacityPercent: 30 } })
    const { entry } = applyCueEdit(before, { select: { id: 'c-1' }, style: { background: { enabled: true } } })
    expect(entry.subtitleBackground).toEqual({ enabled: true, color: 'white', opacityPercent: 30 })
  })

  it('writes emphasis spans, and reports them as changed', () => {
    const { entry, changed } = applyCueEdit(cue(), {
      select: { id: 'c-1' },
      emphasisSpans: [{ start: 2, end: 4, text: '重要' }],
    })
    expect(entry.emphasisSpans).toEqual([{ start: 2, end: 4, text: '重要' }])
    expect(changed).toContain('emphasisSpans')
  })

  it('marks the cue edited only when something moved', () => {
    expect(applyCueEdit(cue(), { select: { id: 'c-1' }, style: { fontSizePx: 96 } }).entry.isEdited).toBe(true)
    expect(applyCueEdit(cue(), { select: { id: 'c-1' } }).entry.isEdited).toBe(false)
  })
})

describe('REQ-0554 §2-1/§2-2 — ★ word timings are never collateral damage', () => {
  it('★ a STYLE-only change leaves words untouched and still valid', () => {
    // RES-0552 §3-3. "I changed the colour and the karaoke disappeared" must
    // not be possible.
    const before = cue({ words: WORDS, karaokeEnabled: true })
    const { entry } = applyCueEdit(before, {
      select: { id: 'c-1' },
      style: { textColorHex: '#FF0000', fontSizePx: 96, animation: { type: 'pop' } },
    })
    expect(entry.words).toBe(before.words)
    expect(areWordsValidForText(entry.words, entry.text)).toBe(true)
  })

  it('★ a TEXT change keeps the stored words (they are judged, not deleted)', () => {
    // REQ-0554 §2-2 inherits the non-destructive rule: restoring the text
    // restores the karaoke. `edit_subtitle` deletes them instead — the
    // divergence is deliberate and recorded in RES-0554.
    const before = cue({ words: WORDS })
    const { entry } = applyCueEdit(before, { select: { id: 'c-1' }, text: 'まったく違う文' })
    expect(entry.words).toEqual(WORDS)
    expect(areWordsValidForText(entry.words, entry.text)).toBe(false)
  })

  it('…and restoring the text makes them valid again', () => {
    const before = cue({ words: WORDS })
    const changedText = applyCueEdit(before, { select: { id: 'c-1' }, text: '別の文' }).entry
    const restored = applyCueEdit(changedText, { select: { id: 'c-1' }, text: 'ここが重要です' }).entry
    expect(areWordsValidForText(restored.words, restored.text)).toBe(true)
  })
})

describe('REQ-0554 §2-4 — unknown fields are rejected, not ignored', () => {
  const bad = (edits: unknown): string[] =>
    validateCueEdits(edits).problems.map((p) => p.message)

  it('★ an unknown top-level field', () => {
    expect(bad([{ select: { id: 'a' }, colour: '#fff' }]).join()).toContain('colour')
  })

  it('★ an unknown style field', () => {
    expect(bad([{ select: { id: 'a' }, style: { fontSizePixels: 10 } }]).join()).toContain('style.fontSizePixels')
  })

  it('★ an unknown field inside a group', () => {
    expect(bad([{ select: { id: 'a' }, style: { karaoke: { colour: 'x' } } }]).join()).toContain('style.karaoke.colour')
  })

  it('an unknown field inside a span', () => {
    expect(bad([{ select: { id: 'a' }, emphasisSpans: [{ start: 0, end: 1, text: 'x', bold: true }] }]).join())
      .toContain('bold')
  })

  it('a valid edit produces no problems', () => {
    expect(validateCueEdits([{ select: { id: 'a' }, style: { shadow: { depthPx: 4 } } }]).problems).toEqual([])
  })
})

describe('REQ-0554 — validation of values', () => {
  const problems = (edits: unknown): string[] => validateCueEdits(edits).problems.map((p) => p.message)

  it('★ a pin needs BOTH coordinates', () => {
    // One coordinate cannot produce a `\pos`, so accepting it would store a
    // half-state that changes nothing.
    expect(problems([{ select: { id: 'a' }, style: { position: { posX: 100 } } }]).join()).toContain('対で')
    expect(problems([{ select: { id: 'a' }, style: { position: { posX: 100, posY: 200 } } }])).toEqual([])
    // Both null = unpin, which is legal.
    expect(problems([{ select: { id: 'a' }, style: { position: { posX: null, posY: null } } }])).toEqual([])
  })

  it('endSec must be after startSec', () => {
    expect(problems([{ select: { id: 'a' }, startSec: 5, endSec: 5 }]).join()).toContain('endSec')
  })

  it('a span must have end > start', () => {
    expect(problems([{ select: { id: 'a' }, emphasisSpans: [{ start: 3, end: 3, text: '' }] }]).join())
      .toContain('end > start')
  })

  it('select must be one of the three shapes', () => {
    expect(problems([{ select: {} }]).length).toBeGreaterThan(0)
    expect(problems([{ select: { index: -1 } }]).length).toBeGreaterThan(0)
    expect(problems([{ select: { ids: [] } }]).length).toBeGreaterThan(0)
  })

  it('a non-array payload is rejected outright', () => {
    expect(validateCueEdits({ select: { id: 'a' } }).problems[0].message).toContain('配列')
  })
})

/**
 * ★ The drift guard.
 *
 * `read_subtitle --with_style` and `edit_cues`'s style patch are supposed to be
 * the same shape. `STYLE_FIELDS` is the single table relating them, so if a new
 * style field is added to the summary and not to the table, it becomes readable
 * but not writable — and nothing else in the codebase would notice.
 */
describe('REQ-0554 — the read shape and the write shape cannot drift apart', () => {
  it('★ every key the summary emits is writable', () => {
    const summary = summarizeSubtitleStyle(cue(), true) as unknown as Record<string, unknown>
    const writable = new Set(STYLE_FIELDS.map((f) => (f.group === null ? f.key : `${f.group}.${f.key}`)))

    const missing: string[] = []
    for (const [key, value] of Object.entries(summary)) {
      // `autoLineBreak` is a project-level flag the summary reports for context;
      // it is not a per-cue field and has no patch counterpart.
      if (key === 'autoLineBreak') continue
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const sub of Object.keys(value as Record<string, unknown>)) {
          if (!writable.has(`${key}.${sub}`)) missing.push(`${key}.${sub}`)
        }
        continue
      }
      if (!writable.has(key)) missing.push(key)
    }
    expect(missing, `readable but not writable: ${missing.join(', ')}`).toEqual([])
  })

  it('every table entry maps to a real stored field name', () => {
    // Catches a typo in the table that would silently write a field nothing reads.
    const entry = cue({ words: WORDS }) as unknown as Record<string, unknown>
    const knownish = new Set([...Object.keys(entry), 'shadowDepth', 'shadowColor', 'shadowAlpha',
      'textAlpha', 'outlineAlpha', 'rotation', 'casing', 'lineSpacingPercent', 'layer', 'posX', 'posY',
      'fontId', 'karaokeEnabled', 'karaokeStyle', 'karaokeHighlightColor',
      'keywordEmphasisEnabled', 'emphasisColorHex', 'emphasisScalePercent',
      'animationType', 'animationInEnabled', 'animationOutEnabled', 'animationDurationSec',
      'animationStartScalePercent', 'animationBlurPx'])
    const unknown = STYLE_FIELDS.map((f) => f.entry as string).filter((e) => !knownish.has(e))
    expect(unknown).toEqual([])
  })
})

describe('REQ-0554 — a whole-cue patch reads back as itself', () => {
  it('★ every writable field survives a write', () => {
    // The round trip the API promises: what you write is what the summary then
    // reports. Done here on the pure functions; the smoke does it through real
    // files and real pixels.
    const patch: CueEdit = {
      select: { id: 'c-1' },
      style: {
        fontSizePx: 96, textColorHex: '#112233', textAlphaPercent: 80,
        outlineColorHex: '#445566', outlineThicknessPx: 5, outlineAlphaPercent: 70,
        shadow: { depthPx: 10, color: '#778899', alphaPercent: 60 },
        rotationDeg: 15, casing: 'uppercase', lineSpacingPercent: -20, layer: 3,
        position: { horizontal: 'left', vertical: 'top', verticalMarginPx: 120 },
        karaoke: { enabled: true, style: 'switch', highlightColor: '#B4FF39' },
        emphasis: { enabled: true, color: '#FF2E88', scalePercent: 150 },
        animation: { type: 'pop', inEnabled: true, outEnabled: false, durationSec: 0.4, startScalePercent: 0, blurPx: 30 },
        background: { enabled: true, color: 'white', opacityPercent: 40 },
      },
    }
    const { entry } = applyCueEdit(cue(), patch)
    const s = summarizeSubtitleStyle(entry, true)
    expect(s.fontSizePx).toBe(96)
    expect(s.textAlphaPercent).toBe(80)
    expect(s.shadow).toEqual({ depthPx: 10, color: '#778899', alphaPercent: 60 })
    expect(s.rotationDeg).toBe(15)
    expect(s.layer).toBe(3)
    expect(s.position.horizontal).toBe('left')
    expect(s.karaoke).toEqual({ enabled: true, style: 'switch', highlightColor: '#B4FF39' })
    expect(s.emphasis).toEqual({ enabled: true, color: '#FF2E88', scalePercent: 150 })
    expect(s.animation.type).toBe('pop')
    expect(s.background).toEqual({ enabled: true, color: 'white', opacityPercent: 40 })
  })
})

/**
 * REQ-0554 \u00a72-7 \u2014 a project the AI edited still opens in the GUI.
 *
 * The GUI's open path (`renderer/services/project-file.ts`) and `edit_cues`
 * call the SAME `shared/project-file` functions, so this pins the thing that
 * would actually break: a patch storing a value the format's parser rejects, or
 * a field that does not survive serialization.
 */
describe('REQ-0554 \u00a72-7 \u2014 the edited file survives the GUI open path', () => {
  it('\u2605 a fully-patched cue serializes and re-parses unchanged', () => {
    const { entry } = applyCueEdit(cue({ words: WORDS }), {
      select: { id: 'c-1' },
      style: {
        fontSizePx: 96, rotationDeg: 15, layer: 2,
        emphasis: { enabled: true, color: '#FF2E88', scalePercent: 150 },
        position: { posX: 100, posY: 200 },
      },
      emphasisSpans: [{ start: 2, end: 4, text: '\u91cd\u8981' }],
    })

    // `buildProjectFile` is the GUI's own save builder — the same function the
    // Save command calls — so this is the real path, not a stand-in for it.
    const video: VideoInfo = {
      path: 'C:\v.mp4', hasVideoStream: true, widthPx: 1920, heightPx: 1080,
      durationSec: 10, fps: 30, container: 'mp4', videoCodec: 'h264',
      audioTracks: [{ index: 1, channels: 'stereo', sampleRateHz: 48000, codec: 'aac', language: 'und' }],
      fileSizeBytes: 1024,
    }
    const pf = buildProjectFile({
      appVersion: '1.4.0', video, transcribedTrackIndex: 1, entries: [entry], cuts: [],
      defaults: { fontSizePx: 100, textColorHex: '#FFFFFF', outlineColorHex: '#000000', outlineThicknessPx: 3, whisperModel: 'large-v3-turbo' },
      whisperModel: 'large-v3-turbo', device: 'cpu', now: new Date('2026-08-27T07:00:00+09:00'),
    })
    const parsed = parseProjectFile(serializeProjectFile(pf))
    expect(parsed.ok, parsed.ok ? '' : `parser rejected it: ${(parsed as { reason: string }).reason}`).toBe(true)
    if (!parsed.ok) return

    const back = parsed.project.editing.subtitles[0]
    expect(back.emphasisSpans).toEqual([{ start: 2, end: 4, text: '\u91cd\u8981' }])
    expect(back.fontSizePx).toBe(96)
    expect(back.rotation).toBe(15)
    expect(back.layer).toBe(2)
    expect(back.posX).toBe(100)
    expect(back.posY).toBe(200)
    // \u2605 and the karaoke timings are still there after the trip through disk.
    expect(areWordsValidForText(back.words, back.text)).toBe(true)
  })
})

/**
 * REQ-0554 §2-5 / §2-6 — the warnings.
 *
 * A patch that stores exactly what was asked for but renders nothing is the
 * failure mode this API is most prone to, because the caller is a program that
 * cannot look at the screen. Every one of these is "the write succeeded AND
 * here is why you will not see it".
 */
describe('REQ-0554 §1-3 — warnings for combinations that store but do not show', () => {
  const warn = (before: SubtitleEntry, after: SubtitleEntry, changed: string[], isPaid = true): string[] => {
    const out: RenderNotice[] = []
    collectCueEditWarnings(before, after, changed, isPaid, out)
    return out.map((w) => w.code)
  }

  it('spans stored while emphasis is off', () => {
    const after = cue({ emphasisSpans: [{ start: 0, end: 2, text: 'ここ' }], keywordEmphasisEnabled: false })
    expect(warn(cue(), after, ['emphasisSpans'])).toContain('EMPHASIS_SPANS_WITHOUT_ENABLE')
  })

  it('karaoke on with no usable word timing', () => {
    const after = cue({ karaokeEnabled: true, words: undefined })
    expect(warn(cue(), after, ['style.karaoke.enabled'])).toContain('KARAOKE_NO_WORD_TIMING')
  })

  it('a background box with a zero outline (BorderStyle=3 collapses it)', () => {
    const after = cue({ subtitleBackground: { enabled: true, color: 'black', opacityPercent: 50 }, outlineThicknessPx: 0 })
    expect(warn(cue(), after, ['style.background.enabled'])).toContain('BACKGROUND_NEEDS_OUTLINE')
  })

  it('★ §2-5 a paid font on a FREE build is stored, and warned about', () => {
    // CLAUDE.md §3-12: never refuse. A project authored in the paid edition has
    // to stay editable in the free one — the burn substitutes Noto and emits
    // FONT_TIER_SUBSTITUTED, so the honest thing is to say so at write time.
    const after = cue({ fontId: 'dela-gothic-one' })
    expect(warn(cue(), after, ['style.fontId'], false)).toContain('FONT_TIER_LOCKED')
  })

  it('★ §2-5 the same font on a PAID build warns about nothing', () => {
    expect(warn(cue(), cue({ fontId: 'dela-gothic-one' }), ['style.fontId'], true)).toEqual([])
  })

  it('★ §2-2 a text change that invalidates word timings warns (and does not delete them)', () => {
    const before = cue({ words: WORDS })
    const after = applyCueEdit(before, { select: { id: 'c-1' }, text: '別の文' }).entry
    expect(warn(before, after, ['text'])).toContain('WORD_TIMINGS_INVALIDATED')
    expect(after.words).toEqual(WORDS)
  })

  it('★ §2-6 a span that no longer sits on the text is warned, not silently dropped', () => {
    // The anchor `text` is what lets resolveEmphasis re-find a span after an
    // edit. When it can find neither the offsets nor the anchor, the span will
    // not render — and an agent must be told, or it will build its next
    // decision on emphasis that is not there.
    const after = cue({
      text: 'まったく違う文章',
      keywordEmphasisEnabled: true,
      emphasisSpans: [{ start: 40, end: 44, text: '存在しない' }],
    })
    expect(warn(cue(), after, ['emphasisSpans'])).toContain('EMPHASIS_SPAN_UNRESOLVED')
  })

  it('§2-6 a span that still matches its anchor does NOT warn', () => {
    const after = cue({ text: 'ここが重要です', keywordEmphasisEnabled: true,
      emphasisSpans: [{ start: 3, end: 5, text: '重要' }] })
    expect(warn(cue(), after, ['emphasisSpans'])).not.toContain('EMPHASIS_SPAN_UNRESOLVED')
  })

  it('★ one warning per code per call, however many cues share the problem', () => {
    // 50 cues with the same problem is one fact, not 50 lines for an agent to read.
    const out: RenderNotice[] = []
    const after = cue({ subtitleBackground: { enabled: true, color: 'black', opacityPercent: 50 }, outlineThicknessPx: 0 })
    for (let i = 0; i < 50; i++) collectCueEditWarnings(cue(), after, ['style.background.enabled'], true, out)
    expect(out.filter((w) => w.code === 'BACKGROUND_NEEDS_OUTLINE')).toHaveLength(1)
  })
})
