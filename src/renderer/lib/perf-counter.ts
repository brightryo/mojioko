/**
 * Render-counter dev hook (REQ-071 Phase 3.9).
 *
 * Exposes a per-component render count on `window.__mojioko_profile` so a
 * Playwright spec can measure how often each timeline subtree re-renders
 * in response to zoom / scroll / playhead state changes.  The hook is a
 * no-op outside of seed mode (`window.__mojioko_test` is only attached
 * when the renderer was loaded with `?seed=demo`).
 *
 * Production code paths still call `bumpRenderCount('Block')` etc., but
 * the helper short-circuits to a single `typeof window !== 'undefined'`
 * check and an object lookup — cheaper than a function-component render
 * itself, so the overhead in shipped builds is negligible.
 *
 * The counters are cleared by Playwright before each measurement step
 * via `window.__mojioko_profile_reset()`.
 */

declare global {
  interface Window {
    __mojioko_profile?: Record<string, number>
    __mojioko_profile_reset?: () => void
  }
}

interface MojiokoTestWindow {
  __mojioko_test?: unknown
}

/**
 * Increment the render counter for `name`.
 *
 * No-op outside of seed mode — the counter map is only initialised once
 * the renderer detects `window.__mojioko_test` (which `main.tsx`
 * attaches only when loaded with `?seed=demo`).  Production builds
 * therefore pay only the cost of a `typeof` + property lookup per call.
 */
export function bumpRenderCount(name: string): void {
  if (typeof window === 'undefined') return
  if (!(window as unknown as MojiokoTestWindow).__mojioko_test) return
  if (!window.__mojioko_profile) {
    window.__mojioko_profile = {}
    window.__mojioko_profile_reset = () => {
      if (window.__mojioko_profile) {
        for (const k of Object.keys(window.__mojioko_profile)) {
          window.__mojioko_profile[k] = 0
        }
      }
    }
  }
  window.__mojioko_profile[name] = (window.__mojioko_profile[name] ?? 0) + 1
}
