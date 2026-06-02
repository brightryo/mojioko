/**
 * Subtitle font registry — single source of truth for every font ID, display
 * name, ASS font name, downloadable asset URL, expected size, and OFL
 * attribution string used anywhere in the app.
 *
 * Bundled vs downloadable
 * - `bundled: true`   → ships inside resources/fonts/ in the installer.
 *                       Cannot be uninstalled.  The "Noto Sans JP SemiBold"
 *                       entry is the application default.
 * - `bundled: false`  → must be downloaded by the user on first use.  Asset
 *                       URLs follow the convention
 *                       `https://github.com/<owner>/<repo>/releases/download/fonts-v1/<FileName>.ttf`.
 *                       The `OFL.txt` shared across the release is at
 *                       `fonts-v1/OFL.txt`.
 *
 * Notes
 * - `cssFontFamily` is the family name registered via `@font-face` (renderer
 *   side, CSS preview) — it is shared between bundled and downloaded fonts
 *   so the preview switches by changing the family literal.
 * - `assFontName` is the value placed in the ASS `Style:` line under
 *   `Fontname`.  For the fonts shipped under Google Fonts this matches the
 *   `family` and `cssFontFamily`, with NotoSansJP-SemiBold using
 *   "Noto Sans JP SemiBold" because libass matches subfamily by full name.
 * - `expectedSizeBytes` is used by the integrity check in
 *   `font-downloader.ts` (±10 % tolerance).  Values are best-effort from the
 *   asset Content-Length at the time of release publication.
 */

import { GITHUB_OWNER, GITHUB_REPO } from './app-info'

/** Release tag that hosts every downloadable font asset. */
export const FONTS_RELEASE_TAG = 'fonts-v1'

// Per-font OFL distribution: each font ships its own `<FontName>-OFL.txt`
// alongside its TTF in the `fonts-v1` release.  This satisfies SIL OFL v1.1
// §2 — "each copy contains the above copyright notice and this license" —
// because the per-font OFL text starts with that specific font's copyright
// header (the upstream form from `google/fonts/ofl/<name>/OFL.txt`).
//
// An earlier design shared a single `fonts-v1/OFL.txt` between all fonts and
// relied on `meta.copyright` to supply the per-font header at render time.
// That approach was rejected: the *distributed file itself* must carry the
// notice for the licence to be conveyed with the binary, not merely surfaced
// at runtime.  Removed `FONTS_SHARED_OFL_URL` for that reason.

export type FontId =
  | 'noto-sans-jp-semibold'
  | 'dela-gothic-one'
  | 'reggae-one'
  | 'yusei-magic'
  | 'mochiy-pop-one'
  | 'hachi-maru-pop'
  | 'potta-one'
  | 'dotgothic16'
  | 'rampart-one'

export type FontLicense = 'SIL-OFL-1.1'

export interface FontMeta {
  id: FontId
  /** Shown in the picker UI. */
  displayName: string
  /** Family registered via CSS `@font-face` (used by SubtitleOverlay etc.). */
  cssFontFamily: string
  /** Value placed in the ASS `Style:` `Fontname` field. */
  assFontName: string
  /** Single TTF filename — also the relative path inside the font directory. */
  fileName: string
  /** OpenType weight class to register the @font-face under. */
  weight: number
  /** When true, ships in the installer; cannot be uninstalled. */
  bundled: boolean
  /** Full URL to the .ttf asset.  Null only for bundled fonts. */
  downloadUrl: string | null
  /**
   * Per-font OFL.txt URL.  Non-null for every downloadable font — the asset
   * lives at `fonts-v1/<FontName>-OFL.txt` and carries that font's own
   * copyright header followed by the standard SIL OFL v1.1 body.  Null only
   * for bundled fonts whose OFL is shipped via the installer rather than
   * fetched on demand.
   */
  oflUrl: string | null
  /** Best-effort Content-Length at release time; used for ±10 % size check. */
  expectedSizeBytes: number
  /** Copyright line, surfaced verbatim in the License attribution screen. */
  copyright: string
  /** Upstream project / source URL for attribution. */
  sourceUrl: string
  /** License identifier (SPDX-style). */
  license: FontLicense
  /**
   * Subdirectory inside `resources/fonts/` containing the TTF.  Defined only
   * for bundled fonts.  E.g. `'Noto_Sans_JP/static'` for the default Noto.
   * Downloadable fonts always live at `%APPDATA%/MOJIOKO/fonts/<id>/` and
   * leave this null.
   */
  bundledRelativeDir: string | null
  /**
   * Display-only flag: the font's glyph table omits a handful of post-jōyō
   * additions (塡 / 剝 / 頰 are the canonical examples) so subtitles
   * containing those code points would fall back to libass' default face
   * mid-word.  UI surfaces a small "稀な漢字が表示されない場合があります"
   * note alongside the font name so the user can pick another face for
   * scripts that need them.  REQ-022 step 5.
   */
  lacksRareKanji?: boolean
}

function assetUrl(fileName: string): string {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${FONTS_RELEASE_TAG}/${fileName}`
}

/**
 * Font registry.  Order = display order in the picker.  The bundled Noto entry
 * is intentionally first so the default font sits at the top of the list.
 *
 * For the seven fonts that are not yet uploaded to `fonts-v1`, the URL is
 * pre-allocated to the canonical filename so once the owner uploads the
 * asset with the same name, the downloader starts succeeding without code
 * change.  Sizes are approximate and will tighten when actual uploads land.
 */
export const FONT_REGISTRY: readonly FontMeta[] = [
  {
    id: 'noto-sans-jp-semibold',
    displayName: 'Noto Sans JP SemiBold',
    cssFontFamily: 'Noto Sans JP',
    assFontName: 'Noto Sans JP SemiBold',
    fileName: 'NotoSansJP-SemiBold.ttf',
    weight: 600,
    bundled: true,
    downloadUrl: null,
    oflUrl: null,
    expectedSizeBytes: 0,
    copyright: 'Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name "Source". Noto Sans JP is licensed under the SIL Open Font License, Version 1.1.',
    sourceUrl: 'https://fonts.google.com/noto/specimen/Noto+Sans+JP',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: 'Noto_Sans_JP/static'
  },
  {
    id: 'dela-gothic-one',
    displayName: 'Dela Gothic One',
    cssFontFamily: 'Dela Gothic One',
    assFontName: 'Dela Gothic One',
    fileName: 'DelaGothicOne-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('DelaGothicOne-Regular.ttf'),
    oflUrl: assetUrl('DelaGothicOne-OFL.txt'),
    expectedSizeBytes: 5_469_244,
    copyright: 'Copyright 2020 The Dela Gothic Project Authors (https://github.com/syakuzen/DelaGothic)',
    sourceUrl: 'https://fonts.google.com/specimen/Dela+Gothic+One',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null
  },
  {
    id: 'reggae-one',
    displayName: 'Reggae One',
    cssFontFamily: 'Reggae One',
    assFontName: 'Reggae One',
    fileName: 'ReggaeOne-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('ReggaeOne-Regular.ttf'),
    oflUrl: assetUrl('ReggaeOne-OFL.txt'),
    expectedSizeBytes: 2_153_256,
    copyright: 'Copyright 2020 The Reggae Project Authors (https://github.com/fontworks-fonts/Reggae)',
    sourceUrl: 'https://fonts.google.com/specimen/Reggae+One',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null
  },
  {
    id: 'yusei-magic',
    displayName: 'Yusei Magic',
    cssFontFamily: 'Yusei Magic',
    assFontName: 'Yusei Magic',
    fileName: 'YuseiMagic-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('YuseiMagic-Regular.ttf'),
    oflUrl: assetUrl('YuseiMagic-OFL.txt'),
    expectedSizeBytes: 3_134_968,
    copyright: 'Copyright 2020 The Yusei Magic Project Authors (https://github.com/tanukifont/YuseiMagic)',
    sourceUrl: 'https://fonts.google.com/specimen/Yusei+Magic',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null
  },
  {
    id: 'mochiy-pop-one',
    displayName: 'Mochiy Pop One',
    cssFontFamily: 'Mochiy Pop One',
    assFontName: 'Mochiy Pop One',
    fileName: 'MochiyPopOne-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('MochiyPopOne-Regular.ttf'),
    oflUrl: assetUrl('MochiyPopOne-OFL.txt'),
    expectedSizeBytes: 5_163_948,
    copyright: 'Copyright 2020 The Mochiypop Project Authors (https://github.com/fontdasu/Mochiypop)',
    sourceUrl: 'https://fonts.google.com/specimen/Mochiy+Pop+One',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null
  },
  {
    id: 'hachi-maru-pop',
    displayName: 'Hachi Maru Pop',
    cssFontFamily: 'Hachi Maru Pop',
    assFontName: 'Hachi Maru Pop',
    fileName: 'HachiMaruPop-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('HachiMaruPop-Regular.ttf'),
    oflUrl: assetUrl('HachiMaruPop-OFL.txt'),
    expectedSizeBytes: 4_385_624,
    copyright: 'Copyright 2020 The Hachi Maru Pop Project Authors (https://github.com/noriokanisawa/HachiMaruPop)',
    sourceUrl: 'https://fonts.google.com/specimen/Hachi+Maru+Pop',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    lacksRareKanji: true
  },
  {
    id: 'potta-one',
    displayName: 'Potta One',
    cssFontFamily: 'Potta One',
    assFontName: 'Potta One',
    fileName: 'PottaOne-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('PottaOne-Regular.ttf'),
    oflUrl: assetUrl('PottaOne-OFL.txt'),
    expectedSizeBytes: 4_918_516,
    copyright: 'Copyright 2020 The Potta Project Authors (https://github.com/go108go/Potta)',
    sourceUrl: 'https://fonts.google.com/specimen/Potta+One',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    lacksRareKanji: true
  },
  {
    id: 'dotgothic16',
    displayName: 'DotGothic16',
    cssFontFamily: 'DotGothic16',
    assFontName: 'DotGothic16',
    fileName: 'DotGothic16-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('DotGothic16-Regular.ttf'),
    oflUrl: assetUrl('DotGothic16-OFL.txt'),
    expectedSizeBytes: 2_069_236,
    copyright: 'Copyright 2020 The DotGothic16 Project Authors (https://github.com/fontworks-fonts/DotGothic16)',
    sourceUrl: 'https://fonts.google.com/specimen/DotGothic16',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null
  },
  {
    id: 'rampart-one',
    displayName: 'Rampart One',
    cssFontFamily: 'Rampart One',
    assFontName: 'Rampart One',
    fileName: 'RampartOne-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('RampartOne-Regular.ttf'),
    oflUrl: assetUrl('RampartOne-OFL.txt'),
    expectedSizeBytes: 3_722_352,
    copyright: 'Copyright 2020 The Rampart Project Authors (https://github.com/fontworks-fonts/Rampart)',
    sourceUrl: 'https://fonts.google.com/specimen/Rampart+One',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null
  }
] as const

/** Default font.  Always installed (bundled). */
export const DEFAULT_FONT_ID: FontId = 'noto-sans-jp-semibold'

export function getFontMeta(id: FontId): FontMeta {
  const meta = FONT_REGISTRY.find((f) => f.id === id)
  if (!meta) {
    // Defensive — should never happen for FontId-typed inputs.  Fall back to
    // the default rather than throwing so a bad settings file does not crash
    // the renderer on first read.
    return FONT_REGISTRY[0]
  }
  return meta
}

/** Type guard for IPC-boundary validation. */
export function isFontId(value: unknown): value is FontId {
  return typeof value === 'string' && FONT_REGISTRY.some((f) => f.id === value)
}

/**
 * Status of a font from the renderer's perspective.
 * - `bundled` → installed via the installer; cannot be uninstalled.
 * - `installed` → previously downloaded; ready for selection / removal.
 * - `not-installed` → known font ID, not yet downloaded.
 * - `unavailable` → asset URL returned 404 the last time we checked.  Used
 *                   to surface "this font has not been uploaded yet" without
 *                   blocking the rest of the picker.
 */
export type FontStatus = 'bundled' | 'installed' | 'not-installed' | 'unavailable'

export interface FontInfo {
  id: FontId
  displayName: string
  status: FontStatus
  /** Actual on-disk size in bytes (0 when not installed). */
  sizeBytes: number
  /** Expected size from the registry (0 for bundled). */
  expectedSizeBytes: number
  bundled: boolean
  hasDownloadUrl: boolean
}

export interface FontsState {
  fonts: FontInfo[]
  activeFontId: FontId
  /** Total bytes consumed by downloaded (non-bundled) fonts. */
  totalUsedBytes: number
}

export type DownloadFontEvent =
  | { event: 'progress'; file: string; fileIndex: number; totalFiles: number; percent: number }
  | { event: 'completed' }
  | { event: 'failed'; error: string }
