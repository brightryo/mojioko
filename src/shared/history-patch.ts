/**
 * REQ-0352 — building the patch that Undo applies.
 *
 * ## The defect this exists to prevent
 *
 * Both edit paths wrote history as "snapshot the whole entry, and on undo
 * merge that snapshot back":
 *
 *     const snapshot = { ...entry }          // inspector: applyStyleEdit
 *     snapshots.set(id, { ...e })            // bulk-edit:  applyBulk
 *     …
 *     undo: () => updateEntry(id, snapshot)
 *
 * `updateEntry` MERGES (`{ ...e, ...patch }`), so a key the patch does not
 * carry leaves the stored value untouched.  And an OPTIONAL field that has
 * never been set is not an own property of the entry, so `{ ...entry }` does
 * not carry it either.
 *
 * The consequence is precise and was reported as a user-visible bug: the
 * FIRST time you change an optional field, Undo does nothing — the undo patch
 * has no key for it, so the merge keeps the new value.  The SECOND time it
 * works, because by then the key exists.  `SubtitleEntry` has 29 optional
 * fields, so this was never about the three controls that happened to get
 * reported (karaoke word timings, karaoke style, …); it was every one of them,
 * on its first use.
 *
 * ## The fix
 *
 * Derive the undo patch from the keys the edit actually TOUCHES, reading each
 * previous value off the entry even when it is absent.  `undefined` then
 * appears as an explicit own property, which the merge does apply — restoring
 * "unset" rather than silently keeping the new value.
 *
 * This also narrows undo to the fields the edit changed.  Restoring a whole
 * entry snapshot would rewind fields that a later, unrelated write had
 * touched; the previous code got away with it only because history is linear.
 */

/**
 * The previous values of exactly the fields `patch` will change.
 *
 * @param before  The entry as it was BEFORE the edit.  Callers that stream
 *                preview writes into the store during a drag (colour pickers,
 *                the shadow and opacity sliders) must NOT pass the live entry
 *                here — by commit time it already holds the after value.  They
 *                pass their pre-drag values through `beforePatch` instead.
 * @param patch   The edit.  Its KEY SET defines what undo will touch.
 * @param beforePatch  Overrides for fields whose pre-edit value the caller
 *                knows better than `before` does — see above.
 */
export function buildUndoPatch<T extends object>(
  before: T,
  patch: Partial<T>,
  beforePatch?: Partial<T>,
): Partial<T> {
  const undo: Partial<T> = {}
  for (const key of Object.keys(patch) as (keyof T)[]) {
    // Deliberately assigned even when absent from `before`: writing the key
    // with `undefined` is what makes the merge restore "unset".  Reading a
    // missing key yields `undefined`, which is exactly the value wanted.
    undo[key] = before[key]
  }
  if (beforePatch) {
    for (const key of Object.keys(beforePatch) as (keyof T)[]) {
      undo[key] = beforePatch[key]
    }
  }
  return undo
}
