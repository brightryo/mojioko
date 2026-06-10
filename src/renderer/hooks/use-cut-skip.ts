import { useEffect } from 'react'
import { useProjectStore } from '@/stores/project-store'
import type { CutList } from '../../shared/cuts'

/**
 * Return the Original-axis time to jump to if `t` falls strictly inside
 * any cut, otherwise null.  Pure function — exported separately so unit
 * tests can verify without a real HTMLMediaElement.
 *
 * Edge semantics (matches NLE scrubbing convention):
 *   t === c.startSec → null  (at the very start of a cut, do NOT skip;
 *                             the user just scrubbed to this point)
 *   t inside (c.startSec, c.endSec) → c.endSec
 *   t === c.endSec → null  (already past the cut)
 */
export function findCutSkipTarget(t: number, cuts: CutList): number | null {
  for (const c of cuts) {
    if (t >= c.endSec) continue
    if (t > c.startSec) return c.endSec
    return null
  }
  return null
}

/**
 * Attach cut-skip behaviour to a media element.  On every `timeupdate`,
 * if the element's currentTime lands strictly inside any cut interval,
 * jump the element to that cut's endSec.  No-op when `cuts` is empty.
 *
 * The hosting panel keeps its own `onTimeUpdate` for the rest of its work
 * (focusedRowId sync, currentTime / seek state).  Both handlers see the
 * same `timeupdate` event; the skip handler mutates `currentTime`, which
 * triggers a fresh seek that the panel's handler observes on the next
 * tick — the active subtitle row therefore lands on the post-cut entry,
 * not on whatever was on screen mid-cut.
 *
 * Works for both `<video>` (VideoPreviewPanel) and `<audio>`
 * (AudioPreviewPanel) because both extend HTMLMediaElement.
 */
export function useCutSkip(
  mediaRef: { current: HTMLMediaElement | null },
): void {
  const cuts = useProjectStore((s) => s.cuts)
  useEffect(() => {
    const el = mediaRef.current
    if (!el || cuts.length === 0) return
    function onTimeUpdate() {
      const m = mediaRef.current
      if (!m) return
      const target = findCutSkipTarget(m.currentTime, cuts)
      if (target !== null) {
        m.currentTime = target
      }
    }
    el.addEventListener('timeupdate', onTimeUpdate)
    return () => el.removeEventListener('timeupdate', onTimeUpdate)
  }, [cuts, mediaRef])
}
