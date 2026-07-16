import { describe, it, expect, beforeEach } from 'vitest'
import { useUiStore, isAnyOverlayOpen } from '../../src/renderer/stores/ui-store'

/**
 * REQ-0132 §2.1 / REQ-0137 fix — the overlay registry is an id-keyed
 * Set (was a counter in REQ-0132).  Pins the invariants that make the
 * Set safe under nested opens, out-of-order closes, and React
 * StrictMode's dev double-invoke of effects (setup → cleanup → setup
 * → …).
 *
 * The bug REQ-0137 fixed was NOT actually in the counter arithmetic;
 * it was in WHERE the hook was called (wrapper function body vs
 * Radix Content child).  But we still migrated to a Set because it
 * makes future misuse cheap: re-adding the same id is a no-op, and
 * removing an unknown id is a no-op, so the Set can never be
 * inflated past its real cardinality.
 */

function reset() {
  useUiStore.setState({ overlayIds: new Set<string>() })
}

beforeEach(reset)

describe('REQ-0137 — overlay id-Set + isAnyOverlayOpen', () => {
  it('starts empty → isAnyOverlayOpen false', () => {
    expect(useUiStore.getState().overlayIds.size).toBe(0)
    expect(isAnyOverlayOpen(useUiStore.getState())).toBe(false)
  })

  it('add(id) → size 1 → isAnyOverlayOpen true', () => {
    useUiStore.getState().addOverlay('a')
    expect(useUiStore.getState().overlayIds.size).toBe(1)
    expect(useUiStore.getState().overlayIds.has('a')).toBe(true)
    expect(isAnyOverlayOpen(useUiStore.getState())).toBe(true)
  })

  it('add(id) is idempotent — re-add of same id leaves size at 1', () => {
    useUiStore.getState().addOverlay('a')
    useUiStore.getState().addOverlay('a')
    useUiStore.getState().addOverlay('a')
    expect(useUiStore.getState().overlayIds.size).toBe(1)
  })

  it('remove(id) of unknown id is a no-op', () => {
    useUiStore.getState().removeOverlay('ghost')
    expect(useUiStore.getState().overlayIds.size).toBe(0)
    useUiStore.getState().addOverlay('a')
    useUiStore.getState().removeOverlay('other')
    expect(useUiStore.getState().overlayIds.size).toBe(1)
    expect(useUiStore.getState().overlayIds.has('a')).toBe(true)
  })

  it('supports nested opens — multiple ids simultaneously registered', () => {
    useUiStore.getState().addOverlay('settings')
    useUiStore.getState().addOverlay('color-picker')
    expect(useUiStore.getState().overlayIds.size).toBe(2)
    expect(isAnyOverlayOpen(useUiStore.getState())).toBe(true)
    useUiStore.getState().removeOverlay('color-picker')
    expect(useUiStore.getState().overlayIds.size).toBe(1)
    expect(useUiStore.getState().overlayIds.has('settings')).toBe(true)
    expect(isAnyOverlayOpen(useUiStore.getState())).toBe(true)
    useUiStore.getState().removeOverlay('settings')
    expect(useUiStore.getState().overlayIds.size).toBe(0)
    expect(isAnyOverlayOpen(useUiStore.getState())).toBe(false)
  })

  it('open → close → open → close cycles return to empty every time (REQ-0137 §6)', () => {
    for (let i = 0; i < 5; i++) {
      useUiStore.getState().addOverlay('dialog')
      expect(isAnyOverlayOpen(useUiStore.getState())).toBe(true)
      useUiStore.getState().removeOverlay('dialog')
      expect(isAnyOverlayOpen(useUiStore.getState())).toBe(false)
    }
    expect(useUiStore.getState().overlayIds.size).toBe(0)
  })

  it('simulates React StrictMode dev double-invoke (setup → cleanup → setup) → size 1', () => {
    // StrictMode dev re-invokes each mount effect.  With the Set, this
    // is trivially net +1 because add/remove of the same id are
    // idempotent.  useId() returns a stable string per component
    // instance so both setups use the same id.
    useUiStore.getState().addOverlay('strict-a')      // real mount setup
    useUiStore.getState().removeOverlay('strict-a')   // StrictMode cleanup
    useUiStore.getState().addOverlay('strict-a')      // StrictMode re-setup
    expect(useUiStore.getState().overlayIds.size).toBe(1)
    expect(useUiStore.getState().overlayIds.has('strict-a')).toBe(true)
    useUiStore.getState().removeOverlay('strict-a')   // real unmount
    expect(useUiStore.getState().overlayIds.size).toBe(0)
  })

  it('two independent overlays under StrictMode-style re-invoke stay correct', () => {
    useUiStore.getState().addOverlay('a')
    useUiStore.getState().addOverlay('b')
    useUiStore.getState().removeOverlay('a')
    useUiStore.getState().removeOverlay('b')
    useUiStore.getState().addOverlay('a')
    useUiStore.getState().addOverlay('b')
    expect(useUiStore.getState().overlayIds.size).toBe(2)
    expect(useUiStore.getState().overlayIds.has('a')).toBe(true)
    expect(useUiStore.getState().overlayIds.has('b')).toBe(true)
  })
})
