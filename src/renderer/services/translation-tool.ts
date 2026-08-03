import type { IpcResult } from '../../shared/types'
import type { TranslationToolId, TranslationToolsState } from '../../shared/translation-tools'

/**
 * REQ-0405 — renderer service wrapper for the translation-tool IPC (Phase 1).
 * Components/stores never touch `window.electronAPI` directly (ARCHITECTURE
 * layering); they call these thin wrappers.
 */

export async function listTranslationTools(): Promise<IpcResult<TranslationToolsState>> {
  return window.electronAPI.translationToolList()
}

export async function downloadTranslationTool(
  toolId: TranslationToolId,
): Promise<IpcResult<{ channelId: string }>> {
  return window.electronAPI.translationToolDownload(toolId)
}

export async function uninstallTranslationTool(
  toolId: TranslationToolId,
): Promise<IpcResult<TranslationToolsState>> {
  return window.electronAPI.translationToolUninstall(toolId)
}

/** Enable a tool (id) or disable translation (null). */
export async function setActiveTranslationTool(
  toolId: TranslationToolId | null,
): Promise<IpcResult<TranslationToolsState>> {
  return window.electronAPI.translationToolSetActive(toolId)
}
