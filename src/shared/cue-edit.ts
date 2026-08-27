import type { RenderNotice } from './render-notice'
import { areWordsValidForText } from './words-validity'
import { canSelectFontInTier } from './font-tier'
import { isFontId } from './fonts'
import { resolveEmphasis } from './emphasis'
import type { SubtitleEntry } from './types'

/**
 * REQ-0554 (design: RES-0552) — the semantics of a cue patch, as pure functions.
 *
 * ## Why this is one module, and shared
 *
 * `edit_cues` is reachable from the CLI and from MCP, and both must mean
 * exactly the same thing. Putting the meaning here — rather than inside the
 * command — is what makes "the MCP tool and the CLI agree" a property of the
 * code instead of a promise. The command file becomes I/O plus this.
 *
 * ## The patch shape mirrors the READ shape
 *
 * `read_subtitle --with_style` returns `SubtitleStyleSummary` (nested groups:
 * `shadow`, `position`, `karaoke`, `emphasis`, `animation`, `background`). The
 * patch accepted here is the same shape with every field optional, so **what
 * you can read, you can write back in the form you read it**. `STYLE_FIELDS`
 * below is the one table that relates the two, and
 * `cue-edit-req-0554.test.ts` pins that it covers every key the summary emits —
 * so a new style field cannot be readable but not writable.
 *
 * ## Partial groups
 *
 * A group is merged, not replaced: `{ karaoke: { enabled: true } }` leaves
 * `highlightColor` alone. Replacing would mean a caller who read a cue, changed
 * one field and wrote it back would silently reset the others unless they
 * echoed the whole group — the opposite of the read/write symmetry above.
 */

// ---------------------------------------------------------------------------
// The patch shape
// ---------------------------------------------------------------------------

export interface CueStylePatch {
  fontId?: string
  fontSizePx?: number
  textColorHex?: string
  textAlphaPercent?: number
  outlineColorHex?: string
  outlineThicknessPx?: number
  outlineAlphaPercent?: number
  shadow?: { depthPx?: number; color?: string; alphaPercent?: number }
  rotationDeg?: number
  casing?: string
  lineSpacingPercent?: number
  position?: {
    horizontal?: string
    vertical?: string
    verticalMarginPx?: number
    posX?: number | null
    posY?: number | null
  }
  karaoke?: { enabled?: boolean; style?: string; highlightColor?: string }
  emphasis?: { enabled?: boolean; color?: string; scalePercent?: number }
  animation?: {
    type?: string
    inEnabled?: boolean
    outEnabled?: boolean
    durationSec?: number
    startScalePercent?: number
    blurPx?: number
  }
  background?: { enabled?: boolean; color?: string; opacityPercent?: number }
  layer?: number
}

export interface CueEmphasisSpanInput {
  start: number
  end: number
  text: string
}

export type CueSelect =
  | { id: string }
  | { index: number }
  | { ids: string[] }

export interface CueEdit {
  select: CueSelect
  text?: string
  startSec?: number
  endSec?: number
  isDeleted?: boolean
  style?: CueStylePatch
  emphasisSpans?: CueEmphasisSpanInput[]
  /**
   * REQ-0556 §1 — per-word karaoke timings, the write side of
   * `read_subtitle --with-words`.
   *
   * Stored as given, even when they do not spell the cue's text. That is the
   * existing defensive rule, not laxness: `areWordsValidForText` decides at
   * render time whether karaoke sweeps by real timing or by an even split, so
   * keeping mismatched timings costs a fallback and losing them costs a
   * re-transcription (REQ-0288 / REQ-0555 §1). The caller is told with
   * `KARAOKE_NO_WORD_TIMING`.
   *
   * When `text` and `words` are patched together, the words are judged against
   * the NEW text — the state the cue ends in is the only one worth validating.
   */
  words?: CueWordInput[]
  /**
   * REQ-0556 §2 — re-wrap this cue's text after the rest of the patch is
   * applied.
   *
   * `pack` = 敷き詰め改行 (discard manual breaks, re-fill), `overflow` =
   * はみ出し改行 (keep manual breaks, break only what overflows). Applied LAST
   * on purpose: a patch that enlarges the font and re-wraps in one call must
   * measure at the NEW size, which is exactly the case where a caller would
   * otherwise leave stale breaks behind.
   *
   * Needs the video width and font metrics, so `applyCueEdit` does not perform
   * it — the command layer does, via `shared/cue-wrap.ts`.
   */
  wrap?: 'pack' | 'overflow'
}

/** One word's timing, as accepted by the API. */
export interface CueWordInput {
  text: string
  startSec: number
  endSec: number
}

// ---------------------------------------------------------------------------
// The one mapping between the read shape and the stored fields
// ---------------------------------------------------------------------------

/**
 * `summary key path` → `SubtitleEntry` field.
 *
 * `group` is the nested object in the patch (and in the read summary); a `null`
 * group means the key sits at the top level of both.
 *
 * `entry` is the stored field name. Where the two differ it is because the
 * stored name predates the summary (`textAlpha` vs `textAlphaPercent`,
 * `rotation` vs `rotationDeg`) — renaming stored fields would change the
 * `.mojioko` format, which this REQ must not do.
 */
interface StyleFieldMap {
  group: keyof CueStylePatch | null
  key: string
  entry: keyof SubtitleEntry | 'subtitleBackground'
  /** Background lives inside one stored object rather than a flat field. */
  bgKey?: 'enabled' | 'color' | 'opacityPercent'
}

export const STYLE_FIELDS: readonly StyleFieldMap[] = [
  { group: null, key: 'fontId', entry: 'fontId' },
  { group: null, key: 'fontSizePx', entry: 'fontSizePx' },
  { group: null, key: 'textColorHex', entry: 'textColorHex' },
  { group: null, key: 'textAlphaPercent', entry: 'textAlpha' },
  { group: null, key: 'outlineColorHex', entry: 'outlineColorHex' },
  { group: null, key: 'outlineThicknessPx', entry: 'outlineThicknessPx' },
  { group: null, key: 'outlineAlphaPercent', entry: 'outlineAlpha' },
  { group: null, key: 'rotationDeg', entry: 'rotation' },
  { group: null, key: 'casing', entry: 'casing' },
  { group: null, key: 'lineSpacingPercent', entry: 'lineSpacingPercent' },
  { group: null, key: 'layer', entry: 'layer' },

  { group: 'shadow', key: 'depthPx', entry: 'shadowDepth' },
  { group: 'shadow', key: 'color', entry: 'shadowColor' },
  { group: 'shadow', key: 'alphaPercent', entry: 'shadowAlpha' },

  { group: 'position', key: 'horizontal', entry: 'horizontalPosition' },
  { group: 'position', key: 'vertical', entry: 'verticalPosition' },
  { group: 'position', key: 'verticalMarginPx', entry: 'verticalMarginPx' },
  { group: 'position', key: 'posX', entry: 'posX' },
  { group: 'position', key: 'posY', entry: 'posY' },

  { group: 'karaoke', key: 'enabled', entry: 'karaokeEnabled' },
  { group: 'karaoke', key: 'style', entry: 'karaokeStyle' },
  { group: 'karaoke', key: 'highlightColor', entry: 'karaokeHighlightColor' },

  { group: 'emphasis', key: 'enabled', entry: 'keywordEmphasisEnabled' },
  { group: 'emphasis', key: 'color', entry: 'emphasisColorHex' },
  { group: 'emphasis', key: 'scalePercent', entry: 'emphasisScalePercent' },

  { group: 'animation', key: 'type', entry: 'animationType' },
  { group: 'animation', key: 'inEnabled', entry: 'animationInEnabled' },
  { group: 'animation', key: 'outEnabled', entry: 'animationOutEnabled' },
  { group: 'animation', key: 'durationSec', entry: 'animationDurationSec' },
  { group: 'animation', key: 'startScalePercent', entry: 'animationStartScalePercent' },
  { group: 'animation', key: 'blurPx', entry: 'animationBlurPx' },

  { group: 'background', key: 'enabled', entry: 'subtitleBackground', bgKey: 'enabled' },
  { group: 'background', key: 'color', entry: 'subtitleBackground', bgKey: 'color' },
  { group: 'background', key: 'opacityPercent', entry: 'subtitleBackground', bgKey: 'opacityPercent' },
] as const

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface SelectionResult {
  /** Array positions in `entries`, ascending, no duplicates. */
  positions: number[]
  /** Ids named by the selector that no cue has. */
  missing: string[]
}

/**
 * Resolve a selector against the cue array.
 *
 * `index` counts NON-DELETED cues, matching `read_subtitle`'s `index` — an
 * agent that read index 3 must be able to write index 3. `id` addresses the
 * cue directly and is stable across deletions, which is why the schema
 * documents it as the safer choice.
 */
export function resolveSelection(
  entries: readonly SubtitleEntry[],
  select: CueSelect,
): SelectionResult {
  if ('index' in select) {
    const visible = entries.map((e, i) => ({ e, i })).filter((x) => !x.e.isDeleted)
    const hit = visible[select.index]
    return hit ? { positions: [hit.i], missing: [] } : { positions: [], missing: [`index:${select.index}`] }
  }
  const wanted = 'ids' in select ? select.ids : [select.id]
  const positions: number[] = []
  const missing: string[] = []
  for (const id of wanted) {
    const at = entries.findIndex((e) => e.id === id)
    if (at < 0) missing.push(id)
    else if (!positions.includes(at)) positions.push(at)
  }
  positions.sort((a, b) => a - b)
  return { positions, missing }
}

// ---------------------------------------------------------------------------
// Applying one edit
// ---------------------------------------------------------------------------

export interface ApplyResult {
  entry: SubtitleEntry
  /** Dotted paths that actually changed value. Empty = the edit was a no-op. */
  changed: string[]
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || (a === undefined && b === undefined)
}

/**
 * Apply one edit to one cue and report what actually changed.
 *
 * `changed` lists only fields whose value DIFFERS, so a caller can tell "I
 * asked for 5 things and 5 happened" from "I asked for 5 and it was already
 * like that" — the `unchanged` count in the response is built from this. A
 * patch that silently did nothing would be the "no-op that lies" the API
 * contract forbids.
 *
 * ## `words` is never touched here
 *
 * Not on a style change (RES-0552 §3-3 — "I changed the colour and the karaoke
 * disappeared" must not be possible), and not on a text change either: the
 * stored timings stay, and `areWordsValidForText` decides at render time
 * whether they still spell the text. Keeping them means restoring the text
 * restores the karaoke. The caller is warned when a text edit invalidates them.
 */
export function applyCueEdit(entry: SubtitleEntry, edit: CueEdit): ApplyResult {
  const next: SubtitleEntry = { ...entry }
  const changed: string[] = []

  const set = (path: string, field: string, value: unknown): void => {
    const current = (next as unknown as Record<string, unknown>)[field]
    if (sameValue(current, value)) return
    ;(next as unknown as Record<string, unknown>)[field] = value
    changed.push(path)
  }

  if (edit.text !== undefined) set('text', 'text', edit.text)
  if (edit.startSec !== undefined) set('startSec', 'startSec', edit.startSec)
  if (edit.endSec !== undefined) set('endSec', 'endSec', edit.endSec)
  if (edit.isDeleted !== undefined) set('isDeleted', 'isDeleted', edit.isDeleted)

  if (edit.style) {
    const patch = edit.style as unknown as Record<string, unknown>
    for (const f of STYLE_FIELDS) {
      const container = f.group === null ? patch : (patch[f.group] as Record<string, unknown> | undefined)
      if (!container || !(f.key in container)) continue
      const value = container[f.key]
      const path = f.group === null ? `style.${f.key}` : `style.${f.group}.${f.key}`
      if (f.bgKey) {
        // The background is one stored object; merge into a copy so an
        // untouched sibling key survives.
        const bg = { ...(next.subtitleBackground ?? { enabled: false, color: 'black', opacityPercent: 50 }) }
        if (sameValue((bg as unknown as Record<string, unknown>)[f.bgKey], value)) continue
        ;(bg as unknown as Record<string, unknown>)[f.bgKey] = value
        next.subtitleBackground = bg
        changed.push(path)
        continue
      }
      set(path, f.entry as string, value)
    }
  }

  if (edit.emphasisSpans !== undefined) {
    const before = JSON.stringify(entry.emphasisSpans ?? [])
    const after = JSON.stringify(edit.emphasisSpans)
    if (before !== after) {
      next.emphasisSpans = edit.emphasisSpans.map((s) => ({ start: s.start, end: s.end, text: s.text }))
      changed.push('emphasisSpans')
    }
  }

  // REQ-0556 §1 — word timings. Written verbatim; validity is judged at render
  // time, and `collectCueEditWarnings` reports a mismatch against the cue's
  // FINAL text (which may have been changed by this same patch).
  if (edit.words !== undefined) {
    const before = JSON.stringify(entry.words ?? [])
    const after = JSON.stringify(edit.words)
    if (before !== after) {
      next.words = edit.words.map((w) => ({ text: w.text, startSec: w.startSec, endSec: w.endSec }))
      changed.push('words')
    }
  }

  // Mark as edited only when something really moved, so a no-op patch does not
  // flip the row's "edited" badge in the GUI.
  if (changed.length > 0) next.isEdited = true

  return { entry: next, changed }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** One problem with one edit, addressed by its position in the `edits` array. */
export interface CueEditProblem {
  editIndex: number
  message: string
  remedy?: string
}

const TOP_KEYS = new Set(['select', 'text', 'startSec', 'endSec', 'isDeleted', 'style', 'emphasisSpans', 'words', 'wrap'])
const SPAN_KEYS = new Set(['start', 'end', 'text'])
const WORD_KEYS = new Set(['text', 'startSec', 'endSec'])

/** Every key the style patch accepts, derived from the ONE table. */
function styleKeysFor(group: string | null): Set<string> {
  return new Set(STYLE_FIELDS.filter((f) => (f.group ?? null) === group).map((f) => f.key))
}
const TOP_STYLE_KEYS = styleKeysFor(null)
const STYLE_GROUPS = new Set(
  STYLE_FIELDS.map((f) => f.group).filter((g): g is keyof CueStylePatch => g !== null),
)

/**
 * Reject anything the API does not understand, rather than ignoring it.
 *
 * REQ-0554 §2-4 / RES-0552 §3-1: a silently dropped field is the worst failure
 * mode for an agent, because it reads as success and the next decision is built
 * on a change that never happened. The check lives HERE rather than only in the
 * MCP `inputSchema` so the CLI enforces the identical contract — the schema
 * declares it, this enforces it, and they are checked against each other in
 * `cue-edit-req-0554.test.ts`.
 */
export function validateCueEdits(raw: unknown): { edits: CueEdit[]; problems: CueEditProblem[] } {
  const problems: CueEditProblem[] = []
  if (!Array.isArray(raw)) {
    return { edits: [], problems: [{ editIndex: -1, message: 'edits は配列である必要があります。' }] }
  }
  const edits: CueEdit[] = []

  raw.forEach((item, editIndex) => {
    const bad = (message: string, remedy?: string): void => { problems.push({ editIndex, message, remedy }) }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      bad('各要素はオブジェクトである必要があります。')
      return
    }
    const e = item as Record<string, unknown>

    for (const k of Object.keys(e)) {
      if (!TOP_KEYS.has(k)) {
        bad(`未知のフィールド "${k}" です。`, `使用できるのは ${[...TOP_KEYS].join(' / ')} です。`)
      }
    }

    // --- select ---
    const sel = e.select as Record<string, unknown> | undefined
    if (!sel || typeof sel !== 'object') {
      bad('select が必要です。', 'select: { id } / { index } / { ids }')
    } else if (typeof sel.id === 'string') {
      // ok
    } else if (typeof sel.index === 'number' && Number.isInteger(sel.index) && sel.index >= 0) {
      // ok
    } else if (Array.isArray(sel.ids) && sel.ids.length > 0 && sel.ids.every((x) => typeof x === 'string')) {
      // ok
    } else {
      bad('select は { id } / { index }（0以上の整数）/ { ids }（非空）のいずれかです。')
    }

    // --- scalars ---
    if ('text' in e && typeof e.text !== 'string') bad('text は文字列です。')
    for (const k of ['startSec', 'endSec'] as const) {
      if (k in e && (typeof e[k] !== 'number' || !Number.isFinite(e[k] as number) || (e[k] as number) < 0)) {
        bad(`${k} は 0 以上の数値です。`)
      }
    }
    if ('isDeleted' in e && typeof e.isDeleted !== 'boolean') bad('isDeleted は真偽値です。')
    if (typeof e.startSec === 'number' && typeof e.endSec === 'number' && e.endSec <= e.startSec) {
      bad('endSec は startSec より後である必要があります。')
    }

    // --- style ---
    if ('style' in e) {
      const st = e.style
      if (!st || typeof st !== 'object' || Array.isArray(st)) {
        bad('style はオブジェクトです。')
      } else {
        const s = st as Record<string, unknown>
        for (const k of Object.keys(s)) {
          if (TOP_STYLE_KEYS.has(k)) continue
          if (STYLE_GROUPS.has(k as keyof CueStylePatch)) {
            const g = s[k]
            if (!g || typeof g !== 'object' || Array.isArray(g)) { bad(`style.${k} はオブジェクトです。`); continue }
            const allowed = styleKeysFor(k)
            for (const gk of Object.keys(g as Record<string, unknown>)) {
              if (!allowed.has(gk)) bad(`未知のフィールド "style.${k}.${gk}" です。`, `使用できるのは ${[...allowed].join(' / ')} です。`)
            }
            continue
          }
          bad(`未知のフィールド "style.${k}" です。`)
        }
        // ★ A pin is a PAIR. One coordinate alone has no meaning — the ASS
        // writer needs both to emit `\pos`, so accepting one silently would
        // store a half-state that changes nothing.
        const pos = s.position as Record<string, unknown> | undefined
        if (pos && typeof pos === 'object') {
          const hasX = 'posX' in pos && pos.posX !== null
          const hasY = 'posY' in pos && pos.posY !== null
          if (hasX !== hasY) {
            bad('position.posX と posY は対で指定します（片方だけは無効）。',
              'ピン留めを解除するには両方に null を渡してください。')
          }
        }
      }
    }

    // --- emphasisSpans ---
    if ('emphasisSpans' in e) {
      const spans = e.emphasisSpans
      if (!Array.isArray(spans)) {
        bad('emphasisSpans は配列です。')
      } else {
        spans.forEach((sp, i) => {
          if (!sp || typeof sp !== 'object' || Array.isArray(sp)) { bad(`emphasisSpans[${i}] はオブジェクトです。`); return }
          const o = sp as Record<string, unknown>
          for (const k of Object.keys(o)) {
            if (!SPAN_KEYS.has(k)) bad(`未知のフィールド "emphasisSpans[${i}].${k}" です。`)
          }
          if (typeof o.start !== 'number' || !Number.isInteger(o.start) || o.start < 0) bad(`emphasisSpans[${i}].start は 0 以上の整数です。`)
          if (typeof o.end !== 'number' || !Number.isInteger(o.end) || o.end < 0) bad(`emphasisSpans[${i}].end は 0 以上の整数です。`)
          if (typeof o.text !== 'string') bad(`emphasisSpans[${i}].text は文字列です（アンカー）。`)
          if (typeof o.start === 'number' && typeof o.end === 'number' && o.end <= o.start) {
            bad(`emphasisSpans[${i}] は end > start である必要があります。`)
          }
        })
      }
    }

    // --- words (REQ-0556 §1) ---
    if ('words' in e) {
      const words = e.words
      if (!Array.isArray(words)) {
        bad('words は配列です。', 'read_subtitle --with-words と同じ形（text / startSec / endSec）です。')
      } else {
        words.forEach((w, i) => {
          if (!w || typeof w !== 'object' || Array.isArray(w)) { bad(`words[${i}] はオブジェクトです。`); return }
          const o = w as Record<string, unknown>
          for (const k of Object.keys(o)) {
            if (!WORD_KEYS.has(k)) bad(`未知のフィールド "words[${i}].${k}" です。`,
              `使用できるのは ${[...WORD_KEYS].join(' / ')} です。`)
          }
          if (typeof o.text !== 'string') bad(`words[${i}].text は文字列です。`)
          if (typeof o.startSec !== 'number' || !Number.isFinite(o.startSec)) bad(`words[${i}].startSec は数値です。`)
          if (typeof o.endSec !== 'number' || !Number.isFinite(o.endSec)) bad(`words[${i}].endSec は数値です。`)
          /*
           * A zero-length or reversed word cannot be swept: libass's `\kf`
           * consumes a duration, and a non-positive one makes the highlight
           * jump rather than travel. Rejected here rather than stored, because
           * unlike a text mismatch there is no sensible fallback to degrade to.
           */
          if (typeof o.startSec === 'number' && typeof o.endSec === 'number' && o.endSec <= o.startSec) {
            bad(`words[${i}] は endSec > startSec である必要があります。`)
          }
        })
      }
    }

    // --- wrap (REQ-0556 §2) ---
    if ('wrap' in e && e.wrap !== undefined) {
      if (e.wrap !== 'pack' && e.wrap !== 'overflow') {
        bad('wrap は "pack"（敷き詰め）か "overflow"（はみ出し）です。')
      }
    }

    if (problems.every((p) => p.editIndex !== editIndex)) edits.push(e as unknown as CueEdit)
  })

  return { edits, problems }
}

/**
 * REQ-0554 §1-3 — say so when a patch stores something that will not show.
 *
 * These follow `no-op-warnings.ts`'s流儀: the write succeeds (the value is what
 * the caller asked for) but the caller is told the combination does nothing, so
 * an agent does not build its next decision on a change it cannot see.
 */
export function collectCueEditWarnings(
  before: SubtitleEntry,
  after: SubtitleEntry,
  changed: string[],
  isPaid: boolean,
  warnings: RenderNotice[],
): void {
  const push = (code: string, message: string, detail: Record<string, unknown>): void => {
    // One warning per code per call: fifty cues with the same problem is one
    // fact, not fifty lines an agent has to read.
    if (warnings.some((w) => w.code === code)) return
    warnings.push({ code, message, detail })
  }

  // Spans stored, emphasis off → nothing renders.
  if ((after.emphasisSpans?.length ?? 0) > 0 && after.keywordEmphasisEnabled !== true) {
    push('EMPHASIS_SPANS_WITHOUT_ENABLE',
      '強調範囲を設定しましたが、キーワード強調が無効なため見た目は変わりません。',
      { cueId: after.id, spanCount: after.emphasisSpans?.length ?? 0,
        remedy: 'style.emphasis.enabled を true にしてください。' })
  }

  /*
   * Karaoke has no usable per-word timing → it falls back to an even split.
   *
   * Fires either when karaoke is ON, or — REQ-0556 §1 — when the caller
   * explicitly WROTE `words` that do not spell the cue's final text. The second
   * case matters even with karaoke off: the caller just supplied timings and is
   * entitled to know they will not be used as given, rather than discovering it
   * when they later switch karaoke on.
   */
  const wroteWords = changed.includes('words')
  if ((after.karaokeEnabled === true || wroteWords) && !areWordsValidForText(after.words, after.text)) {
    push('KARAOKE_NO_WORD_TIMING',
      wroteWords
        ? '指定された単語タイミングがこの cue のテキストを綴っていません（保存はしましたが、カラオケは均等割りになります）。'
        : 'カラオケが有効ですが、この cue には有効な単語タイミングがありません（均等割りになります）。',
      { cueId: after.id, hasWords: Array.isArray(after.words) && after.words.length > 0,
        karaokeEnabled: after.karaokeEnabled === true,
        // Which of the two situations this is, so a caller can branch without
        // reading Japanese prose.
        source: wroteWords ? 'patch' : 'stored',
        reason: '単語タイミングを連結したものが、現在のテキストと一致していません。',
        remedy: wroteWords
          ? 'words[].text の連結が text と一致するようにしてください（空白・改行は無視されます）。'
          : '実発話タイミングが必要な場合は再度文字起こししてください。' })
  }

  // Background on with a zero outline → under BorderStyle=3 the box collapses
  // onto the glyphs and is invisible (REQ-0340).
  if (after.subtitleBackground?.enabled === true && (after.outlineThicknessPx ?? 0) === 0) {
    push('BACKGROUND_NEEDS_OUTLINE',
      '背景ボックスが有効ですが、アウトライン幅が 0 のため背景は描画されません。',
      { cueId: after.id,
        reason: 'BorderStyle=3 の箱はアウトラインを太らせたものなので、0 では glyph に潰れます。',
        remedy: 'style.outlineThicknessPx を 1 以上にしてください。' })
  }

  // A paid font on a free build. The write is allowed — a project authored in
  // the paid edition must stay editable in the free one (CLAUDE.md §3-12) — but
  // the burn will substitute Noto, so say so now rather than at render time.
  if (changed.includes('style.fontId') && isFontId(after.fontId) && !canSelectFontInTier(isPaid, after.fontId)) {
    push('FONT_TIER_LOCKED',
      '無料版では使用できないフォントを設定しました（保存はされますが、焼き込み時に Noto Sans JP に置換されます）。',
      { cueId: after.id, fontId: after.fontId,
        reason: '追加フォントは有料版の機能です（遮断は焼き込み時の resolveFontIdForTier）。',
        remedy: '有料版で開くとこの指定どおりに描画されます。' })
  }

  // A text edit that leaves the stored timings no longer spelling the text.
  // They are NOT deleted (REQ-0554 §2-2): restoring the text restores them.
  if (changed.includes('text')
    && Array.isArray(before.words) && before.words.length > 0
    && areWordsValidForText(before.words, before.text)
    && !areWordsValidForText(after.words, after.text)) {
    push('WORD_TIMINGS_INVALIDATED',
      'テキストを変更したため、この cue の単語タイミングは現在のテキストと一致しなくなりました（カラオケは均等割り）。',
      { cueId: after.id, wordCount: before.words.length,
        reason: '保存自体は残しています（テキストを戻せば再び有効になります）。',
        remedy: '実発話タイミングが必要な場合は再度文字起こししてください。' })
  }

  // Spans that no longer sit on the text they were anchored to. `resolveEmphasis`
  // re-anchors what it can; anything it drops would silently not render.
  if (after.keywordEmphasisEnabled === true && (after.emphasisSpans?.length ?? 0) > 0) {
    const resolvedSpans = resolveEmphasis(after)
    if (resolvedSpans.ranges.length < (after.emphasisSpans?.length ?? 0)) {
      push('EMPHASIS_SPAN_UNRESOLVED',
        '一部の強調範囲がテキスト上に見つからず、描画されません。',
        { cueId: after.id,
          requested: after.emphasisSpans?.length ?? 0,
          resolved: resolvedSpans.ranges.length,
          reason: 'span の text（アンカー）が start/end 位置の文字列と一致せず、再解決もできませんでした。',
          remedy: 'read_subtitle で現在のテキストを読み、start/end/text を取り直してください。' })
    }
  }
}
