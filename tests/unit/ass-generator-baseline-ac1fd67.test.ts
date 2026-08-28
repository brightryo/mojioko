import { describe, it, expect } from 'vitest'
// REQ-0340 §3 — `generateAss` no longer defaults `assFontName`.  This file's
// subject is tag composition, not font resolution, so it goes through the
// shim that supplies the historical name.  See the helper for why.
import { generateAssLegacyFont as generateAss } from '../helpers/legacy-ass-font-name'
import type { SubtitleEntry, VideoInfo, BurninPosition } from '../../src/shared/types'

/**
 * REQ-0278 — this file pins the ass-generator output byte-for-byte for the
 * "no new fields" path (no casing / shadow / rotation — those are in
 * ass-generator-style-effects.test.ts), so a future accidental spurious tag
 * (a `\shad0` neutraliser, an ordering shuffle, a whitespace drift) fails CI.
 *
 * ★ REQ-0391 (positioning-redesign Phase 1b) — the baselines were REGENERATED
 * as a deliberate correctness change (decision A).  The runtime is now
 * all-`\pos`: MOJIOKO is the single positioning authority, so every unpinned
 * cue carries a `\pos(...)` and its Dialogue MarginV column is `0` (was the
 * MarginV distance).  A bottom-centre cue at verticalMarginPx 40 on 1920×1080
 * now anchors at `\pos(960,1040)`.  The `\pos` placement's correctness is not
 * asserted here — it is guarded in real MP4 pixels by `verify:pos-parity`,
 * which burns the historical MarginV render and this `\pos` render and proves
 * they match (Δ0 for a single cue).  This file's remaining job is unchanged:
 * catch an UNINTENDED tag/ordering/whitespace drift on top of that shape.
 * The PINNED baseline is untouched (pinned cues already emitted `\pos`).
 *
 * To re-baseline after a future intentional generator change, dump
 * `generateAss(...)` for these fixtures and paste verbatim, then bump the REQ
 * note above.  Do NOT hand-tweak the strings.
 */

const video: VideoInfo = {
  path: 'x.mp4', hasVideoStream: true, widthPx: 1920, heightPx: 1080,
  durationSec: 10, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 0,
}
const burnin: BurninPosition = { horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40 }

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

// -------------------------------------------------------------------
// Baselines from ac1fd67 (pre-Phase-A).  Do NOT edit these strings;
// they represent the frozen output shape that the REQ-0278 removal
// must restore.  If the assertions below break, either the generator
// changed intentionally (in which case bump this file with a new REQ
// number) OR a regression slipped in (in which case revert it).
// -------------------------------------------------------------------

const BASELINE_PLAIN =
  '[Script Info]\n' +
  'ScriptType: v4.00+\n' +
  'PlayResX: 1920\n' +
  'PlayResY: 1080\n' +
  'WrapStyle: 2\n' +
  'ScaledBorderAndShadow: yes\n' +
  '\n' +
  '[V4+ Styles]\n' +
  'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BorderStyle, Outline, Alignment, MarginL, MarginR, MarginV\n' +
  'Style: Default,Noto Sans JP SemiBold,100,&H00FFFFFF,&H00000000,1,3,2,10,10,40\n' +
  'Style: WithBox,Noto Sans JP SemiBold,100,&H00FFFFFF,&H00000000,3,3,2,10,10,40\n' +
  '\n' +
  '[Events]\n' +
  'Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text\n' +
  'Dialogue: 0,0:00:00.00,0:00:02.00,Default,0,0,0,,{\\an2\\pos(960,1040)\\fs100\\c&H00FFFFFF&\\3c&H00000000&\\bord3}Hello World\n'

const BASELINE_CJK =
  BASELINE_PLAIN.replace('}Hello World\n', '}日本語テスト\n')

const BASELINE_BG_ENABLED =
  '[Script Info]\n' +
  'ScriptType: v4.00+\n' +
  'PlayResX: 1920\n' +
  'PlayResY: 1080\n' +
  'WrapStyle: 2\n' +
  'ScaledBorderAndShadow: yes\n' +
  '\n' +
  '[V4+ Styles]\n' +
  'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BorderStyle, Outline, Alignment, MarginL, MarginR, MarginV\n' +
  'Style: Default,Noto Sans JP SemiBold,100,&H00FFFFFF,&H00000000,1,3,2,10,10,40\n' +
  'Style: WithBox,Noto Sans JP SemiBold,100,&H00FFFFFF,&H00000000,3,3,2,10,10,40\n' +
  '\n' +
  '[Events]\n' +
  'Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text\n' +
  'Dialogue: 0,0:00:00.00,0:00:02.00,WithBox,0,0,0,,{\\an2\\pos(960,1040)\\fs100\\c&H00FFFFFF&\\3c&H00000000&\\bord3\\3c&H000000&\\3a&H4D&\\shad0}Hello World\n'

const BASELINE_FADE =
  '[Script Info]\n' +
  'ScriptType: v4.00+\n' +
  'PlayResX: 1920\n' +
  'PlayResY: 1080\n' +
  'WrapStyle: 2\n' +
  'ScaledBorderAndShadow: yes\n' +
  '\n' +
  '[V4+ Styles]\n' +
  'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BorderStyle, Outline, Alignment, MarginL, MarginR, MarginV\n' +
  'Style: Default,Noto Sans JP SemiBold,100,&H00FFFFFF,&H00000000,1,3,2,10,10,40\n' +
  'Style: WithBox,Noto Sans JP SemiBold,100,&H00FFFFFF,&H00000000,3,3,2,10,10,40\n' +
  '\n' +
  '[Events]\n' +
  'Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text\n' +
  'Dialogue: 0,0:00:00.00,0:00:02.00,Default,0,0,0,,{\\an2\\pos(960,1040)\\fs100\\c&H00FFFFFF&\\3c&H00000000&\\bord3\\fad(300,300)}Hello World\n'

const BASELINE_PINNED =
  '[Script Info]\n' +
  'ScriptType: v4.00+\n' +
  'PlayResX: 1920\n' +
  'PlayResY: 1080\n' +
  'WrapStyle: 2\n' +
  'ScaledBorderAndShadow: yes\n' +
  '\n' +
  '[V4+ Styles]\n' +
  'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BorderStyle, Outline, Alignment, MarginL, MarginR, MarginV\n' +
  'Style: Default,Noto Sans JP SemiBold,100,&H00FFFFFF,&H00000000,1,3,2,10,10,40\n' +
  'Style: WithBox,Noto Sans JP SemiBold,100,&H00FFFFFF,&H00000000,3,3,2,10,10,40\n' +
  '\n' +
  '[Events]\n' +
  'Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text\n' +
  'Dialogue: 0,0:00:00.00,0:00:02.00,Default,0,0,0,,{\\an2\\pos(100,200)\\fs100\\c&H00FFFFFF&\\3c&H00000000&\\bord3}Hello World\n'

describe('REQ-0278 — ass-generator byte-identity vs ac1fd67 (pre-Phase-A)', () => {
  it('plain default entry → matches ac1fd67 output byte-for-byte', () => {
    expect(generateAss([makeEntry()], video, burnin)).toBe(BASELINE_PLAIN)
  })

  it('CJK text → matches ac1fd67 output byte-for-byte', () => {
    expect(generateAss([makeEntry({ text: '日本語テスト' })], video, burnin)).toBe(BASELINE_CJK)
  })

  it('background-enabled entry → matches ac1fd67 output byte-for-byte', () => {
    const ass = generateAss(
      [makeEntry({ subtitleBackground: { enabled: true, color: 'black', opacityPercent: 70 } })],
      video,
      burnin,
    )
    expect(ass).toBe(BASELINE_BG_ENABLED)
  })

  it('fade > 0 entry → matches ac1fd67 output byte-for-byte', () => {
    expect(generateAss([makeEntry({ fadeDurationSec: 0.3 })], video, burnin)).toBe(BASELINE_FADE)
  })

  it('pinned entry (\\pos) → matches ac1fd67 output byte-for-byte', () => {
    const patch: Partial<SubtitleEntry> = { posX: 100, posY: 200 }
    expect(generateAss([makeEntry(patch)], video, burnin)).toBe(BASELINE_PINNED)
  })

  it('entry with explicit glow-shaped fields (defensive — post-REQ-0278 the fields do not exist on the type)', () => {
    // Even if some legacy project file smuggles in glowEnabled / glowRadius /
    // glowColor via an object spread, ass-generator MUST ignore them
    // (they're not read anywhere) and produce the same baseline as a
    // plain entry.  Cast to unknown-shaped patch so TS lets us include
    // the now-removed fields for the purpose of this defensive test.
    const patch = { glowEnabled: true, glowRadius: 8, glowColor: '#FF00FF' } as unknown as Partial<SubtitleEntry>
    expect(generateAss([makeEntry(patch)], video, burnin)).toBe(BASELINE_PLAIN)
  })
})
