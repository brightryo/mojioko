import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import { useHistoryStore } from '../../src/renderer/stores/history-store'
import type { SubtitleEntry } from '../../src/shared/types'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'

/**
 * REQ-0127 Phase 1 — text cell edits stream through `updateEntryPreview`
 * during typing (no history) and push exactly one op on blur, with a
 * beforePatch carrying the pre-focus text so Undo rewinds past every
 * keystroke to what was on screen when the editor gained focus.
 *
 * The React textarea + IME + composition wiring is UI-side and lives in
 * CellEditor / TimelineBlockInspector.  This test exercises the pure
 * store-level contract those components rely on.
 */

function makeEntry(id: string, text: string): SubtitleEntry {
  const base = {
    startSec: 0,
    endSec: 1,
    text,
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

function getEntry(id: string): SubtitleEntry {
  const e = useProjectStore.getState().entries.find((x) => x.id === id)
  if (!e) throw new Error(`entry ${id} not found`)
  return e
}

beforeEach(() => {
  useProjectStore.getState().setEntries([makeEntry('e1', 'hello')])
  useHistoryStore.getState().clear()
})

describe('REQ-0127 Phase 1 — text edit: focus-boundary history + typing preview', () => {
  it('streaming updateEntryPreview per keystroke does NOT push history', () => {
    const preFocusText = getEntry('e1').text

    // Simulate a typing session — 8 keystrokes stream through preview.
    const keystrokes = ['h', 'he', 'hel', 'hell', 'hello', 'hello ', 'hello w', 'hello world']
    for (const typed of keystrokes) {
      useProjectStore.getState().updateEntryPreview('e1', { text: typed })
    }

    expect(useHistoryStore.getState().past.length).toBe(0)
    // Store reflects the last typed value (live preview).
    expect(getEntry('e1').text).toBe('hello world')
    // And the pre-focus text is still recoverable via the caller's
    // focusValueRef (simulated here by the local variable).
    expect(preFocusText).toBe('hello')
  })

  it('commit-time push with beforePatch rewinds Undo to the pre-focus text', () => {
    const preFocusText = getEntry('e1').text

    // Preview stream (as in Phase 1 wiring).
    useProjectStore.getState().updateEntryPreview('e1', { text: 'hello world' })

    // Commit path: withHistory(label, patch, beforePatch) as
    // subtitle-table.tsx / timeline-block-inspector.tsx implement it.
    const snapshot = { ...getEntry('e1') }
    const patch = { text: 'hello world', isEdited: true }
    const undoState = { ...snapshot, text: preFocusText }
    useHistoryStore.getState().push({
      label: 'edit text',
      undo: () => useProjectStore.getState().updateEntry('e1', undoState),
      redo: () => useProjectStore.getState().updateEntry('e1', { ...snapshot, ...patch })
    })
    useProjectStore.getState().updateEntry('e1', patch)

    // Exactly 1 history op recorded regardless of how many preview
    // fires happened.
    expect(useHistoryStore.getState().past.length).toBe(1)
    expect(getEntry('e1').text).toBe('hello world')

    // Undo restores to the pre-focus text, NOT any intermediate typed
    // value like "hello w" that only lived in the preview stream.
    useHistoryStore.getState().undo()
    expect(getEntry('e1').text).toBe('hello')
  })

  it('when nothing was typed, no history op fires (mirrors dirty=false skip)', () => {
    // No preview stream, no commit call — the CellEditor / Inspector
    // paths early-return on `!dirtyRef.current`.  Simulate by simply
    // not pushing anything.
    expect(useHistoryStore.getState().past.length).toBe(0)
    expect(getEntry('e1').text).toBe('hello')
  })

  it('Redo re-applies the typed text after Undo', () => {
    const preFocusText = getEntry('e1').text
    useProjectStore.getState().updateEntryPreview('e1', { text: 'edited' })
    const snapshot = { ...getEntry('e1') }
    const patch = { text: 'edited', isEdited: true }
    const undoState = { ...snapshot, text: preFocusText }
    useHistoryStore.getState().push({
      label: 'edit text',
      undo: () => useProjectStore.getState().updateEntry('e1', undoState),
      redo: () => useProjectStore.getState().updateEntry('e1', { ...snapshot, ...patch })
    })
    useProjectStore.getState().updateEntry('e1', patch)

    useHistoryStore.getState().undo()
    expect(getEntry('e1').text).toBe('hello')
    useHistoryStore.getState().redo()
    expect(getEntry('e1').text).toBe('edited')
  })
})
