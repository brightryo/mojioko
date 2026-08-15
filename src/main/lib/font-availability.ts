import { existsSync } from 'node:fs'
import { getFontFilePath } from './paths'
import { getFontMeta, type FontId } from '../../shared/fonts'

/**
 * REQ-0509 §1-4 — "is this font's file actually on disk?", for the main process.
 *
 * ## Why this is not `checkFontInstalled`
 *
 * `services/font-downloader.ts:checkFontInstalled` answers a related but
 * different question — it reports a DOWNLOADED font as installed when its
 * directory is non-empty, which is right for the Settings ▸ Fonts UI (a
 * half-finished download should read as "there, with a size"). Rendering needs
 * the narrower fact: **will `stageFontsDir`'s `copyFile` succeed?** A directory
 * holding only `OFL.txt` passes the first question and fails the second, and it
 * is the second that decides whether a burn survives. Both this probe and the
 * two staging functions go through `getFontFilePath`, so they cannot disagree.
 *
 * ## Why it memoises
 *
 * `resolveRenderableFontId` consults the predicate several times per font (the
 * request, then each same-family candidate, then each bundled-family
 * candidate), and the policy runs it per cue. On a 10k-cue project that is
 * hundreds of thousands of `existsSync` calls for at most 29 distinct answers.
 * The cache lives for one render — long enough to be free, short enough that a
 * download finishing between two burns is picked up.
 */
export function createInstalledFontProbe(): (id: FontId) => boolean {
  const cache = new Map<FontId, boolean>()
  return (id: FontId): boolean => {
    const hit = cache.get(id)
    if (hit !== undefined) return hit
    const present = existsSync(getFontFilePath(getFontMeta(id)))
    cache.set(id, present)
    return present
  }
}
