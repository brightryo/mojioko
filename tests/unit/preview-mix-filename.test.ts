import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'os'

// `paths.ts` imports `electron` for `app.isPackaged`.  Under vitest
// there is no Electron runtime, so stub the app object with the
// values REQ-0231's helpers actually read (none, in fact — but the
// module top-level references app.isPackaged at import time).
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir(),
  },
}))

import {
  generatePreviewMixFilename,
  isPreviewMixFilename,
} from '../../src/main/lib/paths'

/**
 * REQ-0231 — pure tests for the preview-mix filename helpers.
 *
 * `generatePreviewMixFilename` is on the load-bearing path of every
 * multi-track transcription and its output is what the custom
 * protocol validates against.  `isPreviewMixFilename` is the sole
 * gate between an untrusted URL segment and `fs.existsSync` on the
 * preview-mix directory, so its behaviour matters for security
 * (path traversal) as well as correctness (sweep only touches our
 * own files).
 */

describe('REQ-0231 generatePreviewMixFilename', () => {
  it('produces the documented shape (preview-mix-YYYYMMDD-HHMMSS-mmm-<rand>.m4a)', () => {
    // Fixed instant: 2026-07-15 09:10:33.123
    const fixed = new Date(2026, 6, 15, 9, 10, 33, 123)
    const name = generatePreviewMixFilename(fixed)
    expect(name).toMatch(
      /^preview-mix-20260715-091033-123-[a-z0-9]{4}\.m4a$/,
    )
  })

  it('zero-pads all timestamp components', () => {
    const fixed = new Date(2026, 0, 1, 0, 0, 0, 0) // 2026-01-01 00:00:00.000
    const name = generatePreviewMixFilename(fixed)
    expect(name).toMatch(
      /^preview-mix-20260101-000000-000-[a-z0-9]{4}\.m4a$/,
    )
  })

  it('produces distinct filenames on consecutive calls (random suffix)', () => {
    const fixed = new Date(2026, 6, 15, 9, 10, 33, 123)
    const names = new Set<string>()
    for (let i = 0; i < 100; i++) names.add(generatePreviewMixFilename(fixed))
    // With 4 base36 chars (~1.7M possibilities), 100 calls should
    // essentially never collide.  Allow a tiny slack for the
    // (astronomically improbable) case where Math.random dupes.
    expect(names.size).toBeGreaterThanOrEqual(99)
  })

  it('output always passes isPreviewMixFilename', () => {
    for (let i = 0; i < 20; i++) {
      const name = generatePreviewMixFilename()
      expect(isPreviewMixFilename(name), `mismatch: ${name}`).toBe(true)
    }
  })
})

describe('REQ-0231 isPreviewMixFilename', () => {
  // ---- Accepts ----

  it('accepts REQ-086 legacy fixed name (finished)', () => {
    expect(isPreviewMixFilename('preview-mix.m4a')).toBe(true)
  })

  it('accepts REQ-086 legacy fixed name (.tmp)', () => {
    expect(isPreviewMixFilename('preview-mix.m4a.tmp')).toBe(true)
  })

  it('accepts REQ-0231 unique name (finished)', () => {
    expect(isPreviewMixFilename('preview-mix-20260715-091033-123-abcd.m4a')).toBe(true)
  })

  it('accepts REQ-0231 unique name (.tmp)', () => {
    expect(isPreviewMixFilename('preview-mix-20260715-091033-123-abcd.m4a.tmp')).toBe(true)
  })

  // ---- Rejects: path traversal ----

  it('rejects names containing forward slash', () => {
    expect(isPreviewMixFilename('preview-mix.m4a/foo')).toBe(false)
    expect(isPreviewMixFilename('../preview-mix.m4a')).toBe(false)
    expect(isPreviewMixFilename('/preview-mix.m4a')).toBe(false)
  })

  it('rejects names containing backslash', () => {
    expect(isPreviewMixFilename('preview-mix.m4a\\foo')).toBe(false)
    expect(isPreviewMixFilename('..\\preview-mix.m4a')).toBe(false)
    expect(isPreviewMixFilename('C:\\preview-mix.m4a')).toBe(false)
  })

  // ---- Rejects: wrong shapes ----

  it('rejects wrong extensions', () => {
    expect(isPreviewMixFilename('preview-mix.mp3')).toBe(false)
    expect(isPreviewMixFilename('preview-mix-20260715-091033-123-abcd.mp3')).toBe(false)
    expect(isPreviewMixFilename('preview-mix.m4b')).toBe(false)
  })

  it('rejects missing prefix', () => {
    expect(isPreviewMixFilename('20260715-091033-123-abcd.m4a')).toBe(false)
    expect(isPreviewMixFilename('preview-20260715-091033-123-abcd.m4a')).toBe(false)
    expect(isPreviewMixFilename('mix-20260715-091033-123-abcd.m4a')).toBe(false)
  })

  it('rejects malformed timestamp', () => {
    // Only 7 digits in date part.
    expect(isPreviewMixFilename('preview-mix-2026071-091033-123-abcd.m4a')).toBe(false)
    // Only 5 digits in time part.
    expect(isPreviewMixFilename('preview-mix-20260715-09103-123-abcd.m4a')).toBe(false)
    // Only 2 digits in ms part.
    expect(isPreviewMixFilename('preview-mix-20260715-091033-12-abcd.m4a')).toBe(false)
    // Uppercase in random suffix (regex uses [a-z0-9]).
    expect(isPreviewMixFilename('preview-mix-20260715-091033-123-ABCD.m4a')).toBe(false)
    // Non-base36 char.
    expect(isPreviewMixFilename('preview-mix-20260715-091033-123-!@#$.m4a')).toBe(false)
  })

  it('rejects unrelated files a user might drop in the directory', () => {
    expect(isPreviewMixFilename('.DS_Store')).toBe(false)
    expect(isPreviewMixFilename('Thumbs.db')).toBe(false)
    expect(isPreviewMixFilename('desktop.ini')).toBe(false)
    expect(isPreviewMixFilename('my-video.mp4')).toBe(false)
    expect(isPreviewMixFilename('')).toBe(false)
  })
})
