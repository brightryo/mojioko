import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pickTranscriptionTrack } from '../../src/shared/track-pick'

/**
 * REQ-0517 §1 — the CLI rounds the audio track against the input file, using
 * the GUI's ladder rather than a second copy of it.
 *
 * ## The defect
 *
 * `transcribe.ts` read `settings.defaultAudioTrackIndex` and passed it
 * straight through, never comparing it with the file.  A user who had set
 * their default to Track 2 in Settings — a supported choice — then failed on
 * every single-track video with `Failed to set value '0:a:1' for option
 * 'map'`, an ffmpeg message that never says "track".  The GUI had been
 * rounding since REQ-0121; only the headless paths had not.
 *
 * ## What is pinned here
 *
 * The ladder's own behaviour is `step1-track-pick.test.ts` (unchanged by the
 * move to `shared/`).  This file pins the two things REQ-0517 added: that the
 * CLI goes THROUGH that ladder instead of re-deriving one, and that an
 * explicit `--track` is refused rather than quietly redirected.
 *
 * Real behaviour was verified end to end against the built CLI with real
 * one-track and two-track clips — see RES-0517 §1-5 for the five cases and
 * their outputs.  These are the fast structural pins beneath that.
 */

const TRANSCRIBE = path.join(process.cwd(), 'src/main/cli/commands/transcribe.ts')
const src = (): string => readFileSync(TRANSCRIBE, 'utf8')
/**
 * The file with comments removed.
 *
 * Every assertion below is about what the code DOES, and the docblock on the
 * fix quotes the pre-REQ-0517 line verbatim (`parseInt(… defaultAudioTrackIndex
 * …)`) and names `probeVideo` while explaining the ffprobe count.  Scanning the
 * raw text therefore matched the prose describing the defect and reported the
 * defect as present — the comments have to go before the code is read.
 */
const code = (): string =>
  src()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('REQ-0517 §1-1 — one ladder, not two', () => {
  it('★ the CLI calls the shared pickTranscriptionTrack', () => {
    expect(code()).toMatch(/pickTranscriptionTrack\s*\(/)
    expect(code()).toContain('shared/track-pick')
  })

  it('★ it does not re-derive the fallback from the setting alone', () => {
    // The pre-REQ-0517 line was:
    //   parseInt(optString(opts,'track') || String(settings.defaultAudioTrackIndex ?? 1), 10)
    // — the setting used as the answer, with no reference to the file.  Any
    // reading of `defaultAudioTrackIndex` must now be feeding the ladder.
    const text = code()
    expect(/defaultAudioTrackIndex/.test(text)).toBe(true)
    // The setting must not be parsed straight into the value handed downstream.
    expect(text).not.toMatch(/parseInt\([^)]*defaultAudioTrackIndex/)
  })

  it('reads the track count from the probe it already ran — no second ffprobe', () => {
    // `probeVideo` is called once, above the track resolution; the ladder is
    // fed from its result.  A second `probeVideo(` would mean an extra ffprobe
    // per transcribe.
    const calls = code().match(/probeVideo\s*\(/g) ?? []
    expect(calls.length).toBe(1)
    expect(code()).toMatch(/pickTranscriptionTrack\(\s*video\.audioTracks/)
  })
})

describe('REQ-0517 §1-3 — an explicit --track is refused, never redirected', () => {
  it('★ a missing explicit track raises USAGE', () => {
    const text = code()
    // The refusal must sit in the explicit branch and name USAGE.
    expect(text).toMatch(/--track \$\{asked\} はこのファイルに存在しません/)
    const idx = text.indexOf('はこのファイルに存在しません')
    const before = text.slice(Math.max(0, idx - 400), idx)
    expect(before).toContain("'USAGE'")
  })

  it('the refusal tells the caller which tracks the file does have', () => {
    expect(code()).toMatch(/音声トラック: \$\{have\}/)
  })
})

describe('REQ-0517 §1-4 — rounding is never silent', () => {
  it('★ a fallback emits AUDIO_TRACK_FALLBACK and it reaches the result', () => {
    const text = code()
    expect(text).toContain('AUDIO_TRACK_FALLBACK')
    // Pushed only under `fallbackUsed`, and merged into the emitted warnings.
    expect(text).toMatch(/picked\.fallbackUsed/)
    expect(text).toMatch(/const warnings: CliWarning\[\] = \[\.\.\.trackFallback\]/)
  })

  it('the message carries both the preferred and the used track', () => {
    expect(src()).toMatch(/preferred,\s*\n\s*used: track,/)
  })
})

describe('REQ-0517 — the ladder itself still behaves (moved, not rewritten)', () => {
  const tracks = (...idx: number[]) => idx.map((index) => ({ index }))

  it('uses the preferred track when the file has it', () => {
    expect(pickTranscriptionTrack(tracks(1, 2), 2)).toEqual({ trackIndex: 2, fallbackUsed: false })
  })

  it('★ falls back to Track 1 when it does not — the owner\'s case', () => {
    expect(pickTranscriptionTrack(tracks(1), 2)).toEqual({ trackIndex: 1, fallbackUsed: true })
  })

  it('returns null when there is no audio at all, so the caller can say so', () => {
    expect(pickTranscriptionTrack([], 2)).toEqual({ trackIndex: null, fallbackUsed: false })
  })

  it('falls back to index 1 specifically, not "the first track"', () => {
    // A file whose only audio stream is index 2 has no Track 1 to fall back to.
    expect(pickTranscriptionTrack(tracks(2, 3), 5)).toEqual({ trackIndex: null, fallbackUsed: false })
  })
})
