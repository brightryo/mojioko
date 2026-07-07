import { useEffect } from 'react'
import { useUiStore } from '@/stores/ui-store'

/**
 * REQ-0132 §2.1 — auto-registers the caller with the app-wide overlay
 * counter for as long as the caller is mounted.  Every Radix Dialog /
 * Sheet Content and the ColorPicker Popover call this so
 * `isAnyOverlayOpen(state)` (see ui-store) is accurate without each
 * consumer having to remember to flip a per-overlay boolean.
 *
 * Contract:
 *   - Radix Dialog / Sheet Content mount = Root open, unmount = Root
 *     closed.  A single mount effect (`incrementOverlay` on mount,
 *     `decrementOverlay` on unmount) is therefore an accurate open/
 *     close signal.  This works because Radix Portal only renders
 *     Content while the Dialog is open.
 *   - The ColorPicker Popover uses a different lifecycle (Popover
 *     content stays mounted longer than the open state in some Radix
 *     versions), so it explicitly increments/decrements from its
 *     `onOpenChange` callback rather than relying on this hook.
 *
 * The counter (not a boolean) matters because two overlays can be
 * open simultaneously — e.g. Settings open, then a nested ColorPicker
 * inside Settings.  Decrementing a counter is idempotent under nested
 * open/close; a boolean flag would race.
 */
export function useOverlayRegistration(): void {
  useEffect(() => {
    const { incrementOverlay, decrementOverlay } = useUiStore.getState()
    incrementOverlay()
    return () => {
      decrementOverlay()
    }
  }, [])
}
