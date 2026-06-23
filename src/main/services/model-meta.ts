import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { MODEL_FORMAT_GENERATION } from '../../shared/constants'

/**
 * REQ-20260615-065 S-6 — shape of `model.meta.json` (one per
 * downloaded model directory).  `formatGeneration` is the
 * `MODEL_FORMAT_GENERATION` value at download time and is what the
 * reader compares against to decide whether to log a re-download
 * suggestion.  `fasterWhisperVersion` is the runtime version that
 * issued the download — purely informational for users who file
 * bug reports, the runtime does not act on it.
 *
 * Lives in its own module (no electron / logger imports) so vitest
 * can exercise the read / write / stale-detect contract without
 * dragging in the main-process environment.
 */
export interface ModelMeta {
  modelId: string
  downloadedAt: string
  fasterWhisperVersion: string
  formatGeneration: number
}

// `faster-whisper`'s wheel version at the time MODEL_FORMAT_GENERATION
// was set.  Bumping the constant in shared/constants.ts and updating
// this string is the only edit a future model-format break needs in
// the downloader pipeline.
const FASTER_WHISPER_VERSION_AT_GEN = '1.2.1'

/**
 * REQ-20260615-065 S-6 — write `<modelDir>/model.meta.json`.  Best-
 * effort: returns `false` on error and never throws, so a meta-write
 * failure does not roll back the larger download pipeline.  Callers
 * may log the result but are not expected to act on it.
 */
export function writeModelMeta(modelDir: string, modelId: string): boolean {
  const meta: ModelMeta = {
    modelId,
    downloadedAt: new Date().toISOString(),
    fasterWhisperVersion: FASTER_WHISPER_VERSION_AT_GEN,
    formatGeneration: MODEL_FORMAT_GENERATION,
  }
  try {
    writeFileSync(join(modelDir, 'model.meta.json'), JSON.stringify(meta, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

/**
 * REQ-20260615-065 S-6 — read a model's sidecar meta.  Returns null
 * when the file does not exist OR is unparsable OR is missing a
 * required field; all of those cases are treated by callers as
 * "unknown generation = current-compatible" so existing downloads
 * (which have no meta) do not trigger a spurious re-download
 * suggestion.
 */
export function readModelMeta(modelDir: string): ModelMeta | null {
  const metaPath = join(modelDir, 'model.meta.json')
  if (!existsSync(metaPath)) return null
  try {
    const raw = readFileSync(metaPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ModelMeta>
    if (typeof parsed.modelId !== 'string' || typeof parsed.formatGeneration !== 'number') {
      return null
    }
    return {
      modelId: parsed.modelId,
      downloadedAt: String(parsed.downloadedAt ?? ''),
      fasterWhisperVersion: String(parsed.fasterWhisperVersion ?? ''),
      formatGeneration: parsed.formatGeneration,
    }
  } catch {
    return null
  }
}

/**
 * REQ-20260615-065 S-6 — log-only detector for stale model formats.
 *
 * Returns true iff a meta exists AND its `formatGeneration` is
 * STRICTLY less than the current `MODEL_FORMAT_GENERATION`.  Missing
 * meta is intentionally NOT a stale signal — pre-v1.3.0 downloads
 * have no meta, and Phase 0 confirmed the on-disk CT2 layout is
 * unchanged from fw 1.0.3, so they remain compatible.
 *
 * Callers decide whether to surface this; in v1.3.0 it is log-only.
 */
export function isModelFormatStale(modelDir: string): boolean {
  const meta = readModelMeta(modelDir)
  if (meta === null) return false
  return meta.formatGeneration < MODEL_FORMAT_GENERATION
}
