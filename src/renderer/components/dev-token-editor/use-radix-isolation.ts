import { useEffect, type RefObject } from 'react'

/**
 * REQ-0421 — keep a DEV-only fixed layer (token editor panel / overlay)
 * operable while a Radix modal (Sheet / Dialog) is open.
 *
 * When a Radix modal opens it (a) sets `body { pointer-events: none }` — the
 * caller must put `pointer-events: auto` on the layer root to override that —
 * and (b) installs document-level listeners that dismiss the modal on outside
 * pointerdown and trap focus back inside it on outside focusin.
 *
 * This hook stops the *bubbling native* events that drive (b) at the layer
 * root, so Radix's document listeners never see them: the modal is not
 * dismissed when you click the panel, and focus is not yanked back out of the
 * panel's inputs. It deliberately does NOT stop `click`, so React's onClick
 * delegation (attached at the app root) still fires for the layer's buttons.
 * `stopPropagation` (not `preventDefault`) is used, so native inputs
 * (range/color/textarea) keep working.
 */
export function useRadixModalIsolation(ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stop = (e: Event) => e.stopPropagation()
    const events = ['pointerdown', 'mousedown', 'focusin', 'touchstart'] as const
    events.forEach((ev) => el.addEventListener(ev, stop))
    return () => events.forEach((ev) => el.removeEventListener(ev, stop))
  }, [ref])
}
