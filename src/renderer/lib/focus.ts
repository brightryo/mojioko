/**
 * REQ-0384 §B — release keyboard focus from an editable field.
 *
 * The timeline's playhead-scrub surfaces (the time Ruler and the tracks lane)
 * are plain `<div>`s and call `e.preventDefault()` on pointerdown to own the
 * drag.  `preventDefault` suppresses the browser's native focus change, so a
 * click there does NOT move focus off the inspector's subtitle `<textarea>`.
 * Focus then stays trapped in the field: Space types a space instead of
 * play/pause, and Shift+←/→ selects text instead of stepping a frame
 * (`shouldGlobalShortcutFire` bails while an input is focused).  Clicking a clip
 * body doesn't hit this because clips are `<button>`s, which take focus
 * natively; only the scrub `<div>`s need to blur explicitly.
 *
 * Blurs the active element only when it is a text field (input / textarea /
 * select / contentEditable) — the same "typing context" the global-shortcut
 * predicate recognises — so buttons and other focusables are left alone.
 * Blurring commits any in-progress edit via the field's own `onBlur`, which is
 * the desired "clicking the timeline finishes the edit" behaviour.
 */
export function blurActiveEditable(): void {
  const el = document.activeElement as HTMLElement | null
  if (!el) return
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable) {
    el.blur()
  }
}
