import { describe, it, expect } from 'vitest'
import { displayedFrameSeekSec } from '../../src/shared/frame-seek'

/**
 * REQ-0375 §3 — the still export must extract the SAME frame the preview
 * `<video>` shows at `currentTime = timeSec`: the frame whose interval
 * contains timeSec, index k = floor(timeSec·fps).
 *
 * ffmpeg's output-side `-ss ss` selects the first frame with pts >= ss, and
 * frame pts are multiples of 1/fps, so the frame it lands on is
 * `ceil(ss·fps)`.  The invariant this gate pins: for the snapped seek,
 * `ceil(seekSec·fps) === floor(timeSec·fps)`.  Before the fix the code seeked
 * to timeSec itself, which lands on frame k+1 for any between-boundary time.
 */
// `+ 0` normalises the IEEE-754 `-0` that Math.ceil can return near zero
// (Vitest's toBe uses Object.is, which distinguishes -0 from 0).
const selectedFrame = (ss: number, fps: number) => Math.ceil(ss * fps - 1e-9) + 0
const displayedFrame = (t: number, fps: number) => Math.floor(t * fps + 1e-6) + 0

describe('displayedFrameSeekSec (REQ-0375 §3)', () => {
  const fpsSet = [24, 25, 30, 30000 / 1001, 60]

  for (const fps of fpsSet) {
    it(`selects the displayed frame at every sub-frame offset (fps=${fps.toFixed(3)})`, () => {
      for (let k = 0; k < 40; k++) {
        // sample several times strictly inside frame k's interval [k/fps,(k+1)/fps)
        for (const frac of [0.0, 0.01, 0.37, 0.5, 0.99]) {
          const t = (k + frac) / fps
          const ss = displayedFrameSeekSec(t, fps)
          expect(ss).toBeGreaterThanOrEqual(0)
          expect(selectedFrame(ss, fps)).toBe(displayedFrame(t, fps))
          expect(displayedFrame(t, fps)).toBe(k)
        }
      }
    })
  }

  it('the OLD behaviour (seek = timeSec) picked the NEXT frame for between-boundary times', () => {
    const fps = 30
    const t = 1.3 / fps // inside frame 1
    // old: ceil(t·fps) = 2, i.e. one frame late; new: 1
    expect(selectedFrame(t, fps)).toBe(2)
    expect(selectedFrame(displayedFrameSeekSec(t, fps), fps)).toBe(1)
  })

  it('never seeks negative near t=0', () => {
    expect(displayedFrameSeekSec(0, 30)).toBe(0)
    expect(displayedFrameSeekSec(0.001, 30)).toBe(0)
  })

  it('passes timeSec through unchanged when fps is unknown/zero', () => {
    expect(displayedFrameSeekSec(1.234, 0)).toBe(1.234)
    expect(displayedFrameSeekSec(1.234, -1)).toBe(1.234)
    expect(displayedFrameSeekSec(1.234, NaN)).toBe(1.234)
  })
})
