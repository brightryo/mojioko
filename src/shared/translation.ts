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
export type TranslateErrorCode =
  | 'NO_ACTIVE_TOOL'
  | 'PYTHON_MISSING'
  /** The sidecar started but a Python dependency (e.g. sentencepiece) is absent. */
  | 'SIDECAR_DEPS_MISSING'
  | 'SIDECAR_ERROR'

/**
 * REQ-0411 — pull the module name out of a Python import failure so the
 * renderer can say "the translation sidecar is missing <module>" instead of a
 * generic "translation failed".  Matches `No module named 'x'` (raised by both
 * `ModuleNotFoundError` and bare `ImportError`).  Returns null when the error
 * is not a missing-module failure.
 */
export function detectMissingPythonModule(raw: string): string | null {
  const m = /No module named ['"]([\w.]+)['"]/.exec(raw)
  return m ? m[1] : null
}

/** Whether a raw sidecar error string looks like a missing-dependency failure. */
export function isDepsMissingError(raw: string): boolean {
  return detectMissingPythonModule(raw) !== null || /ModuleNotFoundError|ImportError/.test(raw)
}

/**
 * Build the actionable "install the dependencies" message shown when the
 * translation sidecar is missing a Python package.  Embeds the concrete venv
 * python + pip command so the developer can copy-paste it.
 */
export function buildDepsMissingMessage(pythonExe: string, module: string | null): string {
  const py = pythonExe || 'python'
  const mod = module ? ` (missing module: ${module})` : ''
  return `Translation sidecar dependency missing${mod}. Run: "${py}" -m pip install -r python-sidecar/requirements.txt`
}

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
