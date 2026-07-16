import { describe, it, expect } from 'vitest'
import { pickTranscriptionTrack } from '../../src/renderer/routes/step1-track-pick'

/**
 * REQ-0121 — audio-track fallback ladder for STEP 1.
 *
 * Spec (owner-confirmed):
 *   1. If the preferred track index exists in the video, select it.
 *   2. Else fall back to Track 1 (specifically `index === 1`) and set
 *      `fallbackUsed = true` so the caller can toast the notice.
 *   3. Else — no Track 1 either — return `trackIndex: null` so the caller
 *      leaves selection empty and reuses the existing "no audio track"
 *      handling.
 */

describe('REQ-0121 — pickTranscriptionTrack', () => {
  it('returns the preferred track when it exists', () => {
    const tracks = [{ index: 1 }, { index: 2 }, { index: 3 }]
    expect(pickTranscriptionTrack(tracks, 2)).toEqual({
      trackIndex: 2,
      fallbackUsed: false
    })
  })

  it('returns the preferred track without a fallback flag even when it equals Track 1', () => {
    // Default is Track 2; a user with a 1-track file who has kept the default
    // should NOT see the "fallback" notice.  Preferred was found on the first
    // ladder step even though the value happens to be 1.
    const tracks = [{ index: 1 }]
    expect(pickTranscriptionTrack(tracks, 1)).toEqual({
      trackIndex: 1,
      fallbackUsed: false
    })
  })

  it('falls back to Track 1 when the preferred track is missing', () => {
    // 2-track video, user prefers Track 6 (via Settings > General).
    const tracks = [{ index: 1 }, { index: 2 }]
    expect(pickTranscriptionTrack(tracks, 6)).toEqual({
      trackIndex: 1,
      fallbackUsed: true
    })
  })

  it('falls back to Track 1 even when the video has NO Track 2 (default preferred is 2)', () => {
    // Edge case: some containers ship Track 1 + Track 3 (index=2 absent).
    // The fallback must land on Track 1, not on the first-available track.
    const tracks = [{ index: 1 }, { index: 3 }]
    expect(pickTranscriptionTrack(tracks, 2)).toEqual({
      trackIndex: 1,
      fallbackUsed: true
    })
  })

  it('returns null when no tracks are available at all', () => {
    expect(pickTranscriptionTrack([], 2)).toEqual({
      trackIndex: null,
      fallbackUsed: false
    })
  })

  it('returns null when the preferred track is missing AND Track 1 is missing', () => {
    // Contrived but possible: an edited file that starts numbering at 2.
    // We must NOT paper over the situation with `audioTracks[0]` — the REQ
    // spec is explicit that only `index === 1` counts as the fallback tier,
    // otherwise the existing "no audio track" flow takes over.
    const tracks = [{ index: 2 }, { index: 3 }]
    expect(pickTranscriptionTrack(tracks, 4)).toEqual({
      trackIndex: null,
      fallbackUsed: false
    })
  })

  it('accepts any object shape that has an .index number (structural typing)', () => {
    // The renderer's AudioTrack has `.channels`, `.sampleRateHz`, etc.
    // The helper must accept those extra fields without complaining, and
    // must not touch anything other than `index`.
    const tracks = [
      { index: 1, channels: 'mono', sampleRateHz: 48000, codec: 'aac' },
      { index: 2, channels: 'stereo', sampleRateHz: 48000, codec: 'aac' }
    ]
    expect(pickTranscriptionTrack(tracks, 2)).toEqual({
      trackIndex: 2,
      fallbackUsed: false
    })
  })
})
