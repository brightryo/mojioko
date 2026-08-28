/**
 * REQ-0545 §2 (RES-0543 A1) — reporting a failed settings save, once per cause.
 *
 * ## Why this is not just a `toast.error` at the call site
 *
 * The save is debounced off *every* settings-store mutation, so a persistent
 * cause — a full disk, a file another program is holding — would raise a toast
 * on every slider drag. The first report is the one that matters; the
 * hundredth is noise that buries it.
 *
 * So repeats of the SAME reason are suppressed, and a success clears the
 * suppression: a problem that comes back after being fixed is reported again.
 * A genuinely different failure is never suppressed, because the reason string
 * is the key.
 *
 * ## Why it lives here rather than in `App.tsx`
 *
 * It has state, and state in a module that only a React component can reach is
 * state no test can look at (this repo has no jsdom/RTL setup — see
 * `vitest.config`). Pulling it out makes the suppression rule a pure object
 * with an injected `notify`, which is exactly the part worth pinning.
 */
export interface SettingsSaveReporter {
  /** Call when a save attempt failed. `reason` may be empty. */
  failed: (reason: string) => void
  /** Call when a save attempt succeeded. */
  succeeded: () => void
}

export function createSettingsSaveReporter(
  notify: (reason: string) => void,
): SettingsSaveReporter {
  let lastReported: string | null = null
  return {
    failed(reason: string) {
      // An empty reason still has to be reportable — "it failed and we do not
      // know why" is information the user needs. It just gets one bucket.
      const key = reason || 'unknown'
      if (lastReported === key) return
      lastReported = key
      notify(key)
    },
    succeeded() {
      lastReported = null
    },
  }
}
