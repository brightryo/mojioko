import { beforeEach, describe, expect, it } from 'vitest'
import { deleteEntryById, softDeleteRow, toggleDeleteRow } from '../../src/renderer/lib/entry-row-actions'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import { useHistoryStore } from '../../src/renderer/stores/history-store'
import type { SubtitleEntry } from '../../src/shared/types'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'

/**
 * REQ-0129 Phase 2 → REQ-0138 — the DEL / Backspace keyboard binding
 * calls `deleteEntryById(selectedEntryId, labels)`.  REQ-0138 changed
 * the semantic from "toggle" (fire on live → delete, fire on deleted →
 * restore) to "delete-only" (fire on live → delete, fire on deleted →
 * no-op).  The inspector's delete/restore button keeps the toggle
 * semantic via a separate `toggleDeleteRow` entry point.
 */

function makeEntry(id: string): SubtitleEntry {
  const base = {
    startSec: 0,
    endSec: 1,
    text: 'x',
    fontSizePx: 64,
    textColorHex: '#ffffff',
    outlineColorHex: '#000000',
    outlineThicknessPx: 2,
    fadeDurationSec: 0,
    fontId: undefined,
    ...makeEntryLayoutDefaults()
  }
  return {
    id,
    ...base,
    isDeleted: false,
    isEdited: false,
    original: { ...base }
  }
}

const DELETE_ONLY_LABELS = { delete: '削除' }
const TOGGLE_LABELS = { delete: '削除', restore: '復元' }

beforeEach(() => {
  useProjectStore.getState().setEntries([makeEntry('e1'), makeEntry('e2')])
  useHistoryStore.getState().clear()
})

describe('REQ-0138 — deleteEntryById is delete-only (was toggle in REQ-0129)', () => {
  it('returns false and pushes no history when selection is null', () => {
    const historyBefore = useHistoryStore.getState().past.length
    const result = deleteEntryById(null, DELETE_ONLY_LABELS)
    expect(result).toBe(false)
    expect(useHistoryStore.getState().past.length).toBe(historyBefore)
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e1')?.isDeleted).toBe(false)
  })

  it('returns false and pushes no history when selection is undefined', () => {
    const result = deleteEntryById(undefined, DELETE_ONLY_LABELS)
    expect(result).toBe(false)
    expect(useHistoryStore.getState().past.length).toBe(0)
  })

  it('returns false and pushes no history when the id does not resolve', () => {
    const result = deleteEntryById('nonexistent-id', DELETE_ONLY_LABELS)
    expect(result).toBe(false)
    expect(useHistoryStore.getState().past.length).toBe(0)
  })

  it('soft-deletes the selected entry and pushes exactly one history op', () => {
    const result = deleteEntryById('e1', DELETE_ONLY_LABELS)
    expect(result).toBe(true)
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e1')?.isDeleted).toBe(true)
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e2')?.isDeleted).toBe(false)
    expect(useHistoryStore.getState().past.length).toBe(1)
  })

  it('Undo restores the deleted entry (single-op contract)', () => {
    deleteEntryById('e1', DELETE_ONLY_LABELS)
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e1')?.isDeleted).toBe(true)
    useHistoryStore.getState().undo()
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e1')?.isDeleted).toBe(false)
  })

  it('REQ-0138 §1.1 — pressing DEL a second time on an already-deleted row is a NO-OP', () => {
    // First DEL: delete succeeds.
    const first = deleteEntryById('e1', DELETE_ONLY_LABELS)
    expect(first).toBe(true)
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e1')?.isDeleted).toBe(true)
    expect(useHistoryStore.getState().past.length).toBe(1)
    // Second DEL: no-op.  `deleteEntryById` returns false so the caller
    // (`use-global-shortcuts`) does not swallow the keystroke, but no
    // silent restore happens.
    const second = deleteEntryById('e1', DELETE_ONLY_LABELS)
    expect(second).toBe(false)
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e1')?.isDeleted).toBe(true)
    expect(useHistoryStore.getState().past.length).toBe(1)
  })

  it('uses the delete label passed in for the history op', () => {
    deleteEntryById('e1', DELETE_ONLY_LABELS)
    const lastOp = useHistoryStore.getState().past.at(-1)
    expect(lastOp?.label).toBe('削除')
  })
})

describe('REQ-0138 — softDeleteRow (delete-only primitive)', () => {
  it('sets isDeleted=true and pushes one op on a live row', () => {
    const e1 = useProjectStore.getState().entries[0]
    softDeleteRow(e1, DELETE_ONLY_LABELS)
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e1')?.isDeleted).toBe(true)
    expect(useHistoryStore.getState().past.length).toBe(1)
    expect(useHistoryStore.getState().past.at(-1)?.label).toBe('削除')
  })

  it('is a no-op on an already-deleted row (no history push, no state change)', () => {
    useProjectStore.getState().updateEntry('e1', { isDeleted: true })
    useHistoryStore.getState().clear()
    const e1 = useProjectStore.getState().entries.find((e) => e.id === 'e1')!
    softDeleteRow(e1, DELETE_ONLY_LABELS)
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e1')?.isDeleted).toBe(true)
    expect(useHistoryStore.getState().past.length).toBe(0)
  })
})

describe('REQ-0138 — toggleDeleteRow (inspector button) still toggles', () => {
  it('flips isDeleted in both directions', () => {
    const e1 = useProjectStore.getState().entries[0]
    toggleDeleteRow(e1, TOGGLE_LABELS)
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e1')?.isDeleted).toBe(true)
    const e1Deleted = useProjectStore.getState().entries.find((e) => e.id === 'e1')!
    toggleDeleteRow(e1Deleted, TOGGLE_LABELS)
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e1')?.isDeleted).toBe(false)
    expect(useHistoryStore.getState().past.length).toBe(2)
    expect(useHistoryStore.getState().past.map((op) => op.label)).toEqual(['削除', '復元'])
  })
})
