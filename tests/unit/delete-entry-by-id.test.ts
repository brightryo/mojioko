import { beforeEach, describe, expect, it } from 'vitest'
import { deleteEntryById } from '../../src/renderer/lib/entry-row-actions'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import { useHistoryStore } from '../../src/renderer/stores/history-store'
import type { SubtitleEntry } from '../../src/shared/types'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'

/**
 * REQ-0129 Phase 2 — the timeline's DEL / Backspace keyboard binding
 * calls `deleteEntryById(selectedEntryId, labels)`.  The helper is a
 * thin wrapper around `toggleDeleteRow` that handles the lookup + the
 * "nothing selected" edge case; a keyboard shortcut fires
 * unconditionally when the timeline is mounted and a form-tag guard
 * is on (react-hotkeys-hook `enableOnFormTags: false` default), so
 * the store-level guard is the second line of defence.
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

const LABELS = { delete: '削除', restore: '復元' }

beforeEach(() => {
  useProjectStore.getState().setEntries([makeEntry('e1'), makeEntry('e2')])
  useHistoryStore.getState().clear()
})

describe('REQ-0129 Phase 2 — deleteEntryById', () => {
  it('returns false and pushes no history when selection is null', () => {
    const historyBefore = useHistoryStore.getState().past.length
    const result = deleteEntryById(null, LABELS)
    expect(result).toBe(false)
    expect(useHistoryStore.getState().past.length).toBe(historyBefore)
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e1')?.isDeleted).toBe(false)
  })

  it('returns false and pushes no history when selection is undefined', () => {
    const result = deleteEntryById(undefined, LABELS)
    expect(result).toBe(false)
    expect(useHistoryStore.getState().past.length).toBe(0)
  })

  it('returns false and pushes no history when the id does not resolve', () => {
    const result = deleteEntryById('nonexistent-id', LABELS)
    expect(result).toBe(false)
    expect(useHistoryStore.getState().past.length).toBe(0)
  })

  it('soft-deletes the selected entry and pushes exactly one history op', () => {
    const result = deleteEntryById('e1', LABELS)
    expect(result).toBe(true)
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e1')?.isDeleted).toBe(true)
    // Other entries are untouched.
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e2')?.isDeleted).toBe(false)
    expect(useHistoryStore.getState().past.length).toBe(1)
  })

  it('Undo restores the deleted entry (single-op contract)', () => {
    deleteEntryById('e1', LABELS)
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e1')?.isDeleted).toBe(true)
    useHistoryStore.getState().undo()
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e1')?.isDeleted).toBe(false)
  })

  it('pressing DEL a second time on an already-deleted row RESTORES it (toggle)', () => {
    // First DEL: delete
    deleteEntryById('e1', LABELS)
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e1')?.isDeleted).toBe(true)
    // Second DEL: restore (toggle semantic mirrors the inspector trash icon)
    deleteEntryById('e1', LABELS)
    expect(useProjectStore.getState().entries.find((e) => e.id === 'e1')?.isDeleted).toBe(false)
    // Two history ops.
    expect(useHistoryStore.getState().past.length).toBe(2)
  })

  it('uses the labels passed in for the history op (locale-controlled)', () => {
    deleteEntryById('e1', LABELS)
    const lastOp = useHistoryStore.getState().past.at(-1)
    expect(lastOp?.label).toBe('削除')
    useHistoryStore.getState().undo()
    // (labels.restore would only appear if the deleted row was toggled
    // again while flagged deleted, so we don't inspect the restore label
    // here — the previous `pressing DEL a second time` test covers
    // that path implicitly.)
  })
})
