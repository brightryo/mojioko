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

// REQ-0219 — the idle watchdog from REQ-0218 §Fix 4 was withdrawn.
// The premise (~event silence implies hang~) can never be safely
// distinguished from ~heavy processing is legitimately taking a
// while~ from the outside, and any threshold false-positives on long-
// form CPU transcription runs — which is MOJIOKO's main use case.
// The user can watch the UI and press Cancel if progress stalls; the
// app must NOT guess-and-kill with an arbitrary timer.  The reliable
// cancel path lives in `cancelTranscription()` below, which is what
// `ipc/transcription.ts:transcriptionCancel` invokes.
//
// The other three REQ-0218 fixes remain in force:
//   Fix 1 (exit-handler ownership check) — see `proc.on('exit')` below.
//   Fix 2 (owning-proc death → `failed` event) — same handler.
//   Fix 3 (`terminateSidecarAndWait` for GPU-tool delete) — reused
//   here by `cancelTranscription` to guarantee SIGKILL escalation.

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
    // REQ-0218 §Fix 1 — ownership check.  A respawn (see line 83-89)
    // fires kill() on the old proc synchronously but the OS-level exit
    // event lands a few dozen ms later, by which point `sidecarProcess`
    // has already been re-assigned to a fresh proc AND `transcribe()`
    // has installed a new `pendingCallback` and written the payload
    // to the fresh proc's stdin.  If we cleared module state here
    // without checking, we would silently disarm the healthy new proc
    // — RES-0217 §2 traces that exact race as the root cause of the
    // "GPU-mode silent hang" bug.
    if (sidecarProcess !== proc) return

    // REQ-0218 §Fix 2 — the owning process died while a transcribe was
    // in flight.  Emit a `failed` event before nullifying the callback
    // so the UI surfaces an error instead of hanging forever waiting
    // for a `completed`/`failed` that will never arrive.
    const cb = pendingCallback
    sidecarProcess = null
    pendingCallback = null
    // REQ-0150 — drop the remembered env value so the next spawn re-
    // reads settings freshly rather than skipping the respawn based on
    // a stale value.
    lastGpuEnvValue = null
    if (cb) {
      log.error(`[sidecar] died during in-flight transcribe (code=${code})`)
      cb({
        event: 'failed',
        error: `Transcription process exited unexpectedly (code=${code ?? 'null'})`,
      })
    }
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
      pendingCallback = null
      reject(new TranscriptionError(norm.error))
      return
    }
    const videoPath = norm.path

    const payload = _buildTranscribePayload(request, videoPath)

    proc.stdin!.write(JSON.stringify(payload) + '\n', 'utf-8', (err) => {
      if (err) {
        pendingCallback = null
        reject(new TranscriptionError(`Failed to send to sidecar: ${err.message}`))
      }
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

/**
 * REQ-0218 §Fix 3 — awaitable variant of {@link terminateSidecar} that
 * resolves only after the OS process has actually exited (or the given
 * timeout elapses).  Needed by `deleteGpuTool()` which unlinks the CUDA
 * DLLs from disk: Windows refuses `unlink` on a DLL that any live
 * process has mapped, so the delete has to wait for the sidecar's
 * memory image to be torn down first (RES-0217 §3).
 *
 * Sequence:
 *   1. If no live sidecar exists → resolve immediately.
 *   2. Send `{cmd: 'shutdown'}` on stdin so the sidecar's own `main()`
 *      loop exits cleanly (frees CUDA DLL handles as part of Python
 *      interpreter teardown).
 *   3. After a short grace period, escalate to `kill()` if still alive.
 *   4. Resolve on the 'exit' event, OR after `timeoutMs` elapses —
 *      whichever comes first.  On timeout, force `SIGKILL`-equivalent
 *      via `kill('SIGKILL')` and resolve regardless: `deleteGpuTool()`
 *      will then attempt `rmSync` anyway and the caller surfaces the
 *      EPERM (if any) via the standard error path.
 *
 * Deliberately does NOT reject on timeout — the caller wants a
 * best-effort "sidecar should be gone by now" signal, not a hard
 * contract that the process is definitely dead.
 */
export async function terminateSidecarAndWait(timeoutMs = 3000): Promise<void> {
  const proc = sidecarProcess
  if (!proc || proc.killed) {
    // Clear module state defensively — if the caller races with an
    // exit event we may already be here without a live proc.
    sidecarProcess = null
    pendingCallback = null
    return
  }

  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(gracefulTimer)
      clearTimeout(hardTimer)
      // The proc's own 'exit' handler (installed in ensureSidecar) will
      // clear module state via the ownership-check path.  We do NOT
      // clear it here to avoid a double-clear race.
      resolve()
    }

    proc.once('exit', finish)

    // Try graceful shutdown first — the sidecar's `main()` loop reads
    // `{cmd: 'shutdown'}` and breaks out cleanly, letting the Python
    // interpreter run atexit hooks that unload the CUDA DLLs.
    try {
      proc.stdin?.write(JSON.stringify({ cmd: 'shutdown' }) + '\n')
    } catch {
      /* stdin may already be closed; the SIGTERM path below covers it */
    }

    // Escalate to SIGTERM after a short grace period if the sidecar
    // has not exited on its own.  1 second is enough for a healthy
    // Python interpreter to complete atexit teardown of 11 CUDA DLLs
    // in local testing; tuning knob if a future rebuild needs longer.
    const gracefulMs = Math.min(1000, Math.floor(timeoutMs / 2))
    const gracefulTimer = setTimeout(() => {
      if (!settled) {
        try { proc.kill() } catch { /* ignore */ }
      }
    }, gracefulMs)

    // Hard deadline — force SIGKILL-equivalent and resolve so the
    // caller (typically `deleteGpuTool`) can proceed to `rmSync`.
    // A DLL still locked at this point will surface as EPERM through
    // the standard error path.
    const hardTimer = setTimeout(() => {
      if (!settled) {
        log.warn(`[sidecar] terminateSidecarAndWait timed out after ${timeoutMs}ms — forcing SIGKILL`)
        try { proc.kill('SIGKILL') } catch { /* ignore */ }
        finish()
      }
    }, timeoutMs)
  })
}

/**
 * REQ-0219 — user-initiated cancel path for a running transcribe.
 *
 * Two responsibilities the IPC layer needs met on every cancel:
 *
 *   1. **The sidecar process really dies.**  A hung sidecar that
 *      ignores `SIGTERM` must still be killed so the user can start a
 *      fresh transcribe.  Reuses `terminateSidecarAndWait(3000)` —
 *      graceful `{cmd:'shutdown'}` → SIGTERM at ~1 s → SIGKILL at 3 s —
 *      so a stuck sidecar is guaranteed to release its handles within
 *      the 3-second deadline.  (Same escalation the GPU-tool delete
 *      path relies on; sharing the helper keeps both call sites in
 *      sync on the ~how do we forcibly stop the sidecar~ contract.)
 *
 *   2. **The main-side `transcribe()` promise settles.**  The renderer
 *      already handles cancel locally (see `services/transcription.ts`
 *      `doCancel` — rejects its own run promise with `Error('Cancelled')`
 *      immediately), but the main-side promise returned by
 *      `transcribe()` was previously left pending forever when the
 *      cancel handler just nulled `pendingCallback`.  That leaked the
 *      `activeRuns` entry in `ipc/transcription.ts` and the parent
 *      `.finally(finish)` never fired.  Fixed here by invoking the
 *      captured callback with `{event:'failed', error:'Cancelled'}`
 *      BEFORE the proc goes away — same `'Cancelled'` sentinel string
 *      that `ffmpeg-burnin.ts:350` / `preview-mix.ts:145` /
 *      `model-downloader.ts:283` use, so any downstream code that
 *      needs to distinguish cancel from error via
 *      `msg.includes('Cancelled')` continues to work.
 *
 * The exit handler installed in `ensureSidecar()` (Fix 1 / Fix 2) will
 * still fire when the proc actually exits, but by then `pendingCallback`
 * is already null so Fix 2 correctly no-ops — no spurious second
 * `failed` event is emitted.  Module state (`sidecarProcess`,
 * `lastGpuEnvValue`) is cleared by that same exit handler, keeping the
 * ownership-check invariant intact.
 */
export async function cancelTranscription(): Promise<void> {
  // Detach the callback FIRST so a late sidecar event (from the
  // 1-second graceful window) or the imminent exit handler cannot
  // fire it a second time.  Captured local `cb` is what we invoke.
  const cb = pendingCallback
  pendingCallback = null
  if (cb) {
    log.info('[sidecar] cancelTranscription — settling in-flight transcribe with Cancelled')
    cb({ event: 'failed', error: 'Cancelled' })
  }
  await terminateSidecarAndWait(3000)
}

