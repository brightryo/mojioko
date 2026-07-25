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
 *                       `https://github.com/<owner>/<repo>/releases/download/<FONTS_RELEASE_TAG>/<FileName>.ttf`.
 *                       Per-font `<Font>-OFL.txt` files live alongside
 *                       each TTF under the same release tag.
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

/**
 * Release tag that hosts every downloadable font asset.
 *
 * v1 (REQ-0153): pre-v1.3.6 baseline; 12 upstream-named fonts.
 *   **Still published, still needed by shipped v1.3.5 users. Do NOT
 *   modify / delete.**
 * v2 (REQ-0271 / REQ-0273): expanded to 26 upstream-named TTFs (added
 *   Noto Sans JP × 9 weights and Poppins × 9 weights).  **Superseded
 *   by v3 and never reached shipping** — main was not merged with the
 *   fonts-v2 branch because REQ-0274 discovered a fatal libass /
 *   DirectWrite family-name collision.  Kept published for
 *   traceability; NOT touched.
 * v3 (REQ-0275): every family name is prefixed `MOJIOKO ` so libass'
 *   DirectWrite provider cannot silently substitute a system-installed
 *   font of the same name.  This is the shipping asset set for v1.3.6.
 *   See SPECIFICATION §24.3.1 "Family-name namespacing" for the recipe.
 *
 * Registry entries funnel their `downloadUrl` through `assetUrl()`
 * below, so bumping this constant retargets every URL at once.
 */
export const FONTS_RELEASE_TAG = 'fonts-v3'

/**
 * REQ-0269 C-4 — Font set version.  Increments every time the registry
 * gains a new downloadable asset (or an existing asset is re-uploaded).
 *
 * Written into settings.json under `fontSetInstalledVersion` when the
 * bulk download completes.  REQ-0275 §3 tightened the semantics: the
 * saved value MUST equal `FONT_SET_VERSION` for a font to be treated
 * as `installed`.  A recorded value < FONT_SET_VERSION (or absent) is
 * `not-installed` — the picker shows a "re-download" prompt.  This
 * protects existing v1.3.5 users whose local `fonts-v1` files reference
 * upstream family names (`Noto Sans JP`) which libass will silently
 * substitute in v1.3.6+; forcing a re-download replaces those files
 * with `fonts-v3`'s MOJIOKO-namespaced versions.
 *
 * v1: the original 12 downloadable fonts (REQ-0153).
 * v2: added Noto/Poppins weight expansion; SUPERSEDED (never shipped).
 * v3: MOJIOKO-namespaced family names (REQ-0275).  Ships in v1.3.6.
 */
export const FONT_SET_VERSION = 3

// Per-font OFL distribution: each font ships its own `<FontName>-OFL.txt`
// alongside its TTF in the current release tag (see FONTS_RELEASE_TAG).
// This satisfies SIL OFL v1.1 §2 — "each copy contains the above
// copyright notice and this license" — because the per-font OFL text
// starts with that specific font's copyright header (the upstream form
// from `google/fonts/ofl/<name>/OFL.txt`).
//
// An earlier design shared a single `OFL.txt` between all fonts and
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
   * lives at `<FONTS_RELEASE_TAG>/<FontName>-OFL.txt` and carries that font's
   * own copyright header followed by the standard SIL OFL v1.1 body.  Null
   * only for bundled fonts whose OFL is shipped via the installer rather
   * than fetched on demand.
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
 * REQ-0270 §3 — every downloadable entry now points at `fonts-v2` via
 * `assetUrl()` + `FONTS_RELEASE_TAG`.  Sizes remain approximate estimates
 * for the newly-added weights and will tighten once the `fonts-v2` release
 * assets are actually uploaded and the ±10 % integrity check settles
 * against real Content-Length values.
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
// Bold (700), ExtraBold (800), Black (900).  Hosted under the
// `fonts-v2` release tag (REQ-0270 §3 aligned the tag with
// FONT_SET_VERSION).  Sizes are the Google Fonts static distribution
// values (all ~5.4-5.5 MB per weight); the ±10 % integrity check will
// accept the actual Content-Length once the `fonts-v2` release is
// published (owner-gated).
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
    cssFontFamily: 'MOJIOKO Noto Sans JP',
    assFontName: 'MOJIOKO Noto Sans JP Thin',
    fileName: 'NotoSansJP-Thin.ttf',
    weight: 100,
    bundled: false,
    downloadUrl: assetUrl('NotoSansJP-Thin.ttf'),
    oflUrl: assetUrl('NotoSansJP-OFL.txt'),
    expectedSizeBytes: 5_769_992,
    copyright: NOTO_COPYRIGHT,
    sourceUrl: NOTO_SOURCE_URL,
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  {
    id: 'noto-sans-jp-extralight',
    displayName: 'Noto Sans JP ExtraLight',
    cssFontFamily: 'MOJIOKO Noto Sans JP',
    assFontName: 'MOJIOKO Noto Sans JP ExtraLight',
    fileName: 'NotoSansJP-ExtraLight.ttf',
    weight: 200,
    bundled: false,
    downloadUrl: assetUrl('NotoSansJP-ExtraLight.ttf'),
    oflUrl: assetUrl('NotoSansJP-OFL.txt'),
    expectedSizeBytes: 5_771_360,
    copyright: NOTO_COPYRIGHT,
    sourceUrl: NOTO_SOURCE_URL,
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  {
    id: 'noto-sans-jp-light',
    displayName: 'Noto Sans JP Light',
    cssFontFamily: 'MOJIOKO Noto Sans JP',
    assFontName: 'MOJIOKO Noto Sans JP Light',
    fileName: 'NotoSansJP-Light.ttf',
    weight: 300,
    bundled: false,
    downloadUrl: assetUrl('NotoSansJP-Light.ttf'),
    oflUrl: assetUrl('NotoSansJP-OFL.txt'),
    expectedSizeBytes: 5_770_904,
    copyright: NOTO_COPYRIGHT,
    sourceUrl: NOTO_SOURCE_URL,
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  {
    id: 'noto-sans-jp-regular',
    displayName: 'Noto Sans JP Regular',
    cssFontFamily: 'MOJIOKO Noto Sans JP',
    assFontName: 'MOJIOKO Noto Sans JP Regular',
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
    cssFontFamily: 'MOJIOKO Noto Sans JP',
    assFontName: 'MOJIOKO Noto Sans JP Medium',
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
    cssFontFamily: 'MOJIOKO Noto Sans JP',
    assFontName: 'MOJIOKO Noto Sans JP SemiBold',
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
    cssFontFamily: 'MOJIOKO Noto Sans JP',
    assFontName: 'MOJIOKO Noto Sans JP Bold',
    fileName: 'NotoSansJP-Bold.ttf',
    weight: 700,
    bundled: false,
    downloadUrl: assetUrl('NotoSansJP-Bold.ttf'),
    oflUrl: assetUrl('NotoSansJP-OFL.txt'),
    expectedSizeBytes: 5_761_772,
    copyright: NOTO_COPYRIGHT,
    sourceUrl: NOTO_SOURCE_URL,
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  {
    id: 'noto-sans-jp-extrabold',
    displayName: 'Noto Sans JP ExtraBold',
    cssFontFamily: 'MOJIOKO Noto Sans JP',
    assFontName: 'MOJIOKO Noto Sans JP ExtraBold',
    fileName: 'NotoSansJP-ExtraBold.ttf',
    weight: 800,
    bundled: false,
    downloadUrl: assetUrl('NotoSansJP-ExtraBold.ttf'),
    oflUrl: assetUrl('NotoSansJP-OFL.txt'),
    expectedSizeBytes: 5_758_996,
    copyright: NOTO_COPYRIGHT,
    sourceUrl: NOTO_SOURCE_URL,
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  {
    id: 'noto-sans-jp-black',
    displayName: 'Noto Sans JP Black',
    cssFontFamily: 'MOJIOKO Noto Sans JP',
    assFontName: 'MOJIOKO Noto Sans JP Black',
    fileName: 'NotoSansJP-Black.ttf',
    weight: 900,
    bundled: false,
    downloadUrl: assetUrl('NotoSansJP-Black.ttf'),
    oflUrl: assetUrl('NotoSansJP-OFL.txt'),
    expectedSizeBytes: 5_756_616,
    copyright: NOTO_COPYRIGHT,
    sourceUrl: NOTO_SOURCE_URL,
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  {
    id: 'dela-gothic-one',
    displayName: 'Dela Gothic One',
    cssFontFamily: 'MOJIOKO Dela Gothic One',
    assFontName: 'MOJIOKO Dela Gothic One',
    fileName: 'DelaGothicOne-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('DelaGothicOne-Regular.ttf'),
    oflUrl: assetUrl('DelaGothicOne-OFL.txt'),
    expectedSizeBytes: 5_469_276,
    copyright: 'Copyright 2020 The Dela Gothic Project Authors (https://github.com/syakuzen/DelaGothic)',
    sourceUrl: 'https://fonts.google.com/specimen/Dela+Gothic+One',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  {
    id: 'reggae-one',
    displayName: 'Reggae One',
    cssFontFamily: 'MOJIOKO Reggae One',
    assFontName: 'MOJIOKO Reggae One',
    fileName: 'ReggaeOne-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('ReggaeOne-Regular.ttf'),
    oflUrl: assetUrl('ReggaeOne-OFL.txt'),
    expectedSizeBytes: 2_153_296,
    copyright: 'Copyright 2020 The Reggae Project Authors (https://github.com/fontworks-fonts/Reggae)',
    sourceUrl: 'https://fonts.google.com/specimen/Reggae+One',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  {
    id: 'yusei-magic',
    displayName: 'Yusei Magic',
    cssFontFamily: 'MOJIOKO Yusei Magic',
    assFontName: 'MOJIOKO Yusei Magic',
    fileName: 'YuseiMagic-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('YuseiMagic-Regular.ttf'),
    oflUrl: assetUrl('YuseiMagic-OFL.txt'),
    expectedSizeBytes: 3_135_024,
    copyright: 'Copyright 2020 The Yusei Magic Project Authors (https://github.com/tanukifont/YuseiMagic)',
    sourceUrl: 'https://fonts.google.com/specimen/Yusei+Magic',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  {
    id: 'mochiy-pop-one',
    displayName: 'Mochiy Pop One',
    cssFontFamily: 'MOJIOKO Mochiy Pop One',
    assFontName: 'MOJIOKO Mochiy Pop One',
    fileName: 'MochiyPopOne-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('MochiyPopOne-Regular.ttf'),
    oflUrl: assetUrl('MochiyPopOne-OFL.txt'),
    expectedSizeBytes: 5_163_984,
    copyright: 'Copyright 2020 The Mochiypop Project Authors (https://github.com/fontdasu/Mochiypop)',
    sourceUrl: 'https://fonts.google.com/specimen/Mochiy+Pop+One',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  {
    id: 'hachi-maru-pop',
    displayName: 'Hachi Maru Pop',
    cssFontFamily: 'MOJIOKO Hachi Maru Pop',
    assFontName: 'MOJIOKO Hachi Maru Pop',
    fileName: 'HachiMaruPop-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('HachiMaruPop-Regular.ttf'),
    oflUrl: assetUrl('HachiMaruPop-OFL.txt'),
    expectedSizeBytes: 4_385_668,
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
    cssFontFamily: 'MOJIOKO Potta One',
    assFontName: 'MOJIOKO Potta One',
    fileName: 'PottaOne-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('PottaOne-Regular.ttf'),
    oflUrl: assetUrl('PottaOne-OFL.txt'),
    expectedSizeBytes: 4_918_564,
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
    cssFontFamily: 'MOJIOKO DotGothic16',
    assFontName: 'MOJIOKO DotGothic16',
    fileName: 'DotGothic16-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('DotGothic16-Regular.ttf'),
    oflUrl: assetUrl('DotGothic16-OFL.txt'),
    expectedSizeBytes: 2_069_276,
    copyright: 'Copyright 2020 The DotGothic16 Project Authors (https://github.com/fontworks-fonts/DotGothic16)',
    sourceUrl: 'https://fonts.google.com/specimen/DotGothic16',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  {
    id: 'rampart-one',
    displayName: 'Rampart One',
    cssFontFamily: 'MOJIOKO Rampart One',
    assFontName: 'MOJIOKO Rampart One',
    fileName: 'RampartOne-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('RampartOne-Regular.ttf'),
    oflUrl: assetUrl('RampartOne-OFL.txt'),
    expectedSizeBytes: 3_722_392,
    copyright: 'Copyright 2020 The Rampart Project Authors (https://github.com/fontworks-fonts/Rampart)',
    sourceUrl: 'https://fonts.google.com/specimen/Rampart+One',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en', 'ja']
  },
  // -----------------------------------------------------------------
  // REQ-0153 — international (Latin) faces.  All SIL OFL 1.1 with the
  // per-font copyright header preserved verbatim in the sibling
  // `<Name>-OFL.txt` asset.  Hosted under the current
  // `FONTS_RELEASE_TAG` alongside every other downloadable font.
  // REQ-0270 §3 retargets these from the pre-v1.3.6 `fonts-v1` tag to
  // `fonts-v2`, matching the FONT_SET_VERSION bump.
  // -----------------------------------------------------------------
  {
    id: 'anton',
    displayName: 'Anton',
    cssFontFamily: 'MOJIOKO Anton',
    assFontName: 'MOJIOKO Anton',
    fileName: 'Anton-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('Anton-Regular.ttf'),
    oflUrl: assetUrl('Anton-OFL.txt'),
    expectedSizeBytes: 170_792,
    copyright: 'Copyright 2020 The Anton Project Authors (https://github.com/googlefonts/AntonFont.git)',
    sourceUrl: 'https://fonts.google.com/specimen/Anton',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'bebas-neue',
    displayName: 'Bebas Neue',
    cssFontFamily: 'MOJIOKO Bebas Neue',
    assFontName: 'MOJIOKO Bebas Neue',
    fileName: 'BebasNeue-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('BebasNeue-Regular.ttf'),
    oflUrl: assetUrl('BebasNeue-OFL.txt'),
    expectedSizeBytes: 61_344,
    copyright: 'Copyright © 2010 by Dharma Type.',
    sourceUrl: 'https://fonts.google.com/specimen/Bebas+Neue',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'montserrat',
    displayName: 'Montserrat',
    cssFontFamily: 'MOJIOKO Montserrat',
    // REQ-0153 — Google Fonts serves Montserrat only as a variable
    // font on the wght axis.  libass (0.17+, bundled with ffmpeg
    // shipped in this app) reads variable fonts via the same
    // fontconfig path; the wght axis default is 400 = Regular so
    // the ASS `Style:` line's `Fontname` = "MOJIOKO Montserrat"
    // resolves to the Regular instance without any extra plumbing.
    // REQ-0275 §2 namespaced the family so libass' DirectWrite
    // provider on Windows cannot silently substitute a
    // system-installed "Montserrat" of a different revision.
    assFontName: 'MOJIOKO Montserrat',
    fileName: 'Montserrat-Variable.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('Montserrat-Variable.ttf'),
    oflUrl: assetUrl('Montserrat-OFL.txt'),
    expectedSizeBytes: 745_040,
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
    cssFontFamily: 'MOJIOKO Poppins',
    assFontName: 'MOJIOKO Poppins Thin',
    fileName: 'Poppins-Thin.ttf',
    weight: 100,
    bundled: false,
    downloadUrl: assetUrl('Poppins-Thin.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 163_716,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'poppins-extralight',
    displayName: 'Poppins ExtraLight',
    cssFontFamily: 'MOJIOKO Poppins',
    assFontName: 'MOJIOKO Poppins ExtraLight',
    fileName: 'Poppins-ExtraLight.ttf',
    weight: 200,
    bundled: false,
    downloadUrl: assetUrl('Poppins-ExtraLight.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 163_612,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'poppins-light',
    displayName: 'Poppins Light',
    cssFontFamily: 'MOJIOKO Poppins',
    assFontName: 'MOJIOKO Poppins Light',
    fileName: 'Poppins-Light.ttf',
    weight: 300,
    bundled: false,
    downloadUrl: assetUrl('Poppins-Light.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 161_980,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'poppins',
    displayName: 'Poppins Regular',
    cssFontFamily: 'MOJIOKO Poppins',
    assFontName: 'MOJIOKO Poppins',
    fileName: 'Poppins-Regular.ttf',
    weight: 400,
    bundled: false,
    downloadUrl: assetUrl('Poppins-Regular.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 160_372,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'poppins-medium',
    displayName: 'Poppins Medium',
    cssFontFamily: 'MOJIOKO Poppins',
    assFontName: 'MOJIOKO Poppins Medium',
    fileName: 'Poppins-Medium.ttf',
    weight: 500,
    bundled: false,
    downloadUrl: assetUrl('Poppins-Medium.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 158_620,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'poppins-semibold',
    displayName: 'Poppins SemiBold',
    cssFontFamily: 'MOJIOKO Poppins',
    assFontName: 'MOJIOKO Poppins SemiBold',
    fileName: 'Poppins-SemiBold.ttf',
    weight: 600,
    bundled: false,
    downloadUrl: assetUrl('Poppins-SemiBold.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 157_356,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'poppins-bold',
    displayName: 'Poppins Bold',
    cssFontFamily: 'MOJIOKO Poppins',
    assFontName: 'MOJIOKO Poppins Bold',
    fileName: 'Poppins-Bold.ttf',
    weight: 700,
    bundled: false,
    downloadUrl: assetUrl('Poppins-Bold.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 156_052,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'poppins-extrabold',
    displayName: 'Poppins ExtraBold',
    cssFontFamily: 'MOJIOKO Poppins',
    assFontName: 'MOJIOKO Poppins ExtraBold',
    fileName: 'Poppins-ExtraBold.ttf',
    weight: 800,
    bundled: false,
    downloadUrl: assetUrl('Poppins-ExtraBold.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 154_880,
    copyright: 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)',
    sourceUrl: 'https://fonts.google.com/specimen/Poppins',
    license: 'SIL-OFL-1.1',
    bundledRelativeDir: null,
    languages: ['en']
  },
  {
    id: 'poppins-black',
    displayName: 'Poppins Black',
    cssFontFamily: 'MOJIOKO Poppins',
    assFontName: 'MOJIOKO Poppins Black',
    fileName: 'Poppins-Black.ttf',
    weight: 900,
    bundled: false,
    downloadUrl: assetUrl('Poppins-Black.ttf'),
    oflUrl: assetUrl('Poppins-OFL.txt'),
    expectedSizeBytes: 153_484,
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
  'MOJIOKO Noto Sans JP': 'noto-sans-jp-semibold',
  'MOJIOKO Poppins': 'poppins-bold',
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
 * REQ-0275 §2-2 — strip the internal `MOJIOKO ` namespace prefix from a
 * cssFontFamily so the user-facing UI shows the upstream family name
 * (e.g. `Noto Sans JP` instead of `MOJIOKO Noto Sans JP`).  Idempotent
 * on strings that lack the prefix.
 */
export function stripFamilyNamespacePrefix(cssFontFamily: string): string {
  const PREFIX = 'MOJIOKO '
  return cssFontFamily.startsWith(PREFIX) ? cssFontFamily.slice(PREFIX.length) : cssFontFamily
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
 * REQ-0281 §3 / §4-2 — family-level status for the FontPicker's
 * list section.  Binary result matching the REQ's "0 / 1" model:
 * a family counts as `'installed'` only when EVERY registered
 * weight is on-disk AND the recorded set version matches.
 * Bundled Noto is a special case — its family reports
 * `'bundled'` because at least one weight (Regular / Medium /
 * SemiBold) ships in the installer payload, so it's always
 * available regardless of the downloadable extra weights.
 *
 * Rules (mirror the REQ intent — no intermediate state):
 *   hasBundledWeight = true                          → 'bundled'
 *   every downloadable weight installed && setIsCurrent → 'installed'
 *   otherwise (any weight missing OR version stale)  → 'not-installed'
 *
 * The `setIsCurrent` input MUST come from the caller (comparing
 * `settings.fontSetInstalledVersion` to `FONT_SET_VERSION`); this
 * helper stays free of any storage / IO concern so it can be unit
 * tested with plain booleans.
 */
export type FamilyStatus = 'bundled' | 'installed' | 'not-installed'

export function deriveFamilyStatus(
  family: FontFamily,
  isInstalledOnDisk: (fontId: FontId) => boolean,
  setIsCurrent: boolean,
): FamilyStatus {
  if (family.hasBundledWeight) return 'bundled'
  // For a non-bundled family, EVERY registered weight must be present
  // and the set version must match.  Missing even one weight collapses
  // to `not-installed` — no partial state is allowed in the REQ-0281
  // binary model.
  if (!setIsCurrent) return 'not-installed'
  const everyWeightPresent = family.weights.every((w) => isInstalledOnDisk(w.fontId))
  return everyWeightPresent ? 'installed' : 'not-installed'
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
 * REQ-0269 D-1 / REQ-0270 §2 / REQ-0273 §8 — pick the best available
 * FontId to render `fontId` with when the underlying font (or its
 * downloadable weight) is not yet on disk OR is tier-locked (free
 * build asking for a paid-tier weight).
 *
 *   Order:
 *     1. `fontId` itself, if installed AND selectable in the current tier.
 *     2. Same-family alternate: any weight in the same `cssFontFamily`
 *        that is INSTALLED AND SELECTABLE, closest to the requested
 *        weight (Euclidean).  Preserves the book/display voice better
 *        than dropping straight to Noto SemiBold.
 *     3. `DEFAULT_FONT_ID` (Noto Sans JP SemiBold) — always bundled AND
 *        always selectable (`canSelectFontInTier` returns true for
 *        `DEFAULT_FONT_ID` in every tier).
 *
 * REQ-0273 §8 — both predicates are REQUIRED (no default fallback).
 * The pre-REQ-0273 signature let `isSelectable` default to `() => true`,
 * which was fail-open: a future caller that forgot to pass the tier
 * predicate would silently bypass tier gating with no type error to
 * flag the omission.  Making it required forces every call site to
 * confront the tier question explicitly — tests that don't care about
 * tier semantics pass `() => true` in-line, making the intent visible
 * in the test file.
 *
 * The ORIGINAL `fontId` in the project entry is intentionally NOT
 * mutated — this returns a render-time substitute only, and the moment
 * the font set is downloaded (paid tier) or the user upgrades to the
 * Store build, the natural resolution walks back to step 1.
 */
export function resolveRenderableFontId(
  fontId: FontId,
  isInstalled: (id: FontId) => boolean,
  isSelectable: (id: FontId) => boolean,
): FontId {
  if (isInstalled(fontId) && isSelectable(fontId)) return fontId
  const meta = FONT_REGISTRY.find((f) => f.id === fontId)
  if (meta) {
    const familyCandidates = FONT_REGISTRY
      .filter((f) => f.cssFontFamily === meta.cssFontFamily && isInstalled(f.id) && isSelectable(f.id))
      .sort((a, b) => Math.abs(a.weight - meta.weight) - Math.abs(b.weight - meta.weight))
    if (familyCandidates.length > 0) return familyCandidates[0].id
  }
  return DEFAULT_FONT_ID
}

/**
 * REQ-0153 §2 / REQ-0270 §1 — canonical display order for every font-list
 * rendering site (settings picker, timeline inspector row selector,
 * bulk-edit bar selector, subtitle style dialog, license attribution
 * list).
 *
 * Primary key: **family display name** (`en` locale, case-insensitive) so
 *   Anton → Bebas Neue → Dela Gothic One → DotGothic16 → Hachi Maru Pop
 *   → Mochiy Pop One → Montserrat → Noto Sans JP → Poppins → Potta One
 *   → Rampart One → Reggae One → Yusei Magic.  The pre-REQ-0270 sort
 *   also used displayName alphabetical, so the family-level order is
 *   unchanged from v1.3.5.
 *
 * Secondary key: **numeric weight ascending** so multi-weight families
 *   land in the natural typographic order — Thin (100) → ExtraLight
 *   (200) → Light (300) → Regular (400) → Medium (500) → SemiBold
 *   (600) → Bold (700) → ExtraBold (800) → Black (900).  Before
 *   REQ-0270 the sort was purely alphabetical over the full displayName
 *   (family+weight), which lands Black / Bold / ExtraBold before Thin —
 *   useless as a weight selector.  Sorting by numeric weight fixes the
 *   picker without needing a two-level (family + weight) UI.
 *
 * `FONT_REGISTRY` order itself is intentionally NOT touched —
 * `getFontMeta`'s defensive `[0]` fallback and the "Noto first" mental
 * model still hold at the data layer; only the display order is sorted.
 */
export function getSortedFontRegistry(): FontMeta[] {
  return [...FONT_REGISTRY].sort((a, b) => {
    const family = a.cssFontFamily.localeCompare(b.cssFontFamily, 'en', { sensitivity: 'base' })
    if (family !== 0) return family
    return a.weight - b.weight
  })
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

/**
 * REQ-0275 §3 / REQ-0276 §2 — pure decision function that maps
 * (bundled, installed, setIsCurrent) → FontStatus.  Extracted from the
 * main-side `buildFontsState` in `font-downloader.ts` so the three-way
 * install-status logic is unit-testable without touching disk or
 * dragging Electron into the test bundle.
 *
 * Rules:
 *   bundled = true                       → 'bundled'   (never affected by version gating)
 *   installed = true  && setIsCurrent    → 'installed'
 *   installed = true  && !setIsCurrent   → 'not-installed'  (stale-set safeguard)
 *   installed = false                    → 'not-installed'
 *
 * `setIsCurrent` is derived by the caller from `recordedSetVersion
 * === FONT_SET_VERSION`; keeping that comparison outside the helper
 * makes tests drive every path with a plain boolean, no module-level
 * constant to work around.
 */
export function deriveFontStatus(bundled: boolean, installed: boolean, setIsCurrent: boolean): FontStatus {
  if (bundled) return 'bundled'
  if (installed && setIsCurrent) return 'installed'
  return 'not-installed'
}

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
  /**
   * REQ-0276 §3 — the `fontSetInstalledVersion` value recorded in
   * `settings.json` at the moment this state was built.  `undefined`
   * means the user has never completed a bulk download (fresh install
   * OR a pre-REQ-0275 install where the version stamp did not exist).
   * A value strictly less than `FONT_SET_VERSION` indicates an
   * outdated set that must be re-downloaded before the fonts will
   * render correctly at burn-in.
   *
   * The FontPicker uses this field to distinguish "brand-new user
   * (unset)" from "existing v1.3.5 user upgrading (outdated)" for the
   * upgrade-notice banner (REQ-0276 §3).
   */
  fontSetInstalledVersion?: number
}

export type DownloadFontEvent =
  | { event: 'progress'; file: string; fileIndex: number; totalFiles: number; percent: number }
  | { event: 'completed' }
  | { event: 'failed'; error: string }
