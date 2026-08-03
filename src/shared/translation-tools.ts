/**
 * REQ-0405 — translation-tool registry + pure state machine (Phase 1).
 *
 * The translation engine is **MADLAD-400** (Google, Apache-2.0): one CTranslate2
 * model covers 400+ languages, downloaded on demand exactly like a Whisper model
 * (optional, not bundled).  Phase 1 is management only — download / enable /
 * delete — with NO inference; the real translation (Phase 2) is a separate REQ.
 * See `dev-docs/specs/translation-tool.md`.
 *
 * This module is the single source of truth for the offered sizes and for the
 * lifecycle state transitions, kept pure so the main-process handler and the
 * unit tests exercise the same logic.
 */

export type TranslationToolId = 'madlad400-3b' | 'madlad400-7b' | 'madlad400-10b'

export interface TranslationToolDef {
  id: TranslationToolId
  /** i18n key suffix under `translationTool.*` for the size label. */
  labelKey: string
  /**
   * Approximate int8 download size, bytes.  Placeholder estimate until the real
   * CTranslate2 repo is wired (Phase 1 shows "約 N GB"; the installed size is
   * read from disk once downloaded).
   */
  expectedSizeBytes: number
  /**
   * HuggingFace repo id of the CTranslate2/int8 conversion, or `null` while the
   * tool is a Phase-1 PLACEHOLDER — download is then gated (`not-configured`),
   * so no network call is made until a real repo is set (REQ-0405 §6).
   */
  repo: string | null
  /** CT2 model files to fetch from `repo` (filled when the repo is wired). */
  files: readonly string[]
}

const GB = 1_000_000_000

/**
 * Offered sizes (D4, owner-confirmed): MADLAD-400 3B / 7B / 10B, int8.
 * `repo`/`files` are placeholders (Phase 1) — see the module docblock.
 */
export const TRANSLATION_TOOLS: readonly TranslationToolDef[] = [
  { id: 'madlad400-3b', labelKey: 'size3b', expectedSizeBytes: 3 * GB, repo: null, files: [] },
  { id: 'madlad400-7b', labelKey: 'size7b', expectedSizeBytes: 7 * GB, repo: null, files: [] },
  { id: 'madlad400-10b', labelKey: 'size10b', expectedSizeBytes: 10 * GB, repo: null, files: [] },
]

export const TRANSLATION_TOOL_IDS: readonly TranslationToolId[] = TRANSLATION_TOOLS.map((t) => t.id)

export function isTranslationToolId(x: unknown): x is TranslationToolId {
  return typeof x === 'string' && TRANSLATION_TOOLS.some((t) => t.id === x)
}

export function getTranslationTool(id: TranslationToolId): TranslationToolDef {
  const def = TRANSLATION_TOOLS.find((t) => t.id === id)
  if (!def) throw new Error(`Unknown translation tool: ${id}`)
  return def
}

export type TranslationToolStatus = 'not-downloaded' | 'downloading' | 'downloaded'

export interface TranslationToolInfo {
  id: TranslationToolId
  status: TranslationToolStatus
  /** Actual disk usage, bytes; 0 when not downloaded. */
  sizeBytes: number
  /** Approximate download size shown before install. */
  expectedSizeBytes: number
  /** Whether this tool is the currently enabled one. */
  active: boolean
}

/** The list + active selection surfaced to the renderer (mirrors `ModelsState`). */
export interface TranslationToolsState {
  tools: TranslationToolInfo[]
  activeId: TranslationToolId | null
}

// ---------------------------------------------------------------------------
// Pure state machine (REQ-0405 §4).  `installed` = tool ids present on disk;
// `activeId` = the enabled tool.  The main handler derives `installed` from disk
// and persists `activeId` in settings, then reduces user actions through here.
// ---------------------------------------------------------------------------

export interface ToolMachineState {
  installed: readonly TranslationToolId[]
  activeId: TranslationToolId | null
}

export type ToolAction =
  | { type: 'downloaded'; id: TranslationToolId }
  | { type: 'deleted'; id: TranslationToolId }
  | { type: 'enable'; id: TranslationToolId }
  | { type: 'disable' }

/**
 * Advance the lifecycle by one user action.  Rules (spec §4):
 *  - `downloaded`: mark the tool installed (idempotent).
 *  - `deleted`: remove it; if it was the active one, clear `activeId`.
 *  - `enable`: only a DOWNLOADED tool can be enabled; enabling one implicitly
 *    disables the others (single active).  Enabling a not-downloaded tool is a
 *    no-op.
 *  - `disable`: clear `activeId`.
 * Pure — returns a new state, never mutates the input.
 */
export function reduceToolState(state: ToolMachineState, action: ToolAction): ToolMachineState {
  switch (action.type) {
    case 'downloaded':
      if (state.installed.includes(action.id)) return state
      return { ...state, installed: [...state.installed, action.id] }
    case 'deleted': {
      const installed = state.installed.filter((i) => i !== action.id)
      const activeId = state.activeId === action.id ? null : state.activeId
      return { installed, activeId }
    }
    case 'enable':
      if (!state.installed.includes(action.id)) return state // cannot enable a not-downloaded tool
      return { ...state, activeId: action.id }
    case 'disable':
      return { ...state, activeId: null }
  }
}

/**
 * Derive the renderer-facing {@link TranslationToolsState} from the machine
 * state, an optional set of currently-downloading ids, and an optional map of
 * on-disk sizes.  `activeId` is clamped to a still-installed tool so a stale
 * persisted value never marks a missing tool active.
 */
export function buildToolsState(
  state: ToolMachineState,
  opts: {
    downloading?: readonly TranslationToolId[]
    sizeBytes?: Partial<Record<TranslationToolId, number>>
  } = {},
): TranslationToolsState {
  const downloading = opts.downloading ?? []
  const sizes = opts.sizeBytes ?? {}
  const activeId =
    state.activeId !== null && state.installed.includes(state.activeId) ? state.activeId : null
  const tools: TranslationToolInfo[] = TRANSLATION_TOOLS.map((def) => {
    const installed = state.installed.includes(def.id)
    const status: TranslationToolStatus = installed
      ? 'downloaded'
      : downloading.includes(def.id)
        ? 'downloading'
        : 'not-downloaded'
    return {
      id: def.id,
      status,
      sizeBytes: installed ? (sizes[def.id] ?? 0) : 0,
      expectedSizeBytes: def.expectedSizeBytes,
      active: activeId === def.id,
    }
  })
  return { tools, activeId }
}
