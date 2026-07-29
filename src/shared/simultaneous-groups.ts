/**
 * REQ-0332 §3-2 — "which cues can be on screen together?"
 *
 * ## Why this is needed
 *
 * Emitting `\pos` takes an event OUT of libass's collision detection
 * (measured in RES-0323 §3-1: `\move` / `\pos` events fight over the same
 * slot rather than stacking).  A cue split into per-line events for line
 * spacing therefore no longer auto-stacks, and MOJIOKO has to place it.
 *
 * The owner's decision (REQ-0332 §3, from event-splitting.md §5): **never
 * let a libass-positioned cue and a self-positioned cue share the screen.**
 * If ANY cue in a simultaneously-visible group is split, the WHOLE group is
 * positioned by us.  Two placement authorities on one frame is the failure
 * this avoids — they would disagree about where the free slots are and
 * captions would land on top of each other.
 *
 * ## What "simultaneously visible" means
 *
 * Being on screen together is NOT transitive for a pair of cues, but the
 * property we need is: *is there any chain of overlaps linking these two?*
 * If A overlaps B and B overlaps C, then B shares the screen with each of
 * them, so B cannot be both libass-positioned (for A's sake) and
 * self-positioned (for C's sake).  The decision therefore has to propagate
 * along overlaps, which makes the right unit the **transitive closure of
 * time-interval overlap** — the connected components of the interval graph.
 *
 * Computing it is one sweep, not a graph walk: sort by `startSec`, keep the
 * running maximum `endSec` of the current component, and start a new
 * component the moment a cue begins at or after that maximum.  Any cue that
 * starts before it necessarily overlaps at least one member.
 *
 * Interval convention is the codebase-wide `[startSec, endSec)` — END
 * EXCLUSIVE (see `findActiveEntryId`), so a cue starting exactly when
 * another ends does NOT share a frame with it.
 */

export interface TimeInterval {
  startSec: number
  endSec: number
}

/**
 * Group the items into connected components of time-interval overlap.
 *
 * Returns groups of INDICES into `items`, so the caller keeps its own
 * ordering and can look up whatever it stores alongside.  Indices within a
 * group are ascending by index; groups are ordered by their earliest start.
 */
export function groupByTimeOverlap(items: readonly TimeInterval[]): number[][] {
  const order = items
    .map((_, i) => i)
    .sort((a, b) => items[a].startSec - items[b].startSec || a - b)

  const groups: number[][] = []
  let current: number[] = []
  let groupEnd = -Infinity

  for (const i of order) {
    const item = items[i]
    if (current.length > 0 && item.startSec < groupEnd) {
      current.push(i)
      groupEnd = Math.max(groupEnd, item.endSec)
      continue
    }
    if (current.length > 0) groups.push(current)
    current = [i]
    groupEnd = item.endSec
  }
  if (current.length > 0) groups.push(current)

  for (const g of groups) g.sort((a, b) => a - b)
  return groups
}
