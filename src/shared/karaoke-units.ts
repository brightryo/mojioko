import type { SubtitleEntry, WordSpan } from './types'
import { buildFallbackKaraokeUnits } from './karaoke-fallback'
import { projectCueWhitespaceOntoWords, splitWordsAtHardBreaks } from './karaoke-ass'
import { resolveKaraokeTiming } from './karaoke-timing'

/**
 * REQ-0515 — the ONE place that resolves a karaoke cue's render units.
 *
 * ## Why this module exists
 *
 * The preview (`subtitle-overlay.tsx`) and the ASS writer (`ass-generator.ts`)
 * each held their own copy of this expression:
 *
 *     karaokeGateOn
 *       ? splitWordsAtHardBreaks(
 *           e.text,
 *           resolveKaraokeTiming(e).mode === 'words'
 *             ? e.words!
 *             : buildFallbackKaraokeUnits(e.text, e.startSec, e.endSec))
 *       : []
 *
 * Two copies, kept in step by comment and by hand.  REQ-0515 had to add a step
 * to that pipeline (`projectCueWhitespaceOntoWords`), and adding it twice is
 * exactly the shape this codebase keeps paying for — REQ-0320 §1 is the
 * standing record of what a second copy of a render decision costs.  So the
 * pipeline moved here and both renderers call it.
 *
 * ## What it decides, and what it deliberately does not
 *
 * It answers "**which units, spelling what, at what times**":
 *
 *   1. `resolveKaraokeTiming` picks the timing source — real Whisper words, or
 *      the equal split (REQ-0336 owns that judgement, including the time-axis
 *      half that a text-only predicate cannot make).
 *   2. `projectCueWhitespaceOntoWords` makes the cue's own `text` the authority
 *      for the CHARACTERS, keeping `words` as the authority only for the CLOCK
 *      (REQ-0515 — see that function for the bug this closes).
 *   3. `splitWordsAtHardBreaks` gives every `\N` a unit boundary to attach to
 *      (REQ-0308).
 *
 * It does NOT decide whether karaoke is on at all.  The gate is
 * `karaokeEnabled` + `canUseKaraokeInTier(isMsix)`, and the tier flag reaches
 * the two callers by different routes (a store selector in the renderer, a
 * parameter in the writer), so it stays with them and arrives here as a
 * boolean.  Keeping "is it on" and "what does it draw" apart is also what lets
 * the inspector ask about timing availability for a cue whose switch is off.
 */
export type KaraokeUnitsInput = Parameters<typeof resolveKaraokeTiming>[0] &
  Pick<SubtitleEntry, 'text' | 'startSec' | 'endSec' | 'words'>

export function resolveKaraokeUnits(
  entry: KaraokeUnitsInput,
  gateOn: boolean,
): readonly WordSpan[] {
  if (!gateOn) return []
  const base = resolveKaraokeTiming(entry).mode === 'words'
    ? entry.words!
    : buildFallbackKaraokeUnits(entry.text, entry.startSec, entry.endSec)
  return splitWordsAtHardBreaks(entry.text, projectCueWhitespaceOntoWords(entry.text, base))
}
