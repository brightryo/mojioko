import { describe, it, expect } from 'vitest'
import { isAbsolute } from 'path'
import { normalizeVideoPath } from '../../src/main/services/normalize-video-path'

/**
 * REQ-0103 — a Microsoft Store certification tester saw
 * ``Audio extraction failed: ffmpeg audio extraction failed: ... Error
 * opening input: No such file or directory`` for input files whose names
 * contained shell metacharacters (``|``), the middle dot (``·``), emoji, and
 * non-ASCII / CJK characters — file names typical of SNS clip downloads
 * ("417K views · 5K reactions | ... 🥺 😭 …").
 *
 * The owner's environment (Japanese Windows) processed the same class of file
 * names successfully, so this is not "any non-ASCII path always breaks"; it is
 * a condition-dependent bug.  The direct fix (Python sidecar reconfiguring
 * stdin to UTF-8, argv arrays with `shell: false`, absolute-path
 * normalization) lives across three files; this test pins the pure normalizer.
 *
 * Coverage targets:
 *
 *  - Empty / falsy input → clear error, not a crash.
 *  - Absolute path with pipe / middle-dot / emoji / CJK / spaces / drive
 *    letter — the exact tester-reported string classes — passes through
 *    verbatim (no escaping, no mangling).
 *  - Relative path → resolved to an absolute path via the injected resolver.
 *  - Non-existent path → returns a clear error the caller can surface without
 *    invoking ffmpeg.
 *  - Multiple different tester-style file names all pass through when they
 *    exist on the (mocked) filesystem — proves the normalizer does not eat
 *    per-character variants (the reported failure varies across sessions).
 */

describe('normalizeVideoPath', () => {
  it('rejects an empty input path', () => {
    const result = normalizeVideoPath('')
    expect(result).toEqual({ ok: false, error: 'empty input path' })
  })

  it('returns error when the file does not exist', () => {
    const p = 'D:\\test files\\does-not-exist.mp4'
    const result = normalizeVideoPath(p, { existsFn: () => false })
    expect(result).toEqual({
      ok: false,
      error: `Input file does not exist at ${p}`,
    })
  })

  it('passes through an absolute Windows path containing pipe / middle-dot / emoji verbatim', () => {
    // Verbatim from the tester's second error image.  Contains: pipe `|`,
    // middle-dot `·`, emojis (🥺 😭), CJK-adjacent latin (Icala Aliboli),
    // spaces, and drive-letter `D:` — the exact combination that reproduces
    // the field failure.
    const testerPath =
      'D:\\test files\\417K views · 5K reactions | Lale ngokuthula skeem 🥺 😭 Icala Aliboli.mp4'
    const result = normalizeVideoPath(testerPath, { existsFn: () => true })
    expect(result).toEqual({ ok: true, path: testerPath })
  })

  it('passes through the first tester file (spaces + emoji + parens) verbatim', () => {
    const testerPath =
      'D:\\test files\\Best Funny Videos Of 2026 🙂, Try Not To Laugh CHALLENGE (Impossible).mp4'
    const result = normalizeVideoPath(testerPath, { existsFn: () => true })
    expect(result).toEqual({ ok: true, path: testerPath })
  })

  it('handles an audio input (.wav) with the same tester-class filename', () => {
    // Tester's first error message referred to a `.wav`; we run every input
    // (video or audio) through the same extract path, so the normalizer must
    // treat the two identically.
    const wavPath =
      'D:\\test files\\Best Funny Videos Of 2026 🙂, Try Not To Laugh CHALLENGE (Impossible).wav'
    const result = normalizeVideoPath(wavPath, { existsFn: () => true })
    expect(result).toEqual({ ok: true, path: wavPath })
  })

  it('accepts CJK / Japanese full-width symbols and non-Windows drive letters', () => {
    const jaPath = 'C:\\Users\\brightryo\\動画\\切り抜き — 全角括弧【テスト】＆記号.mp4'
    const result = normalizeVideoPath(jaPath, { existsFn: () => true })
    expect(result).toEqual({ ok: true, path: jaPath })
  })

  it('resolves a relative path against the injected resolver', () => {
    const rawRelative = 'videos\\clip.mp4'
    const resolved = 'D:\\dev\\mojioko\\videos\\clip.mp4'
    const result = normalizeVideoPath(rawRelative, {
      existsFn: () => true,
      resolveFn: (p) => (p === rawRelative ? resolved : p),
    })
    expect(result).toEqual({ ok: true, path: resolved })
  })

  it('does not invoke the resolver for an already-absolute path', () => {
    // `path.resolve('D:\\x')` is a no-op on Windows but a costly one on Posix
    // hosts running these tests (the test suite runs on CI Linux too); more
    // importantly, if the caller ever swaps in a custom resolver, absolute
    // inputs must be passed through untouched.
    const absolutePath = isAbsolute('D:\\already\\absolute.mp4')
      ? 'D:\\already\\absolute.mp4'
      : '/already/absolute.mp4'
    let resolverCalls = 0
    const result = normalizeVideoPath(absolutePath, {
      existsFn: () => true,
      resolveFn: (p) => {
        resolverCalls++
        return p
      },
    })
    expect(result).toEqual({ ok: true, path: absolutePath })
    expect(resolverCalls).toBe(0)
  })

  it('handles a batch of tester-class filenames without eating any character', () => {
    // Guards against a future "sanitize filename" temptation.  Every distinct
    // problem character class must round-trip unchanged: only path resolution
    // and existence checking are the normalizer's job.
    const cases = [
      'D:\\a b c\\file with spaces.mp4',
      'D:\\pipe\\a | b.mp4',
      'D:\\dots\\a · b.mp4',
      'D:\\amp\\a & b.mp4',
      'D:\\gt\\a > b.mp4',
      'D:\\emoji\\🙂 🥺 😭.mp4',
      'D:\\mixed\\417K views · 5K reactions | 🥺.mp4',
      'D:\\jp\\日本語ファイル.mp4',
      'D:\\zh\\中文文件.mp4',
      'D:\\ko\\한국어파일.mp4',
      'D:\\wav\\audio ｜ · 🙂.wav',
    ]
    for (const p of cases) {
      const result = normalizeVideoPath(p, { existsFn: () => true })
      expect(result).toEqual({ ok: true, path: p })
    }
  })
})
