import { describe, it, expect } from 'vitest'
import { buildTrimConcatFilter } from '../../src/main/services/ffmpeg-trim-filter'
import { sanitizeCuts, type Cut } from '../../src/shared/cuts'

const SUBS = "subtitles='/tmp/x.ass':fontsdir='/tmp/fonts'"

function cut(startSec: number, endSec: number, id?: string): Cut {
  return { startSec, endSec, id: id ?? `c-${startSec}-${endSec}` }
}

describe('buildTrimConcatFilter', () => {
  it('video-only source (no audio tracks) emits -an and only video chain', () => {
    const r = buildTrimConcatFilter(60, [cut(10, 15)], 'simple', 0, SUBS)
    expect(r.filterComplex).toContain('[0:v]trim=start=0.000000:end=10.000000,setpts=PTS-STARTPTS[v0]')
    expect(r.filterComplex).toContain('[0:v]trim=start=15.000000:end=60.000000,setpts=PTS-STARTPTS[v1]')
    expect(r.filterComplex).toContain('[v0][v1]concat=n=2:v=1:a=0[vcat]')
    expect(r.filterComplex).toContain(`[vcat]${SUBS}[vout]`)
    expect(r.mapArgs).toEqual(['-map', '[vout]'])
    expect(r.outputCodecArgs).toEqual(['-an'])
  })

  it('simple audioMode with 1 track: per-track trim+concat then amix', () => {
    const r = buildTrimConcatFilter(60, [cut(10, 15)], 'simple', 1, SUBS)
    expect(r.filterComplex).toContain('[0:a:0]atrim=start=0.000000:end=10.000000,asetpts=PTS-STARTPTS[a0_0]')
    expect(r.filterComplex).toContain('[a0_0][a0_1]concat=n=2:v=0:a=1[at0cat]')
    expect(r.filterComplex).toContain('[at0cat]amix=inputs=1:duration=longest:normalize=0[aout]')
    expect(r.mapArgs).toEqual(['-map', '[vout]', '-map', '[aout]'])
    expect(r.outputCodecArgs).toEqual(['-c:a', 'aac', '-b:a', '192k'])
  })

  it('simple audioMode with 2 tracks: amix both per-track concats', () => {
    const r = buildTrimConcatFilter(60, [cut(10, 15)], 'simple', 2, SUBS)
    expect(r.filterComplex).toContain('[at0cat][at1cat]amix=inputs=2:duration=longest:normalize=0[aout]')
    expect(r.mapArgs).toEqual(['-map', '[vout]', '-map', '[aout]'])
  })

  it('preserve audioMode with 2 tracks: separate map outputs, aac re-encode', () => {
    const r = buildTrimConcatFilter(60, [cut(10, 15)], 'preserve', 2, SUBS)
    expect(r.filterComplex).toContain('[a0_0][a0_1]concat=n=2:v=0:a=1[at0cat]')
    expect(r.filterComplex).toContain('[a1_0][a1_1]concat=n=2:v=0:a=1[at1cat]')
    // No amix — preserve keeps tracks separate.
    expect(r.filterComplex).not.toContain('amix')
    expect(r.mapArgs).toEqual(['-map', '[vout]', '-map', '[at0cat]', '-map', '[at1cat]'])
    expect(r.outputCodecArgs).toEqual(['-c:a', 'aac', '-b:a', '192k'])
  })

  it('multiple cuts produce N+1 kept segments', () => {
    const r = buildTrimConcatFilter(60, [cut(10, 15), cut(30, 32)], 'simple', 0, SUBS)
    expect(r.filterComplex).toContain('trim=start=0.000000:end=10.000000')
    expect(r.filterComplex).toContain('trim=start=15.000000:end=30.000000')
    expect(r.filterComplex).toContain('trim=start=32.000000:end=60.000000')
    expect(r.filterComplex).toContain('[v0][v1][v2]concat=n=3:v=1:a=0[vcat]')
  })

  it('cut at start drops the leading segment (only one branch)', () => {
    const r = buildTrimConcatFilter(60, [cut(0, 10)], 'simple', 0, SUBS)
    expect(r.filterComplex).toContain('[0:v]trim=start=10.000000:end=60.000000,setpts=PTS-STARTPTS[v0]')
    expect(r.filterComplex).toContain('[v0]concat=n=1:v=1:a=0[vcat]')
  })

  it('throws when every frame is cut (no kept segments)', () => {
    expect(() => buildTrimConcatFilter(60, [cut(0, 60)], 'simple', 0, SUBS)).toThrow(
      /no kept segments/
    )
  })

  // ---------------------------------------------------------------------------
  // REQ-105 Phase 2 — nested / touching cuts now appear in storage.  The
  // filter_complex must produce the SAME trim/concat chain it would have
  // produced for the union-equivalent disjoint shape.  buildKeptSegments
  // (which the builder routes through) handles this; these tests lock the
  // resulting argv so a regression in either function is visible here.
  // ---------------------------------------------------------------------------

  it('nested cuts produce the same filter_complex as the outer cut alone', () => {
    const nested = sanitizeCuts([cut(10, 30, 'outer'), cut(15, 20, 'inner')])
    const merged = sanitizeCuts([cut(10, 30, 'merged-equivalent')])
    const rNested = buildTrimConcatFilter(60, nested, 'simple', 0, SUBS)
    const rMerged = buildTrimConcatFilter(60, merged, 'simple', 0, SUBS)
    expect(rNested.filterComplex).toBe(rMerged.filterComplex)
    // Spot check: two kept segments [0,10] + [30,60].
    expect(rNested.filterComplex).toContain('[0:v]trim=start=0.000000:end=10.000000,setpts=PTS-STARTPTS[v0]')
    expect(rNested.filterComplex).toContain('[0:v]trim=start=30.000000:end=60.000000,setpts=PTS-STARTPTS[v1]')
    expect(rNested.filterComplex).toContain('[v0][v1]concat=n=2:v=1:a=0[vcat]')
  })

  it('touching cuts produce the same filter_complex as one continuous cut', () => {
    const touching = sanitizeCuts([cut(10, 15, 'a'), cut(15, 20, 'b')])
    const merged = sanitizeCuts([cut(10, 20, 'merged-equivalent')])
    const rTouching = buildTrimConcatFilter(60, touching, 'simple', 0, SUBS)
    const rMerged = buildTrimConcatFilter(60, merged, 'simple', 0, SUBS)
    expect(rTouching.filterComplex).toBe(rMerged.filterComplex)
  })

  it('3-way overlap collapses to a single span in the kept-segment chain', () => {
    const cuts = sanitizeCuts([cut(10, 18, 'a'), cut(15, 22, 'b'), cut(20, 30, 'c')])
    const r = buildTrimConcatFilter(60, cuts, 'simple', 0, SUBS)
    expect(r.filterComplex).toContain('[0:v]trim=start=0.000000:end=10.000000,setpts=PTS-STARTPTS[v0]')
    expect(r.filterComplex).toContain('[0:v]trim=start=30.000000:end=60.000000,setpts=PTS-STARTPTS[v1]')
    expect(r.filterComplex).toContain('[v0][v1]concat=n=2:v=1:a=0[vcat]')
  })
})
