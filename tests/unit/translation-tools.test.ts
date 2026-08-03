import { describe, it, expect } from 'vitest'
import {
  TRANSLATION_TOOLS,
  TRANSLATION_TOOL_IDS,
  isTranslationToolId,
  getTranslationTool,
  reduceToolState,
  buildToolsState,
  type ToolMachineState,
} from '../../src/shared/translation-tools'

/**
 * REQ-0405 §2 — the translation-tool registry + lifecycle state machine
 * (download / enable / delete).  Phase 1 is management-only; these pin the pure
 * transitions the main-process handler reduces user actions through.
 */

describe('translation-tools registry (REQ-0405)', () => {
  it('offers 3B / 7B / 10B (D4)', () => {
    expect(TRANSLATION_TOOL_IDS).toEqual(['madlad400-3b', 'madlad400-7b', 'madlad400-10b'])
  })

  it('every tool is a Phase-1 placeholder (repo null, no files) with a size estimate', () => {
    for (const t of TRANSLATION_TOOLS) {
      expect(t.repo).toBeNull()
      expect(t.files).toEqual([])
      expect(t.expectedSizeBytes).toBeGreaterThan(0)
    }
    // ascending sizes 3B < 7B < 10B
    const sizes = TRANSLATION_TOOLS.map((t) => t.expectedSizeBytes)
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b))
  })

  it('id guard + lookup', () => {
    expect(isTranslationToolId('madlad400-7b')).toBe(true)
    expect(isTranslationToolId('nope')).toBe(false)
    expect(isTranslationToolId(42)).toBe(false)
    expect(getTranslationTool('madlad400-3b').id).toBe('madlad400-3b')
    expect(() => getTranslationTool('x' as never)).toThrow()
  })
})

describe('reduceToolState — lifecycle transitions (REQ-0405 §4)', () => {
  const empty: ToolMachineState = { installed: [], activeId: null }

  it('download marks a tool installed (idempotent)', () => {
    const s1 = reduceToolState(empty, { type: 'downloaded', id: 'madlad400-3b' })
    expect(s1.installed).toEqual(['madlad400-3b'])
    const s2 = reduceToolState(s1, { type: 'downloaded', id: 'madlad400-3b' })
    expect(s2.installed).toEqual(['madlad400-3b']) // no duplicate
  })

  it('enable requires a downloaded tool; enabling one disables the others', () => {
    // Cannot enable a not-downloaded tool.
    expect(reduceToolState(empty, { type: 'enable', id: 'madlad400-3b' }).activeId).toBeNull()

    let s: ToolMachineState = { installed: ['madlad400-3b', 'madlad400-7b'], activeId: null }
    s = reduceToolState(s, { type: 'enable', id: 'madlad400-3b' })
    expect(s.activeId).toBe('madlad400-3b')
    s = reduceToolState(s, { type: 'enable', id: 'madlad400-7b' }) // single active
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
    expect(del.activeId).toBeNull() // was active → cleared
  })

  it('deleting a NON-active tool leaves activeId untouched', () => {
    const s: ToolMachineState = { installed: ['madlad400-3b', 'madlad400-7b'], activeId: 'madlad400-7b' }
    const del = reduceToolState(s, { type: 'deleted', id: 'madlad400-3b' })
    expect(del.installed).toEqual(['madlad400-7b'])
    expect(del.activeId).toBe('madlad400-7b')
  })

  it('does not mutate the input state', () => {
    const frozen = Object.freeze({ installed: Object.freeze(['madlad400-3b']), activeId: null }) as ToolMachineState
    expect(() => reduceToolState(frozen, { type: 'downloaded', id: 'madlad400-7b' })).not.toThrow()
  })
})

describe('buildToolsState — derive renderer state (REQ-0405)', () => {
  it('all not-downloaded initially (fresh install)', () => {
    const state = buildToolsState({ installed: [], activeId: null })
    expect(state.tools.map((t) => t.status)).toEqual(['not-downloaded', 'not-downloaded', 'not-downloaded'])
    expect(state.tools.every((t) => t.sizeBytes === 0 && !t.active)).toBe(true)
    expect(state.activeId).toBeNull()
  })

  it('reflects downloaded + downloading + active, and disk sizes for installed', () => {
    const state = buildToolsState(
      { installed: ['madlad400-3b'], activeId: 'madlad400-3b' },
      { downloading: ['madlad400-7b'], sizeBytes: { 'madlad400-3b': 123 } },
    )
    const byId = new Map(state.tools.map((t) => [t.id, t]))
    expect(byId.get('madlad400-3b')).toMatchObject({ status: 'downloaded', active: true, sizeBytes: 123 })
    expect(byId.get('madlad400-7b')).toMatchObject({ status: 'downloading', active: false, sizeBytes: 0 })
    expect(byId.get('madlad400-10b')).toMatchObject({ status: 'not-downloaded', active: false })
    expect(state.activeId).toBe('madlad400-3b')
  })

  it('clamps a stale activeId that is not installed to null (never marks a missing tool active)', () => {
    const state = buildToolsState({ installed: [], activeId: 'madlad400-10b' })
    expect(state.activeId).toBeNull()
    expect(state.tools.every((t) => !t.active)).toBe(true)
  })
})
