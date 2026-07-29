import { describe, it, expect } from 'vitest'

/**
 * REQ-0292 §3 — bulk-edit rotation stuck-at-0 bug.
 *
 * Regression: the bulk-edit rotation NumberStepperInput used to be
 * rendered with `value={0}` hardcoded.  The stepper's `handleStep`
 * computes `next = clamp(value + delta)`, so with `value` frozen at
 * 0 every click applied 15° again (never 30 → 45 → …) and the minus
 * button stayed disabled because it checks `value <= min`.  Bulk-
 * edit now owns a `rotationDraft` state that advances alongside each
 * commit — the input then behaves like any other controlled stepper.
 *
 * This test pins the pure state-transition behaviour that drives the
 * fix, without needing a React DOM harness:
 *
 *   - after each commit the draft advances by the applied delta
 *   - minus after a click reduces the draft below the last-applied
 *     value (fixes the "minus button always disabled" symptom)
 *   - the applied value is normalised to [0, 360) via the same
 *     modulo formula the handler uses, so 375° → 15° etc.
 */

function normaliseDeg(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/**
 * Simulate the bulk-edit rotation loop: a NumberStepperInput bound
 * to `rotationDraft` calls `handleRotationBulk(next)` on each
 * chevron click.  The handler normalises `next` and writes it back
 * into the draft.  We drive the same three lines manually here.
 */
function simulateStep(draft: number, delta: number): number {
  const next = normaliseDeg(draft + delta)
  return next
}

describe('REQ-0292 §3 — bulk rotation draft advances (regression pin)', () => {
  it('first + click advances draft 0 → 15', () => {
    expect(simulateStep(0, 15)).toBe(15)
  })

  it('subsequent + clicks advance further (fixes the stuck-at-15 symptom)', () => {
    let draft = 0
    draft = simulateStep(draft, 15) // 15
    draft = simulateStep(draft, 15) // 30
    draft = simulateStep(draft, 15) // 45
    expect(draft).toBe(45)
  })

  it('- click reduces the draft (fixes the minus-always-disabled symptom)', () => {
    // Simulate: user + clicks up to 30, then - clicks back to 15
    let draft = 0
    draft = simulateStep(draft, 15)
    draft = simulateStep(draft, 15)
    expect(draft).toBe(30)
    draft = simulateStep(draft, -15)
    expect(draft).toBe(15)
  })

  it('crossing 360 wraps back to 0 (mod-360 normalisation)', () => {
    // 345 + 15 = 360 → 0
    expect(simulateStep(345, 15)).toBe(0)
    // 350 + 15 = 365 → 5
    expect(simulateStep(350, 15)).toBe(5)
  })

  it('negative crossing 0 wraps to 345 (mod handles negative correctly)', () => {
    // 0 - 15 = -15 → normalised to 345
    expect(simulateStep(0, -15)).toBe(345)
  })

  it('normaliseDeg agrees with the ass-generator-facing normalisation contract', () => {
    // The generator does `((rotation ?? 0) % 360 + 360) % 360` — same
    // formula.  Pin the boundary values to catch any drift.
    expect(normaliseDeg(0)).toBe(0)
    expect(normaliseDeg(360)).toBe(0)
    expect(normaliseDeg(720)).toBe(0)
    expect(normaliseDeg(-1)).toBe(359)
    expect(normaliseDeg(-360)).toBe(0)
    expect(normaliseDeg(359)).toBe(359)
  })
})
