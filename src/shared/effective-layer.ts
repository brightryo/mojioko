/**
 * REQ-0394 (positioning-redesign Phase 2 finish) — effective z-order layers.
 *
 * ## Why "effective" (derived) rather than the stored field alone
 *
 * `SubtitleEntry.layer` (REQ-0392, `resolveLayer`) is the user's z-order
 * **intent** — a floor set by the inspector's "bring to front / send to back".
 * The timeline wants rows to mean z-order (top row = front) AND overlapping cues
 * to sit on SEPARATE rows so their blocks never collide.  Those two goals need
 * one more step: within a set of time-overlapping cues, each must get a DISTINCT
 * layer.  `computeEffectiveLayers` derives that — the single source both the
 * timeline rows, the preview `z-index`, and the burn-in ASS `Layer` column read,
 * so all three agree by construction.
 *
 * Deriving it (instead of writing bumped layers back onto entries) means:
 *   - no saved-data migration (a v1/v2 project's stored `layer` is untouched);
 *   - no undo entanglement (a time edit that changes overlaps just recomputes —
 *     it never mutates a second entry's stored `layer`);
 *   - the same auto-re-separation the derived timeline packer always had.
 *
 * ## The rule
 *
 * Process cues in (intent layer asc, startSec asc, input order) order and give
 * each the SMALLEST layer `>= its intent floor` not already used by a
 * time-overlapping cue placed before it.  Consequences:
 *   - a project with no z-order intent (all layer 0) colours exactly like the
 *     old greedy time packer — non-overlapping cues share layer 0, overlaps
 *     climb to 1, 2, …;
 *   - a cue brought to front (high intent) sits at least that high;
 *   - overlapping cues always differ, so rows never collide.
 *
 * Edge case (documented, not a correctness bug): under tangled overlaps of
 * MIXED intents, a lower-intent cue forced upward can end in front of a
 * higher-intent cue it does not overlap.  The hard invariant (overlaps distinct)
 * always holds; perfect intent ordering under arbitrary overlap tangles is a
 * constraint-solving problem out of scope here.  Overlaps are rare and
 * mixed-intent overlaps rarer, so the common cases are exact.
 */

import type { SubtitleEntry } from './types'
import { resolveLayer } from './cue-placement'

/** Contact / near-contact tolerance (seconds); matches `timeline-layout`. */
const TIME_EPS_SEC = 1e-3

export interface CueTimes {
  startSec: number
  endSec: number
}

/**
 * Map of entry id → effective z-order layer (higher = nearer the front).
 *
 * `timesOverride` lets a caller (a timeline drag) pin one cue's times to a
 * snapshot so its effective layer — and therefore its row — does not jump
 * mid-drag, mirroring `timeline-layout`'s `greedyTimes`.
 */
export function computeEffectiveLayers(
  entries: readonly SubtitleEntry[],
  timesOverride?: ReadonlyMap<string, CueTimes>,
): Map<string, number> {
  const timeOf = (e: SubtitleEntry): CueTimes =>
    timesOverride?.get(e.id) ?? { startSec: e.startSec, endSec: e.endSec }

  const overlaps = (a: SubtitleEntry, b: SubtitleEntry): boolean => {
    const ta = timeOf(a)
    const tb = timeOf(b)
    // Half-open [start, end); contact (a.end == b.start) is NOT an overlap.
    return ta.startSec < tb.endSec - TIME_EPS_SEC && tb.startSec < ta.endSec - TIME_EPS_SEC
  }

  const order = entries
    .map((e, i) => ({ e, i }))
    .sort((x, y) => {
      const lx = resolveLayer(x.e)
      const ly = resolveLayer(y.e)
      if (lx !== ly) return lx - ly
      const sx = timeOf(x.e).startSec
      const sy = timeOf(y.e).startSec
      if (sx !== sy) return sx - sy
      return x.i - y.i
    })

  const eff = new Map<string, number>()
  const placed: SubtitleEntry[] = []
  for (const { e } of order) {
    const floor = resolveLayer(e)
    const used = new Set<number>()
    for (const p of placed) {
      if (overlaps(e, p)) {
        const pl = eff.get(p.id)
        if (pl !== undefined) used.add(pl)
      }
    }
    let layer = floor
    while (used.has(layer)) layer++
    eff.set(e.id, layer)
    placed.push(e)
  }
  return eff
}
