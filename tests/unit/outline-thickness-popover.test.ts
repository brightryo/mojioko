import { describe, it, expect } from 'vitest'
import { shouldCommitOnClose } from '../../src/renderer/components/subtitle-table/outline-thickness-popover'

/**
 * REQ-0222 — the outline-thickness popover uses a coarse-grained
 * "push history exactly once at popover close, only if the value
 * changed" contract (same pattern the ColorPicker uses for its
 * OK/Cancel path).  The decision itself is a one-line pure function,
 * but pinning it as a unit test:
 *
 *   - documents the intent explicitly (future refactor won't
 *     accidentally invert the guard)
 *   - guards the "empty popover session = no undo pollution" UX rule
 *     (RES-0199's history-hygiene principle carried into REQ-0222)
 *
 * Every case below maps to a scenario the RES-0222 acceptance list
 * calls out: opening then closing without moving the slider, moving
 * and moving back to the start value, and a genuine edit.
 */
describe('REQ-0222 shouldCommitOnClose', () => {
  it('empty popover session (open → close, value unchanged) does NOT commit', () => {
    expect(shouldCommitOnClose(5, 5)).toBe(false)
  })

  it('moved and moved back to open value does NOT commit', () => {
    // valueOnOpen was 8; user dragged 8 → 12 → 6 → 8; final == open.
    // The intermediate `updateEntryPreview` writes already touched
    // the store, but no history op should be recorded because the
    // net-visible outcome from an Undo perspective is nothing.
    expect(shouldCommitOnClose(8, 8)).toBe(false)
  })

  it('genuine upward change commits', () => {
    expect(shouldCommitOnClose(12, 8)).toBe(true)
  })

  it('genuine downward change commits', () => {
    expect(shouldCommitOnClose(3, 8)).toBe(true)
  })

  it('boundary values (0 and OUTLINE_THICKNESS_MAX_PX) are treated identically', () => {
    // 0 is a valid outline width (no outline).  A move from N → 0
    // is a genuine change and must commit.
    expect(shouldCommitOnClose(0, 5)).toBe(true)
    expect(shouldCommitOnClose(5, 0)).toBe(true)
    // No-change at the extremes still does not commit.
    expect(shouldCommitOnClose(0, 0)).toBe(false)
  })

  it('negative or absurd inputs still follow the equality rule (no clamping surprises)', () => {
    // The helper is intentionally dumb about domain: the caller has
    // already clamped via the slider's `min` / `max`.  We only pin
    // the pure "did the value change" rule so behavior stays
    // predictable if a future caller feeds it something exotic.
    expect(shouldCommitOnClose(-1, -1)).toBe(false)
    expect(shouldCommitOnClose(-1, 0)).toBe(true)
  })
})
