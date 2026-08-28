/**
 * REQ-0546 (RES-0543 F2) — "does this window have work that would be lost?"
 *
 * ## The requirement that shapes everything else
 *
 * **Zero false negatives.** Closing with unsaved edits and no warning is the
 * failure being fixed; a spurious prompt is an annoyance. So the tracker is
 * built to say "unsaved" whenever it cannot be certain otherwise.
 *
 * ## Why not the undo stack's length
 *
 * The obvious design — remember the undo depth at save time and compare — has a
 * false-negative hole in THIS codebase: `history-store` caps `past` at
 * `MAX_HISTORY` (`.slice(-MAX_HISTORY)`), so once a long session saturates the
 * stack the length stops changing while the edits keep coming. Depth at save
 * time would then equal depth at close time with real work in between, and the
 * app would close silently. Undo/redo also move the depth in both directions,
 * so "same depth" never meant "same content" to begin with.
 *
 * ## What is used instead
 *
 * A flag set from a SUBSCRIPTION to the project store. Zustand notifies on
 * every `set`, so no mutation can slip past — the tracker does not have to
 * enumerate the store's ~20 actions and stay in sync with them, which is where
 * a false negative would eventually creep in. The flag is cleared at exactly
 * the two moments the document becomes "what is on disk": a successful save,
 * and loading a project.
 *
 * ## Known limits (stated rather than hidden)
 *
 * - **False positives are possible.** An edit followed by its own undo leaves
 *   the document byte-identical to the saved state but the flag stays set, so
 *   the user is asked about work that no longer differs. Content hashing would
 *   fix it and is not worth the cost here — the prompt is cheap, the missed
 *   warning is not.
 * - A store mutation that writes an equal value still counts as a change.
 * - It tracks the PROJECT store only. Settings are persisted separately and
 *   continuously (REQ-0545 §2 now reports failures), so they are not part of
 *   "unsaved work" in this sense.
 */
export interface UnsavedTracker {
  /** A project-store mutation happened. */
  noteChange(): void
  /** The document was written to disk. */
  markSaved(): void
  /** A project was loaded / closed: the document now matches its source. */
  reset(): void
  /**
   * The decision. `hasProject` is passed in rather than read here so the
   * judgement stays a pure function of its two inputs — that is the part worth
   * testing, and it keeps this module free of store imports.
   */
  hasUnsavedWork(hasProject: boolean): boolean
}

export function createUnsavedTracker(): UnsavedTracker {
  let changed = false
  return {
    noteChange() { changed = true },
    markSaved() { changed = false },
    reset() { changed = false },
    hasUnsavedWork(hasProject: boolean) {
      // No project on screen means nothing to lose, so the app closes without
      // asking — the REQ's "編集ゼロのときは確認を出さずに即終了".
      return hasProject && changed
    },
  }
}

/** The app-wide instance. One window, one document. */
export const unsavedTracker = createUnsavedTracker()
