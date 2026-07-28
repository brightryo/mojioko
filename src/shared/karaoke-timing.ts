import type { SubtitleEntry } from './types'
import { areWordsValidForText } from './words-validity'

/**
 * REQ-0336 §1 — the ONE place that decides whether a karaoke cue is drawn
 * from its real per-word timings or from the equal-split fallback.
 *
 * ## The bug this closes
 *
 * `WordSpan` carries ABSOLUTE video seconds.  Validity, however, was judged
 * solely by `areWordsValidForText` — a TEXT predicate that never looks at the
 * time axis.  Dragging a clip on the timeline changes `startSec` / `endSec`
 * but not `text`, so `words` stayed "valid" while its absolute timestamps
 * pointed outside the cue's own window.  Measured on the burn (RES-0336 §1-7):
 *
 *   - a 3.0 s cue trimmed to 1.2 s coloured **2 of its 5 characters** and
 *     stopped (spoken-colour area 0.406 at 0.1 s before the cue ended);
 *   - a cue dragged EARLIER emitted a leading `{\k520}` silence longer than
 *     the cue itself, so **nothing coloured at all** (spoken-colour area
 *     0.000 at every sample inside the cue).
 *
 * The equal-split fallback could not rescue either case because it was gated
 * on `words` being text-INVALID.
 *
 * ## The rule (owner's decision, REQ-0336 §1-3)
 *
 * **Touching the times disqualifies the real word timings.**  Move and resize
 * are NOT distinguished: trimming breaks the correspondence with the audio and
 * there is no way to re-sync it.  But a cue that has text and karaoke on must
 * colour ALL of its characters between its own start and its own end — a 3 s
 * 「テスト」 trimmed to 2 s colouring only 「テ」 and 「ト」 is simply wrong.
 * So the disqualified cue falls to the equal split, which by construction
 * spans exactly `[startSec, endSec]`.
 *
 * Real timings apply only when ALL of these hold:
 *   1. `words` exists and is non-empty;
 *   2. it still matches `text` (`areWordsValidForText`);
 *   3. the cue's times are unchanged from `original`;
 *   4. the user has not opted out (`karaokeUseWordTimings === false`).
 * Everything else is an equal split.
 *
 * ## Why `original`, and why no new field
 *
 * `SubtitleEntryOriginal` already declares required `startSec` / `endSec` —
 * the transcription-time snapshot that "Reset row" restores (`resetRow` in
 * `entry-row-actions.ts` compares exactly these two to decide whether a reset
 * affects time).  Comparing against it means the detection is a property of
 * the DATA, not of the code path that wrote it: timeline drag-move, edge
 * resize, the time-adjust dialog, the inline time inputs, row duplication and
 * anything a future REQ adds are all covered without per-path work.  Adding a
 * `timesEdited` flag would have re-created the same "one writer forgot to set
 * it" hole this codebase keeps re-learning.
 *
 * ## Non-destructive (REQ-0336 §1-4)
 *
 * Nothing here clears `words`.  They merely stop being *used*, and come back
 * the moment the times match `original` again — via Undo, or via "Reset row".
 *
 * ## Single source of truth (REQ-0336 §1-6)
 *
 * Both consumers — the preview (`subtitle-overlay.tsx`) and the ASS writer
 * (`ass-generator.ts`) — call this function.  Do NOT re-derive the judgement
 * at a call site: `fade-opacity.ts` claimed in its JSDoc to "mirror" the
 * writer while independently re-deriving it, and the two drifted (RES-0323).
 */

/** Which timings a karaoke cue is rendered from. */
export type KaraokeTimingMode = 'words' | 'even'

/**
 * Why the real per-word timings are not in use.  Present only when
 * `mode === 'even'`; each value maps to its own tooltip string so the user is
 * told what to undo, not merely that something is off.
 *
 * - `no-words`    — the cue never had per-word data (SRT import, manually
 *                   added row, pre-REQ-0285 project file, silence-only
 *                   segment).  Nothing restores it short of re-transcribing.
 * - `text-edited` — `words` no longer concatenates to `text`.  Restored by
 *                   putting the text back, or by "Reset row".
 * - `time-edited` — the cue's start and/or end differ from `original`.
 *                   Restored by Undo or by "Reset row".
 * - `user-off`    — the user turned the 「発話タイミング」 toggle off.  Not a
 *                   fault condition; the toggle turns it straight back on.
 */
export type KaraokeTimingReason = 'no-words' | 'text-edited' | 'time-edited' | 'user-off'

export interface KaraokeTimingResolution {
  mode: KaraokeTimingMode
  reason?: KaraokeTimingReason
}

/**
 * The entry shape this module needs.  Deliberately structural rather than the
 * whole `SubtitleEntry` so unit tests (and any future non-cue caller) can pass
 * a minimal object, while every real caller passes a `SubtitleEntry` and gets
 * the same answer.
 */
export type KaraokeTimingInput = Pick<SubtitleEntry, 'text' | 'startSec' | 'endSec' | 'words'> & {
  readonly original: Pick<SubtitleEntry['original'], 'startSec' | 'endSec'>
}

/**
 * Why the real per-word timings are UNAVAILABLE for this cue, or `null` when
 * they are available.  This is the "can the toggle be operated at all"
 * question; `resolveKaraokeTiming` adds the user's own choice on top.
 *
 * Order matters: `no-words` is checked before `text-edited` so a row that
 * never had word data is not reported as "you edited the text".
 */
export function karaokeWordTimingBlocker(
  entry: KaraokeTimingInput,
): Exclude<KaraokeTimingReason, 'user-off'> | null {
  if (entry.words === undefined || entry.words.length === 0) return 'no-words'
  if (!areWordsValidForText(entry.words, entry.text)) return 'text-edited'
  if (entry.startSec !== entry.original.startSec || entry.endSec !== entry.original.endSec) {
    return 'time-edited'
  }
  return null
}

/**
 * Resolve which timings this cue's karaoke runs on.
 *
 * Callers still own the karaoke GATE itself (`karaokeEnabled` + the tier
 * check) — this function answers only "which timings", never "is karaoke on".
 * Keeping the two separate is what lets the inspector show the toggle's
 * availability for a cue whose karaoke switch is currently off.
 */
export function resolveKaraokeTiming(entry: KaraokeTimingInput): KaraokeTimingResolution {
  const blocker = karaokeWordTimingBlocker(entry)
  if (blocker !== null) return { mode: 'even', reason: blocker }
  return { mode: 'words' }
}
