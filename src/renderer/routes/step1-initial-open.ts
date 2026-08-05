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
 *   - else    → at least one usable model is installed; leave every STEP1
 *               accordion collapsed (`null`).  REQ-0422 removed the input-
 *               video card from STEP1 (file selection moved into the setup
 *               drawer), so there is no must-touch section to auto-open on
 *               the happy path — the user just presses [文字起こし開始].
 *
 * Pure helper so the rule is unit-testable without rendering the whole
 * route — exercised by `tests/unit/step1-initial-open.test.ts`.
 */
export function pickInitialOpenSection(
  activeModelId: WhisperModelId | null
): 'whisper' | null {
  return activeModelId === null ? 'whisper' : null
}
