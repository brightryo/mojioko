/**
 * REQ-0551 — the consent state for AI integration, and the two decisions made
 * from it.
 *
 * ## Why a gate exists at all
 *
 * MOJIOKO's promise is "everything happens on this PC", and for transcription,
 * translation and burn-in that stays true: the processing is local and the
 * video and audio files never leave the machine. AI integration does not change
 * that — but it does add something the promise did not cover.
 *
 * When an assistant drives MOJIOKO over MCP, the assistant is a remote service.
 * What it reads and writes through the tools — **the full subtitle text, file
 * paths, the video's metadata, and the tools' replies** — travels to the AI
 * provider's servers, because that is where the assistant runs. The media
 * itself does not.
 *
 * That is a real narrowing of a headline promise, so the user gets to see the
 * line drawn before they connect anything, not after.
 *
 * ## Two different situations
 *
 * - Someone connecting for the FIRST time is asked, and nothing happens unless
 *   they accept.
 * - Someone who already set this up before the gate existed is TOLD once. Their
 *   setup is not broken, and the `.mcpb` they already exported keeps working —
 *   revoking a working configuration to make a point would be its own kind of
 *   harm. The notice says so explicitly.
 *
 * These are separate fields because they answer different questions: "did they
 * agree" and "have we told them". Collapsing them would either nag a user who
 * dismissed the notice, or silently treat dismissal as agreement.
 */
export interface AiIntegrationConsent {
  /** When the user pressed the accept button. Absent = never accepted. */
  consentAcceptedAtMs?: number
  /**
   * When the one-time retroactive notice was shown to an already-configured
   * user. Absent = not shown yet.
   */
  noticeSeenAtMs?: number
}

/** Has the user explicitly agreed? */
export function hasAiConsent(state: AiIntegrationConsent | undefined): boolean {
  return typeof state?.consentAcceptedAtMs === 'number'
}

/**
 * Should an action that hands connection details to an assistant be gated?
 *
 * Every such action goes through this, so "which buttons are gated" has one
 * answer rather than one per button.
 */
export function needsAiConsentGate(state: AiIntegrationConsent | undefined): boolean {
  return !hasAiConsent(state)
}

/**
 * Should the one-time retroactive notice be shown when the AI tab opens?
 *
 * Only for someone who is ALREADY set up (`hasExported`) and has neither
 * accepted nor been told. A fresh user sees nothing on open — they will meet
 * the gate when they act, which is the better moment: a dialog that appears
 * for a tab you merely clicked reads as noise.
 */
export function needsAiRetroactiveNotice(
  state: AiIntegrationConsent | undefined,
  hasExported: boolean,
): boolean {
  if (!hasExported) return false
  if (hasAiConsent(state)) return false
  return typeof state?.noticeSeenAtMs !== 'number'
}

/**
 * Validate the record read off disk.
 *
 * Strict about types because a malformed value here decides whether a user is
 * asked for consent: a non-number `consentAcceptedAtMs` must NOT be mistaken
 * for "they agreed". Anything unrecognised falls back to "not agreed, not
 * told", which re-asks — the safe direction.
 */
export function sanitizeAiConsent(raw: unknown): AiIntegrationConsent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: AiIntegrationConsent = {}
  if (typeof r.consentAcceptedAtMs === 'number' && Number.isFinite(r.consentAcceptedAtMs)) {
    out.consentAcceptedAtMs = r.consentAcceptedAtMs
  }
  if (typeof r.noticeSeenAtMs === 'number' && Number.isFinite(r.noticeSeenAtMs)) {
    out.noticeSeenAtMs = r.noticeSeenAtMs
  }
  return out
}
