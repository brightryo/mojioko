/**
 * REQ-0514 — the NEGATIVE CONTROL for `verify:anim-first-frame`.
 *
 * ## Why this file replaced a `git checkout`
 *
 * The control used to check the pre-REQ-0379 sources out of git and bundle
 * them.  That is the most faithful control there is, and it rots: those sources
 * import the tree as it was *then*, while everything they do NOT check out is
 * the tree as it is *now*.  REQ-0508 moved `font-tier` out of `renderer/lib`
 * and REQ-0466 removed `computeFixedStackOffsets` from `active-entry`'s
 * exports, so by REQ-0514 the historical bundle could not be built at all — and
 * the gate had been dying on that build, unnoticed, ever since (nobody runs it;
 * the REQ-0512 lesson).  Worse, it died *inside* the `try`, so the `finally`
 * that restored the tree ran on the way out and discarded whatever uncommitted
 * work was in those four files.
 *
 * ## What replaced it
 *
 * The perturbation is applied to the ONE decision under test instead of to four
 * whole files.  Everything else — the panel, the overlay, the paint writer, the
 * curves — is the real production code, unmodified, exactly as in the positive
 * run.  So the control still proves what a control has to prove ("the sampler
 * detects the defect"), and it cannot be broken by a refactor somewhere else in
 * the tree.
 *
 * ## The perturbation
 *
 * Pre-REQ-0379, `resolveCueAnimState` snapped a PAUSED cue sitting at or before
 * its own start to the SETTLED transform unconditionally.  REQ-0379 (owner
 * decision B) narrowed that to cues with no entrance to play (`&& !hasEntrance`)
 * so an animated cue shows its entrance INITIAL instead — which is what stops a
 * settled frame flashing in front of the entrance when playback starts.
 * Dropping the `!hasEntrance` term below is therefore precisely the old
 * behaviour, and nothing else.
 */
import {
  animationTransformAt,
  resolveAnimation,
  NEUTRAL_TRANSFORM,
  type AnimationTransform,
} from '../../src/shared/cue-animation'

export * from '../../src/shared/cue-animation'

export function resolveCueAnimState(
  entry: Parameters<typeof resolveAnimation>[0] & { startSec: number; endSec: number },
  tSec: number,
  isPaused: boolean,
): { anim: AnimationTransform; inRange: boolean } {
  const inRange = tSec >= entry.startSec && tSec < entry.endSec
  const spec = resolveAnimation(entry)
  // ★ The defect: no `&& !hasEntrance`.  Everything else is the shipped body.
  const snapToSettled = isPaused && tSec <= entry.startSec
  const anim =
    snapToSettled || !inRange
      ? { ...NEUTRAL_TRANSFORM }
      : animationTransformAt(spec, entry.startSec, entry.endSec, tSec)
  return { anim, inRange }
}
