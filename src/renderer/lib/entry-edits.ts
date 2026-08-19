import type { SubtitleEntry } from '../../shared/types'
import { resolveLayer } from '../../shared/cue-placement'

/**
 * Centisecond precision (= 1 / 100 s).  This is the precision at which:
 *
 *  - the TimeInput field formats and parses (`formatTimecode` /
 *    `parseTimecode` in `lib/time.ts` use `HH:MM:SS.cc`),
 *  - the TimeEditorDialog rounds its commit (`roundCs` in
 *    `time-editor-dialog.tsx`),
 *  - the ASS burn-in writer emits time tags (`formatAssTime` in
 *    `main/services/ass-generator.ts`),
 *
 * so the user can never observe a difference smaller than this between the
 * "stored" and "displayed" value of a row.
 *
 * Aligning timeline drag output to the same precision keeps all three edit
 * entry points (dialog, inline TimeInput, drag) writing values that compare
 * exactly across renders — without it, `dxPx / pixelsPerSec` accumulates
 * float drift and a round-trip drag back to a row's original start time
 * lands at e.g. `13.0700001` while the display still reads "00:00:13.07",
 * leaving the row permanently flagged as edited.  (REQ-059.)
 */
const CENTISECOND_PER_SEC = 100

/** Round seconds to centisecond precision (matches display / ASS write precision). */
export function roundToCs(sec: number): number {
  return Math.round(sec * CENTISECOND_PER_SEC) / CENTISECOND_PER_SEC
}

/**
 * REQ-0528 §2-2 — the highest cue time the video can carry, in seconds.
 *
 * FLOORED to a centisecond, and that is not cosmetic: every write path rounds
 * through {@link roundToCs}, which is HALF-UP, so a ceiling of e.g. 7.235 would
 * let a clamped value round back up to 7.24 — above the video. Flooring first
 * means the post-round value can never exceed the duration. The rule was
 * established for the drag path by REQ-20260613-012; this is that same
 * expression, lifted so the drag and the dialog cannot drift apart.
 *
 * Returns `Number.MAX_VALUE` when there is no usable duration (no video loaded,
 * or audio-only mode, which deliberately passes `Infinity`) — i.e. no ceiling,
 * which is what every caller wants in that state.
 */
export function cueCeilingSec(videoDurationSec: number): number {
  return isFinite(videoDurationSec) && videoDurationSec > 0
    ? Math.floor(videoDurationSec * CENTISECOND_PER_SEC) / CENTISECOND_PER_SEC
    : Number.MAX_VALUE
}

/**
 * REQ-0528 §2 — bring a cue's times inside the video's duration.
 *
 * The single clamp for NON-DRAG edit paths. The timeline drag/resize path has
 * always clamped (inside `computeDragPatch`), and it now shares
 * {@link cueCeilingSec} with this function so "the ceiling" has exactly one
 * definition; what REQ-0528 fixes is that the 「時間を調整」 dialog — the other
 * way to set a time — had no ceiling at all and could push a cue to 16 s on a
 * 7 s video.
 *
 * Both ends are clamped, not just the end: a start beyond the video is equally
 * unrenderable. If a cue lies ENTIRELY beyond the duration both ends land on
 * the ceiling and it becomes zero-length — deliberately left to surface as the
 * existing `timeInvalid` badge rather than silently invented into some
 * plausible-looking span, because there is no honest guess for where a cue that
 * was never inside the video "should" go.
 *
 * `clamped` lets a caller tell the user something happened instead of silently
 * moving their input.
 */
export function clampCueTimesToDuration(
  startSec: number,
  endSec: number,
  videoDurationSec: number,
): { startSec: number; endSec: number; clamped: boolean } {
  const ceiling = cueCeilingSec(videoDurationSec)
  const nextStart = Math.min(startSec, ceiling)
  const nextEnd = Math.min(endSec, ceiling)
  return {
    startSec: nextStart,
    endSec: nextEnd,
    clamped: nextStart !== startSec || nextEnd !== endSec,
  }
}

/**
 * True iff `a` and `b` would render to the same centisecond display tag
 * (`HH:MM:SS.cc`).  Uses integer-cs comparison rather than float subtraction
 * with an epsilon so values straddling a 0.005 s bucket boundary still get
 * classified by the same rule the UI display uses.
 */
function sameCs(a: number, b: number): boolean {
  return Math.round(a * CENTISECOND_PER_SEC) === Math.round(b * CENTISECOND_PER_SEC)
}

/**
 * Recompute whether a row is in the "edited" state by comparing each field
 * against its `original` snapshot.  Replaces the previous convention of
 * callers manually setting `isEdited: true` on every patch — that convention
 * could not detect "edited then restored" round-trips (e.g. drag the block
 * away and back, type the same value into TimeInput a second time, reset a
 * single field via undo).
 *
 * Comparison rules:
 *
 *  - **startSec / endSec**: same-centisecond comparison.  A drag that
 *    returns the row to its displayed start time (e.g. `13.07`) reads as
 *    "not edited" even if the underlying float is `13.0700001` due to
 *    `dxPx / pixelsPerSec` drift, because both sides round to `1307` cs.
 *    Pre-existing Whisper-imported originals at sub-cs precision (e.g.
 *    `13.0712...` from faster-whisper) compare against the user's
 *    cs-aligned edit at their cs display — matching what the UI actually
 *    shows.
 *  - **text / fontSizePx / textColorHex / outlineColorHex /
 *    outlineThicknessPx / fadeDurationSec / fontId**: strict `!==`.  These
 *    fields are either discrete (integers, enums, hex strings, booleans)
 *    or carry no display-precision concept, so no tolerance applies.
 *
 * Excluded: `isDeleted` (a separate state, orthogonal to "edited"), `id`
 * and `original` itself (structural metadata, not user data).
 */
export function isEditedFromOriginal(e: SubtitleEntry): boolean {
  const o = e.original
  return (
    !sameCs(e.startSec, o.startSec) ||
    !sameCs(e.endSec, o.endSec) ||
    e.text !== o.text ||
    e.fontSizePx !== o.fontSizePx ||
    e.textColorHex !== o.textColorHex ||
    e.outlineColorHex !== o.outlineColorHex ||
    e.outlineThicknessPx !== o.outlineThicknessPx ||
    e.fadeDurationSec !== o.fadeDurationSec ||
    e.fontId !== o.fontId ||
    // REQ-20260613-016 / v1.2.2 機能A — per-row layout fields.
    // Strict equality for the enums + integer margin; the layout knobs
    // have no display-precision concept.
    e.horizontalPosition !== o.horizontalPosition ||
    e.verticalPosition !== o.verticalPosition ||
    e.verticalMarginPx !== o.verticalMarginPx ||
    // REQ-20260613-016 / v1.2.2 機能A — per-row background.
    // Structural comparison: enabled / color / opacityPercent independently.
    e.subtitleBackground.enabled !== o.subtitleBackground.enabled ||
    e.subtitleBackground.color !== o.subtitleBackground.color ||
    e.subtitleBackground.opacityPercent !== o.subtitleBackground.opacityPercent ||
    // REQ-20260613-016 / v1.2.2 機能B — free position.
    // Strict `!==` covers the (undefined ⇄ number) transition: pinning
    // an unpinned row, or releasing a pinned row, both flip isEdited.
    // Two NaN-free numbers compare bitwise so no precision rule applies.
    e.posX !== o.posX ||
    e.posY !== o.posY ||
    // REQ-0392 — z-order.  Compared through `resolveLayer` so an explicit 0 and
    // an absent field (both = layer 0) are equal; only a real front/back change
    // flips isEdited.
    resolveLayer(e) !== resolveLayer(o)
  )
}
