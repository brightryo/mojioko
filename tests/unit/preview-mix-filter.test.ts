import { describe, it, expect } from 'vitest'
import { buildAmixAudioFilter } from '../../src/main/services/preview-mix-filter'

describe('buildAmixAudioFilter', () => {
  it('N=0 emits -an and no map entries', () => {
    const r = buildAmixAudioFilter(0)
    expect(r.filterComplex).toBe('')
    expect(r.mapArgs).toEqual([])
    expect(r.codecArgs).toEqual(['-an'])
  })

  it('N=0 treats negative input as no audio (defensive)', () => {
    const r = buildAmixAudioFilter(-1)
    expect(r.codecArgs).toEqual(['-an'])
  })

  it('N=1 still emits amix=inputs=1 to match legacy burnin shape', () => {
    const r = buildAmixAudioFilter(1)
    expect(r.filterComplex).toBe(
      '[0:a:0]amix=inputs=1:duration=longest:normalize=0[aout]',
    )
    expect(r.mapArgs).toEqual(['-map', '[aout]'])
    expect(r.codecArgs).toEqual(['-c:a', 'aac', '-b:a', '192k'])
  })

  it('N=2 mixes both source tracks', () => {
    const r = buildAmixAudioFilter(2)
    expect(r.filterComplex).toBe(
      '[0:a:0][0:a:1]amix=inputs=2:duration=longest:normalize=0[aout]',
    )
    expect(r.mapArgs).toEqual(['-map', '[aout]'])
    expect(r.codecArgs).toEqual(['-c:a', 'aac', '-b:a', '192k'])
  })

  it('N=3 mixes all three source tracks in order', () => {
    const r = buildAmixAudioFilter(3)
    expect(r.filterComplex).toBe(
      '[0:a:0][0:a:1][0:a:2]amix=inputs=3:duration=longest:normalize=0[aout]',
    )
    expect(r.mapArgs).toEqual(['-map', '[aout]'])
  })

  it('REQ-086 contract — exact filter shape matches the pre-REQ-086 inline burnin filter for N >= 1', () => {
    // Mirror the legacy `ffmpeg-burnin.ts` no-cuts simple-mode literal:
    //   const inputLabels = Array.from({ length: N }, (_, i) => `[0:a:${i}]`).join('')
    //   const audioFilter = `${inputLabels}amix=inputs=${N}:duration=longest:normalize=0[aout]`
    for (const N of [1, 2, 3, 8]) {
      const labels = Array.from({ length: N }, (_, i) => `[0:a:${i}]`).join('')
      const expected = `${labels}amix=inputs=${N}:duration=longest:normalize=0[aout]`
      expect(buildAmixAudioFilter(N).filterComplex).toBe(expected)
    }
  })
})
