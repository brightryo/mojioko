import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import { useHistoryStore } from '../../src/renderer/stores/history-store'
import type { SubtitleEntry } from '../../src/shared/types'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'

/**
 * REQ-0251 案件B — preview subtitle drag undo/redo.
 *
 * Simulates the exact flow used by video-preview-panel's drag handlers:
 *   1. pointerdown → snapshot entry
 *   2. pointermove → store.updateEntry({ posX, posY }) many times
 *   3. pointerup  → push history op { undo: restore-snapshot, redo: apply-final }
 *
 * The tests characterize the round-trip so we can prove Undo lands on the
 * pre-drag position and Redo lands on the post-drag position for both the
 * pinned and unpinned starting states.
 */

function makeEntry(id: string, overrides: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base = {
    startSec: 0,
    endSec: 1,
    text: 'x',
    fontSizePx: 64,
    textColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    outlineThicknessPx: 2,
    fadeDurationSec: 0,
    fontId: undefined,
    ...makeEntryLayoutDefaults(),
  }
  const entry: SubtitleEntry = {
    id,
    ...base,
    ...overrides,
    isDeleted: false,
    isEdited: false,
    original: { ...base },
  }
  return entry
}

function getEntry(id: string): SubtitleEntry {
  const e = useProjectStore.getState().entries.find((x) => x.id === id)
  if (!e) throw new Error(`entry ${id} not found`)
  return e
}

/**
 * Simulates the drag lifecycle implemented in video-preview-panel.tsx
 * (handleOverlayPointerDown → handleWindowPointerMove → handleWindowPointerUp)
 * after the REQ-0251 案件B fix.  Captures only posX/posY as explicit-key
 * fields so the Undo patch always includes both keys — even when the
 * pre-drag entry was unpinned and its posX/posY were `undefined`.
 */
function simulateDrag(
  entryId: string,
  intermediatePositions: Array<{ x: number; y: number }>,
  final: { x: number; y: number } | null,
): void {
  // pointerdown: capture pre-drag posX/posY as explicit keys.
  const draggedEntry = getEntry(entryId)
  const beforePosX = draggedEntry.posX
  const beforePosY = draggedEntry.posY

  // pointermove: write each intermediate position.
  for (const p of intermediatePositions) {
    useProjectStore.getState().updateEntry(entryId, { posX: p.x, posY: p.y })
  }
  // Final pointermove writes the release position (skipped when null =
  // no-effect drag).
  if (final !== null) {
    useProjectStore.getState().updateEntry(entryId, { posX: final.x, posY: final.y })
  }

  // pointerup: read final entry, build before/after patches, push once.
  const finalEntry = getEntry(entryId)
  const beforePatch = { posX: beforePosX, posY: beforePosY }
  const afterPatch = { posX: finalEntry.posX, posY: finalEntry.posY }
  // No-op guard mirrors the fix in handleWindowPointerUp.
  if (beforePatch.posX === afterPatch.posX && beforePatch.posY === afterPatch.posY) return
  useHistoryStore.getState().push({
    label: 'drag position',
    undo: () => useProjectStore.getState().updateEntry(entryId, beforePatch),
    redo: () => useProjectStore.getState().updateEntry(entryId, afterPatch),
  })
}

beforeEach(() => {
  useHistoryStore.getState().clear()
})

describe('REQ-0251 案件B — preview drag Undo/Redo (unpinned → pinned)', () => {
  it('drags an unpinned entry and Undo restores pre-drag (posX/posY undefined)', () => {
    useProjectStore.getState().setEntries([makeEntry('e1')]) // posX/posY undef by default
    expect(getEntry('e1').posX).toBeUndefined()
    expect(getEntry('e1').posY).toBeUndefined()

    simulateDrag('e1', [{ x: 50, y: 60 }, { x: 80, y: 90 }], { x: 100, y: 120 })
    expect(getEntry('e1').posX).toBe(100)
    expect(getEntry('e1').posY).toBe(120)

    useHistoryStore.getState().undo()
    expect(getEntry('e1').posX).toBeUndefined()
    expect(getEntry('e1').posY).toBeUndefined()

    useHistoryStore.getState().redo()
    expect(getEntry('e1').posX).toBe(100)
    expect(getEntry('e1').posY).toBe(120)
  })
})

describe('REQ-0251 案件B — preview drag Undo/Redo (pinned → pinned)', () => {
  it('drags an already-pinned entry and Undo restores the original pinned pos', () => {
    useProjectStore.getState().setEntries([makeEntry('e1', { posX: 10, posY: 20 })])
    expect(getEntry('e1').posX).toBe(10)
    expect(getEntry('e1').posY).toBe(20)

    simulateDrag('e1', [{ x: 200, y: 300 }], { x: 400, y: 500 })
    expect(getEntry('e1').posX).toBe(400)
    expect(getEntry('e1').posY).toBe(500)

    useHistoryStore.getState().undo()
    expect(getEntry('e1').posX).toBe(10)
    expect(getEntry('e1').posY).toBe(20)

    useHistoryStore.getState().redo()
    expect(getEntry('e1').posX).toBe(400)
    expect(getEntry('e1').posY).toBe(500)
  })
})

describe('REQ-0251 案件B — sequential drags stack as independent Undo units', () => {
  it('two drags → two Undos → each one restores its own before-state', () => {
    useProjectStore.getState().setEntries([makeEntry('e1')])

    // Drag 1: undef → (100, 100)
    simulateDrag('e1', [], { x: 100, y: 100 })
    // Drag 2: (100, 100) → (200, 200)
    simulateDrag('e1', [], { x: 200, y: 200 })

    expect(getEntry('e1').posX).toBe(200)
    expect(getEntry('e1').posY).toBe(200)

    useHistoryStore.getState().undo() // undo drag 2
    expect(getEntry('e1').posX).toBe(100)
    expect(getEntry('e1').posY).toBe(100)

    useHistoryStore.getState().undo() // undo drag 1
    expect(getEntry('e1').posX).toBeUndefined()
    expect(getEntry('e1').posY).toBeUndefined()
  })
})

describe('REQ-0251 案件B — no-op drag (same before/after) skips history push', () => {
  it('drag that returns to the starting position pushes no history op', () => {
    useProjectStore.getState().setEntries([makeEntry('e1', { posX: 50, posY: 60 })])
    const historyBefore = useHistoryStore.getState().past.length
    // Move through intermediate positions but land back on (50, 60).
    simulateDrag('e1', [{ x: 200, y: 300 }], { x: 50, y: 60 })
    expect(useHistoryStore.getState().past.length).toBe(historyBefore)
  })
})
