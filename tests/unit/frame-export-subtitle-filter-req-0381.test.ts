import { describe, it, expect } from 'vitest'
import { frameExportSubtitleFilter } from '../../src/shared/frame-seek'

/**
 * REQ-0381 — pass-2 filter for the two-pass subtitle frame export.
 *
 * The `subtitles` (libass) filter renders karaoke `\k`/`\kf` and animation
 * `\fad`/`\t` at the frame's pts.  Pass 2 burns the subtitle onto an already
 * extracted still, so its pts is meaningless; the filter sets the still's clock
 * to the continuous playhead time with a fine timebase (`settb=AVTB`) so libass
 * renders exactly the state the preview shows at `timeSec` — NOT re-quantised to
 * the frame grid.  Real-pixel parity is pinned by
 * `scripts/verify-karaoke-frame-parity`; this pins the emitted string.
 */
describe('frameExportSubtitleFilter (REQ-0381)', () => {
  const SUB = "subtitles='/tmp/x.ass':fontsdir='/tmp/fonts'"

  it('prepends a fine-timebase setpts at the playhead time', () => {
    // settb=AVTB MUST come before setpts — on the native 1/fps timebase the
    // pts would round back to the frame grid, re-introducing the very lag being
    // fixed.  setpts uses the playhead time so libass renders at that instant.
    expect(frameExportSubtitleFilter(1.316, SUB)).toBe(`settb=AVTB,setpts=1.316000/TB,${SUB}`)
    expect(frameExportSubtitleFilter(0, SUB)).toBe(`settb=AVTB,setpts=0.000000/TB,${SUB}`)
  })

  it('keeps microsecond precision (not re-quantised to any frame grid)', () => {
    // Two sub-frame-apart playheads must produce DIFFERENT setpts values, or the
    // export would collapse to the same libass instant (the pre-fix bug).
    const a = frameExportSubtitleFilter(1.30011, SUB)
    const b = frameExportSubtitleFilter(1.30055, SUB)
    expect(a).not.toBe(b)
    expect(a).toContain('setpts=1.300110/TB')
    expect(b).toContain('setpts=1.300550/TB')
  })

  it('falls back to the bare filter for non-finite / negative time', () => {
    // A broken time must never produce a malformed filtergraph.
    expect(frameExportSubtitleFilter(NaN, SUB)).toBe(SUB)
    expect(frameExportSubtitleFilter(-0.5, SUB)).toBe(SUB)
    expect(frameExportSubtitleFilter(Infinity, SUB)).toBe(SUB)
  })
})
