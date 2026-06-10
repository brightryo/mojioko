import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import { useHistoryStore } from '../../src/renderer/stores/history-store'
import { resetRow, toggleDeleteRow } from '../../src/renderer/lib/entry-row-actions'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-062 regression — the timeline inspector's Reset button must
 * actually restore the row's original values, including the typical
 * scenario where the live `startSec` was rounded to cs by a timeline
 * drag (REQ-059) while the `original.startSec` is still the raw
 * sub-cs Whisper float.  Same exact code path the subtitle-table Reset
 * button uses — they share `entry-row-actions.resetRow`.
 *
 * The complementary REQ-062 #2 (Inspector X-close) is a propagation /
 * Radix-popover wiring issue verified by Playwright smoke, not by a
 * pure-function unit test.
 */

function makeEntry(overrides: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const original = {
    startSec: 13.0321, // raw Whisper float — sub-centisecond precision
    endSec: 15.5678,
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
    ...original,
    isDeleted: false,
    isEdited: false,
    original,
    ...overrides
  }
}

function getEntry(): SubtitleEntry {
  const e = useProjectStore.getState().entries.find((x) => x.id === 'e1')
  if (!e) throw new Error('entry not found')
  return e
}

const RESET_LABELS = { reset: 'reset' }

beforeEach(() => {
  useProjectStore.getState().setEntries([makeEntry()])
  useHistoryStore.getState().clear()
})

describe('resetRow — drag-then-reset round-trip', () => {
  it('restores startSec to the original sub-cs float after a cs-aligned drag', () => {
    // Simulate a drag that committed a cs-aligned value into startSec.
    useProjectStore.getState().updateEntry('e1', { startSec: 13.0 })
    expect(getEntry().startSec).toBe(13.0)
    expect(getEntry().isEdited).toBe(true) // 13.0 vs 13.0321 differ in cs (1300 vs 1303)

    // Reset via the shared lib — same call path the inspector uses.
    resetRow(getEntry(), RESET_LABELS)

    expect(getEntry().startSec).toBe(13.0321)
    expect(getEntry().endSec).toBe(15.5678)
    expect(getEntry().isEdited).toBe(false)
  })

  it('restores every field, not just time', () => {
    // Make non-time edits too — exercise text + size + colour.
    useProjectStore.getState().updateEntry('e1', {
      text: 'changed',
      fontSizePx: 80,
      textColorHex: '#ff0000'
    })
    expect(getEntry().isEdited).toBe(true)

    resetRow(getEntry(), RESET_LABELS)

    const e = getEntry()
    expect(e.text).toBe('hello')
    expect(e.fontSizePx).toBe(64)
    expect(e.textColorHex).toBe('#ffffff')
    expect(e.isEdited).toBe(false)
  })

  it('clears a per-row fontId override added after import', () => {
    // Original had `fontId: undefined`.  User picked a different font for
    // this row; reset must drop the override entirely.
    useProjectStore.getState().updateEntry('e1', { fontId: 'noto-sans-jp-semibold' })
    expect(getEntry().fontId).toBe('noto-sans-jp-semibold')
    expect(getEntry().isEdited).toBe(true)

    resetRow(getEntry(), RESET_LABELS)

    expect(getEntry().fontId).toBeUndefined()
    expect(getEntry().isEdited).toBe(false)
  })

  it('restores isDeleted = false even when the row was both deleted and edited', () => {
    useProjectStore.getState().updateEntry('e1', { startSec: 14, isDeleted: true })
    expect(getEntry().isDeleted).toBe(true)

    resetRow(getEntry(), RESET_LABELS)

    expect(getEntry().isDeleted).toBe(false)
    expect(getEntry().startSec).toBe(13.0321)
    expect(getEntry().isEdited).toBe(false)
  })

  it('pushes exactly one history op (undo restores edit, redo restores reset)', () => {
    useProjectStore.getState().updateEntry('e1', { startSec: 13.0, text: 'edited' })
    const beforeReset = { ...getEntry() }

    resetRow(getEntry(), RESET_LABELS)
    const afterReset = { ...getEntry() }

    const history = useHistoryStore.getState()
    expect(history.past.length).toBe(1)
    expect(history.past[0].label).toBe('reset')

    history.undo()
    expect(getEntry().startSec).toBe(beforeReset.startSec)
    expect(getEntry().text).toBe(beforeReset.text)

    history.redo()
    expect(getEntry().startSec).toBe(afterReset.startSec)
    expect(getEntry().text).toBe(afterReset.text)
  })
})

describe('toggleDeleteRow', () => {
  it('toggles isDeleted with the right history label', () => {
    toggleDeleteRow(getEntry(), { delete: 'del', restore: 'res' })
    expect(getEntry().isDeleted).toBe(true)
    expect(useHistoryStore.getState().past.at(-1)?.label).toBe('del')

    toggleDeleteRow(getEntry(), { delete: 'del', restore: 'res' })
    expect(getEntry().isDeleted).toBe(false)
    expect(useHistoryStore.getState().past.at(-1)?.label).toBe('res')
  })
})
