import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readModelMeta, isModelFormatStale } from '../../src/main/services/model-meta'
import { MODEL_FORMAT_GENERATION } from '../../src/shared/constants'

/**
 * REQ-20260615-065 S-6 — model.meta.json sidecar.
 *
 *  - `readModelMeta` returns null when the file is missing OR
 *    unparsable OR missing a required field, so the caller can treat
 *    "no meta" as "unknown generation = current-compatible" without
 *    a separate branch.
 *  - `isModelFormatStale` returns true ONLY when a parsed meta's
 *    `formatGeneration` is STRICTLY less than the current constant.
 *    Missing meta is NOT stale — pre-v1.3.0 downloads must not
 *    trigger spurious re-DL suggestions (Phase 0 verified the on-disk
 *    layout is unchanged).
 *  - The current constant is pinned at `1` so a future accidental
 *    bump shows up in CI (the bump is supposed to be a deliberate
 *    coordinated edit, not a side-effect).
 */

describe('REQ-065 S-6 — model.meta.json', () => {
  let modelDir: string

  beforeEach(() => {
    modelDir = mkdtempSync(join(tmpdir(), 'mojioko-meta-test-'))
  })

  afterEach(() => {
    rmSync(modelDir, { recursive: true, force: true })
  })

  it('readModelMeta returns null when the meta file does not exist', () => {
    expect(readModelMeta(modelDir)).toBeNull()
  })

  it('readModelMeta returns the parsed meta when the file is well-formed', () => {
    writeFileSync(
      join(modelDir, 'model.meta.json'),
      JSON.stringify({
        modelId: 'large-v3-turbo',
        downloadedAt: '2026-06-24T07:00:00.000Z',
        fasterWhisperVersion: '1.2.1',
        formatGeneration: 1,
      }),
      'utf-8'
    )
    const meta = readModelMeta(modelDir)
    expect(meta).not.toBeNull()
    expect(meta?.modelId).toBe('large-v3-turbo')
    expect(meta?.formatGeneration).toBe(1)
    expect(meta?.fasterWhisperVersion).toBe('1.2.1')
  })

  it('readModelMeta returns null when the JSON is invalid', () => {
    writeFileSync(join(modelDir, 'model.meta.json'), '{ not valid json', 'utf-8')
    expect(readModelMeta(modelDir)).toBeNull()
  })

  it('readModelMeta returns null when required fields are missing', () => {
    writeFileSync(
      join(modelDir, 'model.meta.json'),
      JSON.stringify({ modelId: 'large-v3-turbo' /* formatGeneration missing */ }),
      'utf-8'
    )
    expect(readModelMeta(modelDir)).toBeNull()
  })

  it('isModelFormatStale returns false for a missing meta (pre-v1.3 download)', () => {
    expect(isModelFormatStale(modelDir)).toBe(false)
  })

  it('isModelFormatStale returns false when meta matches the current generation', () => {
    writeFileSync(
      join(modelDir, 'model.meta.json'),
      JSON.stringify({
        modelId: 'large-v3-turbo',
        downloadedAt: '2026-06-24T07:00:00.000Z',
        fasterWhisperVersion: '1.2.1',
        formatGeneration: MODEL_FORMAT_GENERATION,
      }),
      'utf-8'
    )
    expect(isModelFormatStale(modelDir)).toBe(false)
  })

  it('isModelFormatStale returns true when meta is older than the current generation', () => {
    writeFileSync(
      join(modelDir, 'model.meta.json'),
      JSON.stringify({
        modelId: 'large-v3-turbo',
        downloadedAt: '2026-06-24T07:00:00.000Z',
        fasterWhisperVersion: '0.9.0',
        formatGeneration: 0, // strictly less than current `1`
      }),
      'utf-8'
    )
    expect(isModelFormatStale(modelDir)).toBe(true)
  })

  it('MODEL_FORMAT_GENERATION is pinned at 1 (v1.3.0 ship value) — an accidental bump must surface in CI', () => {
    expect(MODEL_FORMAT_GENERATION).toBe(1)
  })
})
