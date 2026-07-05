import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import { useHistoryStore } from '../../src/renderer/stores/history-store'
import type { SubtitleEntry } from '../../src/shared/types'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'

/**
 * REQ-0125 — `updateEntryPreview` / `updateEntriesPreview` mirror
 * `updateEntry` (including the auto-recompute of `isEdited`) but must
 * NOT push to the history-store, so a color-picker S/V drag can stream
 * onChange fires into the store without spamming Undo.
 */

function makeEntry(id: string, initialColor: string): SubtitleEntry {
  const base = {
    startSec: 0,
    endSec: 1,
    text: 'x',
    fontSizePx: 64,
    textColorHex: initialColor,
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

function getEntry(id: string): SubtitleEntry {
  const e = useProjectStore.getState().entries.find((x) => x.id === id)
  if (!e) throw new Error(`entry ${id} not found`)
  return e
}

beforeEach(() => {
  useProjectStore.getState().setEntries([
    makeEntry('e1', '#FFFFFF'),
    makeEntry('e2', '#FFFFFF'),
    makeEntry('e3', '#FF0000')
  ])
  useHistoryStore.getState().clear()
})

describe('REQ-0125 — updateEntryPreview (single entry, history-less)', () => {
  it('writes the patch into the target entry', () => {
    useProjectStore.getState().updateEntryPreview('e1', { textColorHex: '#00FF00' })
    expect(getEntry('e1').textColorHex).toBe('#00FF00')
  })

  it('leaves other entries untouched', () => {
    useProjectStore.getState().updateEntryPreview('e1', { textColorHex: '#00FF00' })
    expect(getEntry('e2').textColorHex).toBe('#FFFFFF')
    expect(getEntry('e3').textColorHex).toBe('#FF0000')
  })

  it('recomputes isEdited exactly like updateEntry', () => {
    useProjectStore.getState().updateEntryPreview('e1', { textColorHex: '#00FF00' })
    expect(getEntry('e1').isEdited).toBe(true)
    useProjectStore.getState().updateEntryPreview('e1', { textColorHex: '#FFFFFF' })
    expect(getEntry('e1').isEdited).toBe(false)
  })

  it('does NOT push a history op', () => {
    const historyBefore = useHistoryStore.getState().past.length
    for (let i = 0; i < 20; i++) {
      // Simulate a saturation drag: 20 onChange fires in quick succession.
      useProjectStore.getState().updateEntryPreview('e1', {
        textColorHex: `#${(0x00ff00 + i).toString(16).padStart(6, '0').toUpperCase()}`
      })
    }
    const historyAfter = useHistoryStore.getState().past.length
    expect(historyAfter).toBe(historyBefore)
  })
})

describe('REQ-0125 — updateEntriesPreview (bulk, history-less)', () => {
  it('writes the patch into all listed entries', () => {
    useProjectStore.getState().updateEntriesPreview(['e1', 'e2'], { textColorHex: '#00FF00' })
    expect(getEntry('e1').textColorHex).toBe('#00FF00')
    expect(getEntry('e2').textColorHex).toBe('#00FF00')
  })

  it('leaves out-of-set entries untouched', () => {
    useProjectStore.getState().updateEntriesPreview(['e1', 'e2'], { textColorHex: '#00FF00' })
    expect(getEntry('e3').textColorHex).toBe('#FF0000')
  })

  it('accepts a readonly array of ids (spec)', () => {
    const ids: readonly string[] = ['e1', 'e3']
    useProjectStore.getState().updateEntriesPreview(ids, { textColorHex: '#0000FF' })
    expect(getEntry('e1').textColorHex).toBe('#0000FF')
    expect(getEntry('e3').textColorHex).toBe('#0000FF')
    expect(getEntry('e2').textColorHex).toBe('#FFFFFF') // untouched
  })

  it('recomputes isEdited per entry (e3 that was already at original stays at original)', () => {
    // e3's original color is #FF0000; setting it to #FF0000 should leave isEdited=false.
    useProjectStore.getState().updateEntriesPreview(['e1', 'e3'], { textColorHex: '#FF0000' })
    expect(getEntry('e1').isEdited).toBe(true)   // moved from #FFFFFF -> #FF0000
    expect(getEntry('e3').isEdited).toBe(false)  // was already #FF0000
  })

  it('does NOT push a history op even for many rapid fires', () => {
    const historyBefore = useHistoryStore.getState().past.length
    for (let i = 0; i < 30; i++) {
      useProjectStore.getState().updateEntriesPreview(['e1', 'e2', 'e3'], {
        textColorHex: `#${i.toString(16).padStart(6, '0').toUpperCase()}`
      })
    }
    const historyAfter = useHistoryStore.getState().past.length
    expect(historyAfter).toBe(historyBefore)
  })

  it('handles an empty ids array as a no-op', () => {
    useProjectStore.getState().updateEntriesPreview([], { textColorHex: '#00FF00' })
    expect(getEntry('e1').textColorHex).toBe('#FFFFFF')
    expect(getEntry('e2').textColorHex).toBe('#FFFFFF')
    expect(getEntry('e3').textColorHex).toBe('#FF0000')
  })
})

describe('REQ-0125 — Bug 2 workflow (single-entry drag then commit → 1 Undo restores pre-drag)', () => {
  it('simulates 10 onChange preview fires + 1 commit; Undo rewinds to pre-drag color', () => {
    const originalColor = getEntry('e1').textColorHex // "#FFFFFF"

    // === Simulate the S/V drag ===
    for (let i = 0; i < 10; i++) {
      useProjectStore.getState().updateEntryPreview('e1', {
        textColorHex: `#${(0x100000 + i).toString(16).padStart(6, '0').toUpperCase()}`
      })
    }
    const afterDrag = getEntry('e1').textColorHex // last preview
    expect(useHistoryStore.getState().past.length).toBe(0) // no history yet

    // === Simulate applyStyleEdit-like op at popover close ===
    // snapshot has AFTER value (because preview streamed).  beforePatch
    // carries the pre-drag color.  Undo target = { ...snapshot, ...beforePatch }.
    const snapshotAfter = { ...getEntry('e1') }
    const undoState = { ...snapshotAfter, textColorHex: originalColor }
    useHistoryStore.getState().push({
      label: 'edit color',
      undo: () => useProjectStore.getState().updateEntry('e1', undoState),
      redo: () => useProjectStore.getState().updateEntry('e1', { ...snapshotAfter, textColorHex: afterDrag, isEdited: true })
    })
    // Apply the commit patch to store (identical to what applyStyleEdit does).
    useProjectStore.getState().updateEntry('e1', { textColorHex: afterDrag, isEdited: true })

    expect(useHistoryStore.getState().past.length).toBe(1) // exactly 1 history op

    // === Undo should restore to pre-drag color, not to any drag mid-value ===
    useHistoryStore.getState().undo()
    expect(getEntry('e1').textColorHex).toBe(originalColor)
  })
})
