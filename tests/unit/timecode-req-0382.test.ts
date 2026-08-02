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
})

describe('frameStepSec (REQ-0382 §B)', () => {
  it('steps exactly one frame, snapped to the frame grid', () => {
    expect(frameStepSec(2.5, 30, 1, 7)).toBeCloseTo(76 / 30, 9)
    expect(frameStepSec(2.5, 30, -1, 7)).toBeCloseTo(74 / 30, 9)
    // an off-grid start snaps to the nearest frame first
    expect(frameStepSec(0.02, 30, 1, 7)).toBeCloseTo(2 / 30, 9)
  })
  it('clamps at 0 and at the duration (no out-of-range)', () => {
    expect(frameStepSec(0, 30, -1, 7)).toBe(0)
    expect(frameStepSec(7, 30, 1, 7)).toBeCloseTo(7, 9) // last frame = 210/30
    expect(frameStepSec(6.999, 30, 1, 7)).toBeCloseTo(7, 9)
  })
  it('repeated steps land on exact k/fps boundaries', () => {
    let t = 1.234
    for (let i = 0; i < 5; i++) t = frameStepSec(t, 30, 1, 10)
    expect(t * 30).toBeCloseTo(Math.round(t * 30), 9) // integer frame index
  })
  it('falls back to 30fps for non-positive fps', () => {
    expect(frameStepSec(1, 0, 1, 7)).toBeCloseTo(31 / 30, 9)
  })
})
