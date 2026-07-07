import { describe, it, expect, beforeEach } from 'vitest'
import { useUiStore, isAnyOverlayOpen } from '../../src/renderer/stores/ui-store'

/**
 * REQ-0132 §2.1 — the overlay counter replaces REQ-0131's flag-OR
 * `isAnyModalOpen` scheme.  Pins the invariants that make the counter
 * safe under nested opens and out-of-order closes.
 */

function reset() {
  useUiStore.setState({ overlayOpenCount: 0 })
}

beforeEach(reset)

describe('REQ-0132 — overlay counter + isAnyOverlayOpen', () => {
  it('starts at 0 → isAnyOverlayOpen false', () => {
    expect(useUiStore.getState().overlayOpenCount).toBe(0)
    expect(isAnyOverlayOpen(useUiStore.getState())).toBe(false)
  })

  it('increment → counter=1 → isAnyOverlayOpen true', () => {
    useUiStore.getState().incrementOverlay()
    expect(useUiStore.getState().overlayOpenCount).toBe(1)
    expect(isAnyOverlayOpen(useUiStore.getState())).toBe(true)
  })

  it('supports nested opens (counter > 1 while both are open)', () => {
    useUiStore.getState().incrementOverlay()
    useUiStore.getState().incrementOverlay()
    expect(useUiStore.getState().overlayOpenCount).toBe(2)
    expect(isAnyOverlayOpen(useUiStore.getState())).toBe(true)
    // Close the inner overlay → still open.
    useUiStore.getState().decrementOverlay()
    expect(useUiStore.getState().overlayOpenCount).toBe(1)
    expect(isAnyOverlayOpen(useUiStore.getState())).toBe(true)
    // Close the outer overlay → closed.
    useUiStore.getState().decrementOverlay()
    expect(useUiStore.getState().overlayOpenCount).toBe(0)
    expect(isAnyOverlayOpen(useUiStore.getState())).toBe(false)
  })

  it('clamps at 0 so an extra decrement can never take the counter negative', () => {
    useUiStore.getState().decrementOverlay()
    expect(useUiStore.getState().overlayOpenCount).toBe(0)
    useUiStore.getState().incrementOverlay()
    useUiStore.getState().decrementOverlay()
    useUiStore.getState().decrementOverlay()
    expect(useUiStore.getState().overlayOpenCount).toBe(0)
  })
})
