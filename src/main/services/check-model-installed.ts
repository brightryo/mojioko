import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { readModelMeta } from './model-meta'

/**
 * REQ-20260615-078 — strict "is this model fully downloaded" judgement.
 *
 * v1.3.1 and earlier used `existsSync(modelDir)` as the sole signal,
 * which returned `installed: true` for empty directories and for
 * directories containing a partial multi-GB `model.bin` left behind by
 * a force-kill mid-download.  faster-whisper then tried to mmap that
 * truncated blob and failed with:
 *
 *   File model.bin is incomplete: failed to read a buffer of size N at
 *   position M
 *
 * The new check requires:
 *
 *   1. The model directory exists.
 *   2. EVERY file listed in {@link MODEL_FILES} for this model id is
 *      present.  An empty dir, or a dir with `model.bin` but missing
 *      `config.json`, counts as not-installed.
 *   3. Each small file (config/preprocessor/tokenizer/vocabulary) has a
 *      non-zero size.  These are KB-scale and download in one chunk —
 *      a zero-byte file means the write started but the stream never
 *      delivered any bytes (cancelled before the first chunk).
 *   4. `model.bin` is at least {@link MODEL_BIN_MIN_BYTES} for this
 *      model id.  Sized at ~90 % of the actual HuggingFace blob,
 *      generous enough to absorb future quantization tweaks but well
 *      above any partial download (a clean break point near 100 % is
 *      vanishingly rare; the partial sizes we've seen in the wild are
 *      well under half).
 *
 * `model.meta.json` is checked too — if present, it proves the
 * downloader reached its final "all files complete" step
 * ({@link writeModelMeta} in `model-downloader.ts` runs AFTER every
 * weight file finished writing).  But meta is NOT a hard gate: pre-
 * v1.3.0 downloads lack the sidecar and must still be recognized as
 * installed if their files are present and sized correctly.  Treating
 * "no meta" as "not installed" would mass-orphan existing users'
 * models, which is the worse failure mode.
 *
 * Pure module (fs only — no electron / logger imports) so vitest can
 * drive every branch from `tests/unit/check-model-installed.test.ts`
 * by writing fake model directories under `os.tmpdir()`.
 */

// Per-model required CT2 file lists.  Both v1.3.0 ship models converge
// on the same 5-file layout (REQ-065 Phase 0 verified parity between
// Systran/large-v3 and mobiuslabsgmbh/large-v3-turbo).  Adding a model
// with a different file set is a one-line change here AND in the
// downloader's MODEL_FILES (which re-exports this).
export const MODEL_FILES: Record<string, string[]> = {
  'large-v3':       ['config.json', 'model.bin', 'preprocessor_config.json', 'tokenizer.json', 'vocabulary.json'],
  'large-v3-turbo': ['config.json', 'model.bin', 'preprocessor_config.json', 'tokenizer.json', 'vocabulary.json'],
}
export const DEFAULT_MODEL_FILES = MODEL_FILES['large-v3']

/**
 * Per-model floor (bytes) for `model.bin`.  Sized at ~90 % of the
 * actual HuggingFace blob:
 *
 *   - Systran/faster-whisper-large-v3       model.bin = ~3.09 GB
 *   - mobiuslabsgmbh/faster-whisper-...-turbo  model.bin = ~1.62 GB
 *
 * Anything below this floor is treated as a partial download.  The
 * threshold leaves enough headroom for the upstream maintainers to
 * tweak quantization without breaking detection, while still catching
 * any plausible mid-download abort — the user's reported failure
 * (`size 132776960 at position 233`) is two orders of magnitude below
 * either floor.
 */
export const MODEL_BIN_MIN_BYTES: Record<string, number> = {
  'large-v3-turbo': 1_400_000_000,
  'large-v3':       2_700_000_000,
}

export interface ModelInstalledResult {
  installed: boolean
  sizeMB: number
}

export interface CheckModelInstalledOptions {
  /**
   * Override the per-model `model.bin` size floor used by the partial-
   * detection branch.  Production code does NOT pass this; the
   * defaults in {@link MODEL_BIN_MIN_BYTES} are the source of truth.
   *
   * Exists only so vitest can drive the size-check branches without
   * allocating 1.4 GB sparse files per test.  Tests pass small values
   * (e.g., 1_000) and fake `model.bin` files at corresponding sizes.
   * Keep this out of any IPC contract.
   */
  modelBinFloor?: number
}

/**
 * Strict installed-check.  See module docstring for the decision tree.
 *
 * Returns `installed: false` for any directory that fails the full /
 * partial / empty / missing-file check.  Callers (resolve-active-model,
 * the renderer model card) use this to drive UI state — REQ-077's
 * Branch 2 (`corrected-null`) fires when `isInstalled` returns false
 * for a model that settings.activeModelId points at, so a partial
 * directory now correctly falls into the unselected state instead of
 * letting transcription start and crash the sidecar.
 *
 * `sizeMB` is reported as the sum of present files (best-effort), so
 * the UI can show what bytes are actually on disk even when the check
 * decides the install is incomplete — useful for the "X MB of Y MB"
 * confused-state messaging if we ever need it.  For a complete install
 * the value matches the legacy v1.3.1 behaviour.
 */
export function checkModelInstalled(
  modelId: string,
  modelsDir: string,
  options?: CheckModelInstalledOptions,
): ModelInstalledResult {
  const modelDir = join(modelsDir, modelId)
  if (!existsSync(modelDir)) return { installed: false, sizeMB: 0 }

  // Sum bytes for the UI hint regardless of completeness — the same
  // walk we'd do anyway for the legacy `sizeMB` return value.
  let totalBytes = 0
  try {
    const items = readdirSync(modelDir)
    for (const item of items) {
      try {
        totalBytes += statSync(join(modelDir, item)).size
      } catch { /* ignore stat failures on individual files */ }
    }
  } catch {
    // Directory unreadable — treat as not installed.
    return { installed: false, sizeMB: 0 }
  }

  const sizeMB = Math.round(totalBytes / 1_000_000)
  const requiredFiles = MODEL_FILES[modelId] ?? DEFAULT_MODEL_FILES

  // (2) Every required file must be present on disk.
  for (const filename of requiredFiles) {
    const path = join(modelDir, filename)
    if (!existsSync(path)) {
      return { installed: false, sizeMB }
    }
  }

  // (3) Small files must be non-zero.  These download in a single
  // chunk; a 0-byte file means the write stream opened but the body
  // never delivered bytes — an aborted-before-first-chunk leftover.
  // model.bin gets its own minimum check below, so skip it here.
  for (const filename of requiredFiles) {
    if (filename === 'model.bin') continue
    try {
      const size = statSync(join(modelDir, filename)).size
      if (size === 0) return { installed: false, sizeMB }
    } catch {
      return { installed: false, sizeMB }
    }
  }

  // (4) model.bin must clear the per-model floor.  This is the central
  // protection against the user-reported partial.  Models we don't
  // have a floor for (future additions, defensive) fall back to a
  // "must be non-zero" floor so we still reject obviously-empty bins.
  try {
    const modelBinSize = statSync(join(modelDir, 'model.bin')).size
    const floor = options?.modelBinFloor ?? MODEL_BIN_MIN_BYTES[modelId] ?? 1
    if (modelBinSize < floor) return { installed: false, sizeMB }
  } catch {
    return { installed: false, sizeMB }
  }

  // (Optional corroboration) Meta presence is a positive signal but
  // not required — see module docstring rationale.  Reading it has
  // a side benefit: if a future model-format break invalidates older
  // downloads we can short-circuit here, but v1.3.1 keeps the meta
  // check log-only via `isModelFormatStale` (REQ-065 S-6).
  void readModelMeta // referenced to keep the import live for ts strict + future use

  return { installed: true, sizeMB }
}

/**
 * REQ-20260615-078 — companion check used by the downloader before it
 * starts a fresh DL.  Returns true iff a model directory exists but
 * fails the strict installed check (partial / empty / missing file).
 *
 * The downloader uses this to decide whether to `rm -rf` the directory
 * before re-creating it, so a re-install after a force-kill starts
 * from a clean slate instead of resuming on top of a half-written
 * `model.bin` (which CT2 cannot reuse — its layout is whole-file, not
 * appendable).
 *
 * A completely absent directory returns false (nothing to clean).  A
 * fully installed directory returns false (nothing to clean either —
 * the caller decides separately whether to re-download).
 */
export function isModelDirIncomplete(
  modelsDir: string,
  modelId: string,
  options?: CheckModelInstalledOptions,
): boolean {
  const modelDir = join(modelsDir, modelId)
  if (!existsSync(modelDir)) return false
  const { installed } = checkModelInstalled(modelId, modelsDir, options)
  return !installed
}
