import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import {
  TRANSLATION_TOOLS,
  TRANSLATION_TOOL_IDS,
  getTranslationTool,
  buildToolsState,
  type TranslationToolId,
  type TranslationToolsState,
} from '../../shared/translation-tools'
import { getTranslationToolsDir } from '../lib/paths'

/**
 * REQ-0405 — main-side disk helpers for the translation-tool manager (Phase 1).
 *
 * Mirrors the Whisper model store: a tool is "installed" when its directory
 * exists, carries the `model.meta.json` completion marker (written only after a
 * successful download), AND every declared file is present.  Phase-1 tools are
 * placeholders (empty `files`, `repo: null`) that cannot be downloaded yet, so
 * they read as not-installed unless a directory is placed by hand.
 */

const META_FILE = 'model.meta.json'

export function isToolInstalled(id: TranslationToolId, toolsDir: string): boolean {
  const dir = join(toolsDir, id)
  if (!existsSync(join(dir, META_FILE))) return false
  const def = getTranslationTool(id)
  return def.files.every((f) => existsSync(join(dir, f)))
}

export function toolDirSizeBytes(id: TranslationToolId, toolsDir: string): number {
  const dir = join(toolsDir, id)
  if (!existsSync(dir)) return 0
  let total = 0
  const walk = (p: string): void => {
    for (const name of readdirSync(p)) {
      const child = join(p, name)
      const st = statSync(child)
      if (st.isDirectory()) walk(child)
      else total += st.size
    }
  }
  try {
    walk(dir)
  } catch {
    /* best-effort */
  }
  return total
}

export function installedToolIds(toolsDir: string): TranslationToolId[] {
  return TRANSLATION_TOOL_IDS.filter((id) => isToolInstalled(id, toolsDir))
}

/**
 * Build the renderer-facing state from disk + the persisted active id, clamping
 * a stale active id (its tool no longer installed) to null via the shared
 * `buildToolsState`.
 */
export function buildTranslationToolsState(
  activeId: TranslationToolId | null,
  toolsDir: string = getTranslationToolsDir(),
): TranslationToolsState {
  const installed = installedToolIds(toolsDir)
  const sizeBytes: Partial<Record<TranslationToolId, number>> = {}
  for (const id of installed) sizeBytes[id] = toolDirSizeBytes(id, toolsDir)
  return buildToolsState({ installed, activeId }, { sizeBytes })
}

/** True when the tool has no real download source yet (Phase-1 placeholder). */
export function isToolPlaceholder(id: TranslationToolId): boolean {
  return getTranslationTool(id).repo === null
}

export { TRANSLATION_TOOLS }
