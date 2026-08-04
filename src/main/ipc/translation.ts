import { ipcMain } from 'electron'
import { join } from 'path'
import { Channels } from '../../shared/ipc-channels'
import { getTranslationToolsDir, getPythonExecutable } from '../lib/paths'
import { loadSettings } from '../services/settings-store'
import { isToolInstalled } from '../services/translation-tool-store'
import { getEffectiveGpuToolDir } from '../services/gpu-tool'
import { translateText } from '../services/translation-sidecar'
import { isTranslationToolId } from '../../shared/translation-tools'
import type { IpcResult } from '../../shared/types'
import {
  buildDepsMissingMessage,
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
export function registerTranslationHandlers(): void {
  ipcMain.handle(
    Channels.translationTranslate,
    async (_event, text: string): Promise<IpcResult<TranslateResult>> => {
      const fail = (code: TranslateErrorCode, message: string): IpcResult<TranslateResult> => ({
        ok: false,
        error: { code, message },
      })

      const settings = await loadSettings()
      const activeId = settings.translationToolActiveId ?? null
      const toolsDir = getTranslationToolsDir()
      if (!activeId || !isTranslationToolId(activeId) || !isToolInstalled(activeId, toolsDir)) {
        return fail('NO_ACTIVE_TOOL', 'No active translation tool')
      }

      // Device follows the app processing-device setting.  `getEffectiveGpuToolDir`
      // returns the CUDA folder only when the GPU card is selected AND the tools
      // are installed — the exact same gate the transcription sidecar uses — so a
      // CPU-selected machine translates on CPU.
      const gpuDir = await getEffectiveGpuToolDir()
      const device: 'cpu' | 'cuda' = gpuDir ? 'cuda' : 'cpu'
      const modelDir = join(toolsDir, activeId)

      try {
        const result = await translateText(text, 'en', { modelDir, device, gpuDir })
        return { ok: true, data: result }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('PYTHON_MISSING')) {
          log.error(`[ipc/translation] translate failed (PYTHON_MISSING): ${message}`)
          return fail('PYTHON_MISSING', message)
        }
        // REQ-0411 — a missing Python dependency (e.g. sentencepiece not yet
        // pip-installed) surfaces as a plain "No module named …" string.  Map
        // it to a dedicated code + an actionable install command so the user
        // can fix it instead of seeing a generic "translation failed".
        if (isDepsMissingError(message)) {
          const py = getPythonExecutable() ?? ''
          const detail = buildDepsMissingMessage(py, detectMissingPythonModule(message))
          log.error(`[ipc/translation] translate failed (SIDECAR_DEPS_MISSING): ${message} -> ${detail}`)
          return fail('SIDECAR_DEPS_MISSING', detail)
        }
        log.error(`[ipc/translation] translate failed (SIDECAR_ERROR): ${message}`)
        return fail('SIDECAR_ERROR', message)
      }
    },
  )
}
