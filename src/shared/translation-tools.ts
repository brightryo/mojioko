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

export type TranslationToolId = 'madlad400-3b' | 'madlad400-7b'

export interface TranslationToolDef {
  id: TranslationToolId
  /** i18n key suffix under `translationTool.*` for the size label. */
  labelKey: string
  /**
   * Download size, bytes — the exact sum of `files` at the pinned revision (used
   * for the "約 N GB" estimate before install; the installed size is read from
   * disk once downloaded).
   */
  expectedSizeBytes: number
  /**
   * HuggingFace repo id of the CTranslate2/int8 conversion, or `null` for a
   * placeholder whose download is gated.  REQ-0407 wired both tools to real,
   * Apache-2.0, org-managed (Nextcloud-AI) repos, so `repo` is now non-null.
   */
  repo: string | null
  /**
   * REQ-0407 — the commit hash to PIN the download to, so a later force-push /
   * re-quantization of the repo can never change what a given app version
   * fetches.  `null` only for a placeholder.
   */
  revision: string | null
  /** CT2 model files to fetch from `repo@revision` (all required for runtime). */
  files: readonly string[]
  /** sha256 of `model.bin` at the pinned revision, verified after download. */
  modelBinSha256?: string
}

/** Base URL for the HuggingFace `resolve` endpoint (public, no auth). */
export const HF_RESOLVE_BASE = 'https://huggingface.co'

/**
 * The CTranslate2 runtime files a MADLAD-400 tool needs.  Both tools share the
 * same layout (verified via the HF tree API at pin time).  README / .gitattr /
 * safetensors index are intentionally excluded — not needed to run.
 */
const CT2_FILES: readonly string[] = [
  'model.bin',
  'config.json',
  'shared_vocabulary.json',
  'spiece.model',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'generation_config.json',
]

/**
 * Offered sizes (REQ-0405 D4 → REQ-0407): MADLAD-400 **3B / 7B** (int8 CT2).
 * 10B was dropped — no int8 CT2 conversion exists (fp32 43 GB is impractical).
 * Both repos are Nextcloud-AI org-managed (lower disappearance risk than a
 * personal repo), Apache-2.0 (commercial OK), pinned by `revision`.
 * `expectedSizeBytes` / `modelBinSha256` were read from the pinned revisions.
 */
export const TRANSLATION_TOOLS: readonly TranslationToolDef[] = [
  {
    id: 'madlad400-3b',
    labelKey: 'size3b',
    repo: 'Nextcloud-AI/madlad400-3b-mt-ct2-int8',
    revision: 'aa32bbdeba7880eff2096ec044cb155a340a9400',
    files: CT2_FILES,
    expectedSizeBytes: 2_976_755_501,
    modelBinSha256: '77b9fd9ab97c1259d07089b5f854393dad81bc5fb5647d3f9a5d101c94f40daa',
  },
  {
    id: 'madlad400-7b',
    labelKey: 'size7b',
    repo: 'Nextcloud-AI/madlad400-7b-mt-bt-ct2-int8',
    revision: '35c8ee23db1906ef28970fe7e6e9c4dfbe8a39d7',
    files: CT2_FILES,
    expectedSizeBytes: 8_338_927_875,
    modelBinSha256: '028675a47ec8a287161d24c01a62796595124d48e9972eacba4b08150ef09ba5',
  },
]

export const TRANSLATION_TOOL_IDS: readonly TranslationToolId[] = TRANSLATION_TOOLS.map((t) => t.id)

/**
 * REQ-0407 — the pinned HuggingFace `resolve` URL for one file of a tool:
 * `https://huggingface.co/<repo>/resolve/<revision>/<file>`.  Pure + testable so
 * the URL construction is pinned by a unit test.  Throws for a placeholder
 * (no repo/revision) — the caller gates on that before downloading.
 */
export function translationToolFileUrl(def: TranslationToolDef, file: string): string {
  if (def.repo === null || def.revision === null) {
    throw new Error(`Translation tool ${def.id} has no download source`)
  }
  return `${HF_RESOLVE_BASE}/${def.repo}/resolve/${def.revision}/${file}`
}

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
  /** REQ-0408 — footer figures for the `translation-tools` directory. */
  totalUsedBytes: number
  diskFreeBytes: number
  diskDrive: string
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
    /** REQ-0408 — disk figures for the footer (main process fills these in). */
    diskFreeBytes?: number
    diskDrive?: string
  } = {},
): TranslationToolsState {
  const downloading = opts.downloading ?? []
  const sizes = opts.sizeBytes ?? {}
  const activeId =
    state.activeId !== null && state.installed.includes(state.activeId) ? state.activeId : null
  let totalUsedBytes = 0
  const tools: TranslationToolInfo[] = TRANSLATION_TOOLS.map((def) => {
    const installed = state.installed.includes(def.id)
    const status: TranslationToolStatus = installed
      ? 'downloaded'
      : downloading.includes(def.id)
        ? 'downloading'
        : 'not-downloaded'
    const sizeBytes = installed ? (sizes[def.id] ?? 0) : 0
    totalUsedBytes += sizeBytes
    return {
      id: def.id,
      status,
      sizeBytes,
      expectedSizeBytes: def.expectedSizeBytes,
      active: activeId === def.id,
    }
  })
  return {
    tools,
    activeId,
    totalUsedBytes,
    diskFreeBytes: opts.diskFreeBytes ?? 0,
    diskDrive: opts.diskDrive ?? '',
  }
}
