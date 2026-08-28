import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildNewCue,
  buildResetPatch,
  computeAddInsertion,
  hasResetTarget,
} from '../../src/renderer/lib/cue-structure'
import { buildDuplicateEntry } from '../../src/renderer/lib/duplicate-entry'
import { applyCueEdit, collectCueEditWarnings } from '../../src/shared/cue-edit'
import { areWordsValidForText } from '../../src/shared/words-validity'
import { styleFieldsFromDefaults } from '../../src/renderer/lib/style-defaults-to-entry'
import { buildProjectFile, parseProjectFile, serializeProjectFile } from '../../src/shared/project-file'
import type { RenderNotice } from '../../src/shared/render-notice'
import type { SubtitleEntry, TranscriptionDefaults, VideoInfo, WordSpan } from '../../src/shared/types'

/**
 * REQ-0555 — the second wave of the cue API.
 *
 * Two things are pinned here. §1: "I changed the text" now means the same thing
 * in `edit_subtitle` as in `edit_cues`. §2: `add_cue` / `duplicate_cue` /
 * `reset_cue` mean the same thing as the GUI buttons they mirror — enforced by
 * both callers reaching the same functions, and by a source guard that neither
 * side quietly grows its own copy.
 */

const DEFAULTS: TranscriptionDefaults = {
  fontSizePx: 88, textColorHex: '#EEDD00', outlineColorHex: '#101020',
  outlineThicknessPx: 5, whisperModel: 'medium',
  shadowDepth: 9, casing: 'uppercase', rotation: 12, karaokeEnabled: true,
  horizontalPosition: 'right', verticalPosition: 'top', verticalMarginPx: 77,
} as TranscriptionDefaults

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

const seed = (over: Record<string, unknown> = {}) => ({
  id: 'x-1', startSec: 5, endSec: 7, fadeDurationSec: 0.2,
  defaults: DEFAULTS, videoWidthPx: 1920, videoHeightPx: 1080, ...over,
})

// ---------------------------------------------------------------------------
// §1 — one meaning of "the text changed"
// ---------------------------------------------------------------------------

describe('REQ-0555 §1 — edit_subtitle and edit_cues agree about `words`', () => {
  const textEdit = (entry: SubtitleEntry, text: string) => {
    const { entry: after, changed } = applyCueEdit(entry, { select: { id: entry.id }, text })
    const warnings: RenderNotice[] = []
    collectCueEditWarnings(entry, after, changed, true, warnings)
    return { after, codes: warnings.map((w) => w.code) }
  }

  it('★ a text change KEEPS the word timings (they are judged, not deleted)', () => {
    // The behaviour `edit_subtitle` used to have — `words: undefined` — is the
    // thing this REQ removed. Deleting them made the change unrecoverable:
    // re-transcription was the only way back.
    const before = cue({ words: WORDS })
    const { after } = textEdit(before, 'まったく違う文')
    expect(after.words).toEqual(WORDS)
  })

  it('★ …but they are correctly judged invalid against the new text', () => {
    const { after } = textEdit(cue({ words: WORDS }), 'まったく違う文')
    expect(areWordsValidForText(after.words, after.text)).toBe(false)
  })

  it('★ …and restoring the text brings the karaoke back', () => {
    const before = cue({ words: WORDS })
    const changed = textEdit(before, '別の文').after
    const restored = textEdit(changed, 'ここが重要です').after
    expect(areWordsValidForText(restored.words, restored.text)).toBe(true)
  })

  it('warns WORD_TIMINGS_INVALIDATED, and no longer the destructive code', () => {
    const { codes } = textEdit(cue({ words: WORDS }), 'まったく違う文')
    expect(codes).toContain('WORD_TIMINGS_INVALIDATED')
    expect(codes).not.toContain('WORD_TIMINGS_DISCARDED')
  })

  it('a cue with no word timings warns about nothing', () => {
    expect(textEdit(cue(), '新しい文').codes).toEqual([])
  })

  /*
   * ★ The retired code, kept honest.
   *
   * REQ-0555 §1 says the old code must not "silently disappear". It is gone
   * from the emitters on purpose — nothing is discarded now, so emitting it
   * would be false — and its retirement is written down in the CLI spec's
   * stable-code table. This test is the other half: it fails if the string
   * comes back to life in a command, which would mean two codes describing one
   * event again.
   */
  it('★ WORD_TIMINGS_DISCARDED is retired — no command emits it any more', () => {
    const cliDir = join(__dirname, '../../src/main/cli/commands')
    const files = ['edit-subtitle.ts', 'edit-cues.ts', 'structure-cue.ts']
    for (const f of files) {
      const src = readFileSync(join(cliDir, f), 'utf8')
      // Mentioning it in a comment (explaining the retirement) is fine; EMITTING
      // it is not. The emitted form is always a quoted code.
      expect(src, `${f} must not emit the retired code`).not.toMatch(/code:\s*'WORD_TIMINGS_DISCARDED'/)
    }
  })
})

// ---------------------------------------------------------------------------
// §2-1 — add
// ---------------------------------------------------------------------------

describe('REQ-0555 §2-1 — a cue lands where the GUI would put it', () => {
  const at = (id: string, startSec: number, isDeleted = false) =>
    cue({ id, startSec, endSec: startSec + 1, isDeleted })

  it('goes before the first later cue', () => {
    const entries = [at('a', 1), at('b', 5), at('c', 9)]
    expect(computeAddInsertion(entries, 4)).toEqual({ fullIdx: 1, visiblePos: 2 })
  })

  it('appends after the last cue when nothing is later', () => {
    const entries = [at('a', 1), at('b', 5)]
    expect(computeAddInsertion(entries, 99)).toEqual({ fullIdx: 2, visiblePos: 3 })
  })

  it('an empty project takes position 0', () => {
    expect(computeAddInsertion([], 3)).toEqual({ fullIdx: 0, visiblePos: 1 })
  })

  it('★ deleted rows are skipped for the USER position but still occupy the array', () => {
    // The two numbers exist precisely because they disagree here — conflating
    // them would insert at the wrong array slot in any project with a deleted
    // row, which is most of them.
    const entries = [at('a', 1), at('gone', 2, true), at('gone2', 3, true), at('b', 5)]
    const r = computeAddInsertion(entries, 4)
    expect(r.fullIdx).toBe(3)      // before 'b', past BOTH deleted rows
    expect(r.visiblePos).toBe(2)   // but only the 2nd row the user can see
  })

  it('a project of only deleted rows appends at the end', () => {
    const entries = [at('gone', 2, true)]
    // No visible rows at all, so the new cue becomes the first one the user sees.
    expect(computeAddInsertion(entries, 4)).toEqual({ fullIdx: 1, visiblePos: 1 })
  })

  it('★ a new cue is seeded from the SAME projection a transcribed row is', () => {
    // REQ-0335's bug was an added row silently losing shadow / casing /
    // rotation / karaoke because its field list was hand-written.
    const built = buildNewCue(seed()) as unknown as Record<string, unknown>
    const projection = styleFieldsFromDefaults(DEFAULTS, {
      videoWidthPx: 1920, videoHeightPx: 1080,
    }) as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(projection)) {
      expect(built[key], `new cue must carry '${key}' from the defaults`).toEqual(value)
    }
  })

  it('★ §2-5 the new cue is positioned exactly as the GUI would position it', () => {
    // Same call, so the `\pos` a burn computes for it is the same one it would
    // compute for a row added in the app.
    const built = buildNewCue(seed())
    const projection = styleFieldsFromDefaults(DEFAULTS, { videoWidthPx: 1920, videoHeightPx: 1080 })
    expect(built.posX).toEqual(projection.posX)
    expect(built.posY).toEqual(projection.posY)
    expect(built.horizontalPosition).toBe('right')
    expect(built.verticalPosition).toBe('top')
    expect(built.verticalMarginPx).toBe(77)
  })

  it('the original snapshot does not share the background object', () => {
    const built = buildNewCue(seed())
    expect(built.original.subtitleBackground).not.toBe(built.subtitleBackground)
    expect(built.original.subtitleBackground).toEqual(built.subtitleBackground)
  })

  it('carries the requested times and text, and starts undeleted', () => {
    const built = buildNewCue(seed({ text: 'こんにちは' }))
    expect([built.startSec, built.endSec, built.text]).toEqual([5, 7, 'こんにちは'])
    expect(built.isDeleted).toBe(false)
  })

  it('the fade default is not clobbered by the layout defaults spread', () => {
    // The spread order is inherited verbatim from step2.tsx; this pins that a
    // later spread does not silently win over the seeded value.
    expect(buildNewCue(seed({ fadeDurationSec: 0.75 })).fadeDurationSec).toBe(0.75)
  })
})

// ---------------------------------------------------------------------------
// §2-2 — duplicate
// ---------------------------------------------------------------------------

describe('REQ-0555 §2-2 — duplication is the GUI duplication', () => {
  it('★ copies style AND word timings, which a hand-written copy historically dropped', () => {
    // REQ-0322: the hand-listed duplication had drifted sixteen fields behind
    // the type, so duplicating a karaoke row lost its per-word timings.
    const source = cue({ words: WORDS, karaokeEnabled: true, fontSizePx: 96, rotation: 15 })
    const dup = buildDuplicateEntry(source, 'dup-1')
    expect(dup.words).toEqual(WORDS)
    expect(dup.karaokeEnabled).toBe(true)
    expect(dup.fontSizePx).toBe(96)
    expect(dup.rotation).toBe(15)
  })

  it('★ mints a new id and shares no nested object with its source', () => {
    const source = cue({ words: WORDS })
    const dup = buildDuplicateEntry(source, 'dup-1')
    expect(dup.id).toBe('dup-1')
    expect(dup.id).not.toBe(source.id)
    expect(dup.subtitleBackground).not.toBe(source.subtitleBackground)
    expect(dup.words).not.toBe(source.words)
  })

  it('two duplicates of one source get different ids', () => {
    const source = cue()
    expect(buildDuplicateEntry(source, 'a').id).not.toBe(buildDuplicateEntry(source, 'b').id)
  })
})

// ---------------------------------------------------------------------------
// §2-3 — reset
// ---------------------------------------------------------------------------

describe('REQ-0555 §2-3 — reset restores what the GUI button restores', () => {
  /** A cue whose LIVE fields have been edited away from its `original`. */
  const edited = (over: Partial<SubtitleEntry>): SubtitleEntry =>
    ({ ...cue(), ...over, isEdited: true }) as SubtitleEntry

  it('restores the original text, times and style', () => {
    const entry = edited({ text: '編集後', fontSizePx: 120 })
    const restored = { ...entry, ...buildResetPatch(entry) }
    expect(restored.text).toBe('ここが重要です')
    expect(restored.fontSizePx).toBe(60)
    expect(restored.isEdited).toBe(false)
  })

  it('★ clears a drag-pinned position even though `original` has no such key', () => {
    // Each of these four lines in `buildResetPatch` was its own bug: a bare
    // `{...entry, ...original}` keeps the LIVE value when `original` lacks the
    // key, so Reset left the row pinned / on the wrong layer / in the wrong font.
    const entry = edited({ posX: 500, posY: 300, layer: 4, fontId: 'dela-gothic-one' })
    const restored = { ...entry, ...buildResetPatch(entry) }
    expect(restored.posX).toBeUndefined()
    expect(restored.posY).toBeUndefined()
    expect(restored.layer).toBeUndefined()
    expect(restored.fontId).toBeUndefined()
  })

  it('un-deletes a deleted row', () => {
    const entry = edited({ isDeleted: true })
    expect({ ...entry, ...buildResetPatch(entry) }.isDeleted).toBe(false)
  })

  it('does not share the background object with `original`', () => {
    const entry = cue()
    const patch = buildResetPatch(entry)
    expect(patch.subtitleBackground).not.toBe(entry.original.subtitleBackground)
  })

  it('★ a cue with no `original` is reported as having nothing to restore', () => {
    // §2-3: a warning and no change, not an error — otherwise "reset everything"
    // becomes unusable on a project containing one such cue.
    expect(hasResetTarget(cue())).toBe(true)
    expect(hasResetTarget({ ...cue(), original: undefined } as unknown as SubtitleEntry)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §2-4 — the no-second-implementation guard
// ---------------------------------------------------------------------------

describe('REQ-0555 §2-4 — one implementation, reached by both callers', () => {
  const read = (p: string) => readFileSync(join(__dirname, '../..', p), 'utf8')
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('★ the CLI reaches the GUI logic rather than repeating it', () => {
    const src = read('src/main/cli/commands/structure-cue.ts')
    for (const fn of ['computeAddInsertion', 'buildNewCue', 'buildResetPatch', 'buildDuplicateEntry']) {
      expect(src, `structure-cue.ts must call ${fn}`).toContain(fn)
    }
  })

  it('★ the CLI does not hand-build a cue behind the builder\'s back', () => {
    /*
     * The failure this catches is not a typo — it is the tempting shortcut of
     * spreading a few fields inline "just for the CLI", which is exactly how
     * the duplication list drifted sixteen fields behind the type. If the CLI
     * ever seeds style from defaults itself, it can diverge from the GUI
     * without any test noticing.
     */
    const src = stripComments(read('src/main/cli/commands/structure-cue.ts'))
    expect(src).not.toContain('styleFieldsFromDefaults')
    expect(src).not.toContain('makeEntryLayoutDefaults')
  })

  it('★ the GUI reset button uses the shared patch builder', () => {
    const src = stripComments(read('src/renderer/lib/entry-row-actions.ts'))
    expect(src).toContain('buildResetPatch')
    // The old inline patch is gone — if it came back, the CLI and the button
    // could restore different things.
    expect(src).not.toMatch(/posX:\s*original\.posX/)
  })
})

// ---------------------------------------------------------------------------
// §3-3 — negative controls
// ---------------------------------------------------------------------------

/**
 * ★ REQ-0555 §3-3 — do the assertions above actually discriminate?
 *
 * Each control reproduces the PRE-fix computation inline — the naive or
 * historical version of the one decision under test — and shows the assertion
 * fails on it. No `git checkout` (CLAUDE.md §18): the perturbation is the input
 * to the assertion, everything else is the real code.
 *
 * A control that passes here means the corresponding test above is not vacuous.
 */
describe('REQ-0555 §3-3 — negative controls', () => {
  it('★ §1 control: the OLD delete-on-text-change makes the karaoke unrecoverable', () => {
    // Pre-REQ-0555 `edit_subtitle`: `{ ...entry, text, words: undefined }`.
    const before = cue({ words: WORDS })
    const oldWay = { ...before, text: '別の文', words: undefined } as SubtitleEntry
    const oldRestored = { ...oldWay, text: 'ここが重要です' } as SubtitleEntry
    // The "restoring the text brings the karaoke back" test would FAIL on this.
    expect(areWordsValidForText(oldRestored.words, oldRestored.text)).toBe(false)

    // …and the current behaviour genuinely differs.
    const { entry: newWay } = applyCueEdit(before, { select: { id: before.id }, text: '別の文' })
    const newRestored = applyCueEdit(newWay, { select: { id: before.id }, text: 'ここが重要です' }).entry
    expect(areWordsValidForText(newRestored.words, newRestored.text)).toBe(true)
  })

  it('★ §2-1 control: naive "append at the end" puts the cue in the wrong place', () => {
    const at = (id: string, startSec: number) => cue({ id, startSec, endSec: startSec + 1 })
    const entries = [at('a', 1), at('b', 5), at('c', 9)]
    const naiveAppend = entries.length              // what a fresh implementation would do
    const real = computeAddInsertion(entries, 4).fullIdx
    expect(real).toBe(1)
    expect(real).not.toBe(naiveAppend)
  })

  it('★ §2-2 control: a hand-listed duplicate drops the word timings', () => {
    /*
     * The pre-REQ-0322 duplication, reduced to the four fields such lists
     * always start with. This is not a strawman: REQ-0322 records the real one
     * drifting SIXTEEN fields behind the type.
     */
    const source = cue({ words: WORDS, karaokeEnabled: true, fontSizePx: 96 })
    const handListed = {
      id: 'dup-1', startSec: source.startSec, endSec: source.endSec, text: source.text,
    } as unknown as SubtitleEntry
    expect(handListed.words).toBeUndefined()
    expect(handListed.karaokeEnabled).toBeUndefined()

    // The real one carries them.
    const real = buildDuplicateEntry(source, 'dup-1')
    expect(real.words).toEqual(WORDS)
    expect(real.karaokeEnabled).toBe(true)
  })

  it('★ §2-3 control: a bare {...entry, ...original} spread leaves the row pinned', () => {
    // Exactly the bug REQ-20260615-018 B / REQ-0392 / REQ-022 fixed: `original`
    // has no posX/posY/layer/fontId keys, so the spread keeps the LIVE values.
    const entry = { ...cue(), posX: 500, posY: 300, layer: 4 } as SubtitleEntry
    const bareSpread = { ...entry, ...entry.original } as SubtitleEntry
    expect(bareSpread.posX).toBe(500)   // still pinned — Reset did nothing
    expect(bareSpread.layer).toBe(4)

    const real = { ...entry, ...buildResetPatch(entry) } as SubtitleEntry
    expect(real.posX).toBeUndefined()
    expect(real.layer).toBeUndefined()
  })
})

/**
 * ★ REQ-0555 §3-2 — the round trip that matters: through the GUI's SAVE path.
 *
 * `read_subtitle` reading back a file the CLI just wrote only proves the CLI
 * can read its own writing. What has to hold is that the APP can — so this
 * runs the structurally-edited entries through `buildProjectFile`, the very
 * function the Save command calls, then serializes and re-parses.
 *
 * Deliberately NOT done with `convert` in the smoke: converting
 * .mojioko → .mojioko re-mints every cue id, so an id comparison there would
 * fail for a reason unrelated to structural editing (RES-0555 §9).
 */
describe('REQ-0555 §3-2 — count, order and ids survive the GUI save path', () => {
  const VIDEO: VideoInfo = {
    path: 'C:' + String.fromCharCode(92) + 'v.mp4', hasVideoStream: true,
    widthPx: 1920, heightPx: 1080, durationSec: 30, fps: 30,
    container: 'mp4', videoCodec: 'h264',
    audioTracks: [{ index: 1, channels: 'stereo', sampleRateHz: 48000, codec: 'aac', language: 'und' }],
    fileSizeBytes: 1024,
  }

  const save = (entries: SubtitleEntry[]): SubtitleEntry[] => {
    const pf = buildProjectFile({
      appVersion: '1.4.0', video: VIDEO, transcribedTrackIndex: 1, entries, cuts: [],
      defaults: DEFAULTS, whisperModel: 'large-v3-turbo', device: 'cpu',
      now: new Date('2026-08-27T07:00:00+09:00'),
    })
    const parsed = parseProjectFile(serializeProjectFile(pf))
    if (!parsed.ok) throw new Error(`parser rejected the project: ${(parsed as { reason: string }).reason}`)
    return parsed.project.editing.subtitles
  }

  it('★ an added, a duplicated and a reset cue all survive save → load', () => {
    const at = (id: string, startSec: number, text: string) =>
      ({ ...cue({ id, startSec, endSec: startSec + 1 }), text }) as SubtitleEntry
    const entries = [at('a', 1, 'first'), at('c', 9, 'third')]

    // add — into the middle, by the shared rule
    const added = buildNewCue({ ...seed({ startSec: 5, endSec: 7, text: 'second' }), id: 'cli-1' })
    const { fullIdx } = computeAddInsertion(entries, 5)
    entries.splice(fullIdx, 0, added)

    // duplicate — immediately after its source, as the GUI inserts it
    entries.splice(1, 0, buildDuplicateEntry(entries[0], 'cli-dup-1'))

    const loaded = save(entries)

    expect(loaded.map((e) => e.text)).toEqual(['first', 'first', 'second', 'third'])
    expect(loaded.map((e) => e.id)).toEqual(['a', 'cli-dup-1', 'cli-1', 'c'])
    expect(new Set(loaded.map((e) => e.id)).size).toBe(loaded.length)
  })

  it('★ a duplicated karaoke cue keeps its word timings across save → load', () => {
    // The full path an agent's edit takes: duplicate → write → the user opens
    // the project. If the timings were lost at any step the karaoke is gone.
    const source = { ...cue({ words: WORDS }), id: 'src' } as SubtitleEntry
    const loaded = save([source, buildDuplicateEntry(source, 'dup-1')])
    expect(areWordsValidForText(loaded[1].words, loaded[1].text)).toBe(true)
  })

  it('a reset cue reloads in its original state', () => {
    const entry = { ...cue(), text: 'EDITED', fontSizePx: 200, isEdited: true } as SubtitleEntry
    const reset = { ...entry, ...buildResetPatch(entry) } as SubtitleEntry
    const loaded = save([reset])
    expect(loaded[0].text).toBe('ここが重要です')
    expect(loaded[0].fontSizePx).toBe(60)
    expect(loaded[0].isEdited).toBe(false)
  })
})
