import { describe, it, expect } from 'vitest'
import { resolveTarget, contentScaleFactor, scaleEntries, RESOLUTION_PRESETS } from '../../src/main/cli/scale-video'
import type { SubtitleEntry } from '../../src/shared/types'

/** REQ-0447 Phase 2b — pure resolution-scaling helpers. */
describe('REQ-0447 — resolveTarget', () => {
  it('resolves a known preset', () => {
    expect(resolveTarget(undefined, 'shorts')).toEqual({ ok: true, target: { w: 1080, h: 1920 } })
    expect(RESOLUTION_PRESETS.shorts).toEqual([1080, 1920])
  })
  it('errors on an unknown preset', () => {
    const r = resolveTarget(undefined, 'bogus')
    expect(r.ok).toBe(false)
  })
  it('parses WxH resolution and rejects bad formats', () => {
    expect(resolveTarget('1080x1920', undefined)).toEqual({ ok: true, target: { w: 1080, h: 1920 } })
    expect(resolveTarget('1080X1920', undefined)).toEqual({ ok: true, target: { w: 1080, h: 1920 } })
    expect(resolveTarget('1080', undefined).ok).toBe(false)
    expect(resolveTarget('axb', undefined).ok).toBe(false)
  })
  it('null when neither is given (no scaling)', () => {
    expect(resolveTarget(undefined, undefined)).toEqual({ ok: true, target: null })
  })
})

describe('REQ-0447 — contentScaleFactor', () => {
  it('fits source inside target preserving aspect (min ratio)', () => {
    expect(contentScaleFactor(1280, 720, 1080, 1920)).toBeCloseTo(0.84375, 4) // width-bound
    expect(contentScaleFactor(1280, 720, 1920, 1080)).toBeCloseTo(1.5, 4) // height-bound
    expect(contentScaleFactor(0, 0, 100, 100)).toBe(1)
  })
})

describe('REQ-0447 — scaleEntries', () => {
  const e = (over: Partial<SubtitleEntry>): SubtitleEntry =>
    ({ id: 'x', startSec: 0, endSec: 1, text: 't', isDeleted: false, isEdited: false, fontSizePx: 100, outlineThicknessPx: 4, verticalMarginPx: 40, ...over }) as SubtitleEntry

  it('scales pixel fields by the factor (font floored at 1)', () => {
    const [out] = scaleEntries([e({})], 0.5)
    expect(out.fontSizePx).toBe(50)
    expect(out.outlineThicknessPx).toBe(2)
    expect(out.verticalMarginPx).toBe(20)
    const [tiny] = scaleEntries([e({ fontSizePx: 1 })], 0.1)
    expect(tiny.fontSizePx).toBe(1) // floored
  })
  it('scales posX/posY/shadowDepth only when present', () => {
    const [out] = scaleEntries([e({ posX: 200, posY: 100, shadowDepth: 10 })], 0.5)
    expect(out.posX).toBe(100)
    expect(out.posY).toBe(50)
    expect(out.shadowDepth).toBe(5)
    const [noPos] = scaleEntries([e({})], 0.5)
    expect(noPos.posX).toBeUndefined()
  })
})
