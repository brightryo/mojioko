import { useProjectStore } from '@/stores/project-store'

/**
 * Returns true when the loaded input file is audio-only — i.e. ffprobe
 * found no video stream (`VideoInfo.hasVideoStream === false`).  Falls
 * back to `false` when no input has been picked yet so STEP 1's
 * "choose file" branches stay in their default video posture.
 *
 * Derived from `useProjectStore.video.hasVideoStream` rather than a
 * dedicated store slice — there is exactly one source of truth (the
 * ffprobe result on `video`) and adding a parallel `mode` field would
 * just invite drift.
 *
 * REQ-028.
 */
export function useIsAudioOnly(): boolean {
  return useProjectStore((s) => s.video !== null && !s.video.hasVideoStream)
}
