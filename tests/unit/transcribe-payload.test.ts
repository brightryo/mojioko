import { describe, it, expect } from 'vitest'
import {
  applyTranscriptionTierGate,
  buildTranscribePayload,
} from '../../src/main/services/transcribe-payload'
import type { TranscriptionStartRequest } from '../../src/shared/ipc-contracts'
import type { TranscriptionAdvancedParams } from '../../src/shared/types'

/**
 * REQ-0207 — the "off-time byte-identical" contract for the sidecar
 * payload.  The whole design of the word-subtitle feature depends on
 * the sidecar seeing exactly the same JSON when the flag is off as
 * it did before REQ-0207 existed.
 *
 * These tests pin two things:
 *   1. When `wordSubtitle` is omitted / undefined / false, the produced
 *      payload has EXACTLY the pre-REQ-0207 keys and values.  A
 *      snapshot-style deep-equal on a fixed reference object catches
 *      any accidental key addition even if the feature branch grows
 *      other side effects here later.
 *   2. When `wordSubtitle === true`, the payload adds a single boolean
 *      key with that name.
 *
 * If either invariant breaks, the packaged sidecar EXE (which will
 * predate REQ-0207 until its next rebuild) either receives an unknown
 * key or misses the flag — both are regressions we must catch before
 * shipping.
 */

const ADVANCED: TranscriptionAdvancedParams = {
  vadFilter: true,
  vadThreshold: 0.5,
  minSpeechDurationMs: 250,
  minSilenceDurationMs: 2000,
  beamSize: 5,
  language: 'auto',
}

function baseRequest(overrides: Partial<TranscriptionStartRequest> = {}): TranscriptionStartRequest {
  return {
    videoPath: 'C:\\Users\\test\\video.mp4',
    trackIndex: 1,
    modelId: 'large-v3-turbo',
    modelsDir: 'C:\\Users\\test\\AppData\\Roaming\\MOJIOKO\\models',
    ffmpegPath: 'C:\\Program Files\\ffmpeg\\ffmpeg.exe',
    defaults: {
      fontSizePx: 100,
      textColorHex: '#FFFFFF',
      outlineColorHex: '#000000',
      outlineThicknessPx: 3,
      fadeDurationSec: 0,
    },
    advanced: ADVANCED,
    ...overrides,
  }
}

/**
 * The reference off-time payload: hand-written from the pre-REQ-0207
 * source of `transcribe()` so the test blocks any future edit that
 * accidentally re-orders or renames keys.  Use `.toEqual` for content
 * equality; iteration order in JSON.stringify is stable for string keys
 * in insertion order (ECMAScript) so the sidecar-side JSON is
 * byte-identical when `wordSubtitle` is absent.
 */
const OFF_TIME_REFERENCE = {
  cmd: 'transcribe',
  videoPath: 'C:\\Users\\test\\video.mp4',
  trackIndex: 1,
  model: 'large-v3-turbo',
  modelsDir: 'C:\\Users\\test\\AppData\\Roaming\\MOJIOKO\\models',
  ffmpegPath: 'C:\\Program Files\\ffmpeg\\ffmpeg.exe',
  vadFilter: true,
  vadThreshold: 0.5,
  minSpeechDurationMs: 250,
  minSilenceDurationMs: 2000,
  beamSize: 5,
  language: 'auto',
}

describe('REQ-0207 buildTranscribePayload — off-time byte-identical contract', () => {
  it('omits wordSubtitle when the request has no wordSubtitle field', () => {
    const request = baseRequest()
    const payload = buildTranscribePayload(request, request.videoPath)
    expect(payload).toEqual(OFF_TIME_REFERENCE)
    expect('wordSubtitle' in payload).toBe(false)
  })

  it('omits wordSubtitle when the request explicitly sets it to false', () => {
    const request = baseRequest({ wordSubtitle: false })
    const payload = buildTranscribePayload(request, request.videoPath)
    expect(payload).toEqual(OFF_TIME_REFERENCE)
    expect('wordSubtitle' in payload).toBe(false)
  })

  it('omits wordSubtitle when the request explicitly sets it to undefined', () => {
    // TypeScript type is optional; runtime callers may pass undefined
    // through spread ops.  The payload builder must not leak "undefined"
    // as a key either.
    const request = baseRequest({ wordSubtitle: undefined })
    const payload = buildTranscribePayload(request, request.videoPath)
    expect(payload).toEqual(OFF_TIME_REFERENCE)
    expect('wordSubtitle' in payload).toBe(false)
  })

  it('produces a stable stringify output for the off path (JSON parity guard)', () => {
    // Insertion order is preserved by JSON.stringify for string keys, so
    // pinning the exact serialized bytes gives us a hard guarantee that
    // the sidecar reads the identical byte stream on stdin.  Regenerate
    // the reference only when the pre-REQ-0207 payload legitimately
    // changes; do NOT regenerate to accommodate a wordSubtitle addition.
    const request = baseRequest()
    const payload = buildTranscribePayload(request, request.videoPath)
    const serialised = JSON.stringify(payload)
    const expected = JSON.stringify(OFF_TIME_REFERENCE)
    expect(serialised).toBe(expected)
  })
})

describe('REQ-0207 buildTranscribePayload — on path adds the flag', () => {
  it('inserts wordSubtitle: true when the request opts in', () => {
    const request = baseRequest({ wordSubtitle: true })
    const payload = buildTranscribePayload(request, request.videoPath)
    expect(payload.wordSubtitle).toBe(true)
    // All other keys still match the reference (the on-path is a strict
    // superset of the off-path — no reordering, no renaming).
    for (const [k, v] of Object.entries(OFF_TIME_REFERENCE)) {
      expect(payload[k]).toEqual(v)
    }
  })

  it('normalizes videoPath through the caller — build function trusts input', () => {
    // The builder does NOT re-run normalization; the caller has already
    // done that via `normalizeVideoPath`.  Pin that the payload uses the
    // videoPath argument (post-normalization) rather than the untouched
    // request.videoPath.
    const request = baseRequest({ videoPath: 'raw\\input.mp4' })
    const payload = buildTranscribePayload(request, 'C:\\normalized\\input.mp4')
    expect(payload.videoPath).toBe('C:\\normalized\\input.mp4')
  })
})

/**
 * REQ-0210 — main-side tier gate that runs upstream of
 * `buildTranscribePayload` to force `wordSubtitle` off in NSIS (free-
 * tier) builds.  These tests pin two things:
 *
 *   1. NSIS builds NEVER emit `wordSubtitle: true` regardless of what
 *      the renderer passed (defence against DevTools tampering with
 *      the outgoing IPC payload).
 *   2. MSIX builds pass the request through unchanged, so REQ-0207's
 *      on-path behavior is preserved.
 *
 * The gate is applied *before* `buildTranscribePayload`, so the byte-
 * identical off-path guarantee above is unaffected — the builder still
 * sees the same input shape it always did.
 */
describe('REQ-0210 applyTranscriptionTierGate — NSIS strips wordSubtitle', () => {
  it('strips wordSubtitle:true when isMsix=false (renderer opted in)', () => {
    const request = baseRequest({ wordSubtitle: true })
    const gated = applyTranscriptionTierGate(request, false)
    expect(gated.wordSubtitle).toBe(false)
  })

  it('leaves wordSubtitle:false alone when isMsix=false', () => {
    const request = baseRequest({ wordSubtitle: false })
    const gated = applyTranscriptionTierGate(request, false)
    expect(gated.wordSubtitle).toBe(false)
  })

  it('normalizes wordSubtitle:undefined to false when isMsix=false', () => {
    // The gate's contract is "wordSubtitle is deterministically off on
    // NSIS" — we do not distinguish undefined from false there, since
    // `buildTranscribePayload` treats both the same way (omitted).  The
    // downstream byte-identical guarantee still holds because the
    // builder gates on `=== true`, not on presence.
    const request = baseRequest()
    const gated = applyTranscriptionTierGate(request, false)
    expect(gated.wordSubtitle).toBe(false)
  })

  it('preserves all non-wordSubtitle fields on NSIS builds', () => {
    const request = baseRequest({ wordSubtitle: true })
    const gated = applyTranscriptionTierGate(request, false)
    // Every field except wordSubtitle should be byte-identical to input.
    const stripWordSubtitle = (r: TranscriptionStartRequest): Omit<TranscriptionStartRequest, 'wordSubtitle'> => {
      const clone = { ...r }
      delete clone.wordSubtitle
      return clone
    }
    expect(stripWordSubtitle(gated)).toEqual(stripWordSubtitle(request))
  })

  it('end-to-end: NSIS payload never contains wordSubtitle:true', () => {
    // Full pipeline check — gate + builder in sequence, mimicking the
    // main-side IPC handler.  Whatever the renderer sends, the sidecar
    // sees `wordSubtitle` absent (byte-identical to pre-REQ-0207).
    for (const flag of [true, false, undefined] as const) {
      const request = baseRequest({ wordSubtitle: flag })
      const gated = applyTranscriptionTierGate(request, false)
      const payload = buildTranscribePayload(gated, gated.videoPath)
      expect('wordSubtitle' in payload).toBe(false)
      expect(payload).toEqual(OFF_TIME_REFERENCE)
    }
  })
})

describe('REQ-0210 applyTranscriptionTierGate — MSIX passthrough', () => {
  it('leaves wordSubtitle:true intact when isMsix=true', () => {
    const request = baseRequest({ wordSubtitle: true })
    const gated = applyTranscriptionTierGate(request, true)
    expect(gated.wordSubtitle).toBe(true)
  })

  it('leaves wordSubtitle:false intact when isMsix=true', () => {
    const request = baseRequest({ wordSubtitle: false })
    const gated = applyTranscriptionTierGate(request, true)
    expect(gated.wordSubtitle).toBe(false)
  })

  it('leaves wordSubtitle:undefined intact when isMsix=true', () => {
    const request = baseRequest()
    const gated = applyTranscriptionTierGate(request, true)
    expect(gated.wordSubtitle).toBeUndefined()
  })

  it('returns the same reference when isMsix=true (no shallow-clone cost)', () => {
    // Micro-behavior guarantee: the MSIX passthrough must be a true
    // identity so main-side callers can rely on structural equality if
    // they need it.  If this ever changes to a spread, the assertion
    // catches it and forces a review.
    const request = baseRequest({ wordSubtitle: true })
    const gated = applyTranscriptionTierGate(request, true)
    expect(gated).toBe(request)
  })

  it('end-to-end: MSIX payload preserves REQ-0207 on-path shape', () => {
    const request = baseRequest({ wordSubtitle: true })
    const gated = applyTranscriptionTierGate(request, true)
    const payload = buildTranscribePayload(gated, gated.videoPath)
    expect(payload.wordSubtitle).toBe(true)
    for (const [k, v] of Object.entries(OFF_TIME_REFERENCE)) {
      expect(payload[k]).toEqual(v)
    }
  })
})
