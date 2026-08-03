import { describe, it, expect } from 'vitest'
import {
  TRANSLATION_TOOLS,
  TRANSLATION_TOOL_IDS,
  isTranslationToolId,
  getTranslationTool,
  translationToolFileUrl,
  reduceToolState,
  buildToolsState,
  type ToolMachineState,
  type TranslationToolId,
} from '../../src/shared/translation-tools'

/**
 * REQ-0405 §2 / REQ-0407 — the translation-tool registry + lifecycle state
 * machine + pinned download URLs.  These pin the pure parts the main-process
 * handler/downloader rely on; the fs/network download is owner-verified.
 */

const REQUIRED_FILES = [
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

describe('translation-tools registry (REQ-0407 — 2 tools, real pinned repos)', () => {
  it('offers exactly 3B and 7B (10B dropped)', () => {
    expect(TRANSLATION_TOOL_IDS).toEqual(['madlad400-3b', 'madlad400-7b'])
  })

  it('every tool is pinned: non-null Apache repo + commit revision + required files + size + model.bin sha256', () => {
    for (const t of TRANSLATION_TOOLS) {
      expect(t.repo).toMatch(/^Nextcloud-AI\/madlad400-/) // org-managed, not a personal repo
      expect(t.revision).toMatch(/^[0-9a-f]{40}$/) // pinned commit hash
      expect(t.files).toEqual(REQUIRED_FILES) // full CT2 runtime set
      expect(t.expectedSizeBytes).toBeGreaterThan(1_000_000_000)
      expect(t.modelBinSha256).toMatch(/^[0-9a-f]{64}$/)
    }
    // ascending sizes 3B < 7B
    expect(getTranslationTool('madlad400-3b').expectedSizeBytes)
      .toBeLessThan(getTranslationTool('madlad400-7b').expectedSizeBytes)
  })

  it('id guard + lookup (10B is no longer a valid id)', () => {
    expect(isTranslationToolId('madlad400-7b')).toBe(true)
    expect(isTranslationToolId('madlad400-10b')).toBe(false)
    expect(isTranslationToolId(42)).toBe(false)
    expect(getTranslationTool('madlad400-3b').id).toBe('madlad400-3b')
  })

  it('translationToolFileUrl builds the pinned HF resolve URL', () => {
    const def = getTranslationTool('madlad400-3b')
    expect(translationToolFileUrl(def, 'model.bin')).toBe(
      `https://huggingface.co/${def.repo}/resolve/${def.revision}/model.bin`,
    )
    // every required file resolves to a /<rev>/ pinned URL
    for (const f of def.files) {
      expect(translationToolFileUrl(def, f)).toContain(`/resolve/${def.revision}/`)
    }
  })
})

describe('reduceToolState — lifecycle transitions (REQ-0405 §4)', () => {
  const empty: ToolMachineState = { installed: [], activeId: null }

  it('download marks a tool installed (idempotent)', () => {
    const s1 = reduceToolState(empty, { type: 'downloaded', id: 'madlad400-3b' })
    expect(s1.installed).toEqual(['madlad400-3b'])
    expect(reduceToolState(s1, { type: 'downloaded', id: 'madlad400-3b' }).installed).toEqual(['madlad400-3b'])
  })

  it('enable requires a downloaded tool; enabling one disables the other', () => {
    expect(reduceToolState(empty, { type: 'enable', id: 'madlad400-3b' }).activeId).toBeNull()
    let s: ToolMachineState = { installed: ['madlad400-3b', 'madlad400-7b'], activeId: null }
    s = reduceToolState(s, { type: 'enable', id: 'madlad400-3b' })
    expect(s.activeId).toBe('madlad400-3b')
    s = reduceToolState(s, { type: 'enable', id: 'madlad400-7b' })
    expect(s.activeId).toBe('madlad400-7b')
  })

  it('disable clears the active tool', () => {
    const s: ToolMachineState = { installed: ['madlad400-3b'], activeId: 'madlad400-3b' }
    expect(reduceToolState(s, { type: 'disable' }).activeId).toBeNull()
  })

  it('delete removes the tool; deleting the ACTIVE tool clears activeId', () => {
    const s: ToolMachineState = { installed: ['madlad400-3b', 'madlad400-7b'], activeId: 'madlad400-3b' }
    const del = reduceToolState(s, { type: 'deleted', id: 'madlad400-3b' })
    expect(del.installed).toEqual(['madlad400-7b'])
    expect(del.activeId).toBeNull()
  })

  it('deleting a NON-active tool leaves activeId untouched', () => {
    const s: ToolMachineState = { installed: ['madlad400-3b', 'madlad400-7b'], activeId: 'madlad400-7b' }
    const del = reduceToolState(s, { type: 'deleted', id: 'madlad400-3b' })
    expect(del.activeId).toBe('madlad400-7b')
  })
})

describe('buildToolsState — derive renderer state (REQ-0405/0407)', () => {
  it('all not-downloaded initially (2 tools)', () => {
    const state = buildToolsState({ installed: [], activeId: null })
    expect(state.tools.map((t) => t.status)).toEqual(['not-downloaded', 'not-downloaded'])
    expect(state.activeId).toBeNull()
  })

  it('reflects downloaded + downloading + active, and disk sizes for installed', () => {
    const state = buildToolsState(
      { installed: ['madlad400-3b'], activeId: 'madlad400-3b' },
      { downloading: ['madlad400-7b'], sizeBytes: { 'madlad400-3b': 123 } },
    )
    const byId = new Map(state.tools.map((t) => [t.id, t]))
    expect(byId.get('madlad400-3b')).toMatchObject({ status: 'downloaded', active: true, sizeBytes: 123 })
    expect(byId.get('madlad400-7b')).toMatchObject({ status: 'downloading', active: false })
    expect(state.activeId).toBe('madlad400-3b')
  })

  it('clamps a stale activeId whose tool is not installed to null', () => {
    // e.g. a settings.json that still points at a since-deleted (or old 10B) tool.
    const state = buildToolsState({ installed: [], activeId: 'madlad400-3b' as TranslationToolId })
    expect(state.activeId).toBeNull()
    expect(state.tools.every((t) => !t.active)).toBe(true)
  })
})
