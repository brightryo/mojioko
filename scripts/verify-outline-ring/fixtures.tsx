/**
 * REQ-0317 §1 — fixtures for the outline-ring verification harness.
 *
 * These are rendered from the REAL `subtitle-overlay.tsx`.  Hand-writing the
 * HTML is what made REQ-0313's harness useless: it built multi-line fixtures as
 * `Hello<br>World`, which splits text nodes, while the plain production path
 * uses a real newline inside ONE text node.  The union-rect bug (REQ-0315 §1)
 * was therefore invisible to the very harness meant to catch it.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SubtitleOverlay } from '../../src/renderer/components/subtitle-overlay/subtitle-overlay'
import { sampleEntries } from '../../src/renderer/lib/fixtures'
import type { SubtitleEntry } from '../../src/shared/types'
import { FONT_REGISTRY, type FontId } from '../../src/shared/fonts'

/** The ASS hard-break sentinel, built without a literal escape. */
const N = String.fromCharCode(92) + 'N'
const TWO = 'これはテストの字幕です' + N + 'もう一行あります'
const ONE = 'これはテストの字幕です'
/** Latin copy for the Latin-only families (Montserrat carries no JP glyphs). */
const LATIN = 'Hamburgefonstiv' + N + 'Weight Probe'
/**
 * REQ-0325 §3-1 — mixed-script copy for the weight fixtures.
 *
 * It MUST contain Latin.  Noto Sans JP's CJK glyphs are full-width at every
 * weight, so a pure-CJK string measures byte-identical from Thin to Black —
 * a face mix-up would move nothing and the row would prove nothing.  The
 * Latin run's advances DO vary per weight, which is what makes the fixture
 * sensitive to the DOM and the canvas disagreeing about which face is live.
 */
const MIXED = 'Hamburgefonstiv 日本語テスト'

const EMPHASIS = {
  keywordEmphasisEnabled: true,
  emphasisColorHex: '#FFD400',
  emphasisScalePercent: 130,
  emphasisSpans: [{ start: 0, end: 4, text: 'これはテ' }],
}
const KARAOKE = {
  karaokeEnabled: true,
  karaokeHighlightColor: '#B4FF39',
  words: [
    { startSec: 0, endSec: 1, text: 'これはテストの字幕です' },
    { startSec: 1, endSec: 2, text: 'もう一行あります' },
  ],
}

export interface Case {
  name: string
  html: string
  /**
   * REQ-0325 §3-1 — the font this case needs registered.  `undefined` means
   * the project default (bundled Noto SemiBold).  index.mjs uses it to skip a
   * case whose TTF is not present on this machine rather than measuring the
   * fallback face and reporting a green run.
   */
  fontId?: FontId
}

function render(name: string, extra: Record<string, unknown>, text: string): Case {
  const entry = {
    ...sampleEntries[0],
    text,
    fontSizePx: 100,
    outlineThicknessPx: 8,
    textColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    textAlpha: 100,
    outlineAlpha: 100,
    shadowDepth: 0,
    rotation: 0,
    casing: 'none',
    karaokeEnabled: false,
    keywordEmphasisEnabled: false,
    horizontalPosition: 'center',
    startSec: 0,
    endSec: 2,
    subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    ...extra,
  } as unknown as SubtitleEntry
  return {
    name,
    html: renderToStaticMarkup(
      React.createElement(SubtitleOverlay, {
        entry,
        videoWidthPx: 1920,
        // 1920 shown at 641 — the owner's ~1/3 preview scale (REQ-0315 §1).
        containerWidthPx: 641,
      }),
    ),
    fontId: extra.fontId as FontId | undefined,
  }
}

/**
 * REQ-0325 §3-1 — every registered weight of `MOJIOKO Noto Sans JP`, one case
 * each.  This is the family most exposed to browser weight synthesis: it has
 * nine faces, six of which arrive through the downloadable font set, and the
 * DOM asks for the weight via `fontWeight: fontMeta.weight` while the canvas
 * replays whatever `getComputedStyle().font` reports.  If those two ever
 * disagree about which face (or which synthesised face) is in play, the ring
 * drifts off the glyphs and only a per-weight case can see it.
 */
function notoWeightCases(): Case[] {
  return FONT_REGISTRY.filter((f) => f.cssFontFamily === 'MOJIOKO Noto Sans JP').map((f) =>
    render(`notosansjp-w${f.weight}`, { fontId: f.id }, MIXED),
  )
}

/**
 * REQ-0325 §3-1 — CONTROL case.  Dela Gothic One is registered with exactly
 * one weight (400), so no synthesis can occur by construction.  If the Noto
 * weight cases drift but this one does not, the fault is weight handling; if
 * this one drifts too, the fault is in the ring geometry itself.
 */
function singleWeightControlCase(): Case {
  return render('dela-single-w400', { fontId: 'dela-gothic-one' }, MIXED)
}

/**
 * REQ-0325 §3-1 — Montserrat.
 *
 * The registry pins Montserrat to ONE entry at weight 400 (a variable font
 * libass cannot drive per-weight — see the `montserrat` comment in
 * `shared/fonts.ts`), and `font-registry.ts` registers the variable TTF with
 * `weight: '400'`.  So the production-reachable state is a single weight, and
 * `montserrat-w400` covers it faithfully.
 *
 * `montserrat-w700-synth` is a deliberate SYNTHETIC probe, and is labelled as
 * such because it is not reachable through the current registry: it rewrites
 * the outer span's `font-weight` to 700 after the real component rendered, so
 * the DOM requests a weight for which NO face exists and Chromium applies
 * faux-bold.  That is the exact "DOM synthesises a weight the canvas font
 * shorthand does not request" failure the gate is meant to detect.  Only the
 * inline weight is touched — the markup is still the real component's output,
 * never hand-written (which is what made REQ-0313's harness useless).
 */
function montserratCases(): Case[] {
  const base = render('montserrat-w400', { fontId: 'montserrat' }, LATIN)
  const NEEDLE = 'font-weight:400'
  if (!base.html.includes(NEEDLE)) {
    throw new Error('montserrat synth probe: outer span no longer carries ' + NEEDLE)
  }
  return [
    base,
    {
      name: 'montserrat-w700-synth',
      html: base.html.replace(NEEDLE, 'font-weight:700'),
      fontId: 'montserrat',
    },
  ]
}

export function buildCases(): Case[] {
  return [
    render('plain', {}, ONE),
    render('multiline', {}, TWO),
    render('emphasis', EMPHASIS, ONE),
    render('multiline+emphasis', EMPHASIS, TWO),
    render('uppercase', { casing: 'uppercase' }, 'hello world' + N + 'second line'),
    render('rotated', { rotation: 12 }, ONE),
    render('rotated+multiline', { rotation: -8 }, TWO),
    render('shadow', { shadowDepth: 14, shadowColor: '#000000', shadowAlpha: 100 }, ONE),
    render('cjk', {}, 'こんにちは' + N + '世界'),
    render('karaoke', KARAOKE, ONE),
    render('multiline+karaoke', KARAOKE, TWO),
    render('multiline+emphasis+karaoke', { ...EMPHASIS, ...KARAOKE }, TWO),
    render('multiline+alpha0', { textAlpha: 0 }, TWO),
    render('multiline+alpha0+outline20', { textAlpha: 0, outlineThicknessPx: 20 }, TWO),
    // REQ-0325 §3-1 — weight coverage.
    ...notoWeightCases(),
    singleWeightControlCase(),
    ...montserratCases(),
  ]
}

/** A single `@font-face` the harness page must declare. */
export interface FaceSpec {
  id: FontId
  family: string
  weight: number
  fileName: string
  /** Non-null → ships in resources/fonts/; null → %APPDATA%/MOJIOKO/fonts/<id>/. */
  bundledRelativeDir: string | null
}

/**
 * REQ-0325 §3-1 — every face the harness page has to register, derived from
 * the REGISTRY rather than a hand-kept list so a new weight cannot be added to
 * the app and silently miss its `@font-face` here.
 *
 * Always includes the three bundled Noto faces (400/500/600) even when no case
 * names them, because the default-font cases resolve to SemiBold and the
 * original harness note is right that a multi-face family is what exercises
 * canvas weight selection at all.
 */
export function requiredFaces(): FaceSpec[] {
  const ids = new Set<FontId>([
    'noto-sans-jp-regular',
    'noto-sans-jp-medium',
    'noto-sans-jp-semibold',
  ])
  for (const c of buildCases()) if (c.fontId) ids.add(c.fontId)
  return FONT_REGISTRY.filter((f) => ids.has(f.id)).map((f) => ({
    id: f.id,
    family: f.cssFontFamily,
    weight: f.weight,
    fileName: f.fileName,
    bundledRelativeDir: f.bundledRelativeDir,
  }))
}
