import { join } from 'path'

/**
 * Pure helpers for detecting MSIX runtime context and resolving the
 * virtualized AppData path the OS redirects packaged-Win32 writes to.
 *
 * Why this module is separate from `paths.ts`:
 *   `paths.ts` depends on `electron` (for `app.getPath(...)`), which is
 *   awkward to mock in vitest.  The MSIX detection / PackageFamilyName
 *   parsing here uses only the Node `process` global and pure string
 *   manipulation, so the tests in `tests/unit/msix.test.ts` exercise it
 *   directly with no electron stub.
 *
 *   `paths.ts` is the glue layer: it reads `process` + `app.getPath('home')`
 *   and delegates the decision logic to the pure functions below.
 *
 * Background: under MSIX the OS redirects writes to
 *   %APPDATA%\<AppDataFolder>\...
 * to
 *   %LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\Roaming\<AppDataFolder>\...
 *
 * Filesystem APIs called from the packaged main process see the merged
 * (logical) path and reads/writes get redirected for them transparently.
 * Operations that hand a path string to another process — most notably
 * `shell.openPath` invoking Explorer.exe outside the package identity —
 * see the *real* logical path, which under MSIX is empty.  We therefore
 * need to construct the physical virtualized path explicitly for those
 * call sites.  See RES-20260615-070 §3-1.
 */

export interface ProcessContext {
  /** Value of `process.platform` (`'win32'` etc). */
  platform: NodeJS.Platform
  /** Value of `process.execPath` — absolute path of the running binary. */
  execPath: string
  /**
   * Electron sets `process.windowsStore === true` when launched from an
   * MSIX/AppX package.  Undefined elsewhere.  Documented but historically
   * unreliable (electron/electron#18161, fixed in PR #23785), so we treat
   * it as one of two independent signals.
   */
  windowsStore?: unknown
}

/**
 * Returns true when the current process is running from an MSIX package.
 *
 * Detection strategy (OR — either is enough):
 *   1. `process.windowsStore === true` — the official Electron signal.
 *   2. `process.execPath` contains `\WindowsApps\` (case-insensitive) —
 *      MSIX installs always land under `C:\Program Files\WindowsApps\`,
 *      so this catches the case where signal (1) regresses again.
 *
 * Returns false on non-Windows platforms unconditionally.
 */
export function isPackagedAsMsix(ctx: ProcessContext): boolean {
  if (ctx.platform !== 'win32') return false
  if (ctx.windowsStore === true) return true
  return ctx.execPath.toLowerCase().includes('\\windowsapps\\')
}

/**
 * Derives the MSIX PackageFamilyName from a packaged-app `process.execPath`.
 *
 *   execPath:          C:\Program Files\WindowsApps\<PackageFullName>\app\app.exe
 *   PackageFullName:   <Name>_<Version>_<Arch>_<ResourceId>_<PublisherId>
 *   PackageFamilyName: <Name>_<PublisherId>
 *
 * The ResourceId segment is usually empty, producing `__` between Arch
 * and PublisherId — splitting on `_` still yields five parts (the empty
 * string sits in the middle), so `parts[0]` and `parts.at(-1)` always
 * give the Name and PublisherId.
 *
 * Returns null when the path does not match the WindowsApps layout or the
 * name doesn't have the expected four-or-more `_`-separated segments.
 * Callers must fall back to the logical path on null.
 */
export function getMsixPackageFamilyName(execPath: string): string | null {
  const match = execPath.match(/\\WindowsApps\\([^\\]+)\\/i)
  if (!match) return null
  const fullName = match[1]
  const parts = fullName.split('_')
  // Expected layout has 5 parts (Name, Version, Arch, ResourceId, PublisherId).
  // Reject anything shorter — defensive against truncated / non-standard names.
  if (parts.length < 4) return null
  const name = parts[0]
  const publisherId = parts[parts.length - 1]
  if (!name || !publisherId) return null
  return `${name}_${publisherId}`
}

/**
 * Constructs the physical filesystem path that MSIX virtualization
 * redirects AppData writes to.
 *
 *   buildMsixVirtualizedPath('<home>', 'foo.bar_h123', 'MOJIOKO', 'models')
 *   → '<home>\AppData\Local\Packages\foo.bar_h123\LocalCache\Roaming\MOJIOKO\models'
 *
 * Caller passes the home dir explicitly (typically `app.getPath('home')`)
 * so this helper stays free of the `electron` import.
 */
export function buildMsixVirtualizedAppDataPath(
  homeDir: string,
  packageFamilyName: string,
  ...subSegments: string[]
): string {
  return join(
    homeDir,
    'AppData', 'Local', 'Packages', packageFamilyName,
    'LocalCache', 'Roaming',
    ...subSegments
  )
}

/**
 * Convenience wrapper that reads from the live Node `process` global.
 * Used by `paths.ts` so callers can keep using `getModelsDir()` etc.
 * without threading a context object through.
 */
export function getCurrentProcessContext(): ProcessContext {
  return {
    platform: process.platform,
    execPath: process.execPath,
    windowsStore: (process as { windowsStore?: unknown }).windowsStore,
  }
}
