import { describe, it, expect, vi } from 'vitest'
import { commitTextEditWithHistory } from '../../src/renderer/lib/commit-text-edit'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-0288 — pins that `commit-text-edit` PRESERVES `entry.words`
 * across text edits (was: proactively cleared under REQ-0285 §4
 * "Layer 1" defensive clear).
 *
 * The reversibility bug this fix addresses:
 *   1. cue "テストです" with karaoke enabled + words valid
 *   2. user adds a newline → "テストです\n"
 *   3. commit-text-edit ran with Layer 1: cleared `words: undefined`
 *   4. user removes the newline → back to "テストです" (matches
 *      original.text)
 *   5. Reset button greyed out (text matches original)
 *   6. Timeline clip returned to "unedited" green
 *   7. BUT karaoke stayed off (words was gone; can't be resurrected
 *      because Reset was greyed).
 *
 * Post-REQ-0288: `words` survives step 3, so step 4 has karaoke
 * available again automatically — the render-time
 * `areWordsValidForText` predicate returns true once text matches
 * words again (REQ-0287's strip-all-whitespace normaliser makes
 * whitespace-only edits transparent).
 *
 * Renamed from the pre-REQ-0288 `commit-text-edit-clears-words.test.ts`
 * so the file name doesn't mislead future readers.
 */

function makeEntry(patch: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base: SubtitleEntry = {
    id: 'e1',
    startSec: 0,
    endSec: 2,
    text: 'hello world',
    fontSizePx: 100,
    textColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    outlineThicknessPx: 3,
    fadeDurationSec: 0,
    horizontalPosition: 'center',
    verticalPosition: 'bottom',
    verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    isDeleted: false,
    isEdited: false,
    words: [
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1.0, text: ' world' },
    ],
    original: {
      startSec: 0,
      endSec: 2,
      text: 'hello world',
      fontSizePx: 100,
      textColorHex: '#FFFFFF',
      outlineColorHex: '#000000',
      outlineThicknessPx: 3,
      fadeDurationSec: 0,
      horizontalPosition: 'center',
      verticalPosition: 'bottom',
      verticalMarginPx: 40,
      subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
      words: [
        { startSec: 0, endSec: 0.5, text: 'hello' },
        { startSec: 0.5, endSec: 1.0, text: ' world' },
      ],
    },
  }
  return { ...base, ...patch }
}

describe('REQ-0288 — commit-text-edit preserves words on real edit', () => {
  it('real text edit → updateEntry patch does NOT include `words: undefined`', () => {
    const entry = makeEntry()
    const updateEntry = vi.fn()
    const pushHistory = vi.fn()

    const changed = commitTextEditWithHistory({
      entry,
      normalizedNew: 'hello there',
      normalizedOnFocus: 'hello world',
      label: 'edit text',
      updateEntry,
      pushHistory,
    })

    expect(changed).toBe(true)
    expect(updateEntry).toHaveBeenCalledTimes(1)
    const [id, patch] = updateEntry.mock.calls[0]
    expect(id).toBe('e1')
    expect(patch.text).toBe('hello there')
    expect(patch.isEdited).toBe(true)
    // The critical assertion (REQ-0288): words is NOT in the patch,
    // so the store's existing words survive the edit.
    expect('words' in patch).toBe(false)
  })

  it('history redo patch also does NOT clear words', () => {
    const entry = makeEntry()
    const updateEntry = vi.fn()
    const pushHistory = vi.fn()

    commitTextEditWithHistory({
      entry,
      normalizedNew: 'hello there',
      normalizedOnFocus: 'hello world',
      label: 'edit text',
      updateEntry,
      pushHistory,
    })

    const historyEntry = pushHistory.mock.calls[0][0] as { undo: () => void; redo: () => void }
    updateEntry.mockClear()
    historyEntry.redo()
    expect(updateEntry).toHaveBeenCalledTimes(1)
    const [, redoPatch] = updateEntry.mock.calls[0] as [string, SubtitleEntry]
    expect(redoPatch.text).toBe('hello there')
    expect(redoPatch.isEdited).toBe(true)
    // Redo carries the pre-edit snapshot's words — they weren't
    // cleared, so redo re-applies the same words alongside the new
    // text.  This is preservation-through-history, not destructive.
    expect(redoPatch.words).toEqual([
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1.0, text: ' world' },
    ])
  })

  it('undo restores the pre-edit snapshot which included the pre-edit words', () => {
    const entry = makeEntry()
    const updateEntry = vi.fn()
    const pushHistory = vi.fn()

    commitTextEditWithHistory({
      entry,
      normalizedNew: 'hello there',
      normalizedOnFocus: 'hello world',
      label: 'edit text',
      updateEntry,
      pushHistory,
    })

    const historyEntry = pushHistory.mock.calls[0][0] as { undo: () => void; redo: () => void }
    updateEntry.mockClear()
    historyEntry.undo()
    expect(updateEntry).toHaveBeenCalledTimes(1)
    const [, undoPatch] = updateEntry.mock.calls[0] as [string, SubtitleEntry]
    expect(undoPatch.text).toBe('hello world')
    // Undo carries the same snapshot (pre-edit words present) — this
    // matched pre-REQ-0288 behaviour too; the guarantee is preserved.
    expect(undoPatch.words).toEqual([
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1.0, text: ' world' },
    ])
  })

  it('no-op (guard fires) → updateEntry and pushHistory NOT called, words untouched', () => {
    const entry = makeEntry()
    const updateEntry = vi.fn()
    const pushHistory = vi.fn()

    const changed = commitTextEditWithHistory({
      entry,
      normalizedNew: 'hello world',
      normalizedOnFocus: 'hello world',
      label: 'edit text',
      updateEntry,
      pushHistory,
    })

    expect(changed).toBe(false)
    expect(updateEntry).not.toHaveBeenCalled()
    expect(pushHistory).not.toHaveBeenCalled()
  })

  it('entry without words (undefined) → still no destructive clear, patch stays minimal', () => {
    // Backward-compat: pre-REQ-0285 project files have no words.
    // The patch should be identical whether or not words was present.
    const entry = makeEntry({ words: undefined })
    const updateEntry = vi.fn()
    const pushHistory = vi.fn()

    commitTextEditWithHistory({
      entry,
      normalizedNew: 'edited',
      normalizedOnFocus: 'hello world',
      label: 'edit text',
      updateEntry,
      pushHistory,
    })

    const [, patch] = updateEntry.mock.calls[0]
    // No mention of words in the patch — the pre-existing undefined
    // stays as-is via the store's shallow-merge semantics.
    expect('words' in patch).toBe(false)
  })
})
