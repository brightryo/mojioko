import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { APP_DATA_FOLDER } from '../../shared/app-info'
import type { FontMeta } from '../../shared/fonts'
import {
  isPackagedAsMsix,
  getMsixPackageFamilyName,
  buildMsixVirtualizedAppDataPath,
  getCurrentProcessContext,
} from './msix'

const isDev = !app.isPackaged

export function getResourcesPath(): string {
  return isDev ? join(app.getAppPath(), 'resources') : process.resourcesPath
}

/**
 * REQ-0258 — resolve the on-disk path to the MOJIOKO EULA text for the
 * given UI language.
 *
 * - Dev: the source of truth lives at `<repo>/build/license_<lang>.txt`
 *   and is also the file the NSIS installer displays at install time.
 * - Packaged: the same two files are shipped under
 *   `<resourcesPath>/eula/license_<lang>.txt` via each electron-builder
 *   yml's `extraResources` block (added in this REQ alongside the About
 *   dialog's new "View EULA" button, since MSIX has no install-time
 *   EULA hook — see the REQ / RES for the rationale).
 *
 * Pure path resolution; caller reads the file.  No fallback file
 * lookup so a missing extraResources bundling surfaces as
 * `EULA_NOT_FOUND` rather than silently substituting the other
 * language.
 */
export function getEulaPath(lang: 'ja' | 'en'): string {
  const filename = `license_${lang}.txt`
  return isDev
    ? join(app.getAppPath(), 'build', filename)
    : join(getResourcesPath(), 'eula', filename)
}

export function getBinPath(...segments: string[]): string {
  const name = process.platform === 'win32' ? `${segments[segments.length - 1]}.exe` : segments[segments.length - 1]
  return join(getResourcesPath(), 'bin', 'ffmpeg', name)
}

/**
 * Legacy single-font directory — kept for callers that still pass the
 * default Noto subdir to libass.  New code should resolve a font's
 * directory via `getFontResolveDir(meta)` instead.
 */
export function getFontsDir(): string {
  return join(getResourcesPath(), 'fonts', 'Noto_Sans_JP', 'static')
}

/** Root of the bundled fonts tree, shipped via electron-builder extraResources. */
export function getFontsBundledRoot(): string {
  return join(getResourcesPath(), 'fonts')
}

/**
 * Root of the user-downloaded font tree.  Each downloaded font lives at
 * `<root>/<font-id>/<filename>.ttf` (plus an OFL.txt sibling).  Mirrors the
 * Whisper model layout under `%APPDATA%/MOJIOKO/models/`.
 */
export function getFontsUserRoot(): string {
  return join(getAppDataPath(), 'fonts')
}

/**
 * Per-font directory inside the user root, regardless of whether the font is
 * actually downloaded yet.  Safe to pass to mkdir + write.
 */
export function getFontUserDir(fontId: string): string {
  return join(getFontsUserRoot(), fontId)
}

/**
 * Resolve the absolute directory containing the TTF for `meta`.  Used as the
 * `fontsdir=` argument to ffmpeg's `subtitles=` filter and as the source
 * directory for opentype.js parsing on the main side.
 *
 * - bundled font  → `resources/fonts/<bundledRelativeDir>/` (must exist in the
 *                   installer).
 * - downloaded   → `%APPDATA%/MOJIOKO/fonts/<id>/` (may not exist until the
 *                   user completes the download).
 */
export function getFontResolveDir(meta: FontMeta): string {
  if (meta.bundled) {
    const sub = meta.bundledRelativeDir ?? ''
    return join(getFontsBundledRoot(), sub)
  }
  return getFontUserDir(meta.id)
}

/**
 * Resolve the path to the SIL OFL v1.1 text shipped alongside a bundled font.
 *
 * Convention: the OFL.txt lives at the **family root** (one level up from the
 * `static/` weight folder), so all weight variants share a single OFL file.
 *   bundled Noto Sans JP → `resources/fonts/Noto_Sans_JP/OFL.txt`
 *
 * Returns the family-root OFL path when `meta.bundledRelativeDir` contains a
 * subpath (e.g. `Noto_Sans_JP/static`); otherwise returns the join of
 * `bundledRelativeDir` itself.
 *
 * Returns null when the font is not bundled — downloaded fonts have their
 * own per-font OFL.txt at `%APPDATA%/MOJIOKO/fonts/<id>/OFL.txt`, which is
 * already handled by `getFontUserDir(id) + '/OFL.txt'`.
 */
export function getBundledOflPath(meta: FontMeta): string | null {
  if (!meta.bundled) return null
  const rel = meta.bundledRelativeDir ?? ''
  // Strip a trailing `/static` segment (or any deeper sub-path) so the OFL
  // lives at the family root.  Falls back to the same dir as the TTF when
  // there is no slash, which is the simpler one-level-deep layout.
  const familyRoot = rel.includes('/') ? rel.split('/')[0] : rel
  return join(getFontsBundledRoot(), familyRoot, 'OFL.txt')
}

export function getAppDataPath(): string {
  return join(app.getPath('appData'), APP_DATA_FOLDER)
}

export function getSettingsPath(): string {
  return join(getAppDataPath(), 'settings.json')
}

export function getLogsDir(): string {
  return join(getAppDataPath(), 'logs')
}

/**
 * Resolves the **physical** directory where Whisper models live on disk.
 *
 * Why this is not just `join(getAppDataPath(), 'models')`:
 *
 * Under MSIX the OS transparently redirects writes to `%APPDATA%\MOJIOKO\…`
 * onto `%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\MOJIOKO\…`.
 * Filesystem calls from inside the package see the merged path and work
 * fine, but call sites that hand the path string to a non-packaged
 * consumer (most importantly `shell.openPath` → Explorer.exe) see the
 * *real* logical path, which is empty.  See RES-20260615-070 §3-1.
 *
 * To keep every existing caller (`shell.ts`, `transcription.ts`, the
 * "保存先" row in the install-confirm dialog) working without
 * environment-aware branching, this function returns the explicit
 * virtualized path under MSIX and the logical path everywhere else.
 *
 * Fallback to the logical path when MSIX is detected but the
 * PackageFamilyName cannot be parsed from `process.execPath` —
 * preserves the v1.3.0 behavior rather than crashing.
 */
export function getModelsDir(): string {
  const ctx = getCurrentProcessContext()
  if (isPackagedAsMsix(ctx)) {
    const pfn = getMsixPackageFamilyName(ctx.execPath)
    if (pfn) {
      return buildMsixVirtualizedAppDataPath(
        app.getPath('home'),
        pfn,
        APP_DATA_FOLDER,
        'models'
      )
    }
  }
  return join(getAppDataPath(), 'models')
}

/**
 * REQ-0149 — physical directory holding the user-downloaded GPU
 * acceleration DLLs (CUDA runtime + cuBLAS + cuDNN redistributables).
 *
 * Before REQ-0149 these 11 DLLs (~1.5 GB) shipped inside the installer
 * under `resources/bin/transcriber/_internal/ctranslate2/`.  That pushed
 * the NSIS payload past 1.85 GB and made the free build harder to
 * distribute.  We now ship a CPU-only installer (~340 MB) and let users
 * download the GPU tools on demand from a GitHub Releases asset
 * (`cuda-v1` tag).
 *
 * The final layout is:
 *   `<gpu-tools>/cuda-v1/{cudart64_12.dll, cublas64_12.dll, ...,
 *                         NVIDIA-LICENSES.txt}`
 * — same MSIX/NSIS virtualization rationale as `getModelsDir()`.  When
 * unpacked to this directory, the Electron main process passes the path
 * to the sidecar via the `MOJIOKO_GPU_TOOL_DIR` env var and
 * `_preload_bundled_cuda_dlls()` in `python-sidecar/main.py` loads them
 * before ctranslate2 gets a chance to LoadLibrary("cublas64_12.dll").
 */
export function getGpuToolsRoot(): string {
  const ctx = getCurrentProcessContext()
  if (isPackagedAsMsix(ctx)) {
    const pfn = getMsixPackageFamilyName(ctx.execPath)
    if (pfn) {
      return buildMsixVirtualizedAppDataPath(
        app.getPath('home'),
        pfn,
        APP_DATA_FOLDER,
        'gpu-tools'
      )
    }
  }
  return join(getAppDataPath(), 'gpu-tools')
}

/**
 * Per-release directory inside `getGpuToolsRoot()`.  Matches the GitHub
 * Releases tag so we can ship a follow-up (`cuda-v2` etc.) without
 * cross-contaminating old installs.  The 11 DLLs land at this path's
 * root after extraction.
 */
export function getGpuToolDir(releaseTag: string): string {
  return join(getGpuToolsRoot(), releaseTag)
}

/**
 * REQ-086 — directory holding the pre-generated multi-track preview mix.
 *
 * Same MSIX/NSIS rationale as `getModelsDir`: under MSIX the OS redirects
 * writes to `%APPDATA%\MOJIOKO\…` onto a virtualized package path; using
 * the explicit physical path here keeps file system semantics consistent
 * with the rest of the AppData layout.  See REQ-071.
 */
export function getPreviewMixDir(): string {
  const ctx = getCurrentProcessContext()
  if (isPackagedAsMsix(ctx)) {
    const pfn = getMsixPackageFamilyName(ctx.execPath)
    if (pfn) {
      return buildMsixVirtualizedAppDataPath(
        app.getPath('home'),
        pfn,
        APP_DATA_FOLDER,
        'preview-mix'
      )
    }
  }
  return join(getAppDataPath(), 'preview-mix')
}

/**
 * REQ-0231 — per-run unique preview-mix filename.
 *
 * The v1.3.2 design used a fixed `preview-mix.m4a` and relied on an
 * atomic `.tmp` → `.m4a` rename to swap in each new run.  That flow
 * hit EPERM on Windows when the renderer's `<audio>` element from the
 * previous run still held the old `preview-mix.m4a` open — Chromium
 * does not release the file handle synchronously with URL swap or
 * component unmount, so a rapid "transcribe → open editor → back to
 * step 1 → transcribe again" cycle stalls at the rename with EPERM
 * (see RES-0119 §1, REQ-0129 backoff attempts, and the fresh
 * REQ-0231 repro).  Even a longer backoff cannot force `<audio>` to
 * release the handle.
 *
 * REQ-0231 fix: every run writes to a new unique file (`.tmp` staged
 * next to it), so the rename target never collides with a locked
 * file.  Old files from prior runs are swept up (best-effort) before
 * each generation, and any file that IS still held by the previous
 * `<audio>` simply survives the sweep until the audio releases —
 * cleanup is not on the critical path.
 *
 * Filename shape (chosen for readability in Explorer + sort order +
 * defence-in-depth against same-millisecond collisions):
 *   preview-mix-YYYYMMDD-HHMMSS-mmm-<4-char base36>.m4a
 * Example:
 *   preview-mix-20260715-091033-123-abcd.m4a
 *
 * Regex used by the sweep + protocol validator:
 *   ^preview-mix-\d{8}-\d{6}-\d{3}-[a-z0-9]{4}\.m4a(\.tmp)?$
 * Also matches the legacy fixed name `preview-mix.m4a(.tmp)` so a
 * post-upgrade sweep tidies pre-REQ-0231 leftovers.
 */
export function generatePreviewMixFilename(now: Date = new Date()): string {
  const YYYY = String(now.getFullYear()).padStart(4, '0')
  const MM = String(now.getMonth() + 1).padStart(2, '0')
  const DD = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  // 4 base36 chars ≈ 20 bits of entropy — same-ms collision odds are
  // ~1 in 1.7M per call.  This is only a safety net; timestamp
  // uniqueness already covers realistic call rates (< 1 per second).
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  return `preview-mix-${YYYY}${MM}${DD}-${hh}${mm}${ss}-${ms}-${rand}.m4a`
}

/** Absolute path for a given preview-mix filename. */
export function getPreviewMixFilePath(filename: string): string {
  return join(getPreviewMixDir(), filename)
}

/**
 * True iff `name` is one of our own preview-mix files (finished OR
 * `.tmp`, new REQ-0231 naming OR legacy fixed name).  Used by both
 * the sweep and the custom protocol to validate anything before
 * touching / serving it.
 *
 * Callers of the protocol treat any URL whose filename does NOT
 * match this as file-not-found so a malicious renderer cannot smuggle
 * a `../../foo.txt` path through the URL.
 */
export function isPreviewMixFilename(name: string): boolean {
  // Path separators must never appear — defence against traversal.
  if (name.includes('/') || name.includes('\\')) return false
  // Legacy fixed-name shape from REQ-086 / pre-REQ-0231.
  if (name === 'preview-mix.m4a' || name === 'preview-mix.m4a.tmp') return true
  // REQ-0231 unique-name shape.
  return /^preview-mix-\d{8}-\d{6}-\d{3}-[a-z0-9]{4}\.m4a(\.tmp)?$/.test(name)
}

export function getPythonSidecarPath(): string {
  return isDev
    ? join(app.getAppPath(), 'python-sidecar', 'main.py')
    : join(process.resourcesPath, 'python-sidecar', 'main.py')
}

/**
 * Returns the path to the PyInstaller-built standalone transcriber binary
 * shipped with packaged installs.  When --onedir is used, PyInstaller writes
 * `mojioko-transcriber.exe` plus its dependency folder under
 * `resources/bin/transcriber/`; the exe is the spawnable entry point.
 *
 * Returns null in dev (sidecar is run via .venv python + main.py instead) or
 * if the file is missing — the caller falls back to the .venv path with a
 * clear error message.
 */
export function getTranscriberExePath(): string | null {
  if (isDev) return null
  const exe = process.platform === 'win32'
    ? join(process.resourcesPath, 'bin', 'transcriber', 'mojioko-transcriber.exe')
    : join(process.resourcesPath, 'bin', 'transcriber', 'mojioko-transcriber')
  return existsSync(exe) ? exe : null
}

/**
 * Returns the path to the Python executable to use for the transcription sidecar.
 *
 * Dev:  .venv in the project root (created by `py -3.11 -m venv .venv`)
 * Prod: bundled Python runtime under resources/python/ (TODO: populate in electron-builder.yml)
 *
 * Returns null if the resolved executable does not exist on disk.
 */
export function getPythonExecutable(): string | null {
  if (isDev) {
    const exe = process.platform === 'win32'
      ? join(app.getAppPath(), '.venv', 'Scripts', 'python.exe')
      : join(app.getAppPath(), '.venv', 'bin', 'python')
    return existsSync(exe) ? exe : null
  }

  // TODO: bundle Python under resources/python/ via electron-builder extraResources.
  // Until then the packaged build falls back to the system Python (will break if absent).
  const exe = process.platform === 'win32'
    ? join(process.resourcesPath, 'python', 'python.exe')
    : join(process.resourcesPath, 'python', 'bin', 'python')
  return existsSync(exe) ? exe : null
}
