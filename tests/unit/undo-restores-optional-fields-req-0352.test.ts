import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import path from 'path'
import { buildUndoPatch } from '../../src/shared/history-patch'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-0352 — Undo restores a field that was previously UNSET.
 *
 * ## The defect
 *
 * Both edit paths built the undo patch by spreading the whole entry
 * (`{ ...entry }` in the inspector's `applyStyleEdit`, `{ ...e }` in the
 * bulk bar's `applyBulk`) and applied it with a MERGING writer
 * (`updateEntry` / `updateEntriesBatch` both do `{ ...e, ...patch }`).
 *
 * An optional field that has never been set is not an own property, so the
 * spread does not carry it, so the merge leaves the new value in place: the
 * FIRST change to any optional field could not be undone.  The second could,
 * because by then the key existed.  That is precisely the "only the first
 * time" symptom the owner reported on the two karaoke controls — and it was
 * never specific to karaoke.
 *
 * ## Why the coverage is type-driven
 *
 * `SubtitleEntry` has 29 optional fields.  Listing the ones to check by hand
 * is how the next field added goes untested, which is the failure mode this
 * codebase has hit repeatedly (`duplicateRow`'s 16 fields, the Step-1 preview's
 * 14, the settings merge).  So the list below is checked BY THE COMPILER
 * against the type: `satisfies Record<OptionalKey, …>` fails to compile if a
 * new optional field is added and not given a sample value here.
 *
 * `OptionalKey` is derived from `SubtitleEntry` itself — a key is optional
 * exactly when it can be omitted, which `{} extends Pick<T, K>` detects.
 */
type OptionalKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? K : never
}[keyof T]
type SubtitleEntryOptionalKey = OptionalKeys<SubtitleEntry>

/**
 * A sample "new" value for every optional field.  The VALUE does not matter —
 * only that each key appears, so the compiler can confirm the set is complete.
 */
const SAMPLES = {
  fontId: 'anton',
  posX: 100,
  posY: 200,
  lineSpacingPercent: -30,
  layer: 5, // REQ-0392 — z-order

  casing: 'uppercase',
  rotation: 90,
  shadowDepth: 12,
  shadowColor: '#123456',
  shadowAlpha: 80,
  textAlpha: 50,
  outlineAlpha: 40,
  karaokeEnabled: true,
  karaokeHighlightColor: '#FFEE00',
  karaokeUseWordTimings: true,
  karaokeStyle: 'switch',
  keywordEmphasisEnabled: true,
  emphasisColorHex: '#FF2E88',
  emphasisScalePercent: 150,
  emphasisKeywords: ['x'],
  emphasizedWordIndices: [0],
  emphasisSpans: [{ start: 0, end: 1 }],
  words: [{ text: 'a', startSec: 0, endSec: 1 }],
  animationDurationSec: 0.3,
  animationBlurPx: 4,
  animationType: 'fade',
  animationInEnabled: true,
  animationOutEnabled: true,
  animationDirection: 'up',
  animationDistancePx: 40,
  animationStartScalePercent: 80,
} as const satisfies Record<SubtitleEntryOptionalKey, unknown>

describe('REQ-0352 — undo restores optional fields to UNSET', () => {
  it('covers every optional field of SubtitleEntry — enforced by tsc', () => {
    /*
     * The `satisfies Record<SubtitleEntryOptionalKey, unknown>` above is the
     * real coverage assertion, and it works in BOTH directions: a key that is
     * not optional on `SubtitleEntry` fails to compile, and an optional key
     * that is missing from the table fails to compile too.
     *
     * But vitest transpiles with esbuild, which STRIPS types without checking
     * them, and no tsconfig in this repo included `tests/` — so on its own
     * that `satisfies` would never be evaluated and this file would claim an
     * exhaustiveness nobody verified.  So the check is run here, for real.
     *
     * `tsconfig.test.json` exists for this and explains why its `include` is
     * one file rather than the whole suite (19 pre-existing type errors in
     * unrelated specs — see RES-0352).
     */
    // `shell: true` because on Windows the launcher is a `.cmd`, which
    // CreateProcess cannot execute directly.  Without it `status` comes back
    // `null` and this assertion would report a spawn failure as if it were a
    // type error — which is exactly what happened while writing this test.
    const r = spawnSync('npx tsc --noEmit -p tsconfig.test.json', {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
      shell: true,
    })
    expect(
      r.status,
      'tsc did not exit 0 — either the optional-field table no longer matches ' +
      `SubtitleEntry, or tsc failed to run:\n${r.stdout ?? ''}${r.stderr ?? ''}`,
    ).toBe(0)
  }, 300_000)

  it('setting a previously-absent optional field yields an undo patch that clears it', () => {
    const failures: string[] = []
    for (const [key, value] of Object.entries(SAMPLES)) {
      // `before` deliberately does NOT have the key — the "first ever change"
      // case, which is the one that was broken.
      const before = { id: 'e1' } as unknown as SubtitleEntry
      const patch = { [key]: value } as Partial<SubtitleEntry>
      const undo = buildUndoPatch(before, patch)

      if (!(key in undo)) {
        failures.push(`${key}: undo patch has no key — a merging writer would keep the new value`)
        continue
      }
      if (undo[key as keyof SubtitleEntry] !== undefined) {
        failures.push(`${key}: undo value is ${String(undo[key as keyof SubtitleEntry])}, expected undefined`)
      }
      // Simulate what the store actually does, so the assertion is about the
      // observable result rather than the shape of the patch.
      const merged = { ...before, ...undo } as Record<string, unknown>
      if (merged[key] !== undefined) {
        failures.push(`${key}: after undo the field is ${String(merged[key])}, expected unset`)
      }
    }
    expect(failures, 'optional fields not restored by undo').toEqual([])
  })

  it('restores a previous VALUE when the field was already set', () => {
    const before = { id: 'e1', shadowDepth: 4, rotation: 90 } as unknown as SubtitleEntry
    const undo = buildUndoPatch(before, { shadowDepth: 12 })
    expect(undo).toEqual({ shadowDepth: 4 })
    // Only the touched key is rewound — an unrelated field is left alone.
    expect('rotation' in undo).toBe(false)
  })

  it('beforePatch wins, for controls that streamed preview writes', () => {
    // The colour pickers and the shadow / opacity sliders write to the store
    // during the drag, so `before` is already the AFTER value by commit time.
    const afterDrag = { id: 'e1', shadowDepth: 12 } as unknown as SubtitleEntry
    const undo = buildUndoPatch(afterDrag, { shadowDepth: 12 }, { shadowDepth: 4 })
    expect(undo).toEqual({ shadowDepth: 4 })
  })

  it('NEGATIVE CONTROL — the old whole-entry-spread undo does NOT clear an unset field', () => {
    // Reproduces the pre-REQ-0352 construction. If this ever starts behaving
    // like the fixed one, the test above has stopped proving anything.
    const before = { id: 'e1' } as unknown as SubtitleEntry
    const oldStyleUndo = { ...before } // the whole-entry spread
    const merged = { ...before, karaokeUseWordTimings: true, ...oldStyleUndo } as Record<string, unknown>
    expect(
      merged.karaokeUseWordTimings,
      'the old construction must still fail to clear the field',
    ).toBe(true)
  })
})
