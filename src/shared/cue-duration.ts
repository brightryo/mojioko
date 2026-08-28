/**
 * REQ-0529 §1-1 — the ONE judgement of "this cue reaches past the end of the
 * video", shared by the GUI badge and the headless warning.
 *
 * ## Why this moved to `shared/`
 *
 * The predicate was inline in `renderer/lib/entry-warnings.ts`, where the CLI
 * and MCP could not reach it — `src/main` imports pure renderer modules freely
 * (`srt-parse`, `style-preset-apply`), but a judgement the headless path needs
 * belongs in `shared/`, not behind a renderer path. This is the same move
 * REQ-0508 made for the font-tier policy, for the same reason: a rule that two
 * surfaces enforce must have one implementation, or they will answer
 * differently and nobody will notice until a user reports it.
 *
 * `entry-warnings.ts` now calls `isCueBeyondVideoEnd` to produce its
 * `overDuration` flag, so the 時間超過 badge and the CLI's
 * `CUE_BEYOND_VIDEO_END` warning are the same test by construction.
 *
 * ## ★ The GUI and the CLI do DIFFERENT things with the answer
 *
 * They agree on which cues are beyond the end. They do not agree on what
 * happens next, and REQ-0529 deliberately did not unify that:
 *
 *   - The GUI DROPS such a cue from the burn entirely (`isBurninTarget`, applied
 *     in `burnin-drawer.tsx` before the request is sent, so the main process
 *     never sees it).
 *   - The CLI/MCP passes it straight to libass, which renders whatever part of
 *     it falls inside the video and then simply stops. Measured on real pixels
 *     (RES-0529 §1-2): a cue 0.5 s → 10 s on a 2 s clip is on screen from 0.5 s
 *     to the last frame.
 *
 * So a cue that merely OVERHANGS the end is truncated headlessly and absent in
 * the GUI. That divergence is reported for the owner to settle rather than
 * silently picked here — see RES-0529. It is also why the warning below counts
 * the two cases separately instead of claiming "these are not in the output".
 */
import type { SubtitleEntry } from './types'

/** The minimal shape the duration checks need off a cue. */
export interface CueTimes {
  startSec: number
  endSec: number
}

/**
 * True when any part of `cue` lies past `videoDurationSec`.
 *
 * Both ends are tested, matching the GUI's long-standing `overDuration` rule: a
 * start beyond the video is as unrenderable as an end beyond it.
 *
 * `Infinity` (no video loaded, or audio-only mode, which passes it
 * deliberately) makes this always false — there is no end to be beyond.
 *
 * Note this is NOT `cueCeilingSec`'s centisecond floor. That floor exists so a
 * value CLAMPED to the ceiling survives HALF-UP rounding; detection has no such
 * round-trip and must not report a cue ending exactly at the duration.
 */
export function isCueBeyondVideoEnd(cue: CueTimes, videoDurationSec: number): boolean {
  return cue.startSec > videoDurationSec || cue.endSec > videoDurationSec
}

/** What `classifyCuesBeyondVideoEnd` found. */
export interface BeyondVideoEndReport {
  /** Cues with any part past the end — `notShown + truncated`. */
  cueCount: number
  /**
   * Cues that start after the video has ended, so NOTHING of them is drawn.
   * These really are absent from the output.
   */
  notShownCount: number
  /**
   * Cues that start inside the video but end after it. libass draws them from
   * their start to the last frame, so they appear — cut short. Counted apart
   * from `notShownCount` because telling a user these are "missing" would send
   * them looking for a subtitle that is on screen.
   */
  truncatedCount: number
  /** The duration the judgement was made against, for the report payload. */
  videoDurationSec: number
}

/**
 * Split the cues that reach past the end of the video into "never drawn" and
 * "cut short".
 *
 * Deleted cues are skipped: `generateAss` drops them before anything is
 * rendered, so warning about one would point at a cue the user already removed.
 * Empty-text cues are NOT skipped — they still occupy time, and the headless
 * path emits a Dialogue line for them.
 */
export function classifyCuesBeyondVideoEnd(
  entries: readonly SubtitleEntry[],
  videoDurationSec: number,
): BeyondVideoEndReport {
  let notShownCount = 0
  let truncatedCount = 0
  for (const e of entries) {
    if (e.isDeleted) continue
    if (!isCueBeyondVideoEnd(e, videoDurationSec)) continue
    if (e.startSec > videoDurationSec) notShownCount++
    else truncatedCount++
  }
  return {
    cueCount: notShownCount + truncatedCount,
    notShownCount,
    truncatedCount,
    videoDurationSec,
  }
}
