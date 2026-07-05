import type { SupportedLanguage } from './app-info'

/**
 * REQ-0101 — resolve the initial UI language from the OS's ordered
 * preference list.  Pure (no Electron / no fs), so it lives under
 * `src/shared/` and is directly exercised by vitest.  The main-process
 * wrapper in `src/main/lib/os-language.ts` reads the actual OS list
 * from Electron and feeds it here.
 *
 * Rule: walk the list front-to-back.  The first `ja` / `ja-XX` entry
 * wins ('ja'); the first `en` / `en-XX` entry wins ('en'); unsupported
 * languages (fr, zh, …) are skipped so `['fr-FR', 'ja-JP']` still
 * resolves to 'ja'.  An empty list, or a list with only unsupported
 * languages, falls back to 'en'.
 *
 * The 'ja' preference is only honoured when it appears before any
 * English preference — this matches Windows's semantics where the
 * ordering in the language pane means "try these in order."
 *
 * Called only at first launch (no saved language yet); once the user
 * has explicitly chosen a language via the settings dropdown the
 * saved value takes precedence and this function is not consulted.
 */
export function resolveInitialLanguage(
  preferredLanguages: readonly string[],
): SupportedLanguage {
  for (const raw of preferredLanguages) {
    if (typeof raw !== 'string') continue
    const lc = raw.toLowerCase()
    if (lc === 'ja' || lc.startsWith('ja-')) return 'ja'
    if (lc === 'en' || lc.startsWith('en-')) return 'en'
  }
  return 'en'
}
