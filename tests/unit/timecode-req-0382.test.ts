import { describe, it, expect } from 'vitest'
import { formatTimecode, frameStepSec } from '../../src/shared/timecode'

/** REQ-0382 §A/§B — frame-precision timecode + one-frame step, pinned. */
describe('formatTimecode (REQ-0382 §A)', () => {
  it('owner-chosen format: M:SS.mmm (f<frame in second>)', () => {
    expect(formatTimecode(2.5, 30)).toBe('0:02.500 (f15)')   // owner example
    expect(formatTimecode(7.0, 30)).toBe('0:07.000 (f0)')    // owner example (total)
  })
  it('frame number is the 0-based frame within the second', () => {
    expect(formatTimecode(7 / 30, 30)).toBe('0:00.233 (f7)')  // frame 7 = 233ms
    expect(formatTimecode(0.5, 24)).toBe('0:00.500 (f12)')    // 24fps
    expect(formatTimecode(0, 30)).toBe('0:00.000 (f0)')
  })
  it('pads minutes/hours correctly', () => {
    expect(formatTimecode(65.5, 30)).toBe('1:05.500 (f15)')
    expect(formatTimecode(3661.5, 30)).toBe('1:01:01.500 (f15)')
  })
  it('non-integer fps (29.97) frame stays within 0..ceil(fps)-1', () => {
    expect(formatTimecode(0.5, 30000 / 1001)).toBe('0:00.500 (f14)')
    // frac just under 1s must not overflow past the last frame index
    expect(formatTimecode(0.999, 30000 / 1001)).toMatch(/\(f29\)$/)
  })
  it('guards non-finite / negative time and non-positive fps', () => {
    expect(formatTimecode(-1, 30)).toBe('0:00.000 (f0)')
    expect(formatTimecode(NaN, 30)).toBe('0:00.000 (f0)')
    expect(formatTimecode(2.5, 0)).toBe('0:02.500 (f15)')  // fps → 30 fallback
    expect(formatTimecode(2.5, NaN)).toBe('0:02.500 (f15)')
  })

  // REQ-0443 §1 — simple mode: h/m/s only (no ms, no frame).
  it('simple mode (detailed=false) shows M:SS / H:MM:SS with no ms or frame', () => {
    expect(formatTimecode(3.56, 30, false)).toBe('0:03')   // owner example
    expect(formatTimecode(7.103, 30, false)).toBe('0:07')  // owner example
    expect(formatTimecode(65.5, 30, false)).toBe('1:05')
    expect(formatTimecode(3661.5, 30, false)).toBe('1:01:01')
    expect(formatTimecode(0, 30, false)).toBe('0:00')
    // fps is irrelevant in simple mode (no frame shown).
    expect(formatTimecode(2.9, 0, false)).toBe('0:02')
    // detailed defaults to true → unchanged from the historical signature.
    expect(formatTimecode(2.5, 30)).toBe('0:02.500 (f15)')
  })
})

describe('frameStepSec (REQ-0382 §B / REQ-0383)', () => {
  // REQ-0383: the step now returns the frame CENTER (index+0.5)/fps — seeking a
  // <video> to an exact boundary undershoots and dup/skips frames.  The
  // meaningful property is that the DISPLAYED frame (floor(seek·fps)) advances
  // by exactly one.  Real-Chromium round-trip is pinned by verify:frame-step.
  const displayedFrame = (t: number, fps: number) => Math.floor(t * fps + 1e-6)

  it('steps one frame and returns that frame’s centre', () => {
    expect(frameStepSec(2.5, 30, 1, 7)).toBeCloseTo(76.5 / 30, 9)   // 2.5s = f75 → f76 centre
    expect(frameStepSec(2.5, 30, -1, 7)).toBeCloseTo(74.5 / 30, 9)  // → f74 centre
    // an off-grid start floors to its displayed frame first (f0), then +1 = f1
    expect(frameStepSec(0.02, 30, 1, 7)).toBeCloseTo(1.5 / 30, 9)
    // the returned time always decodes to the intended frame
    expect(displayedFrame(frameStepSec(2.5, 30, 1, 7), 30)).toBe(76)
    expect(displayedFrame(frameStepSec(0.02, 30, 1, 7), 30)).toBe(1)
  })

  it('advances the displayed frame by exactly one, forward then back (no dup/skip)', () => {
    const fps = 30, dur = 7
    let t = 0
    for (let expected = 1; expected <= 20; expected++) {
      t = frameStepSec(t, fps, 1, dur)
      expect(displayedFrame(t, fps)).toBe(expected)
    }
    for (let expected = 19; expected >= 0; expected--) {
      t = frameStepSec(t, fps, -1, dur)
      expect(displayedFrame(t, fps)).toBe(expected)
    }
  })

  it('works at non-integer fps (59.94) — one frame per step', () => {
    const fps = 60000 / 1001, dur = 2.002
    let t = 0
    for (let expected = 1; expected <= 20; expected++) {
      t = frameStepSec(t, fps, 1, dur)
      expect(displayedFrame(t, fps)).toBe(expected)
    }
  })

  it('clamps at 0 and at the last frame (no out-of-range, no reverse)', () => {
    expect(displayedFrame(frameStepSec(0, 30, -1, 7), 30)).toBe(0)         // can't go below f0
    // 7s @ 30fps = frames 0..209; stepping forward at/after the end holds f209
    expect(displayedFrame(frameStepSec(7, 30, 1, 7), 30)).toBe(209)
    expect(frameStepSec(7, 30, 1, 7)).toBeLessThan(7)                      // never seeks past duration
    expect(displayedFrame(frameStepSec(6.999, 30, 1, 7), 30)).toBe(209)
  })

  it('falls back to 30fps for non-positive fps', () => {
    expect(displayedFrame(frameStepSec(1, 0, 1, 7), 30)).toBe(31) // f30 → f31
  })
})
