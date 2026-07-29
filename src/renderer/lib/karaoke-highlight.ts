import type { WordSpan } from '../../shared/types'

/**
 * REQ-0286 §3 — pure "which word is highlighted at time T" resolver
 * used by the subtitle-overlay's karaoke rAF loop.
 *
 * A word is considered "highlighted" (spoken/past) when the current
 * time has reached its `startSec`.  Words stay highlighted after their
 * `endSec` — matching the libass `\k` behaviour where a syllable's
 * PrimaryColour switch is one-way (once activated, stays activated).
 *
 * ## Return semantics
 *
 * Returns `activeCount` = number of words in `[0, activeCount)` that
 * are currently highlighted.  Renderer maps:
 *   words[i] with i < activeCount  → highlight colour
 *   words[i] with i >= activeCount → base colour
 *
 * Concrete examples for words at startSecs = [1.0, 1.5, 2.0]:
 *   currentTime < 1.0  → activeCount = 0  (no words lit yet)
 *   currentTime = 1.2  → activeCount = 1  (word[0] lit)
 *   currentTime = 1.7  → activeCount = 2  (word[0] + word[1] lit)
 *   currentTime = 2.5  → activeCount = 3  (all lit)
 *
 * ## Why activeCount instead of "currentIndex"
 *
 * A returned single index would ambiguate "word 0 is current" from
 * "no word is current yet" (both would be 0 or -1).  activeCount = 0
 * means unambiguously "none highlighted"; activeCount = words.length
 * means "all highlighted".  Renderer loop is a simple i < activeCount
 * comparison, no boundary edge cases.
 *
 * ## Sorted-startSec assumption
 *
 * `words` MUST be sorted ascending by `startSec` (the sidecar always
 * emits them in order; project files preserve it).  Under that
 * assumption the search is O(N) with early exit, which is fine at
 * ~2-10 words per cue.  A binary-search variant is available if a
 * future REQ produces cues with hundreds of words (unlikely — cues
 * are typically < 60 chars).
 */
export function activeWordCountAtTime(
  words: readonly WordSpan[],
  currentTimeSec: number,
): number {
  let count = 0
  for (let i = 0; i < words.length; i++) {
    if (currentTimeSec >= words[i].startSec) {
      count++
    } else {
      break // sorted → no later word can be active if this one isn't
    }
  }
  return count
}
