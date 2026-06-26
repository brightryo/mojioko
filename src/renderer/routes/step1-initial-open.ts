import type { WhisperModelId } from '../../shared/types'

/**
 * STEP1 mutual-exclusion accordion: which of the two panels (Whisper model
 * picker / input video card) is open on first paint.
 *
 * Pre-v1.3.1 the initial state was hardcoded to `'inputVideo'` so the user
 * landed on "pick a video".  A new user with no Whisper model installed
 * therefore saw the input-video card expanded and the Whisper card
 * collapsed under an amber badge — which is the entry point they actually
 * need to act on first.  REQ-20260615-072 restores the auto-open of the
 * Whisper card in that specific case.
 *
 * Decision is keyed on `activeModelId`:
 *   - `null`  → no model is currently selected, which in practice means
 *               no model is installed at all (the IPC `buildModelsState`
 *               auto-picks any installed model into `activeModelId`).
 *               Open Whisper to surface the download flow.
 *   - else    → at least one usable model is installed; open the input
 *               video card so the user can pick a file and proceed.
 *
 * Pure helper so the rule is unit-testable without rendering the whole
 * route — exercised by `tests/unit/step1-initial-open.test.ts`.
 */
export function pickInitialOpenSection(
  activeModelId: WhisperModelId | null
): 'whisper' | 'inputVideo' {
  return activeModelId === null ? 'whisper' : 'inputVideo'
}
