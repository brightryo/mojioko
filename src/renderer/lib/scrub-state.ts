/**
 * REQ-096 — module-level scrub state used to coordinate the
 * optimistic-playhead path in TimelineView with the VPP seek
 * useEffect and `<video>.timeupdate` handler in VideoPreviewPanel.
 *
 * When `SCRUB_SEEK_THROTTLE_ENABLED` (shared/constants) is on and the
 * user is actively dragging the ruler:
 *   - TimelineView writes `videoCurrentTimeSec` directly on every
 *     pointermove so the Playhead reflects the cursor immediately.
 *   - The actual `<video>.currentTime = X` seek runs only on the
 *     next requestAnimationFrame, with the latest pointermove value.
 *
 * Without coordination, VPP's seek useEffect — which fires when the
 * rAF eventually writes `videoSeekRequestSec` — would call
 * `setVideoCurrentTimeSec(throttledValue)` AFTER the user has
 * already scrubbed further; that would briefly snap the Playhead
 * backward to the stale rAF-committed value.  The same risk applies
 * to `handleTimeUpdate` (the video element's `timeupdate` event).
 *
 * The flag here lets those two paths skip their own
 * `setVideoCurrentTimeSec` writes WHILE A SCRUB IS IN PROGRESS,
 * letting the optimistic value remain the source of truth.  On
 * pointerup the scrub handler clears the flag and the next
 * `timeupdate` re-syncs `videoCurrentTimeSec` with the actual
 * `<video>.currentTime` value, closing any small drift between
 * the optimistic write and the throttled seek.
 *
 * Plain mutable object instead of a Zustand slice on purpose: this
 * is a one-bit non-reactive signal — making it reactive would
 * defeat the very purpose (causing extra re-renders when the flag
 * flips).
 */
export const scrubState = {
  /** True only while the user is actively dragging the ruler scrub. */
  inProgress: false,
}
