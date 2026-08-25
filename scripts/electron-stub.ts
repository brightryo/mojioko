/**
 * REQ-0537 — a stand-in for `electron`, for harnesses that bundle main-process
 * modules for plain node.
 *
 * Why this is needed now: `font-metrics-node` imports `main/lib/paths`
 * statically (REQ-0537 — the lazy `require` it used before did not resolve
 * inside electron-vite's single-file bundle, so font metrics failed in the real
 * app and REQ-0535's background silently reverted). `paths` imports `electron`,
 * and esbuild bundles the electron npm shim, whose module body throws
 * "Electron failed to install correctly" when it is not running under Electron.
 *
 * The stub answers the two things `paths` asks for, pointed at the repo, so a
 * harness that DOES exercise the real resolver gets the real bundled-font
 * directory rather than a fiction. Nothing here fakes a font: if the file is not
 * on disk, the loader still reports `file-not-found`.
 */
import { join } from 'node:path'

/**
 * Repo root.
 *
 * NOT derived from `__dirname`: the harnesses that bundle this file also pass
 * `define: { __dirname: ... }` to pin an unrelated module's asset lookup, and
 * that define applies to the WHOLE bundle — so `__dirname` here silently became
 * the harness directory and every bundled-font path came out one level short.
 * The gate then believed all 29 registry fonts were missing and picked an
 * installed one as its "uninstalled font" control, which of course did not
 * reproduce anything.
 *
 * `MOJIOKO_REPO_ROOT` wins if set; otherwise the cwd, because every harness is
 * launched through an npm script and npm runs scripts from the package root.
 */
const REPO_ROOT = process.env.MOJIOKO_REPO_ROOT ?? process.cwd()

export const app = {
  /** Harnesses run unpackaged, which is what `paths` means by dev. */
  isPackaged: false,
  getAppPath: (): string => REPO_ROOT,
  getPath: (name: string): string => {
    if (name === 'appData') return process.env.APPDATA ?? join(REPO_ROOT, '.appdata')
    if (name === 'home') return process.env.USERPROFILE ?? REPO_ROOT
    return join(REPO_ROOT, '.electron-stub', name)
  },
}

export default { app }
