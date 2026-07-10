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
 *
 * REQ-0195 §3 — the media element inside VideoPreviewPanel is conditionally
 * rendered (only after `previewBodySize` measurement lands `videoFrameW >
 * 0`).  On a project-open path `cuts` is populated BEFORE the panel
 * mounts, and `videoRef.current` is still `null` when this effect fires;
 * the old implementation early-returned and never re-ran (`cuts` did not
 * change again, and `mediaRef` object identity is stable), so cut-skip
 * silently did nothing for opened projects.  Polling via
 * `requestAnimationFrame` retries the attachment until the ref lands.
 * On the normal transcribe flow the element is already mounted by the
 * time cuts first become non-empty, so the loop runs at most one frame.
 */
export function useCutSkip(
  mediaRef: { current: HTMLMediaElement | null },
): void {
  const cuts = useProjectStore((s) => s.cuts)
  useEffect(() => {
    if (cuts.length === 0) return
    let cancelled = false
    let raf = 0
    let attached: HTMLMediaElement | null = null
    function onTimeUpdate() {
      const m = attached
      if (!m) return
      const target = findCutSkipTarget(m.currentTime, cuts)
      if (target !== null) {
        m.currentTime = target
      }
    }
    function tryAttach() {
      if (cancelled) return
      const el = mediaRef.current
      if (!el) {
        raf = requestAnimationFrame(tryAttach)
        return
      }
      el.addEventListener('timeupdate', onTimeUpdate)
      attached = el
    }
    tryAttach()
    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
      if (attached) attached.removeEventListener('timeupdate', onTimeUpdate)
    }
  }, [cuts, mediaRef])
}
