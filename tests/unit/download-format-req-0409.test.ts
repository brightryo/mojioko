import { describe, it, expect } from 'vitest'
import { formatBytesPerSec, formatEtaSeconds } from '../../src/renderer/lib/format'

/**
 * REQ-0409 — the MB/s + ETA readouts that tell the user "slow" vs "frozen".
 */
describe('formatBytesPerSec', () => {
  it('empty for 0 / invalid', () => {
    expect(formatBytesPerSec(0)).toBe('')
    expect(formatBytesPerSec(-5)).toBe('')
    expect(formatBytesPerSec(NaN)).toBe('')
  })
  it('KB/s under 1 MB/s, MB/s above', () => {
    expect(formatBytesPerSec(500_000)).toBe('500 KB/s')
    expect(formatBytesPerSec(12_300_000)).toBe('12.3 MB/s')
    expect(formatBytesPerSec(1_000_000)).toBe('1.0 MB/s')
  })
})

describe('formatEtaSeconds', () => {
  it('empty when no finite estimate', () => {
    expect(formatEtaSeconds(0, 1_000_000)).toBe('')
    expect(formatEtaSeconds(1_000_000, 0)).toBe('')
    expect(formatEtaSeconds(1_000_000, NaN)).toBe('')
  })
  it('m:ss under an hour', () => {
    expect(formatEtaSeconds(10_000_000, 5_000_000)).toBe('0:02') // 2 s
    expect(formatEtaSeconds(150_000_000, 1_000_000)).toBe('2:30') // 150 s
  })
  it('h:mm:ss past an hour', () => {
    expect(formatEtaSeconds(3_661_000_000, 1_000_000)).toBe('1:01:01') // 3661 s
  })
})
