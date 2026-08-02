import type { WordSpan } from './types'
import { stripAllWhitespace } from './words-validity'

/**
 * REQ-0305 / REQ-0306 / REQ-0307 — Hormozi-style keyword emphasis: a per-cue
 * visual that draws chosen parts of a cue's text in a punchy colour + larger
 * size.
 *
 * ## Model history
 *
 * 1. **REQ-0305** stored `emphasizedWordIndices` into the Whisper `words`
 *    array, so emphasis died the moment the user edited the cue text
 *    (`areWordsValidForText` went false).  Owner verdict: unusable —
 *    transcripts always need fixing.
 * 2. **REQ-0306** replaced that with a list of **keyword substrings**
 *    (`emphasisKeywords`), re-matched against the current text at render
 *    time.  That fixed the edit-survival problem, but introduced a worse
 *    one: a keyword occurring twice in a cue emphasised BOTH occurrences,
 *    with no way to pick just one.
 * 3. **REQ-0307 (current)** stores **anchored character spans**
 *    (`emphasisSpans`): `{ start, end, text }` where `start`/`end` are
 *    code-unit offsets into the cue text and `text` is the substring that
 *    was selected (the *anchor*).
 *
 * ## Why span + anchor (and not either alone)
 *
 * - Offsets alone break on edit: inserting one character upstream shifts
 *   every later span onto the WRONG glyphs.  That is louder than losing the
 *   emphasis entirely, which is why the REQ calls it out explicitly.
 * - Anchors alone are the REQ-0306 model, which cannot disambiguate repeats.
 *
 * Storing both gives an exact primary key plus a repair hint.  Resolution
 * order (`resolveEmphasisSpans`, REQ-0307 §2):
 *
 *   1. `text.slice(start, end) === anchor` → use that range verbatim.  This
 *      is the normal case, and it emphasises ONLY the chosen occurrence even
 *      when the same substring appears elsewhere in the cue.
 *   2. Otherwise search the current text for the anchor.  Exactly one match
 *      → re-anchor the span there (the edit shifted it; follow it).
 *   3. Zero matches, or two-or-more (ambiguous) → drop THAT span only.  The
 *      cue's other spans are unaffected.
 *
 * Emphasis fundamentally does NOT need word timing, so none of this consults
 * `words` — emphasis works on cues with no / invalid `words` (REQ-0306 §1,
 * carried forward by REQ-0307 §3).
 *
 * Karaoke still needs `words` (for timing) and is untouched.  When BOTH are
 * on, the emphasis spans are mapped onto the karaoke word units and split at
 * `\k` block boundaries so a span that straddles two words still renders
 * correctly (REQ-0307 §4) — see `emphasizedWordRanges` + `splitTextByLocalRanges`.
 */

/**
 * Default emphasis colour — pink accent, distinct from the karaoke lime.
 *
 * REQ-0308 §5 — was `'#FFD400'` (gold).  Changed to a member of the REQ-0306
 * 16-colour `BASIC_COLORS` palette so the picker shows the default as a
 * selected swatch; the old gold was off-palette and always rendered with no
 * selection highlight.
 *
 * FALLBACK + toggle-ON seed only.  Colours already persisted in user settings
 * or in existing project cues are NOT migrated and keep their old value.
 */
export const EMPHASIS_DEFAULT_COLOR = '#FF2E88'

/** Default emphasis size as a percent of the cue font size (130 = 1.3×). */
export const EMPHASIS_DEFAULT_SCALE_PERCENT = 130

/**
 * Emphasis size multiplier clamp range (percent).
 *
 * REQ-0308 §4-4 — the floor was 100 (grow-only).  It is now 50 so a span can
 * also SHRINK, which the owner wants for "said quietly" nuance.  Because
 * `scale < 1` is now reachable, every width measurer must reflect the
 * multiplier in BOTH directions — see the `scale !== 1` guards in
 * `overflow-calculator.ts` and `auto-line-break.ts`.  The pre-REQ-0308 guards
 * tested `scale > 1`, which would have measured a shrunk span at full size and
 * wrapped it earlier than the burn-in needs.
 */
export const EMPHASIS_SCALE_MIN_PERCENT = 50
export const EMPHASIS_SCALE_MAX_PERCENT = 200

/** ± step for the size-multiplier stepper. */
export const EMPHASIS_SCALE_STEP_PERCENT = 10

/**
 * REQ-0305 §1 — tier gate.  Mirrors `canUseKaraokeInTier` (REQ-0299):
 * keyword emphasis is FREE for every tier.  Kept as a single function so
 * (like karaoke) it is the sole decision surface — the 3 UI screens and
 * the ass-generator all consult this rather than inlining an `isMsix`
 * check.  Flip to `return isMsix` to make it paid again.
 */
export function canUseKeywordEmphasisInTier(_isMsix: boolean): boolean {
  return true
}

/**
 * Clamp a raw emphasis-scale percent into the supported range, rounding to
 * an integer.  `undefined` resolves to the default (130).
 */
export function clampEmphasisScalePercent(v: number | undefined): number {
  const raw = v ?? EMPHASIS_DEFAULT_SCALE_PERCENT
  if (!Number.isFinite(raw)) return EMPHASIS_DEFAULT_SCALE_PERCENT
  return Math.max(
    EMPHASIS_SCALE_MIN_PERCENT,
    Math.min(EMPHASIS_SCALE_MAX_PERCENT, Math.round(raw)),
  )
}

// ---------------------------------------------------------------------------
// Legacy keyword list (REQ-0306) — retained for MIGRATION ONLY
// ---------------------------------------------------------------------------

/** De-duplicate + trim a keyword list, dropping empties.  Order preserved. */
function normaliseKeywords(keywords: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const k of keywords) {
    const t = k.trim()
    if (t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

/**
 * REQ-0306 — resolve the emphasis keywords for a cue, migrating the legacy
 * REQ-0305 `emphasizedWordIndices` on the fly.
 *
 * - If `keywords` is defined (new format), it wins — even an empty array means
 *   "the user is on the new model with nothing selected".
 * - Otherwise, if legacy indices + words exist, derive keywords from the words
 *   at those indices (best-effort migration; unreleased so lossy is fine).
 * - Otherwise, no emphasis.
 *
 * Never throws.
 */
export function resolveEmphasisKeywords(
  keywords: readonly string[] | undefined,
  legacyIndices: readonly number[] | undefined,
  words: readonly WordSpan[] | undefined,
): string[] {
  if (keywords !== undefined) return normaliseKeywords(keywords)
  if (legacyIndices && legacyIndices.length > 0 && words && words.length > 0) {
    const migrated: string[] = []
    for (const i of legacyIndices) {
      if (Number.isInteger(i) && i >= 0 && i < words.length) {
        migrated.push(words[i].text)
      }
    }
    return normaliseKeywords(migrated)
  }
  return []
}

// ---------------------------------------------------------------------------
// Range matching
// ---------------------------------------------------------------------------

export type EmphasisRange = readonly [number, number]

/**
 * Find every occurrence of every keyword in `text` and return the merged,
 * sorted list of emphasised code-unit ranges `[start, end)`.  Matches are
 * literal + case-sensitive; overlapping matches merge into one range.  A
 * keyword never matches across a `\N` sentinel because keywords are trimmed
 * visible substrings (no backslash), so a literal `indexOf` stops at the
 * boundary naturally.
 *
 * REQ-0307: this "emphasise EVERY occurrence" semantic is exactly the bug the
 * span model replaced, so the function survives only as the **migration** step
 * from a REQ-0306 keyword list to REQ-0307 spans (see `resolveEmphasis`).  New
 * code must not call it to decide what to render.
 */
export function computeEmphasisRanges(text: string, keywords: readonly string[]): EmphasisRange[] {
  const raw: Array<[number, number]> = []
  for (const kwRaw of keywords) {
    const kw = kwRaw.trim()
    if (!kw) continue
    let from = 0
    for (;;) {
      const idx = text.indexOf(kw, from)
      if (idx === -1) break
      raw.push([idx, idx + kw.length])
      from = idx + kw.length
    }
  }
  return mergeRanges(raw)
}

/** True if code-unit `offset` falls inside any emphasis range. */
export function isEmphasizedAt(offset: number, ranges: readonly EmphasisRange[]): boolean {
  for (const [s, e] of ranges) {
    if (offset >= s && offset < e) return true
  }
  return false
}

/** Merge + sort raw `[start, end)` pairs into disjoint ascending ranges. */
function mergeRanges(raw: ReadonlyArray<readonly [number, number]>): EmphasisRange[] {
  if (raw.length <= 1) return raw.map(([s, e]) => [s, e] as EmphasisRange)
  const sorted = raw.map(([s, e]) => [s, e] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: Array<[number, number]> = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    if (sorted[i][0] <= last[1]) {
      last[1] = Math.max(last[1], sorted[i][1])
    } else {
      merged.push(sorted[i])
    }
  }
  return merged
}

// ---------------------------------------------------------------------------
// REQ-0307 — anchored character spans (the storage model)
// ---------------------------------------------------------------------------

/**
 * REQ-0307 §2 — one emphasised selection, stored as a character range PLUS the
 * substring it covered when it was made.
 *
 * `start` / `end` are code-unit offsets into the cue's `text` (which may
 * contain `\N` hard-break sentinels; a span never spans a `\N` because the
 * picker never lets the user select one).  `text` is the anchor used to repair
 * the offsets after a text edit — see `resolveEmphasisSpans`.
 */
export interface EmphasisSpan {
  start: number
  end: number
  text: string
}

/** Result of resolving stored spans against the cue's current text. */
export interface EmphasisResolution {
  /** Disjoint, ascending code-unit ranges to emphasise, in `text` coordinates. */
  ranges: EmphasisRange[]
  /**
   * The stored spans after resolution: re-anchored where rule 2 fired, with
   * unresolvable spans dropped, sorted by `start`.  Safe to persist back.
   */
  spans: EmphasisSpan[]
  /**
   * True when `spans` differs from what was passed in (a span was re-anchored,
   * dropped, re-ordered, or migrated from a legacy format).  Callers that own a
   * writable entry MAY persist `spans` so the next resolve takes rule 1.
   */
  changed: boolean
}

/** Remove every `\N` hard-break sentinel from `s`. */
function stripHardBreaks(s: string): string {
  return s.replace(/\\N/g, '')
}

/**
 * REQ-0309 §3(A) — `text` with every `\N` removed, plus the two index maps that
 * move offsets between the original and the break-free coordinate systems.
 *
 * - `origToNorm[i]` — position in `norm` of original code unit `i`.  Both code
 *   units of a `\N` map to the position the sentinel was removed from, so an
 *   offset pointing at a break resolves to the character that follows it.
 * - `normToOrig[j]` — original offset of `norm[j]`.  Has one extra trailing
 *   entry (`text.length`) so `normToOrig[norm.length]` is a valid end sentinel.
 *
 * Indices are per CODE UNIT throughout, matching the rest of the emphasis and
 * karaoke mapping code (a surrogate pair occupies two positions on both axes,
 * and `\N` can never be inserted between its halves).
 */
interface BreakFreeProjection {
  norm: string
  origToNorm: number[]
  normToOrig: number[]
}

function breakFreeProjection(text: string): BreakFreeProjection {
  const origToNorm = new Array<number>(text.length + 1)
  const normToOrig: number[] = []
  let norm = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '\\' && text[i + 1] === 'N') {
      origToNorm[i] = norm.length
      origToNorm[i + 1] = norm.length
      i += 2
      continue
    }
    origToNorm[i] = norm.length
    normToOrig.push(i)
    norm += text[i]
    i += 1
  }
  origToNorm[text.length] = norm.length
  normToOrig.push(text.length)
  return { norm, origToNorm, normToOrig }
}

/** Structural guard — a corrupt / legacy save must never throw (REQ-0307 §3). */
function isEmphasisSpan(v: unknown): v is EmphasisSpan {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Partial<EmphasisSpan>
  return (
    typeof o.start === 'number' &&
    typeof o.end === 'number' &&
    typeof o.text === 'string' &&
    Number.isInteger(o.start) &&
    Number.isInteger(o.end)
  )
}

function sameSpans(a: readonly EmphasisSpan[], b: readonly EmphasisSpan[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end || a[i].text !== b[i].text) return false
  }
  return true
}

/**
 * REQ-0307 §2 — resolve stored spans against the cue's CURRENT text.
 *
 * Per span, in order:
 *   1. the stored range still holds the stored anchor → keep it verbatim.
 *      **This is what makes duplicate substrings safe**: the offsets pick the
 *      occurrence the user clicked, not "every occurrence of this string".
 *   1′. (REQ-0309 §3(A)) the stored offsets still cover the same characters once
 *      `\N` is ignored → keep the range, widened across the break(s).
 *   2. else, the anchor occurs exactly once in the `\N`-free text → re-anchor
 *      there (the user edited earlier in the cue and everything shifted).
 *   3. else (absent, or two-plus candidates and therefore ambiguous) → drop
 *      that span.  Every other span survives.
 *
 * ## Why `\N` is ignored when matching (REQ-0309 §3(A))
 *
 * Auto line-break inserts `\N` wherever the line runs out of width, which can
 * land in the middle of an emphasised run.  Pre-REQ-0309 that broke the anchor
 * and dropped the span, which fed a genuine feedback loop: the emphasis
 * vanished, the cue therefore measured NARROWER than when the break position
 * was chosen, so a second press produced a different wrap and the user had to
 * re-emphasise the text around the break by hand (REQ-0309 §1).
 *
 * Comparing on a `\N`-free footing removes the loop at its root, and it is the
 * same tactic `areWordsValidForText` already uses so karaoke survives breaks.
 * A span may therefore SPAN a `\N`; every consumer handles that:
 * `tokenizeEmphasis` / `buildEmphasisBody` emit the break between two
 * emphasised runs, and `emphasizedWordRanges` skips the sentinel because it
 * carries no stripped index.
 *
 * Never throws: non-object / NaN / negative / inverted entries are treated as
 * unresolvable and dropped.
 */
export function resolveEmphasisSpans(
  text: string,
  spans: readonly unknown[] | undefined,
): EmphasisResolution {
  const input: EmphasisSpan[] = []
  const resolved: EmphasisSpan[] = []
  // REQ-0309 §3(A) — built lazily so a cue whose spans all hit rule 1 (the
  // overwhelmingly common case) pays nothing for the normalisation machinery.
  let proj: BreakFreeProjection | null = null
  const projection = (): BreakFreeProjection => (proj ??= breakFreeProjection(text))
  for (const raw of spans ?? []) {
    if (!isEmphasisSpan(raw)) continue
    input.push({ start: raw.start, end: raw.end, text: raw.text })
    const anchor = raw.text
    if (anchor.length === 0) continue
    // Rule 1 — stored offsets still hold the stored anchor.
    if (
      raw.start >= 0 &&
      raw.end === raw.start + anchor.length &&
      text.slice(raw.start, raw.end) === anchor
    ) {
      resolved.push({ start: raw.start, end: raw.end, text: anchor })
      continue
    }
    // REQ-0309 §3(A) — retry rules 1 and 2 against the text with every `\N`
    // removed.  A line break inserted INSIDE an emphasised run must not destroy
    // the emphasis: pre-REQ-0309 it did, and that fed a loop where wrapping
    // cleared the emphasis, the cue then measured narrower, and the next press
    // produced a different wrap (REQ-0309 §1/§2).  Anchors are compared on the
    // same `\N`-free footing that `areWordsValidForText` already uses for
    // karaoke, so emphasis now survives a break exactly like karaoke does.
    const { norm, origToNorm, normToOrig } = projection()
    const a = stripHardBreaks(anchor)
    if (a.length === 0) continue

    /** Original-text `[start, end)` for a match at `normStart` in `norm`. */
    const toOriginal = (normStart: number): EmphasisSpan | null => {
      const s = normToOrig[normStart]
      // `end` is one past the LAST matched character, so a `\N` sitting just
      // after the run is NOT swallowed into the range.
      const lastOrig = normToOrig[normStart + a.length - 1]
      if (s === undefined || lastOrig === undefined) return null
      const e = lastOrig + 1
      return e > s ? { start: s, end: e, text: a } : null
    }

    // Rule 1′ — the stored offsets still cover the same characters; one or more
    // hard breaks have simply moved inside the range.
    if (raw.start >= 0 && raw.start <= text.length) {
      const ns = origToNorm[raw.start]
      if (ns !== undefined && norm.slice(ns, ns + a.length) === a) {
        const span = toOriginal(ns)
        if (span !== null) {
          resolved.push(span)
          continue
        }
      }
    }
    // Rule 2 — unique occurrence elsewhere → follow the edit.
    const first = norm.indexOf(a)
    if (first === -1) continue                      // rule 3 (absent)
    if (norm.indexOf(a, first + 1) !== -1) continue  // rule 3 (ambiguous)
    const span = toOriginal(first)
    if (span === null) continue
    resolved.push(span)
  }
  resolved.sort((a, b) => a.start - b.start || a.end - b.end)
  // Two spans can resolve onto the identical range (e.g. duplicated storage);
  // keep one so the persisted list stays canonical.
  const deduped: EmphasisSpan[] = []
  for (const sp of resolved) {
    const prev = deduped[deduped.length - 1]
    if (prev && prev.start === sp.start && prev.end === sp.end) continue
    deduped.push(sp)
  }
  return {
    ranges: mergeRanges(deduped.map((s) => [s.start, s.end] as const)),
    spans: deduped,
    changed: !sameSpans(input, deduped),
  }
}

/**
 * The minimal shape `resolveEmphasis` needs off a cue.  Kept structural so the
 * renderer (`SubtitleEntry`), the ass-generator and the tests can all pass
 * their own object without a cast.
 */
export interface EmphasisSource {
  text: string
  /** REQ-0307 storage model. */
  emphasisSpans?: readonly unknown[]
  /** @deprecated REQ-0306 keyword list — migrated on read. */
  emphasisKeywords?: readonly string[]
  /** @deprecated REQ-0305 word indices — migrated on read. */
  emphasizedWordIndices?: readonly number[]
  words?: readonly WordSpan[]
}

/**
 * REQ-0307 §3 — resolve a cue's emphasis, migrating the two legacy formats.
 *
 * Precedence:
 *   - `emphasisSpans` defined (even as `[]`, meaning "on the new model with
 *     nothing selected") → resolve it.
 *   - else `emphasisKeywords` (REQ-0306) → every occurrence of every keyword
 *     becomes a span anchored at that occurrence.  This reproduces the old
 *     rendering exactly, and the first save through the picker turns it into
 *     explicit per-occurrence spans.
 *   - else `emphasizedWordIndices` + `words` (REQ-0305) → the same, via the
 *     word texts at those indices.
 *   - else no emphasis.
 *
 * Migration paths report `changed: true` so a caller with a writable entry can
 * persist the upgrade.  Never throws.
 */
export function resolveEmphasis(src: EmphasisSource): EmphasisResolution {
  if (src.emphasisSpans !== undefined) {
    return resolveEmphasisSpans(src.text, src.emphasisSpans)
  }
  const keywords = resolveEmphasisKeywords(src.emphasisKeywords, src.emphasizedWordIndices, src.words)
  if (keywords.length === 0) {
    return { ranges: [], spans: [], changed: false }
  }
  const ranges = computeEmphasisRanges(src.text, keywords)
  const spans = ranges.map(([s, e]) => ({ start: s, end: e, text: src.text.slice(s, e) }))
  return { ranges, spans, changed: spans.length > 0 }
}

/** Convenience — just the ranges, for width measurement call sites. */
export function resolveEmphasisRanges(src: EmphasisSource): EmphasisRange[] {
  return resolveEmphasis(src).ranges
}

/**
 * REQ-0376 §A — the largest font size the cue actually RENDERS, in ASS px,
 * accounting for keyword emphasis.
 *
 * Keyword emphasis emits an enlarged run with `\fs<scaled>` where
 * `scaled = round(fontSizePx × emphasisScalePercent / 100)` (the exact value
 * `ass-generator` writes, REQ-0308 §4-4).  libass's `fix_collisions` reserves
 * space for the ACTUAL rendered bitmap, so an emphasised cue is taller than its
 * base `fontSizePx` — measured in REQ-0376 §A: a `\fs240` run under a base
 * `\fs160` cue pushed the cue above it 80 px higher (= 240 − 160).
 *
 * `estimateCueHeightAssPx` used the nominal `fontSizePx`, so the preview's
 * stack estimate under-shot libass and overlapping emphasised cues sat at
 * different heights in the preview vs the burn.  Feeding this value in fixes
 * the parity.
 *
 * Gated exactly like the render/emit path (`keywordEmphasisEnabled` AND the
 * tier gate AND at least one resolved range), so it returns the base size
 * whenever nothing is actually enlarged — which keeps every non-emphasis cue,
 * and every free-tier cue, byte-identical.  A shrunk span (scale < 100 %)
 * cannot lower the height below the base because of the `Math.max`.
 */
export function cueMaxRenderedFontAssPx(
  entry: EmphasisSource & {
    fontSizePx: number
    keywordEmphasisEnabled?: boolean
    emphasisScalePercent?: number
  },
  emphasisTierAllowed: boolean,
): number {
  const base = entry.fontSizePx
  if (!emphasisTierAllowed || entry.keywordEmphasisEnabled !== true) return base
  if (resolveEmphasis(entry).ranges.length === 0) return base
  const scaled = Math.round(base * (clampEmphasisScalePercent(entry.emphasisScalePercent) / 100))
  return Math.max(base, scaled)
}

/**
 * REQ-0307 §1 — turn the picker's per-character selection into storable spans.
 *
 * `selectedStarts` holds the code-unit offset of each selected character CELL
 * (one per code point, so a surrogate pair is one entry).  `cells` is the
 * picker's ordered cell list; consecutive selected cells that are physically
 * adjacent in `text` become one span.  A `\N` sentinel is never a cell, so a
 * selection either side of a line break naturally yields two spans and the
 * anchors never contain a backslash.
 */
export function spansFromSelection(
  text: string,
  cells: ReadonlyArray<{ start: number; length: number }>,
  selectedStarts: ReadonlySet<number>,
): EmphasisSpan[] {
  const spans: EmphasisSpan[] = []
  let runStart = -1
  let runEnd = -1
  const flush = (): void => {
    // REQ-0309 §3(A) — the anchor is stored `\N`-free so it never contains a
    // backslash even when the run straddles a break, and so it stays as long
    // (and therefore as unambiguous) as what the user actually selected.
    if (runStart >= 0) {
      spans.push({ start: runStart, end: runEnd, text: stripHardBreaks(text.slice(runStart, runEnd)) })
    }
    runStart = -1
    runEnd = -1
  }
  for (const cell of cells) {
    if (!selectedStarts.has(cell.start)) {
      flush()
      continue
    }
    // REQ-0309 §3(A) — treat a run as continuing across any gap that is made up
    // purely of `\N` sentinels.  A selection the user swept over a wrapped word
    // is ONE emphasis, not two: splitting it here would leave two short anchors
    // (e.g. "プレ" + "イ") that are far easier to render ambiguous by a later
    // edit than the single "プレイ".
    const gapIsBreaksOnly =
      runStart >= 0 && cell.start > runEnd && /^(?:\\N)+$/.test(text.slice(runEnd, cell.start))
    if (runStart >= 0 && (runEnd === cell.start || gapIsBreaksOnly)) {
      runEnd = cell.start + cell.length
    } else {
      flush()
      runStart = cell.start
      runEnd = cell.start + cell.length
    }
  }
  flush()
  return spans
}

/**
 * REQ-0307 §1 — inverse of `spansFromSelection`: which picker cells are covered
 * by the given (already-resolved) ranges.
 */
export function selectionFromRanges(
  cells: ReadonlyArray<{ start: number; length: number }>,
  ranges: readonly EmphasisRange[],
): Set<number> {
  const out = new Set<number>()
  for (const cell of cells) {
    if (isEmphasizedAt(cell.start, ranges)) out.add(cell.start)
  }
  return out
}

/**
 * REQ-0307 — translate ranges expressed in ORIGINAL text coordinates (where a
 * hard break is the two characters `\` + `N`) into the coordinates of a text
 * in which every `\N` has been collapsed to `breakLength` characters.
 *
 * Two call sites need this, both because they measure a *rewritten* string
 * while the spans were anchored against the stored one:
 *   - `overflow-calculator` measures `text.replace(/\\N/g, '\n')` → 1
 *   - the "pack" wrap mode measures `text.replace(/\\N/g, '')`     → 0
 *
 * Each collapsed sentinel shifts everything after it left, so reusing the raw
 * offsets would drift by (2 − breakLength) per preceding break — silently
 * enlarging the wrong glyphs.
 */
export function mapRangesAcrossBreakCollapse(
  text: string,
  ranges: readonly EmphasisRange[],
  breakLength: 0 | 1,
): EmphasisRange[] {
  if (ranges.length === 0) return []
  // origToNew[i] = index in the collapsed string of original code unit i.
  const origToNew = new Array<number>(text.length + 1)
  let i = 0
  let n = 0
  while (i < text.length) {
    if (text[i] === '\\' && text[i + 1] === 'N') {
      origToNew[i] = n
      origToNew[i + 1] = n + breakLength
      n += breakLength
      i += 2
      continue
    }
    origToNew[i] = n
    n += 1
    i += 1
  }
  origToNew[text.length] = n
  const mapped: Array<[number, number]> = []
  for (const [s, e] of ranges) {
    const ms = origToNew[Math.max(0, Math.min(text.length, s))]
    const me = origToNew[Math.max(0, Math.min(text.length, e))]
    if (me > ms) mapped.push([ms, me])
  }
  return mergeRanges(mapped)
}

// ---------------------------------------------------------------------------
// Rendering tokeniser (shared by CSS preview + ASS burn-in)
// ---------------------------------------------------------------------------

export type EmphasisToken =
  | { kind: 'break' }
  | { kind: 'text'; text: string; emphasized: boolean }

/**
 * Split `text` (which may contain `\N` sentinels) into a token stream of
 * line-breaks and maximal same-emphasis text runs, according to `ranges`.
 * The concatenation of the text tokens (with `\N` re-inserted for breaks)
 * reproduces the original text exactly, so when nothing is emphasised the
 * output is identical to the plain text — no parity risk.
 *
 * `\N` is always emitted as a break regardless of ranges, so a keyword that
 * happens to cover a sentinel char can never corrupt the line structure.
 */
export function tokenizeEmphasis(text: string, ranges: readonly EmphasisRange[]): EmphasisToken[] {
  const tokens: EmphasisToken[] = []
  let buf = ''
  let bufEmph = false
  const flush = (): void => {
    if (buf) {
      tokens.push({ kind: 'text', text: buf, emphasized: bufEmph })
      buf = ''
    }
  }
  let i = 0
  while (i < text.length) {
    if (text[i] === '\\' && text[i + 1] === 'N') {
      flush()
      tokens.push({ kind: 'break' })
      i += 2
      continue
    }
    const cp = text.codePointAt(i)!
    const len = cp > 0xffff ? 2 : 1
    const emph = isEmphasizedAt(i, ranges)
    if (buf && emph !== bufEmph) flush()
    if (!buf) bufEmph = emph
    buf += text.substr(i, len)
    i += len
  }
  flush()
  return tokens
}

/**
 * REQ-0306 — build the ASS text body for the karaoke-OFF emphasis path from
 * the keyword ranges.  Emits `\N` for breaks and wraps each emphasised run in
 * `{openTag}...{closeTag}` (both brace-enclosed — REQ-0291 well-formedness).
 * `escapeText` handles casing + ASS escaping per run.
 *
 * @param openTag  tag(s) WITHOUT braces before an emphasised run — e.g.
 *                 `\fs150\c&H0034D4FF&`.
 * @param closeTag tag(s) WITHOUT braces after — e.g. `\fs100\c&H00FFFFFF&`.
 */
export function buildEmphasisBody(
  text: string,
  ranges: readonly EmphasisRange[],
  escapeText: (s: string) => string,
  openTag: string,
  closeTag: string,
): string {
  const parts: string[] = []
  for (const tok of tokenizeEmphasis(text, ranges)) {
    if (tok.kind === 'break') {
      parts.push('\\N')
    } else if (tok.emphasized) {
      parts.push(`{${openTag}}${escapeText(tok.text)}{${closeTag}}`)
    } else {
      parts.push(escapeText(tok.text))
    }
  }
  return parts.join('')
}

// ---------------------------------------------------------------------------
// Karaoke coexistence — map keyword ranges onto karaoke word units
// ---------------------------------------------------------------------------

/**
 * REQ-0307 §4 — project emphasis ranges (cue-text coordinates) onto the karaoke
 * word units, at CHARACTER granularity.
 *
 * REQ-0306 answered "which whole words are emphasised", which was fine while
 * the selection unit was a keyword.  With per-character selection a span can
 * start mid-word and/or straddle two `\k` blocks, so the emitter needs to know
 * *which characters of which word*.  The returned map is keyed by word index;
 * each value holds `[start, end)` ranges in that word's **whitespace-stripped**
 * character coordinates.  Words with no emphasis are absent from the map.
 *
 * Both the real `words` list and the equal-split fallback units satisfy
 * `stripAllWhitespace(concat) === stripAllWhitespace(cueText)`, so walking the
 * stripped cue in lockstep with the stripped word texts is a valid one-to-one
 * mapping for either source (this is the same invariant `computeKaraokeBreaks`
 * relies on).  That is what lets emphasis ride along with karaoke on edited
 * cues, where the fallback units are in play.
 */
export function emphasizedWordRanges(
  cueText: string,
  words: readonly WordSpan[],
  ranges: readonly EmphasisRange[],
): Map<number, EmphasisRange[]> {
  const out = new Map<number, EmphasisRange[]>()
  if (ranges.length === 0 || words.length === 0) return out

  // Map every cue-text code unit to its index in the stripped cue (or -1 when
  // it is whitespace / part of a `\N` sentinel and therefore has no counterpart
  // in the word texts).
  const strippedIndex = new Array<number>(cueText.length).fill(-1)
  let s = 0
  for (let i = 0; i < cueText.length; ) {
    if (cueText[i] === '\\' && cueText[i + 1] === 'N') {
      i += 2
      continue
    }
    if (/\s/.test(cueText[i])) {
      i++
      continue
    }
    strippedIndex[i] = s
    s++
    i++
  }

  // Translate each cue range into stripped-cue coordinates.  Dropping the
  // skipped characters keeps the surviving indices contiguous, so min..max+1
  // is exact rather than an approximation.
  const strippedRanges: Array<[number, number]> = []
  for (const [rs, re] of ranges) {
    let lo = -1
    let hi = -1
    for (let i = Math.max(0, rs); i < Math.min(cueText.length, re); i++) {
      const si = strippedIndex[i]
      if (si < 0) continue
      if (lo < 0) lo = si
      hi = si
    }
    if (lo >= 0) strippedRanges.push([lo, hi + 1])
  }
  if (strippedRanges.length === 0) return out
  const merged = mergeRanges(strippedRanges)

  // Walk the words over the same stripped axis and clip each range into
  // word-local coordinates.
  let cursor = 0
  for (let w = 0; w < words.length; w++) {
    const len = stripAllWhitespace(words[w].text).length
    if (len > 0) {
      const local = clipRangesToWindow(merged, cursor, cursor + len)
      if (local.length > 0) out.set(w, local)
    }
    cursor += len
  }
  return out
}

/**
 * Clip `ranges` to the window `[start, end)` and re-express the survivors in
 * window-local coordinates (i.e. with `start` subtracted).  Ranges entirely
 * outside the window are dropped; one that straddles an edge is cut at it.
 *
 * REQ-0307 §4 introduced this as the per-`\k`-block clip inside
 * `emphasizedWordRanges`; REQ-0330 §1 hoisted it out because the per-display-
 * line body builder in `ass-generator` needs exactly the same operation on a
 * different axis (cue-text code units instead of stripped-cue ones).  Keeping
 * ONE implementation is the point: two hand-rolled clips would be two chances
 * to disagree about whether the edges are inclusive.
 *
 * Input must be disjoint + ascending (everything here comes out of
 * `mergeRanges`); the output then is too.
 */
export function clipRangesToWindow(
  ranges: readonly EmphasisRange[],
  start: number,
  end: number,
): EmphasisRange[] {
  const out: EmphasisRange[] = []
  for (const [a, b] of ranges) {
    const lo = Math.max(a, start)
    const hi = Math.min(b, end)
    if (hi > lo) out.push([lo - start, hi - start])
  }
  return out
}

/** One run of a word split by emphasis — see `splitTextByLocalRanges`. */
export interface EmphasisRun {
  text: string
  emphasized: boolean
}

/**
 * REQ-0307 §4 — split one karaoke word's text into maximal emphasised /
 * plain runs, given ranges in that word's whitespace-stripped coordinates
 * (as produced by `emphasizedWordRanges`).
 *
 * Whitespace inside the word text (faster-whisper's leading `" word"` space)
 * carries no stripped index and is therefore never emphasised — which is what
 * we want: growing the leading space would push the word sideways for no
 * visual gain.  Concatenating the runs reproduces `wordText` exactly, so a word
 * with no emphasis is byte-identical to the plain path.
 */
export function splitTextByLocalRanges(
  wordText: string,
  ranges: readonly EmphasisRange[],
): EmphasisRun[] {
  const runs: EmphasisRun[] = []
  let buf = ''
  let bufEmph = false
  const flush = (): void => {
    if (buf) runs.push({ text: buf, emphasized: bufEmph })
    buf = ''
  }
  let stripped = 0
  for (const ch of wordText) {
    const isSpace = /\s/.test(ch)
    const emph = !isSpace && isEmphasizedAt(stripped, ranges)
    if (buf && emph !== bufEmph) flush()
    if (!buf) bufEmph = emph
    buf += ch
    // Advance by code UNITS — `emphasizedWordRanges` indexes the stripped cue
    // per code unit, so a surrogate pair must consume two positions here too.
    if (!isSpace) stripped += ch.length
  }
  flush()
  return runs
}
