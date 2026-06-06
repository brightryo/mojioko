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
    /**
     * Accumulated synchronous time (ms) per labelled block since the last
     * `__mojioko_profile_times_reset()`.  Populated by {@link measureSync}.
     * REQ-095: render-count-was-zero but stutter remained → the bottleneck
     * is per-event WORK, not render volume, so we need elapsed time too.
     */
    __mojioko_profile_times?: Record<string, number>
    __mojioko_profile_times_reset?: () => void
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

/**
 * Time the synchronous execution of `fn` and accumulate the elapsed
 * milliseconds against `name` on `window.__mojioko_profile_times`.
 *
 * Outside seed mode the helper short-circuits to a direct call so
 * production builds pay only one `typeof` + property check — same
 * overhead profile as {@link bumpRenderCount}.
 *
 * REQ-095: introduced when REQ-094 cut render counts to zero for
 * ruler-scrub but the owner still observed stutter — the bottleneck
 * has to be elapsed time per pointermove (video seek, autoscroll,
 * etc.), so the e2e needed a way to attribute milliseconds, not just
 * counts.
 */
export function measureSync<T>(name: string, fn: () => T): T {
  if (typeof window === 'undefined') return fn()
  if (!(window as unknown as MojiokoTestWindow).__mojioko_test) return fn()
  if (!window.__mojioko_profile_times) {
    window.__mojioko_profile_times = {}
    window.__mojioko_profile_times_reset = () => {
      if (window.__mojioko_profile_times) {
        for (const k of Object.keys(window.__mojioko_profile_times)) {
          window.__mojioko_profile_times[k] = 0
        }
      }
    }
  }
  const start = performance.now()
  try {
    return fn()
  } finally {
    const elapsed = performance.now() - start
    window.__mojioko_profile_times[name] =
      (window.__mojioko_profile_times[name] ?? 0) + elapsed
  }
}
