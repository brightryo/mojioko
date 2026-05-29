import { ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { spawnProcess } from '../lib/child-process'
import { getPythonSidecarPath, getPythonExecutable, getTranscriberExePath } from '../lib/paths'
import type { TranscriptionStartRequest, TranscriptionEvent } from '../../shared/ipc-contracts'
import { TranscriptionError } from '../../shared/errors'
import log from '../lib/logger'

export type TranscriptionEventCallback = (event: TranscriptionEvent) => void

let sidecarProcess: ChildProcess | null = null
let pendingCallback: TranscriptionEventCallback | null = null

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
  if (sidecarProcess && !sidecarProcess.killed) {
    return sidecarProcess
  }

  const { exe, args, mode } = resolveSidecarSpawn()

  log.info(`[sidecar] spawning (${mode}): ${exe}`)
  if (args.length > 0) {
    log.info(`[sidecar] script: ${args[0]}`)
  }

  const proc = spawnProcess(exe, args, {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  })

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

    const adv = request.advanced
    const payload = {
      cmd: 'transcribe',
      videoPath: request.videoPath,
      trackIndex: request.trackIndex,
      model: request.modelId,
      modelsDir: request.modelsDir,
      ffmpegPath: request.ffmpegPath,
      vadFilter: adv.vadFilter,
      vadThreshold: adv.vadThreshold,
      minSpeechDurationMs: adv.minSpeechDurationMs,
      minSilenceDurationMs: adv.minSilenceDurationMs,
      beamSize: adv.beamSize,
      language: adv.language
    }

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

export function checkModelInstalled(modelId: string, modelsDir: string): { installed: boolean; sizeMB: number } {
  const modelDir = join(modelsDir, modelId)
  if (!existsSync(modelDir)) return { installed: false, sizeMB: 0 }
  try {
    let totalBytes = 0
    const items = readdirSync(modelDir)
    for (const item of items) {
      try {
        totalBytes += statSync(join(modelDir, item)).size
      } catch { /* ignore */ }
    }
    return { installed: true, sizeMB: Math.round(totalBytes / 1_000_000) }
  } catch {
    return { installed: false, sizeMB: 0 }
  }
}
