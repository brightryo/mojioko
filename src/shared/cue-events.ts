/**
 * REQ-0327 §1-1 / REQ-0330 §1 / REQ-0332 §3 — the cue → ASS event splitter.
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
 *   - **Line spacing** (REQ-0332): ASS has no line-spacing tag, and
 *     `ass_set_line_spacing()` is not exposed by ffmpeg. Tightening the gap
 *     means emitting each display line as its own event with an explicit
 *     vertical position — a cut on the LINE axis.  **This one is now live.**
 *
 * Building those separately would mean designing the same thing twice, so
 * they share this module. The full design is in
 * `dev-docs/specs/event-splitting.md`.
 *
 * ## The load-bearing property: no-op by default
 *
 * When a cue uses neither feature this returns exactly ONE piece whose body
 * is the caller's display lines re-joined with `\N` — i.e. the very same
 * line `ass-generator` always emitted. That is what keeps
 * `ass-generator-baseline-ac1fd67` byte-identical, and it is deliberately
 * the shape the module was built around (REQ-0327 §1-1) before any
 * splitting logic existed to break it.
 */

import { ASS_HARD_BREAK } from './line-spacing'

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
  /**
   * Value for the MarginV column.  The caller is responsible for zeroing it
   * when it is emitting `\pos`, exactly as the pre-existing pinned-row path
   * does — libass ignores MarginV under `\pos`, and writing 0 makes that
   * unambiguous to anyone reading the ASS file.
   */
  marginV: number
  /** Override block used when the cue stays ONE event.  No braces. */
  styleTag: string
  /**
   * The body of each display line, in order.  Built per line by
   * `ass-generator` (REQ-0330 §1) because a karaoke / emphasis body
   * interleaves `{\k…}` / `{\fs…}` override blocks with the text, so
   * cutting the FINISHED body on `\N` would tear a block in half.
   */
  lineBodies: readonly string[]
  /**
   * Per-line override blocks, one per `lineBodies` element.  Present ⇒ the
   * cue is split on the line axis and each line becomes its own event.
   * Absent ⇒ no split: the lines are re-joined and one event is emitted.
   */
  lineStyleTags?: readonly string[]
}

/**
 * Expand one cue into the events that represent it.
 *
 * The time axis (slide) still lands in a later REQ; this seam is where it
 * goes, and the line axis below shows the shape it will take.
 */
export function expandCueToEvents(input: CueEventInput): CueEventPiece[] {
  const { lineStyleTags } = input
  if (lineStyleTags === undefined) {
    return [{
      startSec: input.startSec,
      endSec: input.endSec,
      marginV: input.marginV,
      styleTag: input.styleTag,
      body: input.lineBodies.join(ASS_HARD_BREAK),
    }]
  }
  if (lineStyleTags.length !== input.lineBodies.length) {
    throw new Error(
      `expandCueToEvents: ${lineStyleTags.length} line style tags for ` +
      `${input.lineBodies.length} line bodies`,
    )
  }
  return input.lineBodies.map((body, i) => ({
    startSec: input.startSec,
    endSec: input.endSec,
    marginV: input.marginV,
    styleTag: lineStyleTags[i],
    body,
  }))
}
