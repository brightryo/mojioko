import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'fs'
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { pipeline } from 'stream/promises'
import { join } from 'path'
import type {
  DownloadGpuToolEvent,
  GpuToolState,
  GpuDetectionCategory,
} from '../../shared/gpu-tool'
import {
  GPU_TOOL_RELEASE_TAG,
  GPU_TOOL_ASSET_URL,
  GPU_TOOL_ASSET_SIZE_BYTES,
  GPU_TOOL_ASSET_SHA256,
  GPU_TOOL_EXPECTED_FILES,
} from '../../shared/gpu-tool'
import { getGpuToolDir, getGpuToolsRoot } from '../lib/paths'
import { detectGpuAdapters } from './gpu-detector'
import { loadSettings, saveSettings } from './settings-store'
import log from '../lib/logger'

/**
 * REQ-0149 — orchestrates the download-and-install lifecycle for the
 * user-downloaded GPU tools.  Splits into three surfaces:
 *
 *   - `buildGpuToolState()` — snapshot for the settings UI.  Combines
 *     "is the folder complete?" + "does this box have an NVIDIA
 *     adapter?" so the renderer can pick the right variant of the
 *     accordion (installable / installed / disabled).
 *
 *   - `downloadGpuTool()` — single-zip HTTP download to a temp file,
 *     SHA-256 verification, then unzip into the versioned install
 *     directory (`gpu-tools/<tag>/`).  Runs a strict pre-existing-dir
 *     wipe like the whisper model downloader so a re-download always
 *     starts from a clean slate.
 *
 *   - `deleteGpuTool()` — recursive delete of the install directory,
 *     invoked from the destructive confirmation dialog in the UI.
 *
 * The sidecar is decoupled from any of this: it just reads the
 * `MOJIOKO_GPU_TOOL_DIR` env var that `transcription-sidecar.ts`
 * populates from `getInstalledGpuToolDir()` at spawn time.
 */

/**
 * REQ-0149 — no npm zip lib.  We reuse the .NET
 * `System.IO.Compression.ZipFile.ExtractToDirectory` cmdlet via
 * PowerShell, which is guaranteed present on every Windows 10/11
 * install and handles the full ~1 GB zip in ~30 s on an SSD.  Cost is
 * one child-process spawn per DL run; well worth avoiding an extra
 * dependency (`adm-zip`, `yauzl`, `unzipper` etc.) that would ship in
 * every installer regardless of whether the user ever triggers the DL.
 */

// ---------------------------------------------------------------------------
// State snapshot
// ---------------------------------------------------------------------------

function directorySizeBytes(dir: string): number {
  let total = 0
  try {
    for (const name of readdirSync(dir)) {
      try {
        total += statSync(join(dir, name)).size
      } catch { /* ignore per-file failures */ }
    }
  } catch { /* dir missing */ }
  return total
}

function isInstallComplete(dir: string): boolean {
  if (!existsSync(dir)) return false
  for (const filename of GPU_TOOL_EXPECTED_FILES) {
    if (!existsSync(join(dir, filename))) return false
  }
  return true
}

/**
 * REQ-0149 — absolute path to the currently-installed GPU tool folder
 * IF (a) the install is complete AND (b) the user has picked the GPU
 * card.  Both conditions must hold before `transcription-sidecar.ts`
 * injects `MOJIOKO_GPU_TOOL_DIR` — REQ-0150 §1 requires a user who has
 * the tools on disk but has picked the CPU card to get CPU execution.
 * A partial install always returns null so a broken folder never
 * masquerades as usable.
 */
export async function getEffectiveGpuToolDir(): Promise<string | null> {
  const dir = getGpuToolDir(GPU_TOOL_RELEASE_TAG)
  if (!isInstallComplete(dir)) return null
  const settings = await loadSettings()
  if ((settings.activeAccelerator ?? 'cpu') !== 'gpu') return null
  return dir
}

function detectionCategory(nvidiaDetected: boolean, otherCount: number): GpuDetectionCategory {
  if (nvidiaDetected) return 'nvidia'
  if (otherCount > 0) return 'other-only'
  return 'none'
}

export async function buildGpuToolState(): Promise<GpuToolState> {
  const dir = getGpuToolDir(GPU_TOOL_RELEASE_TAG)
  const detection = await detectGpuAdapters()
  const installed = isInstallComplete(dir)
  const settings = await loadSettings()

  const category = detectionCategory(detection.nvidiaDetected, detection.otherAdapters.length)

  return {
    installStatus: installed ? 'installed' : 'not-installed',
    sizeBytes: installed ? directorySizeBytes(dir) : 0,
    expectedSizeBytes: GPU_TOOL_ASSET_SIZE_BYTES,
    dir,
    releaseTag: GPU_TOOL_RELEASE_TAG,
    detection: {
      category,
      nvidiaName: detection.nvidiaName,
      otherAdapters: detection.otherAdapters,
    },
    activeAccelerator: settings.activeAccelerator ?? 'cpu',
  }
}

/**
 * REQ-0150 — persist the user's card selection.  `'gpu'` requires the
 * tools to be installed AND an NVIDIA adapter to be present; any
 * other combination is treated as a bug in the renderer and downgraded
 * to `'cpu'` on the main side so a stale settings.json can never
 * inject a GPU env var into a machine that has no NVIDIA card.
 */
export async function setActiveAccelerator(next: 'cpu' | 'gpu'): Promise<GpuToolState> {
  const settings = await loadSettings()
  let effective: 'cpu' | 'gpu' = next
  if (next === 'gpu') {
    const dir = getGpuToolDir(GPU_TOOL_RELEASE_TAG)
    const detection = await detectGpuAdapters()
    if (!isInstallComplete(dir) || !detection.nvidiaDetected) {
      log.warn('[gpu-tool] setActiveAccelerator("gpu") rejected — install incomplete or no NVIDIA')
      effective = 'cpu'
    }
  }
  settings.activeAccelerator = effective
  await saveSettings(settings)
  return buildGpuToolState()
}

// ---------------------------------------------------------------------------
// Download error taxonomy
// ---------------------------------------------------------------------------

export class GpuToolDownloadError extends Error {
  readonly code: NonNullable<
    Extract<DownloadGpuToolEvent, { event: 'failed' }>['errorCode']
  >
  constructor(
    code: NonNullable<
      Extract<DownloadGpuToolEvent, { event: 'failed' }>['errorCode']
    >,
    inner: unknown,
  ) {
    const innerMsg = inner instanceof Error ? inner.message : String(inner)
    super(`GpuToolDownloadError(${code}): ${innerMsg}`)
    this.name = 'GpuToolDownloadError'
    this.code = code
  }
}

function classify(err: unknown): NonNullable<
  Extract<DownloadGpuToolEvent, { event: 'failed' }>['errorCode']
> {
  if (err instanceof GpuToolDownloadError) return err.code
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  if (msg.includes('abort') || msg.includes('cancel')) return 'aborted'
  if (
    msg.includes('terminated') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('network')
  ) return 'network'
  return 'fatal'
}

// ---------------------------------------------------------------------------
// Download + verify + extract
// ---------------------------------------------------------------------------

async function downloadZip(
  destPath: string,
  onProgress: (received: number, total: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const resp = await fetch(GPU_TOOL_ASSET_URL, { signal, redirect: 'follow' })
  if (!resp.ok) {
    throw new GpuToolDownloadError('fatal', new Error(`HTTP ${resp.status}`))
  }
  const contentLength = parseInt(resp.headers.get('content-length') ?? '0', 10)
  if (!resp.body) {
    throw new GpuToolDownloadError('fatal', new Error('No response body'))
  }

  const dest = createWriteStream(destPath)
  let received = 0
  const reader = resp.body.getReader()

  try {
    for (;;) {
      if (signal.aborted) throw new GpuToolDownloadError('aborted', new Error('Cancelled'))
      const { done, value } = await reader.read()
      if (done) break
      dest.write(value)
      received += value.length
      if (contentLength > 0) onProgress(received, contentLength)
    }
    await new Promise<void>((res, rej) =>
      dest.end((err: Error | null | undefined) => (err ? rej(err) : res())),
    )
  } catch (err) {
    dest.destroy()
    throw err
  } finally {
    reader.releaseLock()
  }

  // Integrity checks — Content-Length range and a priori expected size.
  // 10 % tolerance forgives transfer-encoding differences but catches
  // hard truncation.
  if (contentLength > 0 && Math.abs(received - contentLength) > contentLength * 0.1) {
    throw new GpuToolDownloadError('fatal', new Error(
      `Truncated: received ${received}/${contentLength}`,
    ))
  }
  if (Math.abs(received - GPU_TOOL_ASSET_SIZE_BYTES) > GPU_TOOL_ASSET_SIZE_BYTES * 0.1) {
    throw new GpuToolDownloadError('fatal', new Error(
      `Size mismatch: received ${received}, expected ~${GPU_TOOL_ASSET_SIZE_BYTES}`,
    ))
  }
}

async function verifySha256(zipPath: string): Promise<void> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(zipPath), hash)
  const digest = hash.digest('hex').toLowerCase()
  if (digest !== GPU_TOOL_ASSET_SHA256.toLowerCase()) {
    throw new GpuToolDownloadError('checksum', new Error(
      `SHA-256 mismatch: got ${digest}, expected ${GPU_TOOL_ASSET_SHA256}`,
    ))
  }
}

/**
 * Extract the downloaded zip via PowerShell +
 * `System.IO.Compression.ZipFile.ExtractToDirectory`.  No per-file
 * progress — .NET's public unzip API only surfaces start / end.  The
 * caller emits a 0 → 100 jump around the sync call, which matches the
 * user perception (spinner for ~30 s, then flip to "installed").
 */
function extractZipInto(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(destDir, { recursive: true })
    // The script runs one-shot: load the assembly, extract, exit non-
    // zero on any exception.  Paths are single-quoted; PowerShell
    // does not interpolate inside single quotes, and neither `zipPath`
    // nor `destDir` will contain a literal single quote (both come
    // from `app.getPath('appData')` derivatives and paths.ts joins).
    const script =
      "Add-Type -AssemblyName System.IO.Compression.FileSystem;" +
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}','${destDir.replace(/'/g, "''")}')`
    const args = ['-NoProfile', '-NonInteractive', '-Command', script]
    const child = execFile(
      'powershell.exe',
      args,
      { windowsHide: true, timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`Unzip failed: ${err.message}${stderr ? ` | ${stderr.trim()}` : ''}`))
        } else {
          resolve()
        }
      },
    )
    child.on('error', (e) => reject(e))
  })
}

export async function downloadGpuTool(
  onEvent: (evt: DownloadGpuToolEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const installDir = getGpuToolDir(GPU_TOOL_RELEASE_TAG)
  const rootDir = getGpuToolsRoot()
  mkdirSync(rootDir, { recursive: true })

  // Wipe any prior (possibly incomplete) install so we never merge onto
  // an old file set.  Mirrors the whisper model downloader's REQ-078
  // wipe.
  if (existsSync(installDir)) {
    log.info(`[gpu-tool] wiping prior install at ${installDir}`)
    try { rmSync(installDir, { recursive: true, force: true }) } catch (e) {
      log.warn(`[gpu-tool] could not wipe ${installDir}`, e)
    }
  }

  const tmpZipPath = join(rootDir, `${GPU_TOOL_RELEASE_TAG}.zip.partial`)
  if (existsSync(tmpZipPath)) {
    try { unlinkSync(tmpZipPath) } catch { /* ignore */ }
  }

  try {
    log.info(`[gpu-tool] downloading ${GPU_TOOL_ASSET_URL}`)
    onEvent({ event: 'progress', percent: 0, receivedBytes: 0, totalBytes: GPU_TOOL_ASSET_SIZE_BYTES })
    await downloadZip(
      tmpZipPath,
      (received, total) => {
        onEvent({
          event: 'progress',
          percent: Math.min(100, Math.floor((received / total) * 100)),
          receivedBytes: received,
          totalBytes: total,
        })
      },
      signal,
    )

    log.info('[gpu-tool] verifying SHA-256')
    await verifySha256(tmpZipPath)

    log.info(`[gpu-tool] extracting into ${installDir}`)
    onEvent({ event: 'extract', percent: 0 })
    try {
      await extractZipInto(tmpZipPath, installDir)
      onEvent({ event: 'extract', percent: 100 })
    } catch (err) {
      throw new GpuToolDownloadError('extract', err)
    }

    // Verify install completeness — a corrupted zip that unzipped
    // partially would otherwise leave a broken install parading as
    // "installed".  Missing files → full wipe → surface a hard error.
    if (!isInstallComplete(installDir)) {
      try { rmSync(installDir, { recursive: true, force: true }) } catch { /* ignore */ }
      throw new GpuToolDownloadError('extract', new Error(
        'Extraction completed but expected files are missing',
      ))
    }

    onEvent({ event: 'completed' })
    log.info('[gpu-tool] install complete')
  } catch (err) {
    // Cleanup — never leave a corrupt install on disk.
    try { rmSync(installDir, { recursive: true, force: true }) } catch { /* ignore */ }
    const code = classify(err)
    const message = err instanceof Error ? err.message : String(err)
    log.error(`[gpu-tool] download failed (${code}): ${message}`)
    onEvent({ event: 'failed', error: message, errorCode: code })
  } finally {
    // Always drop the temp zip — success (no longer needed) or failure
    // (we already surfaced the error, no reason to keep 1 GB of garbage).
    if (existsSync(tmpZipPath)) {
      try { unlinkSync(tmpZipPath) } catch { /* ignore */ }
    }
  }
}

/**
 * REQ-0218 §Fix 3 — remove the on-demand CUDA/cuDNN redistributables.
 *
 * Terminates any live transcription sidecar BEFORE unlinking, because
 * `_preload_bundled_cuda_dlls()` maps all 11 CUDA DLLs into the sidecar
 * process's address space and Windows refuses `unlink` on a currently-
 * mapped DLL (surfaces as `EPERM: operation not permitted, unlink
 * 'cublas64_12.dll'` — RES-0217 §3).  The wait is bounded by
 * `terminateSidecarAndWait`'s internal timeout so a stuck sidecar
 * can't hang the delete indefinitely; if the timeout elapses and the
 * DLLs are still locked, the subsequent `rmSync` throws EPERM and the
 * IPC layer surfaces it to the UI as a normal error.
 */
export async function deleteGpuTool(): Promise<void> {
  const dir = getGpuToolDir(GPU_TOOL_RELEASE_TAG)
  if (!existsSync(dir)) return
  // Dynamic import to avoid a static import cycle: transcription-sidecar.ts
  // already imports `getEffectiveGpuToolDir` from this file, so a
  // top-level `import { terminateSidecarAndWait } from './transcription-sidecar'`
  // here would form a bidirectional edge.
  const { terminateSidecarAndWait } = await import('./transcription-sidecar')
  await terminateSidecarAndWait(3000)
  log.info(`[gpu-tool] deleting ${dir}`)
  rmSync(dir, { recursive: true, force: true })
}
