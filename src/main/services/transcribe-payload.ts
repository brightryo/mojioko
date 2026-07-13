import type { TranscriptionStartRequest } from '../../shared/ipc-contracts'

/**
 * REQ-0207 — build the JSON payload the sidecar reads over stdin.
 *
 * Extracted into its own file (separate from `transcription-sidecar.ts`) so
 * unit tests can import it without transitively pulling in `electron`.
 * Pure function: no I/O, no side effects.
 *
 * The `off-time byte-identical` contract is the whole point of this module.
 * With `wordSubtitle` omitted / undefined / false, the returned object
 * must have EXACTLY the shape it had before REQ-0207 introduced the flag.
 * The regression test `tests/unit/transcribe-payload.test.ts` snapshots
 * both the key set and the serialised byte stream.
 *
 * The `videoPath` argument is passed separately (not read from `request`)
 * because the caller has already normalized it via `normalizeVideoPath`.
 */
export function buildTranscribePayload(
  request: TranscriptionStartRequest,
  videoPath: string,
): Record<string, unknown> {
  const adv = request.advanced
  const payload: Record<string, unknown> = {
    cmd: 'transcribe',
    videoPath,
    trackIndex: request.trackIndex,
    model: request.modelId,
    modelsDir: request.modelsDir,
    ffmpegPath: request.ffmpegPath,
    vadFilter: adv.vadFilter,
    vadThreshold: adv.vadThreshold,
    minSpeechDurationMs: adv.minSpeechDurationMs,
    minSilenceDurationMs: adv.minSilenceDurationMs,
    beamSize: adv.beamSize,
    language: adv.language
  }
  if (request.wordSubtitle === true) {
    payload.wordSubtitle = true
  }
  return payload
}
