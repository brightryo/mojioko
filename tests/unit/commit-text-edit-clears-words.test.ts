import { describe, it, expect, vi } from 'vitest'
import { commitTextEditWithHistory } from '../../src/renderer/lib/commit-text-edit'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-0285 §4 Layer 1 — pins the proactive words-invalidation on text
 * edit.  Every code path that mutates `SubtitleEntry.text` must clear
 * `words` at the same moment; the shared `commit-text-edit` helper is
 * the primary funnel (both the subtitle-table text cell and the timeline
 * inspector text area go through it, per REQ-0199).  If a future refactor
 * silently drops the `words: undefined` from the patch, these tests
 * break at CI and the invalidation guarantee is restored before merge.
 *
 * Layer 2 (defensive `areWordsValidForText` re-check) is separately
 * pinned in `tests/unit/words-validity.test.ts`.
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

describe('REQ-0285 §4 Layer 1 — commit-text-edit clears words on real edit', () => {
  it('real text edit → updateEntry patch includes `words: undefined`', () => {
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
    // The critical assertion: words are cleared as part of the same
    // atomic patch, so no downstream reader ever sees the edited text
    // paired with the stale words.
    expect('words' in patch).toBe(true)
    expect(patch.words).toBeUndefined()
  })

  it('history redo patch also clears words (both directions of a real edit)', () => {
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

    expect(pushHistory).toHaveBeenCalledTimes(1)
    const historyEntry = pushHistory.mock.calls[0][0] as {
      undo: () => void
      redo: () => void
    }

    // Exercise redo — it must call updateEntry with a state where
    // words is undefined.  We inspect the fresh updateEntry call
    // after invoking redo.
    updateEntry.mockClear()
    historyEntry.redo()
    expect(updateEntry).toHaveBeenCalledTimes(1)
    const [, redoPatch] = updateEntry.mock.calls[0] as [string, SubtitleEntry]
    expect(redoPatch.text).toBe('hello there')
    expect(redoPatch.isEdited).toBe(true)
    expect(redoPatch.words).toBeUndefined()
  })

  it('undo restores the pre-edit state INCLUDING the words that were on the entry when focus landed', () => {
    // The pre-focus snapshot for undo is `{ ...entry, text: normalizedOnFocus }`
    // — everything except text is preserved from the moment focus landed.
    // Words that existed pre-edit are therefore also restored on undo.
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
    // Undo restores the SNAPSHOT which included the pre-edit words.
    expect(undoPatch.words).toEqual([
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1.0, text: ' world' },
    ])
  })

  it('no-op (guard fires) → updateEntry and pushHistory NOT called, words untouched', () => {
    // If the user focused but didn't actually change the text, the
    // guard skips the commit entirely.  `entry.words` is not
    // referenced or altered.
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

  it('entry without words (undefined) → still clears (patch shape unchanged)', () => {
    // Backward compat: entries from a pre-REQ-0285 project have no
    // `words` field.  The clear still fires — writing `undefined`
    // over `undefined` is a no-op, but the patch shape stays
    // consistent so future readers can rely on "text edit patches
    // always include `words: undefined`".
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
    expect('words' in patch).toBe(true)
    expect(patch.words).toBeUndefined()
  })
})
