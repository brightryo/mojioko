/**
 * REQ-0327 §1-1 — the cue → ASS event splitter.
 *
 * ## Why this exists
 *
 * Two features need one cue to become several ASS Dialogue events, for
 * unrelated reasons that happen to demand the same machinery:
 *
 *   - **Slide** (REQ-0323 §3): `\move` takes effect at most ONCE per event.
 *     Measured in RES-0323 §3-1 — a second `\move` in the same event is
 *     discarded outright, first-wins, and `\t` cannot animate `\pos` either.
 *     So an in-and-out slide needs the cue cut on the TIME axis.
 *   - **Line spacing** (REQ-0327): ASS has no line-spacing tag, and
 *     `ass_set_line_spacing()` is not exposed by ffmpeg. Tightening the gap
 *     means emitting each display line as its own event with an explicit
 *     vertical position — a cut on the LINE axis.
 *
 * Building those separately would mean designing the same thing twice, so
 * they share this module. The full design is in
 * `dev-docs/specs/event-splitting.md`.
 *
 * ## The load-bearing property: no-op by default
 *
 * When a cue uses neither feature this returns exactly ONE piece carrying
 * the caller's own strings unchanged, so `ass-generator` emits the very
 * same line it always did. That is what keeps
 * `ass-generator-baseline-ac1fd67` byte-identical, and it is deliberately
 * the first thing established (REQ-0327 §1-1) before any splitting logic
 * exists to break it.
 */

/** One emitted ASS Dialogue event. */
export interface CueEventPiece {
  startSec: number
  endSec: number
  /** Value for the MarginV column. */
  marginV: number
  /** The full override string, WITHOUT the enclosing braces. */
  styleTag: string
  /** The dialogue body that follows the override block. */
  body: string
}

export interface CueEventInput {
  startSec: number
  endSec: number
  marginV: number
  styleTag: string
  body: string
}

/**
 * Expand one cue into the events that represent it.
 *
 * Currently always a no-op passthrough; the line and time axes land in
 * REQ-0327 §1-2 and a later REQ respectively. Kept as a seam so those can
 * be added without touching the generator's emit path again.
 */
export function expandCueToEvents(input: CueEventInput): CueEventPiece[] {
  return [{
    startSec: input.startSec,
    endSec: input.endSec,
    marginV: input.marginV,
    styleTag: input.styleTag,
    body: input.body,
  }]
}
