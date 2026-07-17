import { describe, it, expect } from 'vitest'
import {
  DownloadBusyError,
  tryParseBusyError,
} from '../../src/renderer/services/download-busy-error'

/**
 * REQ-0241 — the busy-error parser lifts the DownloadManager's
 * `DOWNLOAD_BUSY` ErrResult into a typed exception the components can
 * dispatch on.  The tests pin (a) the parse of the well-formed message
 * the main handlers produce, (b) the graceful fallback when the shape
 * drifts, and (c) the null pass-through for unrelated errors so
 * callers can chain to their existing generic Error path.
 */
describe('REQ-0241 tryParseBusyError', () => {
  it('returns null for unrelated codes so callers chain to generic errors', () => {
    expect(tryParseBusyError({ code: 'INVALID_MODEL_ID', message: 'bad id' })).toBeNull()
    expect(tryParseBusyError({ code: 'NETWORK', message: 'undici terminated' })).toBeNull()
  })

  it('returns null for undefined input (defensive against missing error blocks)', () => {
    expect(tryParseBusyError(undefined)).toBeNull()
  })

  it('parses the well-formed main-side message (model)', () => {
    const err = tryParseBusyError({
      code: 'DOWNLOAD_BUSY',
      message: 'Another download is in progress: model (large-v3)',
    })
    expect(err).toBeInstanceOf(DownloadBusyError)
    expect(err?.activeKind).toBe('model')
    expect(err?.activeLabel).toBe('large-v3')
    expect(err?.name).toBe('DownloadBusyError')
  })

  it('parses the well-formed main-side message (gpu-tool with hyphen in kind)', () => {
    const err = tryParseBusyError({
      code: 'DOWNLOAD_BUSY',
      message: 'Another download is in progress: gpu-tool (cuda-v1)',
    })
    expect(err?.activeKind).toBe('gpu-tool')
    expect(err?.activeLabel).toBe('cuda-v1')
  })

  it('parses the well-formed main-side message (font)', () => {
    const err = tryParseBusyError({
      code: 'DOWNLOAD_BUSY',
      message: 'Another download is in progress: font (Delius)',
    })
    expect(err?.activeKind).toBe('font')
    expect(err?.activeLabel).toBe('Delius')
  })

  it('falls back to "unknown" when the message shape drifts', () => {
    const err = tryParseBusyError({
      code: 'DOWNLOAD_BUSY',
      message: 'something else entirely',
    })
    expect(err).toBeInstanceOf(DownloadBusyError)
    expect(err?.activeKind).toBe('unknown')
    expect(err?.activeLabel).toBe('something else entirely')
  })
})
