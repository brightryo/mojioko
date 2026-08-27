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
 * ## Asked every time (REQ-0559 §2)
 *
 * The dialog is shown before EVERY gated action, not just the first. Those
 * actions — exporting the bundle, copying either config — are rare and
 * deliberate, so re-asking costs one click on something nobody does often, and
 * it puts the boundary in front of the user at the moment it applies rather
 * than once, months earlier.
 *
 * `consentAcceptedAtMs` is still recorded, because "did this user ever agree"
 * is worth knowing, but it no longer decides whether to ask.
 *
 * A second field, `noticeSeenAtMs`, used to drive a one-time retroactive notice
 * for users who set this up before the gate existed. REQ-0559 removed it: with
 * every-time asking, those users meet the full dialog the next time they act,
 * which is both the same information and a better moment than a popup for
 * opening a tab. An old settings.json may still contain the key; `sanitize`
 * simply drops it.
 */
export interface AiIntegrationConsent {
  /** When the user pressed the accept button. Absent = never accepted. */
  consentAcceptedAtMs?: number
}

/** Has the user explicitly agreed? */
export function hasAiConsent(state: AiIntegrationConsent | undefined): boolean {
  return typeof state?.consentAcceptedAtMs === 'number'
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
  return out
}
