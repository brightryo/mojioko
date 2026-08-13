import { app } from 'electron'
import { ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { existsSync } from 'fs'
import { spawnProcess } from '../lib/child-process'
import { getPythonExecutable, getTranslateSidecarPath, getTranscriberExePath } from '../lib/paths'
import { pickTranslateSpawn } from './translate-spawn'
import type { TranslateResult, TranslationTarget } from '../../shared/translation'
import log from '../lib/logger'

/**
 * REQ-0410 — resident MADLAD-400 translation sidecar manager (prototype).
 *
 * Spawns `python-sidecar/translate.py` ONCE and keeps it resident so the
 * CTranslate2 model + SentencePiece tokenizer load a single time; subsequent
 * requests are warm.  Requests/responses are matched by an integer `id` over
 * the same line-delimited JSON protocol the transcription sidecar uses.
 *
 * The live process is keyed by `<modelDir>|<device>`.  When the active tool or
 * the processing device changes, the old process is torn down and a fresh one
 * spawned on the next request — mirroring `transcription-sidecar.ts`'s
 * respawn-on-accelerator-change behaviour.
 *
 * Prototype scope (REQ-0410): translations are shown in a throwaway inspector
 * field and never persisted, so this manager holds no state beyond the loaded
 * model and the in-flight request map.
 */

export interface TranslateSpawnConfig {
  /** Directory of the active tool (contains model.bin, spiece.model, …). */
  modelDir: string
  /** 'cpu' or 'cuda' — follows the app processing-device setting. */
  device: 'cpu' | 'cuda'
  /** Optional folder of bundled CUDA DLLs, injected only for device='cuda'. */
  gpuDir?: string | null
}

interface Pending {
  /** Resolve with the raw sidecar response object; each caller shapes it. */
  resolve: (msg: Record<string, unknown>) => void
  reject: (error: Error) => void
}

/** REQ-0430 — bulk translate result: one output per input, plus timings. */
export interface TranslateBatchResult {
  texts: string[]
  loadMs: number
  translateMs: number
}

let sidecarProcess: ChildProcess | null = null
/** `<modelDir>|<device>` of the live process, or '' when none is spawned. */
let liveKey = ''
let seq = 0
const pending = new Map<number, Pending>()

function keyFor(config: TranslateSpawnConfig): string {
  return `${config.modelDir}|${config.device}`
}

/** Reject every in-flight request and drop the live process reference. */
function teardown(reason?: Error): void {
  const err = reason ?? new Error('translation sidecar torn down')
  for (const p of pending.values()) p.reject(err)
  pending.clear()
  const proc = sidecarProcess
  sidecarProcess = null
  liveKey = ''
  if (proc && !proc.killed) {
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Resolve the live spawn target from the real app/paths state.  The pure
 * decision lives in {@link pickTranslateSpawn} (electron-free, unit-tested);
 * this just feeds it the real electron/paths values.
 */
function resolveTranslateSpawn(): ReturnType<typeof pickTranslateSpawn> {
  return pickTranslateSpawn({
    isPackaged: app.isPackaged,
    bundledExe: getTranscriberExePath(),
    pythonExe: getPythonExecutable(),
    translateScript: getTranslateSidecarPath(),
  })
}

function spawnSidecar(config: TranslateSpawnConfig): ChildProcess {
  // REQ-0494 — packaged builds spawn the bundled PyInstaller exe with the
  // `translate` subcommand; dev spawns `.venv` python + translate.py.  Throws
  // PYTHON_MISSING only when neither is available.
  const target = resolveTranslateSpawn()
  if (target.mode === 'venv' && !existsSync(target.args[0])) {
    throw new Error(`SIDECAR_ERROR: translate.py not found at ${target.args[0]}`)
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    MOJIOKO_TRANSLATION_MODEL_DIR: config.modelDir,
    MOJIOKO_TRANSLATION_DEVICE: config.device,
  }
  if (config.device === 'cuda' && config.gpuDir) {
    env.MOJIOKO_GPU_TOOL_DIR = config.gpuDir
  }

  log.info(`[translate-sidecar] spawning: ${target.exe} ${target.args.join(' ')} (mode=${target.mode}, device=${config.device})`)
  const proc = spawnProcess(target.exe, target.args, { env })
  sidecarProcess = proc
  liveKey = keyFor(config)

  const rl = createInterface({ input: proc.stdout! })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      log.warn(`[translate-sidecar] unparsable stdout: ${line}`)
      return
    }
    if (msg.event === 'ready') return
    const id = msg.id as number | undefined
    if (typeof id !== 'number') return
    const waiter = pending.get(id)
    if (!waiter) return
    pending.delete(id)
    if (msg.ok) {
      waiter.resolve(msg)
    } else {
      waiter.reject(new Error(String(msg.error ?? 'translation failed')))
    }
  })

  proc.stderr?.on('data', (chunk: Buffer) => {
    log.debug(`[translate-sidecar stderr] ${chunk.toString().trim()}`)
  })

  proc.on('exit', (code) => {
    // Only tear down if THIS process is still the live one — a respawn
    // reassigns `sidecarProcess` before the old proc's exit event lands.
    if (sidecarProcess !== proc) return
    log.info(`[translate-sidecar] exited with code ${code}`)
    teardown(new Error(`translation sidecar exited (code=${code ?? 'null'})`))
  })

  proc.on('error', (err) => {
    if (sidecarProcess !== proc) return
    log.error('[translate-sidecar] process error', err)
    teardown(err)
  })

  return proc
}

/**
 * Translate `text` into the sidecar's target language, spawning or respawning
 * the resident process as needed.  Resolves with the translated text plus the
 * load/inference timings (loadMs is 0 when the process was already warm).
 */
/** Spawn / respawn the resident sidecar as needed for `config`; returns it. */
function ensureSidecar(config: TranslateSpawnConfig): ChildProcess {
  const desiredKey = keyFor(config)
  if (!sidecarProcess || sidecarProcess.killed || liveKey !== desiredKey) {
    if (sidecarProcess) {
      log.info(`[translate-sidecar] config changed (was=${liveKey} now=${desiredKey}) — respawning`)
    }
    teardown()
    spawnSidecar(config)
  }
  if (!sidecarProcess) {
    throw new Error('SIDECAR_ERROR: sidecar not available after spawn')
  }
  return sidecarProcess
}

/** Send one request and await its raw response, matched by an integer `id`. */
function sendRequest(proc: ChildProcess, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = ++seq
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    proc.stdin!.write(JSON.stringify({ id, ...payload }) + '\n', 'utf-8', (err) => {
      if (err) {
        pending.delete(id)
        reject(new Error(`SIDECAR_ERROR: failed to send request: ${err.message}`))
      }
    })
  })
}

export async function translateText(
  text: string,
  // REQ-0426 — was fixed 'en'; now any curated MADLAD target code.  The value
  // is written verbatim to the sidecar which builds the `<2xx>` token.
  target: TranslationTarget,
  config: TranslateSpawnConfig,
): Promise<TranslateResult> {
  const proc = ensureSidecar(config)
  const msg = await sendRequest(proc, { text, target })
  return {
    text: String(msg.text ?? ''),
    loadMs: typeof msg.loadMs === 'number' ? msg.loadMs : 0,
    translateMs: typeof msg.translateMs === 'number' ? msg.translateMs : 0,
  }
}

/**
 * REQ-0430 — translate a list of sources in ONE sidecar round-trip
 * (CTranslate2 `translate_batch`).  Output order matches the input order.
 */
export async function translateBatch(
  texts: string[],
  target: TranslationTarget,
  config: TranslateSpawnConfig,
): Promise<TranslateBatchResult> {
  const proc = ensureSidecar(config)
  const msg = await sendRequest(proc, { texts, target })
  return {
    texts: Array.isArray(msg.texts) ? (msg.texts as unknown[]).map((v) => String(v ?? '')) : [],
    loadMs: typeof msg.loadMs === 'number' ? msg.loadMs : 0,
    translateMs: typeof msg.translateMs === 'number' ? msg.translateMs : 0,
  }
}

/** Tear down the resident process (called on app quit). */
export function terminateTranslationSidecar(): void {
  teardown()
}
