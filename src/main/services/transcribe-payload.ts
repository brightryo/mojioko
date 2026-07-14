import type { TranscriptionStartRequest } from '../../shared/ipc-contracts'

/**
 * REQ-0210 — main-side tier gate for MSIX-only transcription features.
 *
 * Word-level transcription (REQ-0207) is a paid-tier feature in v1.3.3:
 * available in the MSIX (Microsoft Store) build, locked in the NSIS
 * (free) build.  The renderer's transcription-drawer already disables
 * the checkbox in NSIS, but a DevTools user could still flip the
 * `wordSubtitle` field on the outgoing IPC payload.  This helper is
 * the defense-in-depth layer: called at the main-process IPC boundary
 * (`ipc/transcription.ts:transcriptionStart`) with the process-wide
 * `isPackagedAsMsix()` value, it strips `wordSubtitle: true` before the
 * request reaches `buildTranscribePayload`.
 *
 * Kept pure (no I/O, no `process.*` reads) so vitest can exercise the
 * gate directly without stubbing electron / `isPackagedAsMsix`.
 *
 * Deliberately does NOT modify `buildTranscribePayload` — the byte-
 * identical off-path contract there (REQ-0207) still holds unchanged;
 * this gate runs upstream, ensuring the builder only ever sees a
 * `wordSubtitle:false | undefined` request on NSIS.
 */
export function applyTranscriptionTierGate(
  request: TranscriptionStartRequest,
  isMsix: boolean,
): TranscriptionStartRequest {
  if (isMsix) return request
  // In NSIS builds, force `wordSubtitle` off regardless of what the
  // renderer sent.  Setting it to `false` (not `undefined`) so the
  // shape is deterministic — `buildTranscribePayload` treats both the
  // same, but a stable value simplifies debugging when someone logs
  // `fullRequest` in main-side traces.
  return { ...request, wordSubtitle: false }
}

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
