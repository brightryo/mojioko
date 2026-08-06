import { ipcMain } from 'electron'
import { join } from 'path'
import { Channels } from '../../shared/ipc-channels'
import { getTranslationToolsDir, getPythonExecutable } from '../lib/paths'
import { loadSettings } from '../services/settings-store'
import { isToolInstalled } from '../services/translation-tool-store'
import { getEffectiveGpuToolDir } from '../services/gpu-tool'
import { translateText } from '../services/translation-sidecar'
import { isTranslationToolId } from '../../shared/translation-tools'
import type { IpcResult, IpcErr } from '../../shared/types'
import {
  buildDepsMissingMessage,
  coerceTranslationTarget,
  detectMissingPythonModule,
  isDepsMissingError,
  type TranslateResult,
  type TranslateErrorCode,
} from '../../shared/translation'
import log from '../lib/logger'

/**
 * REQ-0410 — one-shot translate handler for the inspector auto-translate
 * prototype.  Resolves the active translation tool from settings, picks the
 * device from the processing-device setting, and hands off to the resident
 * MADLAD sidecar.  The result is returned to the renderer and never persisted.
 *
 * Errors are typed so the renderer can localize them:
 *   NO_ACTIVE_TOOL       — no active tool, or the active tool is not installed
 *   PYTHON_MISSING       — the .venv python is unavailable (dev machines only)
 *   SIDECAR_DEPS_MISSING — the sidecar ran but a Python dep (e.g. sentencepiece)
 *                          is not installed; message carries the pip command
 *   SIDECAR_ERROR        — any other spawn / inference failure
 */
const fail = (code: TranslateErrorCode, message: string): IpcErr => ({
  ok: false,
  error: { code, message },
})

/**
 * Resolve the active-tool spawn config shared by translate + preload, or a
 * typed NO_ACTIVE_TOOL failure when no installed tool is enabled.  Device
 * follows the app processing-device setting (CUDA only when the GPU card is
 * selected AND installed — the same gate the transcription sidecar uses).
 */
async function resolveSpawnConfig(): Promise<
  | { ok: true; config: { modelDir: string; device: 'cpu' | 'cuda'; gpuDir: string | null } }
  | IpcErr
> {
  const settings = await loadSettings()
  const activeId = settings.translationToolActiveId ?? null
  const toolsDir = getTranslationToolsDir()
  if (!activeId || !isTranslationToolId(activeId) || !isToolInstalled(activeId, toolsDir)) {
    return fail('NO_ACTIVE_TOOL', 'No active translation tool')
  }
  const gpuDir = await getEffectiveGpuToolDir()
  const device: 'cpu' | 'cuda' = gpuDir ? 'cuda' : 'cpu'
  return { ok: true, config: { modelDir: join(toolsDir, activeId), device, gpuDir } }
}

/** Map a caught sidecar error to a typed IpcResult failure (shared). */
function mapSidecarError(err: unknown, ctx: string): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('PYTHON_MISSING')) {
    log.error(`[ipc/translation] ${ctx} failed (PYTHON_MISSING): ${message}`)
    return fail('PYTHON_MISSING', message)
  }
  // REQ-0411 — a missing Python dependency (e.g. sentencepiece not yet
  // pip-installed) surfaces as a plain "No module named …" string.  Map it to a
  // dedicated code + an actionable install command.
  if (isDepsMissingError(message)) {
    const py = getPythonExecutable() ?? ''
    const detail = buildDepsMissingMessage(py, detectMissingPythonModule(message))
    log.error(`[ipc/translation] ${ctx} failed (SIDECAR_DEPS_MISSING): ${message} -> ${detail}`)
    return fail('SIDECAR_DEPS_MISSING', detail)
  }
  log.error(`[ipc/translation] ${ctx} failed (SIDECAR_ERROR): ${message}`)
  return fail('SIDECAR_ERROR', message)
}

export function registerTranslationHandlers(): void {
  ipcMain.handle(
    Channels.translationTranslate,
    async (_event, text: string, target?: string): Promise<IpcResult<TranslateResult>> => {
      const resolved = await resolveSpawnConfig()
      if (!resolved.ok) return resolved
      try {
        // REQ-0426 — target language follows the 「翻訳」 settings tab (passed by
        // the renderer); coerce any unknown code back to the default so the
        // sidecar always receives a valid `<2xx>` token.
        const result = await translateText(text, coerceTranslationTarget(target), resolved.config)
        return { ok: true, data: result }
      } catch (err) {
        return mapSidecarError(err, 'translate')
      }
    },
  )

  // REQ-0426 — preload / warm the model so the first inspector translation after
  // enabling 自動翻訳 is not cold.  Warming means running one tiny translate,
  // which triggers the sidecar's `_ensure` (model + tokenizer + CUDA GEMM warm).
  ipcMain.handle(
    Channels.translationPreload,
    async (): Promise<IpcResult<{ loadMs: number }>> => {
      const resolved = await resolveSpawnConfig()
      if (!resolved.ok) return resolved
      try {
        const result = await translateText(' ', 'en', resolved.config)
        return { ok: true, data: { loadMs: result.loadMs } }
      } catch (err) {
        return mapSidecarError(err, 'preload')
      }
    },
  )
}
