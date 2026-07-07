import { app } from 'electron'
import type { SupportedLanguage } from '../../shared/app-info'
import { resolveInitialLanguage } from '../../shared/language-detect'

/**
 * REQ-0101 — read the OS's language preference from Electron and
 * resolve it to a MOJIOKO-supported UI language via the pure
 * `resolveInitialLanguage` in `shared/language-detect.ts`.
 *
 * Order of consulted APIs:
 *   1. `app.getPreferredSystemLanguages()` — Windows returns the full
 *      ordered list from Settings → Language.  Empty on some non-Win
 *      environments.
 *   2. `app.getLocale()` — single "best guess" locale.  Used as a
 *      one-item fallback when (1) is empty.
 *
 * Both are wrapped in try/catch so a stray failure (e.g. called before
 * `app.ready` on a platform where these methods require ready) falls
 * through to the pure resolver's own 'en' fallback rather than
 * crashing settings load.
 */
export function detectOsLanguage(): SupportedLanguage {
  let langs: string[] = []
  try {
    langs = app.getPreferredSystemLanguages() ?? []
  } catch {
    langs = []
  }
  if (langs.length === 0) {
    try {
      const one = app.getLocale()
      if (one) langs = [one]
    } catch {
      // fall through to resolveInitialLanguage([]) = 'en'
    }
  }
  return resolveInitialLanguage(langs)
}
