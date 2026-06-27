import { describe, it, expect } from 'vitest'
import { pickAudioTrackLabel } from '../../src/renderer/lib/audio-track-label'

/**
 * REQ-20260615-079 — STEP1 input-file accordion header track-summary
 * picker.  The renderer maps the returned tag to a locale key
 * (`audioTracks.noAudioTrack` / `audioTracks.audioTrackCount`) so every
 * decision branch needs a covering case here.
 */

describe('REQ-079 — pickAudioTrackLabel', () => {
  it('returns hidden when no file is loaded (null input)', () => {
    expect(pickAudioTrackLabel(null)).toEqual({ kind: 'hidden' })
  })

  it('returns no-audio when a file is loaded but reports zero audio tracks', () => {
    expect(pickAudioTrackLabel(0)).toEqual({ kind: 'no-audio' })
  })

  it('returns count=1 for a single-track file (English locale renders the _one variant)', () => {
    expect(pickAudioTrackLabel(1)).toEqual({ kind: 'count', count: 1 })
  })

  it('returns count=2 for a two-track file (English renders _other; Japanese uses the same template)', () => {
    expect(pickAudioTrackLabel(2)).toEqual({ kind: 'count', count: 2 })
  })

  it('preserves arbitrary larger counts (multi-track OBS recordings)', () => {
    expect(pickAudioTrackLabel(5)).toEqual({ kind: 'count', count: 5 })
  })

  it('treats negative counts as no-audio (defensive — probe should never emit these)', () => {
    // Not a real production input, but the function's guard says `<= 0`
    // so a negative slip-through still produces a sane render rather
    // than "音声-1トラック".
    expect(pickAudioTrackLabel(-1)).toEqual({ kind: 'no-audio' })
  })

  it('distinguishes null (no file) from 0 (file with no audio) — these MUST render differently', () => {
    // The whole point of the function is to surface this distinction
    // the v1.3.1 UI conflated: the user picking nothing yet vs. the
    // user picking a video that genuinely has no audio.  Encode it
    // here so a refactor that drops the null check is caught.
    const noFile = pickAudioTrackLabel(null)
    const noAudioInFile = pickAudioTrackLabel(0)
    expect(noFile.kind).toBe('hidden')
    expect(noAudioInFile.kind).toBe('no-audio')
    expect(noFile).not.toEqual(noAudioInFile)
  })
})
