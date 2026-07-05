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
