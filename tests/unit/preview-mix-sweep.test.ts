import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * REQ-0231 — sweepPreviewMixDir behaviour tests.
 *
 * The sweep is the mechanism that keeps the preview-mix directory
 * from growing without bound while REQ-0231's per-run unique
 * filename design solves the EPERM at rename.  Its contract:
 *
 *  1. Best-effort: a file whose `rmSync` throws (typically Windows
 *     EPERM from a still-playing `<audio>` handle) is logged and
 *     skipped — the sweep MUST NOT throw or hang the caller.
 *  2. Only files matching `isPreviewMixFilename` are touched — unrelated
 *     files a user may have dropped in the directory are left alone.
 *  3. Both REQ-086 legacy fixed names AND REQ-0231 unique names are
 *     eligible for sweep, so a post-upgrade install cleans up its
 *     leftover `preview-mix.m4a`.
 *  4. Return value carries removed / skipped counts for logging.
 *
 * The "new file is not swept away by itself" guarantee is provided
 * by ordering in `generatePreviewMix` (sweep BEFORE choosing the new
 * filename) — see the ordering comment in `preview-mix.ts`.  Here we
 * test the sweep in isolation.
 */

// A per-test-file scratch dir that both the mock `getPreviewMixDir()`
// and the test setup write to.  Declared here (not `beforeEach`) so
// the vi.mock factory below can reference it via closure.  Assigned
// in beforeEach so each test gets a clean subdirectory.
let scratchDir = ''
// Set of paths for which the mocked rmSync should throw EPERM.
const lockedPaths = new Set<string>()

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir(),
  },
}))

vi.mock('../../src/main/lib/paths', async (importOriginal) => {
  // Preserve `isPreviewMixFilename` from the real module so the
  // classifier stays in lock-step with the production path; only
  // override `getPreviewMixDir` to point at our per-test scratch.
  const real = await importOriginal<typeof import('../../src/main/lib/paths')>()
  return {
    ...real,
    getPreviewMixDir: () => scratchDir,
  }
})

vi.mock('../../src/main/lib/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

// REQ-0231 §best-effort test — cannot use `vi.spyOn(fs, 'rmSync')`
// under vitest's ESM interop (fs's exports are non-configurable, and
// preview-mix.ts's `import { rmSync }` is a static binding captured
// at import time).  Instead, mock `fs` at hoist time and provide a
// controllable rmSync that throws for anything in `lockedPaths` and
// delegates to `unlinkSync` (the real one from importActual) for
// everything else.  All other fs functions come through unchanged.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return {
    ...real,
    rmSync: (p: string, opts?: import('fs').RmOptions) => {
      if (lockedPaths.has(String(p))) {
        const err = new Error(`EPERM: operation not permitted, unlink '${p}'`)
        ;(err as NodeJS.ErrnoException).code = 'EPERM'
        throw err
      }
      return real.rmSync(p, opts)
    },
  }
})

// Import AFTER mocks so the sweep's `getPreviewMixDir()` resolves to
// our scratch dir and rmSync goes through the lock-aware mock.
import { sweepPreviewMixDir, cleanupStalePreviewMixTmp } from '../../src/main/services/preview-mix'

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'mojioko-preview-mix-sweep-'))
  lockedPaths.clear()
})

afterEach(() => {
  lockedPaths.clear()
  if (scratchDir && existsSync(scratchDir)) {
    // Use unlinkSync + rmdirSync manually to avoid going through the
    // mocked rmSync (in case a test left entries in lockedPaths).
    for (const name of readdirSync(scratchDir)) {
      try { unlinkSync(join(scratchDir, name)) } catch { /* ignore */ }
    }
    try { rmSync(scratchDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function touchFile(name: string): string {
  const path = join(scratchDir, name)
  writeFileSync(path, 'x')
  return path
}

// ---------------------------------------------------------------------------
// Contract 1: best-effort — EPERM on one file does not stop the sweep
// ---------------------------------------------------------------------------

describe('REQ-0231 sweepPreviewMixDir: best-effort on lock', () => {
  it('skips a file whose rmSync throws EPERM, but continues with the others', () => {
    const locked = touchFile('preview-mix-20260715-091033-123-abcd.m4a')
    touchFile('preview-mix-20260715-091034-000-wxyz.m4a')
    touchFile('preview-mix.m4a') // legacy leftover

    lockedPaths.add(locked)

    const result = sweepPreviewMixDir()

    // Two removed (the two non-locked files), one skipped (locked).
    expect(result).toEqual({ removed: 2, skipped: 1 })
    // The locked file still exists.
    expect(existsSync(locked)).toBe(true)
    // Only the locked file remains.
    expect(readdirSync(scratchDir).sort()).toEqual([
      'preview-mix-20260715-091033-123-abcd.m4a',
    ])
  })

  it('returns zero counts and does not throw when the directory does not exist', () => {
    rmSync(scratchDir, { recursive: true, force: true })
    const result = sweepPreviewMixDir()
    expect(result).toEqual({ removed: 0, skipped: 0 })
  })
})

// ---------------------------------------------------------------------------
// Contract 2: only touches our own files
// ---------------------------------------------------------------------------

describe('REQ-0231 sweepPreviewMixDir: touches only preview-mix files', () => {
  it('leaves unrelated files alone (user drops in the dir)', () => {
    touchFile('preview-mix-20260715-091033-123-abcd.m4a')
    touchFile('preview-mix.m4a')
    touchFile('README.txt')
    touchFile('my-video.mp4')
    touchFile('.DS_Store')

    const result = sweepPreviewMixDir()

    expect(result).toEqual({ removed: 2, skipped: 0 })
    expect(readdirSync(scratchDir).sort()).toEqual([
      '.DS_Store',
      'README.txt',
      'my-video.mp4',
    ])
  })

  it('leaves subdirectories alone (only files matching the name pattern are considered)', () => {
    touchFile('preview-mix-20260715-091033-123-abcd.m4a')
    mkdirSync(join(scratchDir, 'some-subdir'))
    writeFileSync(join(scratchDir, 'some-subdir', 'file.txt'), 'x')

    const result = sweepPreviewMixDir()

    expect(result.removed).toBe(1)
    expect(existsSync(join(scratchDir, 'some-subdir'))).toBe(true)
    expect(existsSync(join(scratchDir, 'some-subdir', 'file.txt'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Contract 3: both legacy and REQ-0231 names are eligible
// ---------------------------------------------------------------------------

describe('REQ-0231 sweepPreviewMixDir: legacy + new naming both eligible', () => {
  it('sweeps legacy fixed-name files (post-upgrade cleanup)', () => {
    touchFile('preview-mix.m4a')
    touchFile('preview-mix.m4a.tmp')

    const result = sweepPreviewMixDir()

    expect(result).toEqual({ removed: 2, skipped: 0 })
    expect(readdirSync(scratchDir)).toEqual([])
  })

  it('sweeps REQ-0231 unique-name .tmp files (orphan from crashed prior run)', () => {
    touchFile('preview-mix-20260715-091033-123-abcd.m4a')
    touchFile('preview-mix-20260715-091034-500-wxyz.m4a.tmp')

    const result = sweepPreviewMixDir()
    expect(result).toEqual({ removed: 2, skipped: 0 })
  })
})

// ---------------------------------------------------------------------------
// Contract 4: boot-time cleanupStalePreviewMixTmp is now equivalent to sweep
// ---------------------------------------------------------------------------

describe('REQ-0231 cleanupStalePreviewMixTmp: boot-time sweep', () => {
  it('removes both .m4a and .tmp remnants at boot (best-effort)', () => {
    touchFile('preview-mix-20260715-091033-123-abcd.m4a')
    touchFile('preview-mix-20260715-091034-500-wxyz.m4a.tmp')
    touchFile('preview-mix.m4a')
    touchFile('README.txt') // unrelated, should survive

    cleanupStalePreviewMixTmp()

    expect(readdirSync(scratchDir)).toEqual(['README.txt'])
  })

  it('does not throw when the directory does not exist', () => {
    rmSync(scratchDir, { recursive: true, force: true })
    expect(() => cleanupStalePreviewMixTmp()).not.toThrow()
  })
})
