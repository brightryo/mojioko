/**
 * SRT timestamp formatting — `HH:MM:SS,mmm`.
 *
 * ## Why this is its own module (REQ-0347 §1-2)
 *
 * There were two copies of this function: one in `routes/step2.tsx` (the
 * app's "export as SRT") and one in `scripts/generate-test-srt.mjs` (the
 * load-test generator).  Both carried the same bug, and fixing the generator
 * in REQ-0346 fixed exactly one of them — the shipped one kept emitting
 * invalid files for another REQ.  Two copies is how a fix reaches half the
 * places that need it, so the app-side copy now lives here.
 *
 * The generator still has its own copy, deliberately: it is a plain `.mjs`
 * run by bare `node`, and importing a `.ts` module would mean adding `tsx`
 * (or a build step) as a dependency of a dev script — a change not worth
 * making immediately before a Store submission, for a script that is not
 * shipped.  Instead the duplication is GUARDED: the generator's real output
 * is diffed against this function in
 * `tests/unit/srt-time-req-0347.test.ts`, so the copies cannot drift silently.
 * That is the weaker guarantee of the two, and it is a deliberate trade.
 */

/**
 * Format `sec` as an SRT timestamp.
 *
 * ## The bug this shape exists to prevent
 *
 * The previous implementation computed the seconds and the milliseconds
 * independently:
 *
 * ```
 * const s  = Math.floor(sec % 60)
 * const ms = Math.round((sec % 1) * 1000)
 * ```
 *
 * For a `sec` whose fractional part rounds UP to a whole second — say
 * `1194.9999999`, which ordinary float arithmetic produces readily — `ms`
 * becomes `1000` while `s` stays at `54`, emitting `00:19:54,1000`.  That is
 * not a valid SRT timestamp: the milliseconds field is three digits, 000-999.
 * The carry existed; it was simply computed by one expression and needed by
 * the other.
 *
 * Converting ONCE to integer milliseconds and deriving every field from that
 * single value makes the carry structural — there is no second rounding for
 * it to fall between.  `formatAssTime` in `main/services/ass-generator.ts`
 * already had this shape, which is why the burn-in path was never affected.
 *
 * Negative inputs are clamped to zero: SRT has no representation for them,
 * and emitting `-1:59:59,000` would be a worse failure than starting at zero.
 */
export function formatSrtTime(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000))
  const ms = totalMs % 1000
  const totalSec = (totalMs - ms) / 1000
  const s = totalSec % 60
  const m = Math.floor(totalSec / 60) % 60
  const h = Math.floor(totalSec / 3600)
  return (
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:` +
    `${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
  )
}

/**
 * The shape every SRT timestamp must have: two-digit hours, minutes and
 * seconds, then a comma and exactly three digits of milliseconds.
 *
 * Exported so tests can assert the FORMAT rather than golden strings — a
 * golden only catches the values somebody thought to write down, and the
 * value that broke this was one nobody would have picked (REQ-0347 §1-5).
 *
 * Hours are not capped at two digits by the format itself, but `\d{2,}`
 * would admit the very overflow being guarded against elsewhere; a subtitle
 * past 100 hours is not a case this app supports.
 */
export const SRT_TIME_PATTERN = /^\d{2}:\d{2}:\d{2},\d{3}$/
