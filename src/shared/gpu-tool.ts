/**
 * REQ-0149 — GPU acceleration tools distribution constants.
 *
 * The 11 CUDA/cuDNN DLLs that previously shipped inside the installer
 * (REQ-0146, ~1.5 GB) are now published as a single zip asset on
 * GitHub Releases and pulled in on demand from the app UI.  Same
 * pattern as fonts-v1 (`src/shared/fonts.ts`): a dedicated release tag
 * holds a stable filename so the URL can be composed at build time,
 * and a SHA-256 lets the download service verify integrity before
 * extraction.
 *
 * Naming: kept generic (`gpu-tool`) so a future non-CUDA backend
 * (Metal, DirectML, ROCm) can plug in under the same UI slot without
 * a rename cascade through the codebase.  The *current* tag encodes
 * "CUDA 12.6 + cuDNN 9 for NVIDIA" — bumping to `cuda-v2` would flag
 * incompatible content and clean-install into a fresh folder next to
 * the old one under `%APPDATA%/MOJIOKO/gpu-tools/`.
 */
import { GITHUB_OWNER, GITHUB_REPO } from './app-info'

/**
 * GitHub Releases tag holding the GPU tools zip.  Follows the same
 * `<slug>-v<n>` convention as `FONTS_RELEASE_TAG = 'fonts-v1'`.  Bump
 * this if the DLL set changes (major cuDNN version, additional
 * dependencies, etc.) — the folder-name derivation in
 * `getGpuToolDir()` uses this string, so tag bumps naturally isolate
 * old + new installs.
 */
export const GPU_TOOL_RELEASE_TAG = 'cuda-v1'

/**
 * Zip filename on the release page.  Convention keeps the filename
 * equal to the tag so `.../releases/download/cuda-v1/cuda-v1.zip` is
 * self-documenting.  Extension is always `.zip`; the downloader
 * hardcodes this rather than parsing an ext off the URL.
 */
export const GPU_TOOL_ASSET_FILENAME = `${GPU_TOOL_RELEASE_TAG}.zip`

/**
 * Expected download size in bytes (used for the pre-download disk-
 * space check + a Content-Length sanity check inside the download
 * pipeline, mirroring `fonts.ts`).  Value measured at zip creation
 * time in REQ-0149 — must be updated in lock-step with the asset.
 */
export const GPU_TOOL_ASSET_SIZE_BYTES = 1_094_178_434

/**
 * SHA-256 of the zip.  Verified after download completes; a mismatch
 * throws and the extraction step never runs, so partial / corrupted
 * downloads cannot land as a working install.  Lowercase hex — the
 * downloader also normalises before comparing.
 */
export const GPU_TOOL_ASSET_SHA256 =
  '432c2aaffdf8676e7961799645821c44ee8c1fa0e7bf72c6ec4d47a1041cbc7c'

/**
 * Full GitHub Releases download URL.  Composed at import time so
 * consumers can pass it straight into fetch().  Assembly mirrors
 * `fonts.ts:assetUrl()`; the two are intentionally structurally
 * identical so a future consolidation into one shared helper is
 * mechanical.
 */
export const GPU_TOOL_ASSET_URL =
  `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/` +
  `${GPU_TOOL_RELEASE_TAG}/${GPU_TOOL_ASSET_FILENAME}`

/**
 * The 11 DLLs the zip must contain after extraction plus the license
 * text.  Used by the "installed?" check so a hand-edited folder (user
 * deleted a DLL) surfaces as broken instead of masquerading as
 * complete.  Order matters ONLY at preload time (dependency graph,
 * see `python-sidecar/main.py:_preload_bundled_cuda_dlls`); the
 * completeness check treats it as a set.
 */
export const GPU_TOOL_EXPECTED_FILES: readonly string[] = [
  'cudart64_12.dll',
  'cublasLt64_12.dll',
  'cublas64_12.dll',
  'cudnn_graph64_9.dll',
  'cudnn_ops64_9.dll',
  'cudnn_cnn64_9.dll',
  'cudnn_adv64_9.dll',
  'cudnn_heuristic64_9.dll',
  'cudnn_engines_runtime_compiled64_9.dll',
  'cudnn_engines_precompiled64_9.dll',
  'cudnn64_9.dll',
  'NVIDIA-LICENSES.txt',
]

/**
 * REQ-0149 / REQ-0150 — snapshot of the GPU tool subsystem the renderer
 * needs to paint the 2-card accelerator picker.  The renderer combines
 * `installStatus` (are the DLLs on disk?), `gpuDetection` (does this
 * box have an NVIDIA adapter?) and `activeAccelerator` (has the user
 * picked GPU or is CPU the current runtime choice?) to select one of
 * four surface treatments:
 *
 *   (A) NVIDIA present + tools installed + accelerator='gpu' →
 *       both cards, GPU card is the selected one.
 *   (B) NVIDIA present + tools installed + accelerator='cpu' →
 *       both cards, CPU card is the selected one (user opted out of
 *       GPU without deleting the tools).
 *   (C) NVIDIA present + tools NOT installed →
 *       both cards, CPU selected, GPU card in "Download" state.
 *   (D) No NVIDIA (unsupported-gpu or no-gpu) →
 *       accordion collapsed and disabled with the appropriate copy
 *       (REQ-0150 §2 patterns 2 and 3).
 */
export type GpuToolInstallStatus = 'not-installed' | 'installed'

/**
 * The three GPU-presence categories the UI branches on.  Distinct from
 * `installStatus` because a user can have an NVIDIA card but not have
 * downloaded the tools yet (`nvidia` + `not-installed`), or vice versa
 * (they downloaded on a machine with NVIDIA, then swapped cards or
 * moved AppData to a machine without one — treat as `no-nvidia`).
 */
export type GpuDetectionCategory = 'nvidia' | 'other-only' | 'none'

export interface GpuDetectionSnapshot {
  category: GpuDetectionCategory
  /** First NVIDIA adapter name, or null when category !== 'nvidia'. */
  nvidiaName: string | null
  /** All non-NVIDIA adapter names.  Empty when category !== 'other-only'. */
  otherAdapters: string[]
}

export interface GpuToolState {
  installStatus: GpuToolInstallStatus
  sizeBytes: number
  expectedSizeBytes: number
  dir: string
  releaseTag: string
  detection: GpuDetectionSnapshot
  /**
   * User's current accelerator choice, mirrored from settings.  The
   * renderer treats this as the "selected card" indicator.  Only
   * meaningful when `detection.category === 'nvidia'` — the other
   * cases force CPU regardless (there is no GPU option to pick).
   */
  activeAccelerator: 'cpu' | 'gpu'
}

/**
 * REQ-0149 — event union pushed on the `gpu-tool:download:<id>` channel
 * while a download is in flight.  Structurally identical to
 * `DownloadFontEvent` — the zip download is a single-file transfer
 * (no per-file progress), followed by a post-download unzip step
 * whose progress bubbles up under `event: 'extract'`.
 */
export type DownloadGpuToolEvent =
  | { event: 'progress'; percent: number; receivedBytes: number; totalBytes: number }
  | { event: 'extract'; percent: number }
  | { event: 'completed' }
  | { event: 'failed'; error: string; errorCode?: 'network' | 'fatal' | 'aborted' | 'checksum' | 'extract' }
