import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-059 — `updateEntry` recomputes `isEdited` from value comparison so a
 * round-trip edit (drag away + back, type-revert, bulk-revert) clears the
 * "edited" flag without the caller needing to know it should pass
 * `isEdited: false`.
 */

function makeEntry(): SubtitleEntry {
  const base = {
    startSec: 13.07,
    endSec: 15.5,
    text: 'hello',
    fontSizePx: 64,
    textColorHex: '#ffffff',
    outlineColorHex: '#000000',
    outlineThicknessPx: 2,
    fadeEnabled: false,
    fontId: undefined
  }
  return {
    id: 'e1',
    ...base,
    isDeleted: false,
    isEdited: false,
    original: { ...base }
  }
}

function getEntry(): SubtitleEntry {
  const e = useProjectStore.getState().entries.find((x) => x.id === 'e1')
  if (!e) throw new Error('entry not found')
  return e
}

beforeEach(() => {
  useProjectStore.getState().setEntries([makeEntry()])
})

describe('updateEntry — auto-recompute of isEdited', () => {
  it('flips isEdited to true when a value moves away from original', () => {
    useProjectStore.getState().updateEntry('e1', { startSec: 14.0 })
    expect(getEntry().isEdited).toBe(true)
  })

  it('flips isEdited back to false on a value round-trip', () => {
    useProjectStore.getState().updateEntry('e1', { startSec: 14.0 })
    expect(getEntry().isEdited).toBe(true)
    useProjectStore.getState().updateEntry('e1', { startSec: 13.07 })
    expect(getEntry().isEdited).toBe(false)
  })

  it('ignores sub-cs float drift on a "back to original" timeline drag', () => {
    // Mimic the drag bug: arbitrary float landing close to 13.07.
    useProjectStore.getState().updateEntry('e1', { startSec: 13.0700001 })
    expect(getEntry().isEdited).toBe(false)
  })

  it('ignores a caller-supplied isEdited: true when values match original', () => {
    useProjectStore.getState().updateEntry('e1', { startSec: 13.07, isEdited: true })
    expect(getEntry().isEdited).toBe(false)
  })

  it('forces isEdited: true when caller passes isEdited: false on a real edit', () => {
    useProjectStore.getState().updateEntry('e1', { text: 'changed', isEdited: false })
    expect(getEntry().isEdited).toBe(true)
  })

  it('text edited then reverted clears isEdited', () => {
    useProjectStore.getState().updateEntry('e1', { text: 'something else' })
    expect(getEntry().isEdited).toBe(true)
    useProjectStore.getState().updateEntry('e1', { text: 'hello' })
    expect(getEntry().isEdited).toBe(false)
  })

  it('size + color edits both reverting clears isEdited', () => {
    useProjectStore
      .getState()
      .updateEntry('e1', { fontSizePx: 80, textColorHex: '#ff0000' })
    expect(getEntry().isEdited).toBe(true)
    useProjectStore.getState().updateEntry('e1', { fontSizePx: 64 })
    expect(getEntry().isEdited).toBe(true) // colour still differs
    useProjectStore.getState().updateEntry('e1', { textColorHex: '#ffffff' })
    expect(getEntry().isEdited).toBe(false)
  })

  it('reset patch (full original spread + isEdited: false) computes isEdited = false', () => {
    useProjectStore.getState().updateEntry('e1', { text: 'edited' })
    expect(getEntry().isEdited).toBe(true)
    const { original } = getEntry()
    useProjectStore
      .getState()
      .updateEntry('e1', { ...original, fontId: original.fontId, isEdited: false })
    expect(getEntry().isEdited).toBe(false)
  })
})
