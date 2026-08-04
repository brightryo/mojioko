/**
 * REQ-0410 — shared, pure helpers for the translation prototype (auto
 * translate-on-select in the inspector).  Kept pure so the `<2xx>` prefix, the
 * cache key, and the latest-wins decision are unit-tested without a model.
 *
 * The translation is a PROTOTYPE: shown in a throwaway inspector field, never
 * persisted and never written to `SubtitleEntry` (so CLAUDE.md §21 does not
 * apply).  English is fixed for now.
 */

export type TranslationTarget = 'en'

/** IPC result payload for a successful translation. */
export interface TranslateResult {
  text: string
  /** Model+tokenizer load time in ms (0 when the sidecar was already warm). */
  loadMs: number
  /** Inference time in ms for this request. */
  translateMs: number
}

/** Error codes the translate IPC can return (mapped to i18n in the renderer). */
export type TranslateErrorCode = 'NO_ACTIVE_TOOL' | 'PYTHON_MISSING' | 'SIDECAR_ERROR'

/**
 * MADLAD-400 encodes the target language as a `<2xx>` token prefixed onto the
 * SOURCE text (not a decoder option).  This builds the exact string the
 * SentencePiece tokenizer is fed.  The single space after the tag matches the
 * canonical CTranslate2 MADLAD usage.
 */
export function buildMadladSource(text: string, target: TranslationTarget = 'en'): string {
  return `<2${target}> ${text}`
}

/**
 * The text actually sent for translation: `\N` line breaks collapse to spaces
 * and surrounding whitespace is trimmed, so wrapping never changes the request
 * (and the cache key) for otherwise-identical text.
 */
export function normalizeSourceText(text: string): string {
  return text.replace(/\\N/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Cache key for a (source, target) pair: "<target> <normalized text>". */
export function translationCacheKey(text: string, target: TranslationTarget = 'en'): string {
  return `${target} ${normalizeSourceText(text)}`
}

/**
 * Latest-wins guard for the debounced auto-translate: a completed request's
 * result is applied only if it is still the most recent one issued (so quickly
 * switching cues shows the newest translation, never a stale earlier one).
 */
export function isLatestRequest(requestSeq: number, latestSeq: number): boolean {
  return requestSeq === latestSeq
}

/** Whether a source string is worth translating (non-empty after normalize). */
export function isTranslatableText(text: string): boolean {
  return normalizeSourceText(text).length > 0
}
