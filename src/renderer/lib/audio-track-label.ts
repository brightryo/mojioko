/**
 * REQ-20260615-079 — decide what (if anything) the STEP1 input-file
 * accordion header should show next to its title for the audio-track
 * summary.
 *
 * Argument is the count of detected audio tracks (`video.audioTracks
 * .length`) when a file is loaded, or `null` when no file has been
 * chosen yet.  The renderer wraps the value as `video ? n : null` —
 * we don't accept `0` as "no file loaded" because a zero-track loaded
 * file (e.g., a corrupted .mkv whose audio stream count probed as 0)
 * is a real state the user needs to see, distinct from "you haven't
 * picked anything yet".
 *
 * Returns a tagged union so the renderer picks the right locale key +
 * plural rule without duplicating the branching logic:
 *
 *   - `null` (file not loaded) → `hidden`  → render nothing
 *   - `0` (file loaded, no audio streams) → `no-audio` → "音声トラックなし"
 *   - `n >= 1` (file loaded with audio) → `count` → "音声Nトラック"
 *
 * Pre-REQ-079 the header showed either "トラック {N}" + green check
 * (when the auto-selected track matched the user's stored default) or
 * "トラック未選択" (when it didn't, including the always-false initial
 * file-not-loaded state).  That display was a holdover from the
 * pre-drawer UI when track selection lived inline; once REQ-055 /
 * REQ-056 moved selection into the TranscriptionDrawer, the header
 * should summarize the file's audio inventory, not echo a selection
 * the user can no longer change here.
 *
 * Pure (no React / i18next deps) so vitest can drive every branch.
 */

export type AudioTrackLabelState =
  | { kind: 'hidden' }
  | { kind: 'no-audio' }
  | { kind: 'count'; count: number }

export function pickAudioTrackLabel(audioTrackCount: number | null): AudioTrackLabelState {
  if (audioTrackCount === null) return { kind: 'hidden' }
  if (audioTrackCount <= 0) return { kind: 'no-audio' }
  return { kind: 'count', count: audioTrackCount }
}
