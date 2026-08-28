/**
 * REQ-0517 §2 — the ONE shape a non-fatal render notice has, everywhere.
 *
 * ## Why this type moved out of the CLI
 *
 * It was `CliWarning`, declared in `main/cli/output.ts`, and it is what every
 * headless surface already returns in its `warnings[]`: the REQ-0502 no-op
 * combinations, the REQ-0508/0509 font substitutions, REQ-0516's line-pitch
 * warning, REQ-0517's audio-track fallback.  The GUI could see none of them.
 *
 * The one thing the GUI could show was font substitution, over a channel built
 * for it alone: `BurninEvent.completed.fontNotices`, typed
 * `FontSubstitutionNotice[]` whose `code` is a two-member union.  Anything else
 * would not type-check into it, so `SCALE_ANIM_LINE_PITCH_FIXED` had nowhere to
 * go (RES-0516 §3-5).  The choice was to widen a deliberately narrow type or to
 * build a second one-off; the answer is neither — the notice type belongs in
 * `shared/`, and the transport carries whatever the render produced.
 *
 * `CliWarning` remains exported from `main/cli/output.ts` as an alias, so the
 * ~40 CLI call sites are untouched and the name still reads correctly there.
 *
 * ## What this deliberately does NOT decide
 *
 * Which notices the GUI *shows*.  Carrying a notice and toasting it are
 * different questions: the transport is general on purpose, and
 * `render-notice-toast.ts` holds the allowlist, because "a warning that always
 * fires is not read" (REQ-0502) is a presentation rule, not a wire rule.
 */
export interface RenderNotice {
  /** Stable, machine-readable code.  The same strings the CLI documents. */
  code: string
  /**
   * Japanese sentence for headless callers.  The GUI does NOT display this —
   * it looks the code up in i18n so the text follows the app's language.  It
   * travels anyway so one object serves both surfaces and the log shows what
   * the CLI would have said.
   */
  message: string
  /** Code-specific structured payload; see each emitter for its shape. */
  detail?: unknown
}

/**
 * The `detail` shape the font-substitution notices carry, as
 * `detectFontSubstitutions` (CLI) and `fontSubstitutionNotices` (render) both
 * build it.  Declared here so the toast can read it back without casting to
 * `any` and without importing the CLI.
 */
export interface FontSubstitutionDetail {
  substitutions: Array<{
    from: string
    fromName: string
    to: string
    toName: string
    cueCount: number
  }>
  substitutedCueCount: number
  defaultSubstituted: boolean
}

/**
 * Read a notice's font-substitution detail, or `null` when it is not one / is
 * malformed.  A type guard rather than a cast: a notice arrives over IPC, and
 * the toast must not render `undefined → undefined` if a future emitter
 * changes the payload.
 */
export function fontSubstitutionDetail(notice: RenderNotice): FontSubstitutionDetail | null {
  const d = notice.detail
  if (typeof d !== 'object' || d === null) return null
  const rec = d as Record<string, unknown>
  if (!Array.isArray(rec.substitutions)) return null
  const subs: FontSubstitutionDetail['substitutions'] = []
  for (const raw of rec.substitutions) {
    if (typeof raw !== 'object' || raw === null) return null
    const s = raw as Record<string, unknown>
    if (typeof s.fromName !== 'string' || typeof s.toName !== 'string') return null
    subs.push({
      from: String(s.from ?? ''),
      fromName: s.fromName,
      to: String(s.to ?? ''),
      toName: s.toName,
      cueCount: typeof s.cueCount === 'number' ? s.cueCount : 0,
    })
  }
  return {
    substitutions: subs,
    substitutedCueCount: typeof rec.substitutedCueCount === 'number' ? rec.substitutedCueCount : subs.length,
    defaultSubstituted: rec.defaultSubstituted === true,
  }
}
