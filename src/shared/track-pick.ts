/**
 * REQ-0121 — audio-track selection helper for STEP 1 after ffprobe.
 *
 * Fallback ladder (owner-confirmed spec, RES-0120 §A.4):
 *   1. If the preferred track exists (matched by 1-based index), use it.
 *   2. Else fall back to Track 1 (specifically `index === 1`), NOT
 *      "the first available track".  When this fires, the caller must
 *      surface a non-blocking notice (`audioTracks.defaultTrackMissing`
 *      i18n key).
 *   3. Else — no Track 1 either — return `null` so the caller can leave
 *      the selection empty and reuse the existing "no audio track"
 *      handling.  We do NOT invent a new error path here.
 *
 * Kept as a named helper so:
 *   - The ladder is auditable in one place (rather than buried in the
 *     step1 render body).
 *   - The three branches are testable without spinning up the whole
 *     transcribe flow.
 *
 * ## REQ-0517 §1 — why this lives in `shared/` now
 *
 * It was `renderer/routes/step1-track-pick.ts`, so only the GUI could reach
 * it.  The CLI took `settings.defaultAudioTrackIndex` at face value and never
 * compared it with the file, which meant a user who had legitimately set their
 * default to Track 2 in Settings hit `-map 0:a:1` — and a raw ffmpeg failure
 * that never says the word "track" — on every single-track video they passed
 * to `transcribe`, `run`, or any MCP tool wrapping them.
 *
 * The fix is this module moving, not a second ladder being written in
 * `main/`: two copies of a fallback rule is the failure this codebase has paid
 * for repeatedly.  `tests/unit/track-pick-req-0517.test.ts` pins that the CLI
 * calls THIS function and re-derives nothing.
 */

export interface TrackPickResult {
  /** The chosen 1-based track index, or `null` when no track is available at all. */
  trackIndex: number | null
  /** True iff the preferred track was missing and we fell back to Track 1. */
  fallbackUsed: boolean
}

export function pickTranscriptionTrack(
  audioTracks: readonly { index: number }[],
  preferredIndex: number
): TrackPickResult {
  const preferred = audioTracks.find((t) => t.index === preferredIndex)
  if (preferred) return { trackIndex: preferred.index, fallbackUsed: false }
  const trackOne = audioTracks.find((t) => t.index === 1)
  if (trackOne) return { trackIndex: trackOne.index, fallbackUsed: true }
  return { trackIndex: null, fallbackUsed: false }
}
