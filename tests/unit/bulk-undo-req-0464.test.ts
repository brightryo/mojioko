import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import { useHistoryStore } from '../../src/renderer/stores/history-store'
import { buildUndoPatch } from '../../src/shared/history-patch'
import { deepSnapshotEntry, DEEP_COPY_FIELDS } from '../../src/renderer/lib/duplicate-entry'
import { buildColorPairPreSnapshots, pickFirstSelectedToggles } from '../../src/renderer/lib/bulk-edit-undo'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'
import type { SubtitleEntry, SubtitleBackground } from '../../src/shared/types'

/**
 * REQ-0464 §1 — the three bulk-edit Undo / controlled-Switch fixes, pinned to
 * value comparison.  Follows the repo convention (`preview-drag-undo.test.ts`,
 * `bulk-rotation-draft.test.ts`) of driving the real stores + the pure helpers
 * that `applyBulk` composes, rather than mounting the React component.
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
  return {
    id,
    ...base,
    ...overrides,
    isDeleted: false,
    isEdited: false,
    original: { ...base },
  }
}

const getEntry = (id: string): SubtitleEntry => {
  const e = useProjectStore.getState().entries.find((x) => x.id === id)
  if (!e) throw new Error(`entry ${id} not found`)
  return e
}

/**
 * Mirror of `applyBulk`'s core composition (minus the layout recompute /
 * measureSync / onApplied that are irrelevant to colour / background edits):
 * deep-snapshot each row, register one undo/redo pair, apply.
 */
function applyBulkSim(
  ids: string[],
  patch: Partial<SubtitleEntry>,
  preBeforeSnapshots?: ReadonlyMap<string, Partial<SubtitleEntry>>,
): void {
  const all = useProjectStore.getState().entries
  const byId = new Map(all.map((e) => [e.id, e]))
  const snapshots = new Map<string, SubtitleEntry>()
  for (const id of ids) {
    const e = byId.get(id)
    if (e && !e.isDeleted) snapshots.set(id, deepSnapshotEntry(e, patch))
  }
  const apply = () => {
    const perRow = new Map<string, Partial<SubtitleEntry>>()
    for (const id of snapshots.keys()) perRow.set(id, { ...patch, isEdited: true })
    useProjectStore.getState().updateEntriesBatch(perRow)
  }
  const revert = () => {
    const perRow = new Map<string, Partial<SubtitleEntry>>()
    for (const [id, snap] of snapshots) {
      perRow.set(id, buildUndoPatch(snap, patch, preBeforeSnapshots?.get(id)))
    }
    useProjectStore.getState().updateEntriesBatch(perRow)
  }
  useHistoryStore.getState().push({ label: 'bulk', undo: revert, redo: apply })
  apply()
}

const BG_OFF: SubtitleBackground = { enabled: false, color: 'black', opacityPercent: 50 }
const BG_ON: SubtitleBackground = { enabled: true, color: 'white', opacityPercent: 80 }

beforeEach(() => {
  useHistoryStore.getState().clear()
})

// -----------------------------------------------------------------
// Bug 3 — deep-copy snapshot decouples nested fields from the live entry
// -----------------------------------------------------------------
describe('REQ-0464 bug 3 — deepSnapshotEntry decouples nested fields', () => {
  it('subtitleBackground is included in the deep-copy field set', () => {
    expect(DEEP_COPY_FIELDS.has('subtitleBackground')).toBe(true)
    expect(DEEP_COPY_FIELDS.has('words')).toBe(true)
  })

  it('clones the patched nested field (different ref, equal value)', () => {
    const e = makeEntry('e1', { subtitleBackground: { ...BG_OFF } })
    const snap = deepSnapshotEntry(e, { subtitleBackground: { ...BG_ON } })
    expect(snap.subtitleBackground).not.toBe(e.subtitleBackground)
    expect(snap.subtitleBackground).toEqual(BG_OFF)
    // A later in-place mutation of the live entry must NOT reach the snapshot.
    e.subtitleBackground.opacityPercent = 999
    expect(snap.subtitleBackground.opacityPercent).toBe(50)
  })

  it('NEGATIVE CONTROL — a shallow spread would alias the nested object (the bug)', () => {
    const e = makeEntry('e1', { subtitleBackground: { ...BG_OFF } })
    const shallow = { ...e }
    e.subtitleBackground.opacityPercent = 123
    // Shallow copy shares the reference, so the "snapshot" sees the mutation.
    expect(shallow.subtitleBackground.opacityPercent).toBe(123)
  })

  it('narrows the clone to patched fields (font-size edit does not clone bg)', () => {
    const e = makeEntry('e1', { subtitleBackground: { ...BG_OFF } })
    const snap = deepSnapshotEntry(e, { fontSizePx: 80 })
    expect(snap.subtitleBackground).toBe(e.subtitleBackground) // not cloned — undo won't touch it
  })

  it('round-trip: bulk background edit → Undo restores the original background value', () => {
    useProjectStore.getState().setEntries([makeEntry('e1', { subtitleBackground: { ...BG_OFF } })])
    applyBulkSim(['e1'], { subtitleBackground: { ...BG_ON } })
    expect(getEntry('e1').subtitleBackground).toEqual(BG_ON)
    useHistoryStore.getState().undo()
    expect(getEntry('e1').subtitleBackground).toEqual(BG_OFF)
    useHistoryStore.getState().redo()
    expect(getEntry('e1').subtitleBackground).toEqual(BG_ON)
  })
})

// -----------------------------------------------------------------
// Bug 1 — colour pair carries preBeforeSnapshots so Undo skips preview values
// -----------------------------------------------------------------
describe('REQ-0464 bug 1 — colour-pair Undo restores pre-preview colours', () => {
  it('buildColorPairPreSnapshots merges both before-maps per row', () => {
    const text = new Map([['e1', '#FFFFFF'], ['e2', '#FF0000']])
    const outline = new Map([['e1', '#000000'], ['e2', '#00FF00']])
    const pre = buildColorPairPreSnapshots(new Set(['e1', 'e2']), text, outline)
    expect(pre?.get('e1')).toEqual({ textColorHex: '#FFFFFF', outlineColorHex: '#000000' })
    expect(pre?.get('e2')).toEqual({ textColorHex: '#FF0000', outlineColorHex: '#00FF00' })
  })

  it('returns undefined when no preview happened (both maps null)', () => {
    expect(buildColorPairPreSnapshots(new Set(['e1']), null, null)).toBeUndefined()
  })

  it('round-trip: preview drag then pair commit → Undo restores each row\'s ORIGINAL colours', () => {
    useProjectStore.getState().setEntries([
      makeEntry('e1', { textColorHex: '#FFFFFF', outlineColorHex: '#000000' }),
      makeEntry('e2', { textColorHex: '#FF0000', outlineColorHex: '#00FF00' }),
    ])
    // Saturation-drag preview stream (no history) moves the store to after-values.
    const textBefore = new Map([['e1', '#FFFFFF'], ['e2', '#FF0000']])
    const outlineBefore = new Map([['e1', '#000000'], ['e2', '#00FF00']])
    useProjectStore.getState().updateEntriesPreview(['e1', 'e2'], { textColorHex: '#AAAAAA' })
    useProjectStore.getState().updateEntriesPreview(['e1', 'e2'], { outlineColorHex: '#BBBBBB' })
    // The fix: pair commit builds preSnapshots from the before-refs.
    const pre = buildColorPairPreSnapshots(new Set(['e1', 'e2']), textBefore, outlineBefore)
    applyBulkSim(['e1', 'e2'], { textColorHex: '#123456', outlineColorHex: '#654321' }, pre)
    expect(getEntry('e1').textColorHex).toBe('#123456')

    useHistoryStore.getState().undo()
    // Restored to the ORIGINAL colours, NOT the #AAAAAA / #BBBBBB preview values.
    expect(getEntry('e1').textColorHex).toBe('#FFFFFF')
    expect(getEntry('e1').outlineColorHex).toBe('#000000')
    expect(getEntry('e2').textColorHex).toBe('#FF0000')
    expect(getEntry('e2').outlineColorHex).toBe('#00FF00')
  })

  it('NEGATIVE CONTROL — without preSnapshots, Undo restores the preview value (the bug)', () => {
    useProjectStore.getState().setEntries([makeEntry('e1', { textColorHex: '#FFFFFF', outlineColorHex: '#000000' })])
    useProjectStore.getState().updateEntriesPreview(['e1'], { textColorHex: '#AAAAAA' })
    applyBulkSim(['e1'], { textColorHex: '#123456', outlineColorHex: '#654321' }) // no preSnapshots
    useHistoryStore.getState().undo()
    expect(getEntry('e1').textColorHex).toBe('#AAAAAA') // wrong: preview value, not #FFFFFF
  })
})

// -----------------------------------------------------------------
// Bug 2 — toggle Switch seeding reflects the first selected row
// -----------------------------------------------------------------
describe('REQ-0464 bug 2 — pickFirstSelectedToggles reflects the selection state', () => {
  const entries = [
    makeEntry('e1', { karaokeEnabled: true, karaokeUseWordTimings: true, casing: 'uppercase' }),
    makeEntry('e2'),
  ]

  it('reads the toggle flags off the first selected row', () => {
    expect(pickFirstSelectedToggles(new Set(['e1']), entries)).toEqual({
      karaokeEnabled: true,
      karaokeUseWordTimings: true,
      casingUppercase: true,
    })
  })

  it('an OFF row seeds every toggle false (undefined optionals → false)', () => {
    expect(pickFirstSelectedToggles(new Set(['e2']), entries)).toEqual({
      karaokeEnabled: false,
      karaokeUseWordTimings: false,
      casingUppercase: false,
    })
  })

  it('picks the first row in ENTRY order, not selection order', () => {
    expect(pickFirstSelectedToggles(new Set(['e2', 'e1']), entries)?.karaokeEnabled).toBe(true)
  })

  it('returns null for an empty selection', () => {
    expect(pickFirstSelectedToggles(new Set(), entries)).toBeNull()
  })
})
