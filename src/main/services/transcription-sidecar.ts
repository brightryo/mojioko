import { ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { app } from 'electron'
import { spawnProcess } from '../lib/child-process'
import { getPythonSidecarPath, getPythonExecutable, getTranscriberExePath } from '../lib/paths'
import { normalizeVideoPath } from './normalize-video-path'
import { getEffectiveGpuToolDir } from './gpu-tool'
import type { TranscriptionStartRequest, TranscriptionEvent } from '../../shared/ipc-contracts'
import { TranscriptionError } from '../../shared/errors'
import log from '../lib/logger'

// REQ-20260615-078 — the installed-check used to live here as a
// `existsSync(modelDir)` one-liner.  It's now a strict completeness
// gate (per-file presence + model.bin size floor) in its own pure
// module; this file re-exports for callsite stability.  Single source
// of truth — `model-downloader.ts` re-exports the same symbol so the
// duplicate `checkModel` definition is gone.
export { checkModelInstalled } from './check-model-installed'

export type TranscriptionEventCallback = (event: TranscriptionEvent) => void

// REQ-0207 — payload construction moved to `./transcribe-payload.ts` so
// tests can import it without also loading `electron`.  Re-export here
// so any other main-side importer of this module keeps working.
export { buildTranscribePayload } from './transcribe-payload'
import { buildTranscribePayload as _buildTranscribePayload } from './transcribe-payload'

let sidecarProcess: ChildProcess | null = null
let pendingCallback: TranscriptionEventCallback | null = null
// REQ-0150 — remember which `MOJIOKO_GPU_TOOL_DIR` the live sidecar was
// spawned with.  `null` means the sidecar was spawned without a GPU env
// (CPU-only path), a string is the injected folder path.  We compare
// against the current settings on every `ensureSidecar()` and force a
// respawn when the user has flipped between CPU and GPU cards mid-
// session — otherwise the loaded-modules cache from the previous run
// would keep the old choice active.
let lastGpuEnvValue: string | null = null

/**
 * Decide how to spawn the transcription sidecar.
 *
 * Packaged builds: prefer the PyInstaller standalone `mojioko-transcriber.exe`
 * bundled under `resources/bin/transcriber/`.  Falls back to the .venv route
 * if (and only if) the bundle is missing — useful while building/debugging
 * the packaged installer locally.
 *
 * Dev builds: always use `.venv\Scripts\python.exe main.py`.  This keeps the
 * dev iteration loop fast (no PyInstaller rebuild on each Python tweak).
 */
function resolveSidecarSpawn(): { exe: string; args: string[]; mode: 'bundled' | 'venv' } {
  if (app.isPackaged) {
    const bundled = getTranscriberExePath()
    if (bundled) return { exe: bundled, args: [], mode: 'bundled' }
    log.warn('[sidecar] bundled transcriber not found in resources/bin/transcriber/ — falling back to .venv')
  }

  const pythonExe = getPythonExecutable()
  if (pythonExe) {
    return { exe: pythonExe, args: [getPythonSidecarPath()], mode: 'venv' }
  }

  if (!app.isPackaged) {
    const hint = process.platform === 'win32'
      ? 'cd D:\\dev\\mojioko\r\npy -3.11 -m venv .venv\r\n.\\.venv\\Scripts\\Activate.ps1\r\npip install -r python-sidecar\\requirements.txt'
      : 'cd /path/to/mojioko\npython3.11 -m venv .venv\nsource .venv/bin/activate\npip install -r python-sidecar/requirements.txt'
    throw new Error(
      `.venv が見つかりません。プロジェクトルートで以下を実行してください:\n${hint}`
    )
  }
  throw new Error('Bundled transcriber binary not found. Please reinstall the application.')
}

async function ensureSidecar(): Promise<ChildProcess> {
  // REQ-0150 — resolve the desired GPU env FIRST so we can compare
  // against the live sidecar's env and decide whether to respawn.
  const gpuDir = await getEffectiveGpuToolDir()
  const desiredEnvValue = gpuDir ?? null

  if (sidecarProcess && !sidecarProcess.killed) {
    if (desiredEnvValue === lastGpuEnvValue) {
      return sidecarProcess
    }
    log.info(
      `[sidecar] accelerator selection changed ` +
      `(was=${lastGpuEnvValue ?? 'null'} now=${desiredEnvValue ?? 'null'}) — respawning`,
    )
    try { sidecarProcess.kill() } catch { /* ignore */ }
    sidecarProcess = null
  }

  const { exe, args, mode } = resolveSidecarSpawn()

  log.info(`[sidecar] spawning (${mode}): ${exe}`)
  if (args.length > 0) {
    log.info(`[sidecar] script: ${args[0]}`)
  }

  // REQ-0149 / REQ-0150 — inject the GPU-tool directory only when the
  // user has BOTH downloaded the CUDA/cuDNN redistributables AND picked
  // the GPU card.  `getEffectiveGpuToolDir()` (called above) enforces
  // both conditions plus an NVIDIA-adapter sanity check.  Unset =
  // sidecar's `_preload_bundled_cuda_dlls()` no-ops silently and the
  // runtime lands on CPU via `_select_device()`.
  if (gpuDir) {
    log.info(`[sidecar] MOJIOKO_GPU_TOOL_DIR=${gpuDir}`)
  }
  const sidecarEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  }
  if (gpuDir) {
    sidecarEnv.MOJIOKO_GPU_TOOL_DIR = gpuDir
  }
  lastGpuEnvValue = desiredEnvValue
  const proc = spawnProcess(exe, args, { env: sidecarEnv })

  sidecarProcess = proc

  const rl = createInterface({ input: proc.stdout! })
  rl.on('line', (line) => {
    if (!line.trim()) return
    try {
      const event = JSON.parse(line) as TranscriptionEvent
      if (pendingCallback) {
        pendingCallback(event)
        if (event.event === 'completed' || event.event === 'failed' || event.event === 'needsDownload') {
          pendingCallback = null
        }
      }
    } catch {
      log.warn(`[sidecar] unparsable stdout: ${line}`)
    }
  })

  proc.stderr?.on('data', (chunk: Buffer) => {
    log.debug(`[sidecar stderr] ${chunk.toString().trim()}`)
  })

  proc.on('exit', (code) => {
    log.info(`[sidecar] exited with code ${code}`)
    sidecarProcess = null
    pendingCallback = null
    // REQ-0150 — drop the remembered env value so the next spawn re-
    // reads settings freshly rather than skipping the respawn based on
    // a stale value.
    lastGpuEnvValue = null
  })

  return proc
}

export async function transcribe(
  request: TranscriptionStartRequest,
  onEvent: TranscriptionEventCallback
): Promise<void> {
  const proc = await ensureSidecar()

  return new Promise<void>((resolve, reject) => {
    pendingCallback = (event) => {
      onEvent(event)
      if (event.event === 'completed') resolve()
      else if (event.event === 'failed') reject(new TranscriptionError(event.error))
      else if (event.event === 'needsDownload') {
        reject(new TranscriptionError(`Whisper model "${event.model}" is not installed`, { model: event.model }))
      }
    }

    // REQ-0103 — normalize + existence-check the video path before shipping
    // it to the sidecar.  See `normalize-video-path.ts` for full rationale.
    const norm = normalizeVideoPath(request.videoPath)
    if (!norm.ok) {
      reject(new TranscriptionError(norm.error))
      return
    }
    const videoPath = norm.path

    const payload = _buildTranscribePayload(request, videoPath)

    proc.stdin!.write(JSON.stringify(payload) + '\n', 'utf-8', (err) => {
      if (err) reject(new TranscriptionError(`Failed to send to sidecar: ${err.message}`))
    })
  })
}

export function terminateSidecar(): void {
  if (sidecarProcess && !sidecarProcess.killed) {
    try {
      sidecarProcess.stdin?.write(JSON.stringify({ cmd: 'shutdown' }) + '\n')
      setTimeout(() => {
        if (sidecarProcess && !sidecarProcess.killed) {
          sidecarProcess.kill()
        }
      }, 1000)
    } catch {
      sidecarProcess.kill()
    }
  }
  sidecarProcess = null
  pendingCallback = null
}

