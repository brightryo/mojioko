import { describe, it, expect } from 'vitest'
import { generateAss } from '../../src/main/services/ass-generator'
import type { SubtitleEntry, VideoInfo, BurninPosition } from '../../src/shared/types'

/**
 * REQ-0277 Phase A — ass-generator emit tests for the 4 new style
 * effects (casing / drop shadow / glow / rotation).  Each assertion is
 * a substring-in-ASS check because the ASS format is line-based text
 * and inline `\<tag>` order can shift over time — we care that the
 * intended tag string LANDS in the Dialogue line for each enabled
 * effect, and that DISABLED effects do NOT emit tags at all (except
 * shadow's `\shad0` neutraliser, which IS intentional).
 */

const video: VideoInfo = {
  path: 'x.mp4', hasVideoStream: true, widthPx: 1920, heightPx: 1080,
  durationSec: 10, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 0,
}
const burnin: BurninPosition = { horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40 }

// Baseline entry — every existing field required by the type.  Effect
// fields left undefined so each test can toggle just what it exercises.
function makeEntry(patch: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base: SubtitleEntry = {
    id: 'e1',
    startSec: 0, endSec: 2,
    text: 'Hello World',
    fontSizePx: 100,
    textColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    outlineThicknessPx: 3,
    fadeDurationSec: 0,
    horizontalPosition: 'center',
    verticalPosition: 'bottom',
    verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    isDeleted: false,
    isEdited: false,
    original: {
      startSec: 0, endSec: 2, text: 'Hello World',
      fontSizePx: 100, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
      outlineThicknessPx: 3, fadeDurationSec: 0,
      horizontalPosition: 'center', verticalPosition: 'bottom',
      verticalMarginPx: 40,
      subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    },
  }
  return { ...base, ...patch }
}

const dialogueLineOf = (ass: string) => ass.split('\n').find((l) => l.startsWith('Dialogue:'))!

// -----------------------------------------------------------------
// §1 Casing (display-only, doesn't touch stored text)
// -----------------------------------------------------------------
describe('REQ-0277 §1 — casing', () => {
  it('undefined casing → text emitted as-is', () => {
    const ass = generateAss([makeEntry({ text: 'Hello World' })], video, burnin)
    expect(dialogueLineOf(ass)).toContain('Hello World')
    expect(dialogueLineOf(ass)).not.toContain('HELLO WORLD')
  })
  it("casing: 'none' → text emitted as-is", () => {
    const ass = generateAss([makeEntry({ text: 'Hello World', casing: 'none' })], video, burnin)
    expect(dialogueLineOf(ass)).toContain('Hello World')
  })
  it("casing: 'uppercase' → text uppercased in emit but stored text unchanged", () => {
    const entry = makeEntry({ text: 'Hello World', casing: 'uppercase' })
    const ass = generateAss([entry], video, burnin)
    expect(dialogueLineOf(ass)).toContain('HELLO WORLD')
    expect(dialogueLineOf(ass)).not.toContain('Hello World')
    // Stored text is unmodified — this is the SRT export protection.
    expect(entry.text).toBe('Hello World')
  })
  it('uppercase on CJK is a no-op (JP has no case)', () => {
    const ass = generateAss([makeEntry({ text: '日本語テスト', casing: 'uppercase' })], video, burnin)
    expect(dialogueLineOf(ass)).toContain('日本語テスト')
  })
})

// -----------------------------------------------------------------
// §2 Drop shadow
// -----------------------------------------------------------------
describe('REQ-0277 §2 — drop shadow', () => {
  it('shadow off (undefined) → NO shadow tags emitted (Style header has no Shadow column → libass defaults to 0)', () => {
    const ass = generateAss([makeEntry()], video, burnin)
    const line = dialogueLineOf(ass)
    // Regression pin: pre-REQ-0277 output for shadowless non-bg rows
    // must be byte-identical.  No `\shad`, no `\4c`, no `\4a`.
    expect(line).not.toContain('\\shad')
    expect(line).not.toContain('\\4c')
    expect(line).not.toContain('\\4a')
  })
  it('shadow on → emits \\shad<depth>, \\4c<color>, \\4a<alpha>', () => {
    const ass = generateAss([makeEntry({
      shadowEnabled: true, shadowDepth: 6, shadowColor: '#112233', shadowAlpha: 75,
    })], video, burnin)
    const line = dialogueLineOf(ass)
    expect(line).toContain('\\shad6')
    expect(line).toContain('\\4c&H00332211&')  // ASS hex = BBGGRR order
    // alpha: 75% opaque → 0.25 * 255 = 63.75 → 64 → 0x40
    expect(line).toContain('\\4a&H40&')
  })
  it('shadow suppressed when subtitleBackground is enabled (bg path wins)', () => {
    const entry = makeEntry({
      shadowEnabled: true, shadowDepth: 6,
      subtitleBackground: { enabled: true, color: 'black', opacityPercent: 70 },
    })
    const ass = generateAss([entry], video, burnin)
    const line = dialogueLineOf(ass)
    // The bg path emits its own \shad0 and the shadow tags should be omitted entirely.
    expect(line).toContain('\\shad0')  // from the bg path
    expect(line).not.toContain('\\shad6')  // suppressed
    expect(line).not.toContain('\\4c')
    expect(line).not.toContain('\\4a')
  })
  it('shadow off (explicit false) → no shadow tags', () => {
    const ass = generateAss([makeEntry({ shadowEnabled: false })], video, burnin)
    const line = dialogueLineOf(ass)
    expect(line).not.toContain('\\shad')
    expect(line).not.toContain('\\4c')
  })

  it('REQ-0292 §1 — shadow depth up to 100 passes through (no clamp at 20)', () => {
    // Pre-REQ-0292 the burn-in clamped shadow depth at 20; setting the
    // CSS preview slider to 100 would silently emit `\shad20` and the
    // preview would look 5× larger than the burn-in.  REQ-0292 raised
    // the clamp to `SHADOW_DEPTH_MAX_PX = 100` in lockstep with the
    // CSS side so both agree at the new ceiling.
    const ass = generateAss([makeEntry({ shadowEnabled: true, shadowDepth: 100 })], video, burnin)
    expect(dialogueLineOf(ass)).toContain('\\shad100')
  })

  it('REQ-0292 §1 — shadow depth above 100 still clamps to 100 (defensive upper cap)', () => {
    const ass = generateAss([makeEntry({ shadowEnabled: true, shadowDepth: 250 })], video, burnin)
    expect(dialogueLineOf(ass)).toContain('\\shad100')
    expect(dialogueLineOf(ass)).not.toContain('\\shad250')
  })

  it('REQ-0292 §5 — outline thickness 20 passes through `\\bord20` (max raised from 10)', () => {
    // REQ-0292 §5 raised OUTLINE_THICKNESS_MAX_PX from 10 to 20.  The
    // ass-generator emits `\bord<value>` verbatim from the entry, so
    // this test guards that a stored 20 renders as `\bord20` — proving
    // the max bump propagated to the burn-in path without a lingering
    // clamp anywhere downstream.
    const ass = generateAss([makeEntry({ outlineThicknessPx: 20 })], video, burnin)
    expect(dialogueLineOf(ass)).toContain('\\bord20')
  })
})

// REQ-0278 — §3 glow tests were removed here.  The feature itself
// was removed; the byte-identity of a plain entry's ASS to pre-Phase-A
// output is now pinned by tests/unit/ass-generator-baseline-ac1fd67.test.ts.

// -----------------------------------------------------------------
// §4 Rotation
// -----------------------------------------------------------------
describe('REQ-0277 §4 — rotation', () => {
  it('rotation undefined OR 0 → no \\frz tag', () => {
    expect(dialogueLineOf(generateAss([makeEntry()], video, burnin))).not.toContain('\\frz')
    expect(dialogueLineOf(generateAss([makeEntry({ rotation: 0 })], video, burnin))).not.toContain('\\frz')
  })
  it('rotation 90 (user CW) → libass CCW = 270 (frz=270)', () => {
    // Our convention: user-supplied `rotation` is clockwise (matches CSS).
    // libass `\frz` measures counter-clockwise, so ass-generator emits
    // `(360 - deg)`.  90 CW → 270 CCW.
    const ass = generateAss([makeEntry({ rotation: 90 })], video, burnin)
    expect(dialogueLineOf(ass)).toContain('\\frz270')
  })
  it('rotation 180 → \\frz180 (symmetric)', () => {
    const ass = generateAss([makeEntry({ rotation: 180 })], video, burnin)
    expect(dialogueLineOf(ass)).toContain('\\frz180')
  })
  it('rotation 360 collapses to 0 (no tag)', () => {
    const ass = generateAss([makeEntry({ rotation: 360 })], video, burnin)
    expect(dialogueLineOf(ass)).not.toContain('\\frz')
  })
})

// -----------------------------------------------------------------
// §0-1 backward compat — entries without the new fields still work
// -----------------------------------------------------------------
describe('REQ-0277 §0-1 / REQ-0278 — pre-REQ-0277 entries hydrate as effect-off', () => {
  it('entry with no effect fields renders no effect tags (\\frz / \\shad / \\4c / \\4a all absent — \\blur can never appear post-REQ-0278 either)', () => {
    const ass = generateAss([makeEntry()], video, burnin)
    const line = dialogueLineOf(ass)
    // REQ-0278: `\blur` should be absent for ANY entry now (glow removed).
    // Retained here as a defensive pin; the exact-string byte-identity
    // check lives in ass-generator-baseline-ac1fd67.test.ts.
    expect(line).not.toContain('\\blur')
    expect(line).not.toContain('\\frz')
    expect(line).not.toContain('\\shad')
    expect(line).not.toContain('\\4c')
    expect(line).not.toContain('\\4a')
    // No text-transform in the emit path either
    expect(line).toContain('Hello World')
  })
  it('generateAss accepts undefined effect fields without throwing', () => {
    expect(() => generateAss([makeEntry({})], video, burnin)).not.toThrow()
  })
})
