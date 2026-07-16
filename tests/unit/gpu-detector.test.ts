import { describe, it, expect } from 'vitest'
import { classifyAdapters } from '../../src/main/services/gpu-classify'

/**
 * REQ-0150 §2 — the important correctness contract is "iterate every
 * WMI row, do not stop at the first adapter."  These tests pin the
 * pure classifier's behaviour for the corner cases the owner's box
 * (NVIDIA + Ryzen APU iGPU) exercises plus the two cases the owner
 * cannot verify on real hardware (non-NVIDIA only, and none-at-all).
 */
describe('classifyAdapters', () => {
  it('detects NVIDIA when it is the ONLY adapter', () => {
    const r = classifyAdapters(['NVIDIA GeForce RTX 3060'])
    expect(r.nvidiaDetected).toBe(true)
    expect(r.nvidiaName).toBe('NVIDIA GeForce RTX 3060')
    expect(r.otherAdapters).toEqual([])
  })

  it('detects NVIDIA when the discrete GPU is enumerated first (owner box)', () => {
    const r = classifyAdapters([
      'NVIDIA GeForce RTX 3060',
      'AMD Radeon(TM) Graphics',
    ])
    expect(r.nvidiaDetected).toBe(true)
    expect(r.nvidiaName).toBe('NVIDIA GeForce RTX 3060')
    expect(r.otherAdapters).toEqual(['AMD Radeon(TM) Graphics'])
  })

  it('detects NVIDIA when the iGPU is enumerated first (order swap)', () => {
    // REQ-0150 §2 — MSDN documents WMI adapter order as undefined.  Pre-
    // REQ-0150 code took the first row and returned NVIDIA-detected=false
    // in this scenario.  The pure classifier must find NVIDIA no matter
    // where it lands.
    const r = classifyAdapters([
      'AMD Radeon(TM) Graphics',
      'NVIDIA GeForce RTX 3060',
    ])
    expect(r.nvidiaDetected).toBe(true)
    expect(r.nvidiaName).toBe('NVIDIA GeForce RTX 3060')
    expect(r.otherAdapters).toEqual(['AMD Radeon(TM) Graphics'])
  })

  it('categorises Ryzen iGPU-only box as "other-only" (owner cannot verify on real hardware)', () => {
    const r = classifyAdapters(['AMD Radeon(TM) Graphics'])
    expect(r.nvidiaDetected).toBe(false)
    expect(r.nvidiaName).toBeNull()
    expect(r.otherAdapters).toEqual(['AMD Radeon(TM) Graphics'])
  })

  it('categorises AMD Radeon RX discrete-only box as "other-only"', () => {
    const r = classifyAdapters(['AMD Radeon RX 7800 XT'])
    expect(r.nvidiaDetected).toBe(false)
    expect(r.otherAdapters).toEqual(['AMD Radeon RX 7800 XT'])
  })

  it('categorises Intel iGPU-only box as "other-only"', () => {
    const r = classifyAdapters(['Intel(R) UHD Graphics 770'])
    expect(r.nvidiaDetected).toBe(false)
    expect(r.otherAdapters).toEqual(['Intel(R) UHD Graphics 770'])
  })

  it('categorises AMD + Intel dual-adapter (no NVIDIA) as "other-only"', () => {
    const r = classifyAdapters([
      'Intel(R) UHD Graphics',
      'AMD Radeon RX 6600',
    ])
    expect(r.nvidiaDetected).toBe(false)
    expect(r.otherAdapters).toEqual([
      'Intel(R) UHD Graphics',
      'AMD Radeon RX 6600',
    ])
  })

  it('categorises empty adapter list as "no adapters"', () => {
    const r = classifyAdapters([])
    expect(r.nvidiaDetected).toBe(false)
    expect(r.nvidiaName).toBeNull()
    expect(r.otherAdapters).toEqual([])
  })

  it('is case-insensitive on the NVIDIA match', () => {
    const r = classifyAdapters(['nvidia geforce rtx 3060'])
    expect(r.nvidiaDetected).toBe(true)
    expect(r.nvidiaName).toBe('nvidia geforce rtx 3060')
  })

  it('trims whitespace and drops empty rows (defensive against WMI blank lines)', () => {
    const r = classifyAdapters([
      '   ',
      '  NVIDIA GeForce RTX 3060  ',
      '',
    ])
    expect(r.nvidiaDetected).toBe(true)
    expect(r.nvidiaName).toBe('NVIDIA GeForce RTX 3060')
    expect(r.otherAdapters).toEqual([])
  })

  it('picks the FIRST NVIDIA row when multiple NVIDIA cards are present', () => {
    const r = classifyAdapters([
      'NVIDIA GeForce RTX 3060',
      'NVIDIA GeForce GTX 1080',
    ])
    expect(r.nvidiaName).toBe('NVIDIA GeForce RTX 3060')
    expect(r.otherAdapters).toEqual([])
  })

  it('does not confuse a name that merely contains "video" or "vid" with NVIDIA', () => {
    // Defensive: a hypothetical adapter with "Video" in the name should
    // NOT match.  Guards against a future weakening of the regex.
    const r = classifyAdapters(['Generic Video Accelerator'])
    expect(r.nvidiaDetected).toBe(false)
    expect(r.otherAdapters).toEqual(['Generic Video Accelerator'])
  })
})
