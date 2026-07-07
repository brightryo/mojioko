import { useEffect, useId } from 'react'
import { useUiStore } from '@/stores/ui-store'

/**
 * REQ-0132 §2.1 / REQ-0137 fix — auto-registers the caller with the
 * app-wide overlay id set for as long as the caller is mounted.  When
 * any overlay is registered `isAnyOverlayOpen(state)` returns true and
 * the shared shortcut handler + preview panels' Space bindings treat
 * the app as being in context A (background shortcuts suppressed).
 *
 * REQ-0137 changed two things vs the REQ-0132 version:
 *
 *   1. **Where the hook is called.**  REQ-0132 called this from the
 *      wrapper's function body in `dialog.tsx` / `sheet.tsx`, which
 *      fires as soon as the wrapper mounts.  But consumers keep
 *      `<Dialog open={false}><DialogContent>...</DialogContent></Dialog>`
 *      in the tree at all times, so the wrapper mounts at app boot
 *      regardless of `open` — inflating the counter to N even when no
 *      dialog is visibly open, and blocking every editor shortcut.
 *      The fix moves the hook INSIDE `<DialogPrimitive.Content>` via
 *      a small `<OverlayRegistrar />` child component.  Radix's
 *      Presence mounts Content's children only when the Root is open
 *      (or during a close animation), so mount now genuinely
 *      corresponds to "the overlay is visible."
 *
 *   2. **How the state is stored.**  Counter → id-Set.  `useId()`
 *      hands out a stable string per component instance; `add(id)` /
 *      `delete(id)` are idempotent under StrictMode's dev
 *      double-invoke of effects (setup → cleanup → setup → …), so a
 *      re-invoke can never inflate the state past its real cardinality.
 *
 * The pair (position + Set) means no code path can leave the overlay
 * state "stuck open" — a fresh app boot with zero visible overlays
 * always yields `overlayIds.size === 0`.
 */
export function useOverlayRegistration(): void {
  const id = useId()
  useEffect(() => {
    const { addOverlay, removeOverlay } = useUiStore.getState()
    addOverlay(id)
    return () => {
      removeOverlay(id)
    }
  }, [id])
}
