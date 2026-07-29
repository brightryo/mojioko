import { describe, it, expect, beforeEach } from 'vitest'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-0342 §3 — `updateEntriesBatch` must be exactly the per-row loop it
 * replaced, in one store write.
 *
 * `applyBulk` used to call `updateEntry` once per selected row.  Measured at
 * 3000 cues in the subtitle-table view, one font-size click spent 12,666 ms in
 * that loop; the same click in the timeline view spent 96.7 ms, which is what
 * identified the cost as per-write subscriber work rather than the array maps.
 * Collapsing it to one write took the loop to 5.6 ms.
 *
 * The risk of that change is silent behaviour drift, so these pin the
 * properties the loop had: same merged values, same `isEdited` recompute, and
 * — the one that matters for React — untouched entries keep their OBJECT
 * IDENTITY, because every downstream `useMemo` and any future `memo()` on the
 * row component depends on it.
 */
function entry(id: string, patch: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base = {
    startSec: 0, endSec: 1, text: 'hello',
    fontSizePx: 100, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
    outlineThicknessPx: 3, fadeDurationSec: 0,
    horizontalPosition: 'center' as const, verticalPosition: 'bottom' as const,
    verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black' as const, opacityPercent: 50 },
  }
  return {
    id, ...base, isDeleted: false, isEdited: false,
    original: { ...base }, ...patch,
  } as SubtitleEntry
}

const ids = ['a', 'b', 'c', 'd']

beforeEach(() => {
  useProjectStore.setState({ entries: ids.map((i) => entry(i)) })
})

describe('REQ-0342 §3 — updateEntriesBatch', () => {
  it('applies a different patch to each named entry', () => {
    useProjectStore.getState().updateEntriesBatch(
      new Map([['a', { fontSizePx: 120 }], ['c', { fontSizePx: 140 }]]),
    )
    const e = useProjectStore.getState().entries
    expect(e.map((x) => x.fontSizePx)).toEqual([120, 100, 140, 100])
  })

  it('★ leaves untouched entries at the SAME object identity', () => {
    // The whole point of taking one write instead of N: entries nobody
    // patched must not be rebuilt, or every memo downstream invalidates and
    // the batching buys nothing.
    const before = useProjectStore.getState().entries
    useProjectStore.getState().updateEntriesBatch(new Map([['b', { fontSizePx: 120 }]]))
    const after = useProjectStore.getState().entries
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
    expect(after[3]).toBe(before[3])
    expect(after[1]).not.toBe(before[1])
  })

  it('recomputes isEdited from `original`, exactly as updateEntry does', () => {
    useProjectStore.getState().updateEntriesBatch(new Map([['a', { fontSizePx: 120 }]]))
    expect(useProjectStore.getState().entries[0].isEdited).toBe(true)
    // ...and back again: returning a field to its original value clears it.
    useProjectStore.getState().updateEntriesBatch(new Map([['a', { fontSizePx: 100 }]]))
    expect(useProjectStore.getState().entries[0].isEdited).toBe(false)
  })

  it('is equivalent to the per-row loop it replaced', () => {
    const patches = new Map<string, Partial<SubtitleEntry>>([
      ['a', { fontSizePx: 120, isEdited: true }],
      ['d', { fontSizePx: 60, outlineThicknessPx: 8, isEdited: true }],
    ])

    useProjectStore.getState().updateEntriesBatch(patches)
    const batched = useProjectStore.getState().entries

    useProjectStore.setState({ entries: ids.map((i) => entry(i)) })
    for (const [id, p] of patches) useProjectStore.getState().updateEntry(id, p)
    const looped = useProjectStore.getState().entries

    expect(batched).toEqual(looped)
  })

  it('ignores ids that are not in the store', () => {
    const before = useProjectStore.getState().entries
    useProjectStore.getState().updateEntriesBatch(new Map([['nope', { fontSizePx: 1 }]]))
    const after = useProjectStore.getState().entries
    expect(after.map((e) => e.fontSizePx)).toEqual([100, 100, 100, 100])
    // Every entry keeps its identity; only the array itself is rebuilt.
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i])
  })

  it('an empty map does not touch the entries array at all', () => {
    const before = useProjectStore.getState().entries
    useProjectStore.getState().updateEntriesBatch(new Map())
    expect(useProjectStore.getState().entries).toBe(before)
  })

  it('writes once — a subscriber sees a single notification for N entries', () => {
    // This is the property the fix exists for.  N writes meant N subscriber
    // passes, and in the unvirtualised table each pass costs milliseconds.
    let notifications = 0
    const unsub = useProjectStore.subscribe(() => { notifications++ })
    try {
      useProjectStore.getState().updateEntriesBatch(
        new Map(ids.map((i) => [i, { fontSizePx: 120 }])),
      )
      expect(notifications).toBe(1)
    } finally {
      unsub()
    }
  })
})
