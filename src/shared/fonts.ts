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

/**
 * REQ-0269 C-4 — Font set version.  Increments every time the registry
 * gains a new downloadable asset (or an existing asset is re-uploaded).
 *
 * Used by the "Download font set" button to detect when the user's local
 * on-disk set is outdated versus what this app version expects.  Written
 * into settings.json under `fontSetInstalledVersion` when the bulk
 * download completes; if that recorded value is `< FONT_SET_VERSION`,
 * the picker treats the set as `outdated` and offers to re-download.
 *
 * v1: the original 12 downloadable fonts (REQ-0153).
 * v2: adds Noto Sans JP 6 non-bundled weights (Thin, ExtraLight, Light,
 *     Bold, ExtraBold, Black) and 8 additional Poppins weights (Thin,
 *     ExtraLight, Light, Medium, SemiBold, Bold, ExtraBold, Black).
 *     Montserrat stays at Regular only — see RES-0269 Phase 0
 *     verification for the libass variable-font rejection.
 */
export const FONT_SET_VERSION = 2

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
  // Noto Sans JP — 9 weights (REQ-0269 B).  SemiBold is the app default
  // and the ONLY weight bundled in v1.0–v1.3.5; Regular / Medium ship as
  // dead-weight TTFs since v1.0 (fonts.css @font-face rules referenced
  // them) and are now first-class FontIds under REQ-0269 B-2.  The
  // remaining six (Thin / ExtraLight / Light / Bold / ExtraBold / Black)
  // are downloadable via the font set.
  | 'noto-sans-jp-thin'
  | 'noto-sans-jp-extralight'
  | 'noto-sans-jp-light'
  | 'noto-sans-jp-regular'
  | 'noto-sans-jp-medium'
  | 'noto-sans-jp-semibold'
  | 'noto-sans-jp-bold'
  | 'noto-sans-jp-extrabold'
  | 'noto-sans-jp-black'
  | 'dela-gothic-one'
  | 'reggae-one'
  | 'yusei-magic'
  | 'mochiy-pop-one'
  | 'hachi-maru-pop'
  | 'potta-one'
  | 'dotgothic16'
  | 'rampart-one'
  // REQ-0153 — 4 Latin display / sans faces added for the international
  // (v1.3.3) tier.  All SIL OFL 1.1, full glyph coverage from upstream
  // (Devanagari for Poppins, Cyrillic + Latin Extended for Montserrat),
  // paid-tier only via the existing `canSelectFontInTier` / `canDownloadFontInTier`
  // policy that gates every non-default font behind `isMsix`.
  | 'anton'
  | 'bebas-neue'
  // REQ-0269 Phase 0 verification: Montserrat variable font could not be
  // driven per-weight through libass (DirectWrite path silently fell back
  // to Regular for `Fontname="Montserrat Bold"`, only Thin coincidentally
  // resolved — see `dev-docs/font-validation/Montserrat-libass-probe/`).
  // Preview↔burn-in parity would break, so Montserrat stays Regular only.
  | 'montserrat'
  // Poppins — 9 weights (REQ-0269 B).  Existing `poppins` FontId retained
  // for backwards compatibility with pre-v1.3.6 projects — semantically
  // it means "Poppins Regular (400)".  The 8 additional weights get
  // explicit `-<weight>` suffixes.  Family default is Bold (per REQ B-5).
  | 'poppins'
  | 'poppins-thin'
  | 'poppins-extralight'
  | 'poppins-light'
  | 'poppins-medium'
  | 'poppins-semibold'
  | 'poppins-bold'
  | 'poppins-extrabold'
  | 'poppins-black'

export type FontLicense = 'SIL-OFL-1.1'

/**
 * REQ-0153 / REQ-0154 §1 — set of scripts a font actually declares glyphs
 * for.  Rendered as one badge per language by the shared
 * `<FontLangBadge>` next to the display name in every font picker.
 * Missing-glyph rendering (tofu) is intentionally NOT prevented — the
 * badges are the discovery signal, per REQ policy.
 */
export type FontLanguage = 'ja' | 'en'

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
  /**
   * REQ-0154 §1 / §2 — every language the font actually declares glyphs
   * for.  Auto-derived from a cmap probe (`dev-docs/font-validation/
   * probe-cmap.mjs`, one-shot script) rather than hand-picked, so a
   * Japanese face that also carries basic Latin (all 9 pre-REQ-0153
   * faces) correctly surfaces both badges instead of the pre-REQ-0154
   * "ja"-only single tag.
   *
   * Contract (REQ-0155 flipped from REQ-0154's original ja-first order):
   *   - Order: `'en'` first when present, then `'ja'`.  Rationale: every
   *     registered font carries basic Latin (verified in REQ-0154 by cmap
   *     probe), so putting `'en'` at index 0 aligns the "EN" chip in the
   *     same column across every row in the picker, and the extra "JA"
   *     chip on Japanese faces reads as an additive capability rather
   *     than a re-arrangement.
   *   - Non-empty: every registry entry declares at least one language.
   *     The probe found no font that carries JA glyphs without also
   *     carrying Latin, so `['ja']` alone never appears (owner's
   *     hypothesis, verified in REQ-0154 RES §2.2).
   */
  languages: readonly FontLanguage[]
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
// -----------------------------------------------------------------
// REQ-0269 B — Noto Sans JP weight matrix.
//
// Bundled: Regular (400), Medium (500), SemiBold (600) — TTFs already
// live in `resources/fonts/Noto_Sans_JP/static/` since v1.0 (RES-0268
// flagged Regular / Medium as dead weight; REQ-0269 B-2 promotes them
// to registered FontIds so no bytes are wasted).
//
// Downloadable via font set: Thin (100), ExtraLight (200), Light (300),
// Bold (700), ExtraBold (800), Black (900).  All hosted alongside the
// existing v1 assets under the `fonts-v1` release tag — no `fonts-v2`
// bump because the tag is versionless.  Sizes are the Google Fonts
// static distribution values (all ~5.4-5.5 MB per weight); the ±10 %
// integrity check will accept the actual Content-Length once the assets
// are uploaded (fonts-v2 GitHub release publish is owner-gated, per
// REQ-0269 承認制操作).
//
// Copyright / sourceUrl are shared across the whole family (Adobe /
// Google Fonts distribute one OFL notice for the family).  Each weight
// carries its own `<Name>-OFL.txt` in the fonts-v2 release for the
// per-file license-with-binary requirement (SIL OFL §2).
// -----------------------------------------------------------------
const NOTO_COPYRIGHT = 'Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name "Source". Noto Sans JP is licensed under the SIL Open Font License, Version 1.1.'
const NOTO_SOURCE_URL = 'https://fonts.google.com/noto/specimen/Noto+Sans+JP'
const NOTO_BUNDLED_DIR = 'Noto_Sans_JP/static'

export const FONT_REGISTRY: readonly FontMeta[] = [
  {
    id: 'noto-sans-jp-thin',
    displayName: 'Noto Sans JP Thin',
    cssFontFamily: 'Noto Sans JP',
    assFontName: 'Noto Sans JP Thin',
    fileName: 'NotoSansJP-Thin.ttf',
    weight: 100,
    bundled: false,
    downloadUrl: assetUrl('NotoSansJP-Thin.ttf'),
    oflUrl: assetUrl('NotoSansJP-OFL.txt'),
    expectedSizeBytes: 5_400_000,
    copyright: NOTO_COPYRIGHT,
    sourceUrl: NOTO_SOURCE_URL,
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  {
    id: 'noto-sans-jp-extralight',
    displayName: 'Noto Sans JP ExtraLight',
    cssFontFamily: 'Noto Sans JP',
    assFontName: 'Noto Sans JP ExtraLight',
    fileName: 'NotoSansJP-ExtraLight.ttf',
    weight: 200,
    bundled: false,
    downloadUrl: assetUrl('NotoSansJP-ExtraLight.ttf'),
    oflUrl: assetUrl('NotoSansJP-OFL.txt'),
    expectedSizeBytes: 5_400_000,
    copyright: NOTO_COPYRIGHT,
    sourceUrl: NOTO_SOURCE_URL,
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  {
    id: 'noto-sans-jp-light',
    displayName: 'Noto Sans JP Light',
    cssFontFamily: 'Noto Sans JP',
    assFontName: 'Noto Sans JP Light',
    fileName: 'NotoSansJP-Light.ttf',
    weight: 300,
    bundled: false,
    downloadUrl: assetUrl('NotoSansJP-Light.ttf'),
    oflUrl: assetUrl('NotoSansJP-OFL.txt'),
    expectedSizeBytes: 5_400_000,
    copyright: NOTO_COPYRIGHT,
    sourceUrl: NOTO_SOURCE_URL,
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  {
    id: 'noto-sans-jp-regular',
    displayName: 'Noto Sans JP Regular',
    cssFontFamily: 'Noto Sans JP',
    assFontName: 'Noto Sans JP Regular',
    fileName: 'NotoSansJP-Regular.ttf',
    weight: 400,
    bundled: true,
    downloadUrl: null,
    oflUrl: null,
    expectedSizeBytes: 0,
    copyright: NOTO_COPYRIGHT,
    sourceUrl: NOTO_SOURCE_URL,
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: NOTO_BUNDLED_DIR,
    languages: ['en', 'ja']
  },
  {
    id: 'noto-sans-jp-medium',
    displayName: 'Noto Sans JP Medium',
    cssFontFamily: 'Noto Sans JP',
    assFontName: 'Noto Sans JP Medium',
    fileName: 'NotoSansJP-Medium.ttf',
    weight: 500,
    bundled: true,
    downloadUrl: null,
    oflUrl: null,
    expectedSizeBytes: 0,
    copyright: NOTO_COPYRIGHT,
    sourceUrl: NOTO_SOURCE_URL,
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: NOTO_BUNDLED_DIR,
    languages: ['en', 'ja']
  },
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
    copyright: NOTO_COPYRIGHT,
    sourceUrl: NOTO_SOURCE_URL,
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: NOTO_BUNDLED_DIR,
    languages: ['en', 'ja']
  },
  {
    id: 'noto-sans-jp-bold',
    displayName: 'Noto Sans JP Bold',
    cssFontFamily: 'Noto Sans JP',
    assFontName: 'Noto Sans JP Bold',
    fileName: 'NotoSansJP-Bold.ttf',
    weight: 700,
    bundled: false,
    downloadUrl: assetUrl('NotoSansJP-Bold.ttf'),
    oflUrl: assetUrl('NotoSansJP-OFL.txt'),
    expectedSizeBytes: 5_500_000,
    copyright: NOTO_COPYRIGHT,
    sourceUrl: NOTO_SOURCE_URL,
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  {
    id: 'noto-sans-jp-extrabold',
    displayName: 'Noto Sans JP ExtraBold',
    cssFontFamily: 'Noto Sans JP',
    assFontName: 'Noto Sans JP ExtraBold',
    fileName: 'NotoSansJP-ExtraBold.ttf',
    weight: 800,
    bundled: false,
    downloadUrl: assetUrl('NotoSansJP-ExtraBold.ttf'),
    oflUrl: assetUrl('NotoSansJP-OFL.txt'),
    expectedSizeBytes: 5_500_000,
    copyright: NOTO_COPYRIGHT,
    sourceUrl: NOTO_SOURCE_URL,
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  {
    id: 'noto-sans-jp-black',
    displayName: 'Noto Sans JP Black',
    cssFontFamily: 'Noto Sans JP',
    assFontName: 'Noto Sans JP Black',
    fileName: 'NotoSansJP-Black.ttf',
    weight: 900,
    bundled: false,
    downloadUrl: assetUrl('NotoSansJP-Black.ttf'),
    oflUrl: assetUrl('NotoSansJP-OFL.txt'),
    expectedSizeBytes: 5_500_000,
    copyright: NOTO_COPYRIGHT,
    sourceUrl: NOTO_SOURCE_URL,
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
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
    bundledRelativeDir: null,
    languages: ['en', 'ja']
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
    bundledRelativeDir: null,
    languages: ['en', 'ja']
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
    bundledRelativeDir: null,
    languages: ['en', 'ja']
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
    bundledRelativeDir: null,
    languages: ['en', 'ja']
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
    lacksRareKanji: true,
    languages: ['en', 'ja']
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
    lacksRareKanji: true,
    languages: ['en', 'ja']
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
    bundledRelativeDir: null,
    languages: ['en', 'ja']
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
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  // -----------------------------------------------------------------
  // REQ-0153 — international (Latin) faces.  All SIL OFL 1.1 with the
  // per-font copyright header preserved verbatim in the sibling
  // `<Name>-OFL.txt` asset under the same `fonts-v1` release.  Assets
  // uploaded to the existing `fonts-v1` tag (versionless font pool)
  // rather than a `fonts-v2` bump — the release tag holds every
  // downloadable font asset for the app irrespective of app version.
  // -----------------------------------------------------------------
  {
    id: 'anton',
    displayName: 'Anton',
    cssFontFamily: 'Anton',
    assFontName: 'Anton',
    fileName: 'Anton-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('Anton-Regular.ttf'),
    oflUrl: assetUrl('Anton-OFL.txt'),
    expectedSizeBytes: 170_812,
    copyright: 'Copyright 2020 The Anton Project Authors (https://github.com/googlefonts/AntonFont.git)',
    sourceUrl: 'https://fonts.google.com/specimen/Anton',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'bebas-neue',
    displayName: 'Bebas Neue',
    cssFontFamily: 'Bebas Neue',
    assFontName: 'Bebas Neue',
    fileName: 'BebasNeue-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('BebasNeue-Regular.ttf'),
    oflUrl: assetUrl('BebasNeue-OFL.txt'),
    expectedSizeBytes: 61_400,
    copyright: 'Copyright © 2010 by Dharma Type.',
    sourceUrl: 'https://fonts.google.com/specimen/Bebas+Neue',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'montserrat',
    displayName: 'Montserrat',
    cssFontFamily: 'Montserrat',
    // REQ-0153 — Google Fonts serves Montserrat only as a variable
    // font on the wght axis.  libass (0.17+, bundled with ffmpeg
    // shipped in this app) reads variable fonts via the same
    // fontconfig path; the wght axis default is 400 = Regular so
    // the ASS `Style:` line's `Fontname` = "Montserrat" resolves
    // to the Regular instance without any extra plumbing.
    assFontName: 'Montserrat',
    fileName: 'Montserrat-Variable.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('Montserrat-Variable.ttf'),
    oflUrl: assetUrl('Montserrat-OFL.txt'),
    expectedSizeBytes: 744_936,
    copyright: 'Copyright 2024 The Montserrat.Git Project Authors (https://github.com/JulietaUla/Montserrat.git)',
    sourceUrl: 'https://fonts.google.com/specimen/Montserrat',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  // -----------------------------------------------------------------
  // REQ-0269 B — Poppins weight matrix (9 weights, all downloadable).
  //
  // Existing FontId `poppins` is kept as-is at weight 400 for backward
  // compatibility with pre-v1.3.6 project files (which serialised it as
  // just `poppins`).  New weights use the `poppins-<weight>` naming
  // convention.  Family default is Bold (700) per REQ B-5.
  //
  // All 9 static weight TTFs are on Google Fonts under
  // `google/fonts/ofl/poppins/`.  Each file is ~150–170 KB.
  // -----------------------------------------------------------------
  {
    id: 'poppins-thin',
    displayName: 'Poppins Thin',
    cssFontFamily: 'Poppins',
    assFontName: 'Poppins Thin',
    fileName: 'Poppins-Thin.ttf',
    weight: 100,
    bundled: false,
    downloadUrl: assetUrl('Poppins-Thin.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 155_000,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'poppins-extralight',
    displayName: 'Poppins ExtraLight',
    cssFontFamily: 'Poppins',
    assFontName: 'Poppins ExtraLight',
    fileName: 'Poppins-ExtraLight.ttf',
    weight: 200,
    bundled: false,
    downloadUrl: assetUrl('Poppins-ExtraLight.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 158_000,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'poppins-light',
    displayName: 'Poppins Light',
    cssFontFamily: 'Poppins',
    assFontName: 'Poppins Light',
    fileName: 'Poppins-Light.ttf',
    weight: 300,
    bundled: false,
    downloadUrl: assetUrl('Poppins-Light.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 160_000,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'poppins',
    displayName: 'Poppins Regular',
    cssFontFamily: 'Poppins',
    assFontName: 'Poppins',
    fileName: 'Poppins-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('Poppins-Regular.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 160_316,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'poppins-medium',
    displayName: 'Poppins Medium',
    cssFontFamily: 'Poppins',
    assFontName: 'Poppins Medium',
    fileName: 'Poppins-Medium.ttf',
    weight: 500,
    bundled: false,
    downloadUrl: assetUrl('Poppins-Medium.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 160_000,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'poppins-semibold',
    displayName: 'Poppins SemiBold',
    cssFontFamily: 'Poppins',
    assFontName: 'Poppins SemiBold',
    fileName: 'Poppins-SemiBold.ttf',
    weight: 600,
    bundled: false,
    downloadUrl: assetUrl('Poppins-SemiBold.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 160_000,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'poppins-bold',
    displayName: 'Poppins Bold',
    cssFontFamily: 'Poppins',
    assFontName: 'Poppins Bold',
    fileName: 'Poppins-Bold.ttf',
    weight: 700,
    bundled: false,
    downloadUrl: assetUrl('Poppins-Bold.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 160_000,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'poppins-extrabold',
    displayName: 'Poppins ExtraBold',
    cssFontFamily: 'Poppins',
    assFontName: 'Poppins ExtraBold',
    fileName: 'Poppins-ExtraBold.ttf',
    weight: 800,
    bundled: false,
    downloadUrl: assetUrl('Poppins-ExtraBold.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 160_000,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'poppins-black',
    displayName: 'Poppins Black',
    cssFontFamily: 'Poppins',
    assFontName: 'Poppins Black',
    fileName: 'Poppins-Black.ttf',
    weight: 900,
    bundled: false,
    downloadUrl: assetUrl('Poppins-Black.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 160_000,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  }
] as const

/** Default font.  Always installed (bundled). */
export const DEFAULT_FONT_ID: FontId = 'noto-sans-jp-semibold'

/**
 * REQ-0269 B-5 — per-family default weight, applied whenever the user
 * switches a subtitle's font FAMILY.  Guarantees the previously-selected
 * weight is NOT carried across family switches (Regular Noto → Bold
 * Poppins would be a jarring UX): swapping family always resets weight
 * to the family's canonical default, and the FONT+WEIGHT change lands
 * as one atomic history entry so a single Undo restores both.
 *
 * Families not listed here are single-weight and their default is the
 * only registered FontId in that family (identity resolved by
 * `getFamilyDefaultFontId`).
 */
const FAMILY_DEFAULT_FONT_ID: Readonly<Record<string, FontId>> = {
  'Noto Sans JP': 'noto-sans-jp-semibold',
  'Poppins': 'poppins-bold',
}

/**
 * REQ-0269 B — resolve the canonical FontId for a family's default
 * weight.  Multi-weight families (Noto Sans JP, Poppins) use the
 * hardcoded map above; single-weight families return their sole
 * registry entry.  Falls back to `DEFAULT_FONT_ID` if the family
 * is not known at all (defensive; shouldn't happen for valid input).
 */
export function getFamilyDefaultFontId(cssFontFamily: string): FontId {
  const explicit = FAMILY_DEFAULT_FONT_ID[cssFontFamily]
  if (explicit) return explicit
  const single = FONT_REGISTRY.find((f) => f.cssFontFamily === cssFontFamily)
  return single?.id ?? DEFAULT_FONT_ID
}

/**
 * REQ-0269 B — grouped view of the registry, one entry per unique
 * `cssFontFamily`, carrying its ordered weight list.  Used by every
 * font picker so the family selector and weight selector can render as
 * two dependent dropdowns instead of a flat 29-item list.  Families
 * appear in the order they were first seen in `FONT_REGISTRY` (so
 * "Noto Sans JP" pins first, then Anton / Bebas Neue / Dela / …).
 */
export interface FontFamily {
  /** Rendered family name shared by every weight (`cssFontFamily`). */
  cssFontFamily: string
  /** Weights in ascending numeric order (100–900), each keyed by FontId. */
  weights: readonly { weight: number; fontId: FontId; displayName: string; assFontName: string }[]
  /** Family default FontId (matches `getFamilyDefaultFontId`). */
  defaultFontId: FontId
  /** True when the family has more than one registered weight. */
  hasMultipleWeights: boolean
  /** All languages advertised by any weight in the family (union). */
  languages: readonly FontLanguage[]
  /** True when at least one weight is bundled (family is always available). */
  hasBundledWeight: boolean
  /** True when at least one weight carries the `lacksRareKanji` flag. */
  lacksRareKanji: boolean
}

export function getFontFamilies(): FontFamily[] {
  const byFamily = new Map<string, FontFamily & { _seen: Set<number> }>()
  for (const meta of FONT_REGISTRY) {
    let entry = byFamily.get(meta.cssFontFamily)
    if (!entry) {
      entry = {
        cssFontFamily: meta.cssFontFamily,
        weights: [],
        defaultFontId: getFamilyDefaultFontId(meta.cssFontFamily),
        hasMultipleWeights: false,
        languages: [],
        hasBundledWeight: false,
        lacksRareKanji: false,
        _seen: new Set<number>()
      }
      byFamily.set(meta.cssFontFamily, entry)
    }
    if (!entry._seen.has(meta.weight)) {
      entry._seen.add(meta.weight)
      ;(entry.weights as { weight: number; fontId: FontId; displayName: string; assFontName: string }[]).push({
        weight: meta.weight,
        fontId: meta.id,
        displayName: meta.displayName,
        assFontName: meta.assFontName,
      })
    }
    if (meta.bundled) entry.hasBundledWeight = true
    if (meta.lacksRareKanji) entry.lacksRareKanji = true
    // Union languages (order preserves first-seen: en before ja from the
    // first weight seen, subsequent weights don't rearrange).
    const union = new Set<FontLanguage>(entry.languages)
    for (const l of meta.languages) union.add(l)
    entry.languages = Array.from(union) as readonly FontLanguage[]
  }
  for (const entry of byFamily.values()) {
    ;(entry.weights as { weight: number; fontId: FontId; displayName: string; assFontName: string }[]).sort(
      (a, b) => a.weight - b.weight
    )
    entry.hasMultipleWeights = entry.weights.length > 1
  }
  return Array.from(byFamily.values()).map((e) => {
    const { _seen: _drop, ...rest } = e
    void _drop
    return rest
  })
}

/**
 * REQ-0269 B — resolve the FontId that a given `(family, weight)` pair
 * points at.  Used by the weight selector's onChange path to translate
 * a numeric weight click into the concrete FontId to write into the
 * project.  Falls back to the family default when the pair does not
 * match a registered entry (defensive; shouldn't happen for valid UI
 * input).
 */
export function getFontIdForFamilyAndWeight(cssFontFamily: string, weight: number): FontId {
  const meta = FONT_REGISTRY.find((f) => f.cssFontFamily === cssFontFamily && f.weight === weight)
  if (meta) return meta.id
  return getFamilyDefaultFontId(cssFontFamily)
}

/**
 * REQ-0269 D-1 — pick the best available FontId to render `fontId`
 * with when the underlying font (or its downloadable weight) is not
 * yet on disk.
 *
 *   Order:
 *     1. `fontId` itself, if installed.
 *     2. Same-family alternate: any INSTALLED weight in the same
 *        `cssFontFamily`, closest to the requested weight (Euclidean).
 *        Preserves the book/display voice better than dropping straight
 *        to Noto SemiBold.
 *     3. `DEFAULT_FONT_ID` (Noto Sans JP SemiBold) — always bundled.
 *
 * The caller passes an installed-set predicate (typically the renderer's
 * `useInstalledFontIds` Set) so this function stays pure and testable.
 * The ORIGINAL `fontId` in the project entry is intentionally NOT
 * mutated — this returns a render-time substitute only, and the moment
 * the font set is downloaded the natural resolution walks back to
 * step 1.
 */
export function resolveRenderableFontId(
  fontId: FontId,
  isInstalled: (id: FontId) => boolean,
): FontId {
  if (isInstalled(fontId)) return fontId
  const meta = FONT_REGISTRY.find((f) => f.id === fontId)
  if (meta) {
    const familyCandidates = FONT_REGISTRY
      .filter((f) => f.cssFontFamily === meta.cssFontFamily && isInstalled(f.id))
      .sort((a, b) => Math.abs(a.weight - meta.weight) - Math.abs(b.weight - meta.weight))
    if (familyCandidates.length > 0) return familyCandidates[0].id
  }
  return DEFAULT_FONT_ID
}

/**
 * REQ-0153 §2 — canonical display order for every font-list rendering
 * site (settings picker, timeline inspector row selector, bulk-edit
 * bar selector, subtitle style dialog, license attribution list).
 * Alphabetical by `displayName`, `en` locale, case-insensitive so
 * "DotGothic16" sorts next to "Dela Gothic One" the way an
 * English-speaking user expects.  `FONT_REGISTRY` order itself is
 * intentionally NOT touched — `getFontMeta`'s defensive `[0]` fallback
 * and the "Noto first" mental model still hold at the data layer;
 * only the display order is sorted.
 */
export function getSortedFontRegistry(): FontMeta[] {
  return [...FONT_REGISTRY].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' }),
  )
}

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
