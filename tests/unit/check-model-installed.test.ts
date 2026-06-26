import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  checkModelInstalled,
  isModelDirIncomplete,
  MODEL_FILES,
  MODEL_BIN_MIN_BYTES,
} from '../../src/main/services/check-model-installed'

/**
 * REQ-20260615-078 — strict "is this model fully downloaded" check.
 *
 * Replaces the v1.3.1 `existsSync(modelDir)` one-liner that returned
 * `installed: true` for empty directories and for directories holding
 * a partial multi-GB `model.bin` left behind by a force-killed
 * download.  Coverage targets every reject branch the docstring
 * promises, plus the boundary at the `model.bin` size floor.
 *
 * The tests use the `modelBinFloor` option to drive the size-check
 * branches with KB-scale files — writing a real 1.4 GB blob per case
 * would blow up disk usage on every CI run (NTFS does not sparse by
 * default).  A small dedicated set of cases below pins the production
 * defaults so the override does not mask drift in the floor map.
 */

const TURBO = 'large-v3-turbo'
const V3 = 'large-v3'
// Tiny synthetic floor used by the size-branch tests.  Far below any
// production value but lets us write KB-scale fake files.
const TEST_FLOOR = 1_000
const TEST_OPTIONS = { modelBinFloor: TEST_FLOOR }

/** Build a fake model directory with the given file sizes. */
function buildFakeModel(
  modelsDir: string,
  modelId: string,
  fileSizes: Partial<Record<string, number>>,
  options: { meta?: boolean } = {},
): string {
  const modelDir = join(modelsDir, modelId)
  mkdirSync(modelDir, { recursive: true })
  for (const filename of MODEL_FILES[modelId]) {
    const size = fileSizes[filename]
    if (size === undefined) continue // omitted → file deliberately missing
    writeFileSync(join(modelDir, filename), Buffer.alloc(size))
  }
  if (options.meta) {
    writeFileSync(
      join(modelDir, 'model.meta.json'),
      JSON.stringify({
        modelId,
        downloadedAt: '2026-06-27T00:00:00.000Z',
        fasterWhisperVersion: '1.2.1',
        formatGeneration: 1,
      }),
      'utf-8'
    )
  }
  return modelDir
}

describe('REQ-078 — checkModelInstalled (strict)', () => {
  let modelsDir: string

  beforeEach(() => {
    modelsDir = mkdtempSync(join(tmpdir(), 'mojioko-installed-test-'))
  })

  afterEach(() => {
    rmSync(modelsDir, { recursive: true, force: true })
  })

  it('(a) returns installed when every required file is present and model.bin clears the floor (with meta)', () => {
    buildFakeModel(modelsDir, TURBO, {
      'config.json': 1_024,
      'model.bin': TEST_FLOOR + 1,
      'preprocessor_config.json': 1_024,
      'tokenizer.json': 4_096,
      'vocabulary.json': 2_048,
    }, { meta: true })

    const result = checkModelInstalled(TURBO, modelsDir, TEST_OPTIONS)
    expect(result.installed).toBe(true)
    expect(result.sizeMB).toBeGreaterThanOrEqual(0)
  })

  it('(b) returns installed for a legacy model dir (no meta sidecar) — must NOT orphan pre-v1.3.0 downloads', () => {
    buildFakeModel(modelsDir, V3, {
      'config.json': 1_024,
      'model.bin': TEST_FLOOR + 1,
      'preprocessor_config.json': 1_024,
      'tokenizer.json': 4_096,
      'vocabulary.json': 2_048,
    }, { meta: false })

    const result = checkModelInstalled(V3, modelsDir, TEST_OPTIONS)
    expect(result.installed).toBe(true)
  })

  it('(c) returns NOT installed when model.bin is below the floor (the user-reported partial)', () => {
    buildFakeModel(modelsDir, TURBO, {
      'config.json': 1_024,
      'model.bin': TEST_FLOOR - 1, // just below the floor
      'preprocessor_config.json': 1_024,
      'tokenizer.json': 4_096,
      'vocabulary.json': 2_048,
    })

    const result = checkModelInstalled(TURBO, modelsDir, TEST_OPTIONS)
    expect(result.installed).toBe(false)
    // sizeMB still reports what's on disk so a future "X of Y MB" UI
    // hint has the data.
    expect(result.sizeMB).toBeGreaterThanOrEqual(0)
  })

  it('(c-edge) boundary check: floor-minus-1 rejects, exactly floor accepts', () => {
    // The floor is a `<` (strict) rejection, so an exact-floor
    // model.bin must be accepted.
    const baseFiles: Record<string, number> = {
      'config.json': 1_024,
      'preprocessor_config.json': 1_024,
      'tokenizer.json': 4_096,
      'vocabulary.json': 2_048,
    }

    buildFakeModel(modelsDir, TURBO, { ...baseFiles, 'model.bin': TEST_FLOOR - 1 })
    expect(checkModelInstalled(TURBO, modelsDir, TEST_OPTIONS).installed).toBe(false)

    rmSync(join(modelsDir, TURBO), { recursive: true, force: true })
    buildFakeModel(modelsDir, TURBO, { ...baseFiles, 'model.bin': TEST_FLOOR })
    expect(checkModelInstalled(TURBO, modelsDir, TEST_OPTIONS).installed).toBe(true)
  })

  it('(d) returns NOT installed when a required file is missing (e.g., tokenizer.json never started)', () => {
    buildFakeModel(modelsDir, TURBO, {
      'config.json': 1_024,
      'model.bin': TEST_FLOOR + 1,
      'preprocessor_config.json': 1_024,
      // tokenizer.json deliberately omitted
      'vocabulary.json': 2_048,
    })

    expect(checkModelInstalled(TURBO, modelsDir, TEST_OPTIONS).installed).toBe(false)
  })

  it('(e) returns NOT installed for an empty model directory (cancel-after-mkdir leftover)', () => {
    mkdirSync(join(modelsDir, TURBO), { recursive: true })
    const result = checkModelInstalled(TURBO, modelsDir, TEST_OPTIONS)
    expect(result.installed).toBe(false)
    expect(result.sizeMB).toBe(0)
  })

  it('(f) returns NOT installed when the model directory does not exist at all', () => {
    const result = checkModelInstalled(TURBO, modelsDir, TEST_OPTIONS)
    expect(result.installed).toBe(false)
    expect(result.sizeMB).toBe(0)
  })

  it('(g) returns NOT installed when a small required file is zero-byte (write opened, body never arrived)', () => {
    buildFakeModel(modelsDir, TURBO, {
      'config.json': 0, // started but never received bytes
      'model.bin': TEST_FLOOR + 1,
      'preprocessor_config.json': 1_024,
      'tokenizer.json': 4_096,
      'vocabulary.json': 2_048,
    })

    expect(checkModelInstalled(TURBO, modelsDir, TEST_OPTIONS).installed).toBe(false)
  })

  it('(h) returns installed when meta is present and files are valid — meta is positive corroboration, not a hard gate', () => {
    buildFakeModel(modelsDir, V3, {
      'config.json': 1_024,
      'model.bin': TEST_FLOOR + 1,
      'preprocessor_config.json': 1_024,
      'tokenizer.json': 4_096,
      'vocabulary.json': 2_048,
    }, { meta: true })
    expect(checkModelInstalled(V3, modelsDir, TEST_OPTIONS).installed).toBe(true)
  })

  it('(i) production default: a 100 MB model.bin is rejected against the real turbo floor', () => {
    // Use a 100 MB file (cheap) against the production default floor
    // to confirm the user-reported partial size IS rejected without
    // the test-only override.  The reported failure said
    // "position 233" of a 132 MB read — well under 1.4 GB.
    buildFakeModel(modelsDir, TURBO, {
      'config.json': 1_024,
      'model.bin': 100_000_000, // 100 MB — far below MODEL_BIN_MIN_BYTES.turbo
      'preprocessor_config.json': 1_024,
      'tokenizer.json': 4_096,
      'vocabulary.json': 2_048,
    })
    expect(checkModelInstalled(TURBO, modelsDir).installed).toBe(false)
  })
})

describe('REQ-078 — isModelDirIncomplete', () => {
  let modelsDir: string

  beforeEach(() => {
    modelsDir = mkdtempSync(join(tmpdir(), 'mojioko-incomplete-test-'))
  })

  afterEach(() => {
    rmSync(modelsDir, { recursive: true, force: true })
  })

  it('returns false when the model directory does not exist (nothing to wipe)', () => {
    expect(isModelDirIncomplete(modelsDir, TURBO, TEST_OPTIONS)).toBe(false)
  })

  it('returns true for an empty model directory (cancel leftover)', () => {
    mkdirSync(join(modelsDir, TURBO), { recursive: true })
    expect(isModelDirIncomplete(modelsDir, TURBO, TEST_OPTIONS)).toBe(true)
  })

  it('returns true for a partial model.bin (force-kill leftover — the REQ-078 case)', () => {
    buildFakeModel(modelsDir, TURBO, {
      'config.json': 1_024,
      'model.bin': TEST_FLOOR - 1,
      'preprocessor_config.json': 1_024,
      'tokenizer.json': 4_096,
      'vocabulary.json': 2_048,
    })
    expect(isModelDirIncomplete(modelsDir, TURBO, TEST_OPTIONS)).toBe(true)
  })

  it('returns false for a fully installed model (downloader must NOT wipe a working dir)', () => {
    buildFakeModel(modelsDir, TURBO, {
      'config.json': 1_024,
      'model.bin': TEST_FLOOR + 1,
      'preprocessor_config.json': 1_024,
      'tokenizer.json': 4_096,
      'vocabulary.json': 2_048,
    }, { meta: true })
    expect(isModelDirIncomplete(modelsDir, TURBO, TEST_OPTIONS)).toBe(false)
  })
})

describe('REQ-078 — config sanity (production defaults)', () => {
  it('MODEL_BIN_MIN_BYTES has an entry for every ship model', () => {
    for (const modelId of Object.keys(MODEL_FILES)) {
      expect(MODEL_BIN_MIN_BYTES[modelId]).toBeGreaterThan(0)
    }
  })

  it('MODEL_BIN_MIN_BYTES floors are above any plausible partial (>= 1 GB)', () => {
    for (const [, floor] of Object.entries(MODEL_BIN_MIN_BYTES)) {
      // A 1 GB floor easily catches any abort within the first half of
      // a CT2 model.bin download.  Lower than this and we'd risk
      // accepting partials of HuggingFace's >2 GB blobs.
      expect(floor).toBeGreaterThanOrEqual(1_000_000_000)
    }
  })
})
