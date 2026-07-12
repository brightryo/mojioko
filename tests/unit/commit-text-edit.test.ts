import { beforeEach, describe, expect, it } from 'vitest'
import { commitTextEditWithHistory } from '../../src/renderer/lib/commit-text-edit'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import { useHistoryStore } from '../../src/renderer/stores/history-store'
import type { SubtitleEntry } from '../../src/shared/types'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'

/**
 * REQ-0199 — coverage for the shared text-commit helper exercised by
 * `subtitle-table.tsx` (`handleTextCommit`) and
 * `timeline-block-inspector.tsx` (`commitText`).
 *
 * These tests are the successor to `text-focus-boundary-history.test.ts`,
 * which stayed green through the REQ-0198 incident because it tested only
 * the store contract in isolation — the buggy guard in the commit handlers
 * never entered the coverage graph.  The tests below drive
 * `commitTextEditWithHistory` directly with the same real project + history
 * stores the components use, so a regression in the guard or push shape
 * fails here.
 *
 * The scenarios below map 1:1 to the checklist in REQ-0199 §3.
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
    ...makeEntryLayoutDefaults(),
  }
  return {
    id,
    ...base,
    isDeleted: false,
    isEdited: false,
    original: { ...base },
  }
}

function getEntry(id: string): SubtitleEntry {
  const e = useProjectStore.getState().entries.find((x) => x.id === id)
  if (!e) throw new Error(`entry ${id} not found`)
  return e
}

/** Adapter that mirrors what a callsite would pass — the real store methods. */
function callHelper(entryId: string, opts: {
  normalizedNew: string
  normalizedOnFocus: string | null
}): boolean {
  const entry = getEntry(entryId)
  return commitTextEditWithHistory({
    entry,
    normalizedNew: opts.normalizedNew,
    normalizedOnFocus: opts.normalizedOnFocus,
    label: 'history.editText',
    updateEntry: (id, patch) => useProjectStore.getState().updateEntry(id, patch),
    pushHistory: (h) => useHistoryStore.getState().push(h),
  })
}

/**
 * Simulate the exact CellEditor / Inspector runtime shape: preview stream
 * writes each keystroke into the store BEFORE the commit runs, so
 * `entry.text` equals the blur-time draft by the time we call the helper.
 * REQ-0198 root cause depended on this ordering; the fix must survive it.
 */
function simulateTypingSession(
  entryId: string,
  keystrokes: readonly string[],
): void {
  for (const s of keystrokes) {
    useProjectStore.getState().updateEntryPreview(entryId, { text: s })
  }
}

beforeEach(() => {
  useProjectStore.getState().setEntries([makeEntry('e1', 'hello')])
  useHistoryStore.getState().clear()
})

describe('REQ-0199 — commitTextEditWithHistory', () => {
  it('focus → change → blur pushes exactly one history op', () => {
    const preFocus = getEntry('e1').text          // "hello"
    simulateTypingSession('e1', ['h', 'he', 'hey'])
    // Preview stream moved entry.text to "hey" so a naive `=== entry.text`
    // guard would skip — but the helper compares against preFocus.
    expect(getEntry('e1').text).toBe('hey')

    const pushed = callHelper('e1', {
      normalizedNew: 'hey',
      normalizedOnFocus: preFocus,
    })

    expect(pushed).toBe(true)
    expect(useHistoryStore.getState().past.length).toBe(1)
    expect(getEntry('e1').text).toBe('hey')
  })

  it('undo after a change rewinds to the pre-focus text', () => {
    const preFocus = getEntry('e1').text
    simulateTypingSession('e1', ['hello world'])

    callHelper('e1', { normalizedNew: 'hello world', normalizedOnFocus: preFocus })
    expect(getEntry('e1').text).toBe('hello world')

    useHistoryStore.getState().undo()
    expect(getEntry('e1').text).toBe('hello')
  })

  it('redo re-applies the blur-time text after undo', () => {
    const preFocus = getEntry('e1').text
    simulateTypingSession('e1', ['edited'])
    callHelper('e1', { normalizedNew: 'edited', normalizedOnFocus: preFocus })

    useHistoryStore.getState().undo()
    expect(getEntry('e1').text).toBe('hello')
    useHistoryStore.getState().redo()
    expect(getEntry('e1').text).toBe('edited')
  })

  it('focus → no change → blur pushes nothing (helper returns false)', () => {
    const preFocus = getEntry('e1').text
    // No preview stream fired — draft equals pre-focus.
    const pushed = callHelper('e1', {
      normalizedNew: preFocus,
      normalizedOnFocus: preFocus,
    })
    expect(pushed).toBe(false)
    expect(useHistoryStore.getState().past.length).toBe(0)
  })

  it('focus → change → change back to pre-focus → blur pushes nothing', () => {
    const preFocus = getEntry('e1').text
    // User typed something, then deleted back to the original value.
    simulateTypingSession('e1', ['hello!', 'hello'])
    expect(getEntry('e1').text).toBe('hello')       // preview moved back

    const pushed = callHelper('e1', {
      normalizedNew: 'hello',
      normalizedOnFocus: preFocus,
    })

    // No net change → no op → Ctrl+Z would not fire an empty "silent" undo.
    expect(pushed).toBe(false)
    expect(useHistoryStore.getState().past.length).toBe(0)
  })

  it('single paste (one onChange) pushes exactly one history op', () => {
    const preFocus = getEntry('e1').text
    // Paste replaces the entire selection in one onChange event.
    simulateTypingSession('e1', ['This is pasted text'])

    const pushed = callHelper('e1', {
      normalizedNew: 'This is pasted text',
      normalizedOnFocus: preFocus,
    })

    expect(pushed).toBe(true)
    expect(useHistoryStore.getState().past.length).toBe(1)
    expect(getEntry('e1').text).toBe('This is pasted text')
  })

  it('consecutive pastes (JA then EN) push one op; undo rewinds to pre-focus', () => {
    // The exact REQ-0198 reproduction: user pastes JA into a subtitle,
    // then pastes EN over it, then blurs.  Historically the guard bug
    // skipped the push and Ctrl+Z rewound the wrong operation.
    const preFocus = getEntry('e1').text            // "hello"

    // Two paste events in the same focus session.
    simulateTypingSession('e1', ['こんにちは'])
    simulateTypingSession('e1', ['Goodbye'])
    expect(getEntry('e1').text).toBe('Goodbye')

    const pushed = callHelper('e1', {
      normalizedNew: 'Goodbye',
      normalizedOnFocus: preFocus,
    })

    expect(pushed).toBe(true)
    expect(useHistoryStore.getState().past.length).toBe(1)

    useHistoryStore.getState().undo()
    // Undo rewinds all the way past both pastes to what was on screen
    // when focus was captured — REQ-0198's reported expectation.
    expect(getEntry('e1').text).toBe('hello')
  })

  it('stack order preserved: prior op stays intact under a text-commit undo', () => {
    // Simulate a prior timeline drag op sitting on the stack below the
    // upcoming text commit.  After Ctrl+Z the text should rewind but
    // the prior drag op should be untouched (= reachable by a second
    // Ctrl+Z).  This is the "wrong op rewound" flavour of REQ-0198.
    const preFocus = getEntry('e1').text
    const dragBefore = { ...getEntry('e1') }
    useProjectStore.getState().updateEntry('e1', { startSec: 20, endSec: 25 })
    const dragAfter = { ...getEntry('e1') }
    useHistoryStore.getState().push({
      label: 'history.editTime',
      undo: () => useProjectStore.getState().updateEntry('e1', dragBefore),
      redo: () => useProjectStore.getState().updateEntry('e1', dragAfter),
    })

    simulateTypingSession('e1', ['edited'])
    callHelper('e1', { normalizedNew: 'edited', normalizedOnFocus: preFocus })

    expect(useHistoryStore.getState().past.length).toBe(2)

    // First Ctrl+Z: text rewinds, time stays moved.
    useHistoryStore.getState().undo()
    expect(getEntry('e1').text).toBe('hello')
    expect(getEntry('e1').startSec).toBe(20)
    expect(getEntry('e1').endSec).toBe(25)

    // Second Ctrl+Z: time rewinds.
    useHistoryStore.getState().undo()
    expect(getEntry('e1').startSec).toBe(0)
    expect(getEntry('e1').endSec).toBe(1)
  })

  it('null normalizedOnFocus falls through to snapshot-based history', () => {
    // Defensive fallback: a caller without a focus session (hypothetical
    // programmatic commit) still gets a working history op.
    simulateTypingSession('e1', ['forced edit'])

    const pushed = callHelper('e1', {
      normalizedNew: 'forced edit',
      normalizedOnFocus: null,
    })

    expect(pushed).toBe(true)
    expect(useHistoryStore.getState().past.length).toBe(1)

    // Undo uses the snapshot which already had text = "forced edit"
    // because the preview stream ran first.  The point of the null
    // branch is not "correct behaviour when focus is bypassed" — it is
    // "we still write something to history rather than swallowing the
    // edit."  Callers with real focus tracking (both current ones) never
    // hit this branch.
    useHistoryStore.getState().undo()
    // Under the snapshot fallback, undo restores to whatever
    // entry.text held at push time (= post-preview-stream value).
    expect(getEntry('e1').text).toBe('forced edit')
  })

  it('sets isEdited=true on the store write (both live and redo)', () => {
    // Original is unedited.
    expect(getEntry('e1').isEdited).toBe(false)

    const preFocus = getEntry('e1').text
    simulateTypingSession('e1', ['modified'])
    callHelper('e1', { normalizedNew: 'modified', normalizedOnFocus: preFocus })

    expect(getEntry('e1').isEdited).toBe(true)

    // Undo → isEdited should reflect whatever the undoState carried.
    // undoState = { ...snapshot, text: preFocus }, and snapshot was taken
    // AFTER the preview stream had set entry.text = 'modified'.  The
    // preview writer runs isEditedFromOriginal so at snapshot time the
    // flag was already true — undo therefore restores isEdited=true,
    // which is intentional: "the row was touched this session."
    useHistoryStore.getState().undo()
    expect(getEntry('e1').text).toBe('hello')

    // Redo re-applies "modified" and preserves the edited flag.
    useHistoryStore.getState().redo()
    expect(getEntry('e1').text).toBe('modified')
    expect(getEntry('e1').isEdited).toBe(true)
  })
})
