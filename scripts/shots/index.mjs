/**
 * REQ-0564 §2 — screenshots for the download site, taken from the REAL app.
 *
 *   npm run shots -- --videos <dir> --srt <dir> [--out <dir>] [--only s3,s7]
 *
 * ## Why this exists as a permanent tool
 *
 * The site's screenshots were taken by hand, so refreshing them for a release
 * meant redoing the whole set by hand — which is why they were still showing
 * 1.3.6 UI. This drives the shipped renderer through Playwright and writes the
 * set in one command, so the next release is `npm run shots` again.
 * CLAUDE.md §18's test for keeping a tool: would you write it again next time?
 * Every release, yes.
 *
 * ## How a shot gets its state
 *
 * No hand-driving of dialogs. Each shot:
 *   1. runs the real `convert` CLI to build a `.mojioko` from the assigned
 *      video + its SRT — so the SUBTITLE CONTENT is decided by the SRT file
 *      (REQ-0564 §1-3) and is identical on every run;
 *   2. optionally runs the real `edit_cues` CLI to set up emphasis, karaoke,
 *      per-cue styles — the same API an agent would use;
 *   3. launches the app, calls the real `videoProbe` IPC (which is also what
 *      allowlists the file for the `mojioko-media://` protocol — set the store
 *      directly and the preview shows "failed to load"), and loads the cues;
 *   4. arranges the view and screenshots it.
 *
 * So what lands in the PNG is the app's ordinary rendering of a state built by
 * the app's own code paths.
 *
 * ## One video per shot (REQ-0564 §1-4)
 *
 * The footage is static gameplay, so two shots of the same video at different
 * moments would look like two shots of the same thing. `SHOTS` assigns each
 * screenshot its own video; the assignment is asserted at startup so a future
 * edit cannot quietly reuse one.
 */
import { _electron as electron } from 'playwright'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { TARGETS } from '../store-assets/layout.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')

// --- args ------------------------------------------------------------------
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const VIDEO_DIR = arg('videos', String.raw`C:\Users\MyPC\Videos\GamePlay`)
const SRT_DIR = arg('srt', String.raw`C:\Users\MyPC\Videos\SRT`)
const ONLY = (arg('only', '') || '').split(',').filter(Boolean)
/** REQ-0568 §2-3 — where to leave the prepared .mojioko files, if anywhere. */
const KEEP_PROJECTS = arg('keep-projects', '')

/**
 * ★ REQ-0567 §1 — which language PAGE this set is for.
 *
 * Sets the app's UI language and picks the SRT. The one exception is the
 * translation shot, whose whole point is showing the OTHER language — so the
 * ja page gets an English caption there and the en page gets a Japanese one
 * (REQ-0566 §2's rule, applied in both directions).
 */
const PAGE_LANG = arg('lang', 'ja') === 'en' ? 'en' : 'ja'
const OTHER_LANG = PAGE_LANG === 'ja' ? 'en' : 'ja'

/**
 * ★ REQ-0568 §1-1 — what these shots are FOR, which is what sets their size.
 *
 * `site` is the download page (1600x900). `store` and `store-full` are the
 * Microsoft Store listing, which requires exactly 1920x1080; the difference
 * between them is whether a caption band will be composited above the app
 * later. See `scripts/store-assets/layout.mjs` for why the banded variant is
 * captured shorter instead of being scaled down afterwards.
 *
 * The display this runs on is 1920x1080 at scaleFactor 1, so a 1920-wide
 * window extends past the work area — Chromium still rasterises the full
 * content size, and the capture comes back at exactly the requested pixels
 * (verified: contentSize [1920,1080] -> PNG 1920x1080). Nothing is resampled.
 */
const TARGET = arg('target', 'site')
if (!TARGETS[TARGET]) {
  console.error(`shots: unknown --target ${TARGET} (expected ${Object.keys(TARGETS).join(' | ')})`)
  process.exit(2)
}
const WIN = TARGETS[TARGET]

const OUT_DIR = arg('out', path.join(REPO, 'dev-docs', 'shots',
  ...(TARGET === 'site' ? [] : [TARGET]), ...(PAGE_LANG === 'en' ? ['en'] : [])))

/** The libass hard line break, built from a char code so no shell eats it. */
const BREAK = String.fromCharCode(92) + 'N'

/**
 * ★ REQ-0565 §1 — the look the site shows, declared HERE and nowhere else.
 *
 * ## Why this exists
 *
 * `convert` seeds a new project from the machine's `transcriptionDefaults`,
 * so the first run of this tool published seven screenshots with every
 * subtitle tilted 15° — because that is what this developer's settings.json
 * happened to hold that day. The product looked like a tool for slanted
 * captions. Nothing was wrong with the app; the pipeline was reading the
 * environment and calling it a design.
 *
 * That is the same fault CLAUDE.md §18 records for cli-smoke (REQ-0516): an
 * assertion — or here, an artefact — that assumes machine state. The cure is
 * the same. Do not read the environment: state the intent.
 *
 * ## The rule
 *
 * EVERY field that can move a pixel is listed. A field left out is a field the
 * settings can still reach, and it will be missed exactly when someone's
 * settings differ from today's. If you add a visual field to the app, add it
 * here too.
 *
 * The look itself is deliberately the plain one: bottom-centre, horizontal,
 * white on a black outline. What a first-time user should picture.
 */
const SITE_STYLE = {
  /*
   * Weight first: a thin caption over busy gameplay reads as washed out, and a
   * screenshot is the only impression a visitor gets. Bold, not Black — Black
   * at this size starts closing up the counters of small kana.
   */
  fontId: 'noto-sans-jp-bold',
  /*
   * 150px on a 1080p frame. Large enough to dominate the still; small enough
   * that the longest cue in these SRTs still wraps to three lines rather than
   * filling the frame (the wrap below re-flows at exactly this size).
   */
  fontSizePx: 150,
  textColorHex: '#FFFFFF',
  textAlphaPercent: 100,
  /*
   * Thick outline plus a real shadow. Both are doing the same job — separating
   * white text from bright sky, snow and HUD — and neither is enough alone on
   * this footage.
   */
  outlineColorHex: '#000000',
  outlineThicknessPx: 10,
  outlineAlphaPercent: 100,
  shadow: { depthPx: 8, color: '#000000', alphaPercent: 100 },
  rotationDeg: 0,
  casing: 'none',
  lineSpacingPercent: 0,
  layer: 0,
  position: {
    horizontal: 'center',
    vertical: 'bottom',
    verticalMarginPx: 60,
    // Unpin. Storing a coordinate here would override the alignment above.
    posX: null,
    posY: null,
  },
  /*
   * Colour comes from the karaoke sweep rather than from the body text: the
   * caption stays legible white, and the sung part carries the accent. That
   * also means every shot demonstrates a real feature instead of just being
   * tinted. #B4FF39 is the app's own default highlight, so the screenshots
   * match what a new user sees.
   */
  karaoke: { enabled: true, style: 'sweep', highlightColor: '#B4FF39' },
  /*
   * ★ REQ-0571 §1-4 — pink, not yellow.
   *
   * The accent that carries the karaoke sweep is a yellow-green (#B4FF39),
   * and a yellow emphasis sat right next to it read as "slightly different
   * green" rather than as a second thing. #FF2E88 is far enough around the
   * wheel to be unmistakable against both the sweep and this footage's
   * sunset palette.
   */
  emphasis: { enabled: false, color: '#FF2E88', scalePercent: 150 },
  /*
   * Animations off. A still captured mid fade-in or mid pop shows a
   * half-transparent or half-scaled caption — which reads as a rendering bug
   * rather than as an animation, because a screenshot has no time axis.
   */
  animation: {
    type: 'none', inEnabled: false, outEnabled: false,
    durationSec: 0.3, startScalePercent: 60, blurPx: 0,
  },
  background: { enabled: false, color: 'black', opacityPercent: 50 },
}

/**
 * The set. `video: null` means the shot shows no footage (a settings screen),
 * so it needs no assignment.
 *
 * `prep` receives the `.mojioko` path and may run further CLI commands on it.
 * `stage` runs in the page after the project is loaded.
 */
/**
 * ★ REQ-0567 §1 — UI labels the staging clicks, per page language.
 *
 * Kept in one table because a shot that silently fails to open its popover
 * still writes a PNG — it just shows the screen underneath. The staging below
 * asserts the click landed rather than trusting it.
 */
const UI = {
  ja: { device: '処理デバイス', presets: 'スタイルプリセット', exportText: 'テキスト出力' },
  en: { device: 'Processing Device', presets: 'Style presets', exportText: 'Text' },
}

/**
 * Click a control by its label and fail loudly if it is not there.
 *
 * Tries visible text first, then `aria-label` — several of these controls are
 * icon-only buttons whose label exists only for assistive tech. Failing loudly
 * matters more than usual here: a missed click still writes a PNG, it just
 * shows the screen underneath, and that PNG looks perfectly fine.
 */
async function clickLabel(w, label, what) {
  for (const loc of [w.locator(`text=${label}`).first(), w.locator(`[aria-label="${label}"]`).first()]) {
    if (await loc.count() > 0) {
      await loc.click()
      await w.waitForTimeout(900)
      return
    }
  }
  throw new Error(`${what}: no control labelled "${label}" (tried text and aria-label)`)
}

const SHOTS = [
  {
    id: 's1-step1',
    video: 'Game01',
    start: 'step1',
    caption: 'STEP1 — 入力ファイルと文字起こし設定',
    stage: async (w) => {
      // The accordions start collapsed, which screenshots as three thin rows
      // and a lot of empty dark space. Open the transcription-tool section so
      // the shot actually shows the model choice it is captioned as showing.
      const row = w.locator('text=文字起こしツール').first()
      if (await row.count() > 0) {
        await row.click().catch(() => {})
        await w.waitForTimeout(900)
      }
    },
  },
  {
    id: 's2-step2-emphasis',
    /** Checked in pixels after the shot — see assertThreeStates. */
    threeState: true,
    video: 'Game02',
    start: 'step2',
    caption: 'STEP2 — キーワード強調と cue 別スタイル',
    /*
     * ★ REQ-0566 §1 — the emphasised span is CHOSEN, not computed.
     *
     * It used to be `text.slice(0, 4)` of the first long cue, which on this
     * SRT produced 「はい、み」 — not a word, just the first four characters,
     * cut in the middle of 「みなさん」. As a demonstration of "highlight the
     * word that matters" it demonstrated the opposite.
     *
     * A mechanical rule cannot pick a meaningful word without a tokeniser, and
     * a screenshot set does not need one: there are seven shots and they are
     * fixed. So the cue and the span are stated outright, and the assertion
     * below fails loudly if the SRT ever changes underneath them.
     */
    /*
     * The span is CHOSEN per language, not computed — and it picks the same
     * thing in both: the greeting at the END of the line, leaving the address
     * ("はい、みなさん" / "Hey everyone,") in plain white. A mechanical
     * rule cannot do that without a tokeniser, and a fixed screenshot set does
     * not need one.
     */
    /*
     * ★ REQ-0571 §2-1 — THREE states in one caption, on purpose.
     *
     * The old version of this shot showed a greeting with one highlighted
     * phrase. It demonstrated emphasis, but nothing else, and the line itself
     * ("hello everyone") sold no feature at all.
     *
     * This one puts all three of the caption's states side by side in reading
     * order, so a single still explains the whole model:
     *
     *   already spoken   実はこのコース、   karaoke green  #B4FF39
     *   the keyword      絶景              emphasis pink  #FF2E88, 150%
     *   not yet spoken   ポイントがあってさ  plain white + black outline
     *
     * ★ The sweep must stop just AFTER the keyword, not before it.
     *
     * Under karaoke the emphasis colour replaces the SPOKEN colour: the
     * overlay folds `\fs<big>\c<emph>` into the word's own `\k` block and
     * `c` (unspoken) stays base for everyone, "so the emphasised word looks
     * like the others until it is spoken" (ass-generator.ts, REQ-0306 §3,
     * owner-confirmed). Park the playhead before the keyword and it renders
     * bigger but WHITE — which is what the first attempt here did, and it
     * looked exactly like the emphasis colour being ignored.
     *
     * So the keyword has to be inside the swept region, which is why the
     * playhead is pinned by FRACTION of the cue rather than by seconds: it
     * lands on an exact unit boundary, one past the keyword.
     *
     * The line is the SRT's own cue 5, not a rewrite: it is real streamer
     * speech, it names what the footage shows (a coastal viewpoint), and the
     * keyword falls mid-sentence with text on both sides — which is exactly
     * what the composition needs.
     */
    /*
     * ★ The line break is WRITTEN, not left to the wrapper.
     *
     * At showcase size this line does not fit on one row, and `wrap: 'pack'`
     * broke it before the LAST character, leaving one orphan kana on row two.
     * Breaking after the comma instead gives each state its own footing:
     *
     *     実はこのコース、           <- row 1, entirely swept (green)
     *     絶景ポイントがあってさ       <- row 2, keyword then not-yet-spoken
     *
     * which is a clearer legend than one row would have been, because the
     * sweep boundary now lands exactly on the row boundary. Writing the text
     * with its own break (and not re-wrapping afterwards) is what makes it
     * come out the same on every run.
     *
     * The offsets below index the text INCLUDING the two-character break,
     * which is why the keyword starts at 10 rather than 8.
     */
    emphasis: {
      ja: {
        cueIndex: 5,
        expectText: '実はこのコース、絶景ポイントがあってさ',
        text: '実はこのコース、' + BREAK + '絶景ポイントがあってさ',
        start: 10,
        end: 12,
        word: '絶景',
        /*
         * Karaoke with no word timings splits evenly across UNITS, and one
         * CJK codepoint is one unit (karaoke-fallback.ts). The break is not a
         * unit, so there are 19 and the keyword occupies the 9th and 10th —
         * the sweep is stopped just AFTER it, at 10.
         */
        sweptUnits: 10,
        totalUnits: 19,
      },
      en: {
        cueIndex: 5,
        expectText: 'This course actually has an amazing viewpoint',
        text: 'This course actually has an' + BREAK + 'amazing viewpoint',
        start: 29,
        end: 36,
        word: 'amazing',
        /* Latin splits per whitespace-delimited word: 7 units, and the
         * keyword is the 6th — so the sweep is stopped just after it. */
        sweptUnits: 6,
        totalUnits: 7,
      },
    },
    prep: (cues, shot) => {
      const { cueIndex, expectText, text, start, end, word, sweptUnits, totalUnits } = shot.emphasis[PAGE_LANG]
      const cue = cues[cueIndex]
      // SITE_STYLE's `wrap: 'pack'` already ran, so compare with any break
      // it inserted taken back out.
      if (!cue || cue.text.split(BREAK).join('') !== expectText) {
        throw new Error(
          `s2 emphasis (${PAGE_LANG}) is pinned to cue ${cueIndex} = "${expectText}", but the SRT now has ` +
          `"${cue ? cue.text : '(missing)'}". Re-pick the span rather than letting the ` +
          'highlight land on whatever happens to be there.',
        )
      }
      if (text.slice(start, end) !== word) {
        throw new Error(`s2 emphasis offsets ${start}..${end} no longer spell "${word}".`)
      }
      return {
        focusIndex: cueIndex,
        // Stop the sweep ON the boundary before the keyword.
        atFraction: sweptUnits / totalUnits,
        edits: [{
          select: { index: cueIndex },
          style: {
            // On top of SITE_STYLE, which already pinned rotation to 0.
            fontSizePx: 160,
            emphasis: { enabled: true, color: '#FF2E88', scalePercent: 150 },
            /*
             * ★ Karaoke ON here (REQ-0571 §2-1 reverses REQ-0566 §1-2).
             *
             * REQ-0566 turned the sweep off because the emphasis was at the
             * START of the line, so both accents advanced from the same edge
             * and neither could be read. Moving the keyword into the middle
             * of the line removes that collision — the sweep now ENDS where
             * the emphasis BEGINS — so the two features can be shown at once
             * instead of one at a time.
             */
            karaoke: { enabled: true, style: 'sweep', highlightColor: '#B4FF39' },
          },
          text,
          emphasisSpans: [{ start, end, text: word }],
        }],
      }
    },
    /** Sit on the emphasised cue: the point of the shot is to SEE it. */
    focus: 'prep',
  },
  {
    id: 's3-timeline',
    video: 'Game03',
    start: 'step2',
    caption: 'STEP2 — タイムラインで表示タイミングを調整',
    focus: 2,
    stage: async (w) => {
      await w.evaluate(() => window.__mojioko_test.ui.setState({ editorViewMode: 'timeline' }))
    },
  },
  {
    id: 's4-list',
    video: 'Game04',
    start: 'step2',
    caption: 'STEP2 — 一覧で字幕をまとめて編集',
    focus: 2,
    stage: async (w) => {
      await w.evaluate(() => window.__mojioko_test.ui.setState({ editorViewMode: 'list' }))
    },
  },
  {
    id: 's5-translate',
    video: 'Game05',
    /** The translation shot: it deliberately shows the OTHER language. */
    translationShot: true,
    start: 'step2',
    caption: '翻訳した字幕（英語 SRT を読み込んだ状態）',
    focus: 2,
  },
  {
    id: 's6-burn',
    video: 'Game06',
    start: 'step2',
    caption: 'STEP3 — 焼き込み設定',
    focus: 2,
  },
  {
    id: 's9-inspector',
    video: 'Game08',
    start: 'step2',
    caption: '多彩な字幕編集（インスペクタ）',
    focus: 2,
    /*
     * ★ REQ-0566 §2 — the ja page used s2 TWICE (new-features and
     * "flexible editing"), which reads as one screenshot padded out. This is
     * the editing shot: same screen, deliberately different styling — a
     * background box and a coloured body — so the two pictures are making
     * different points instead of repeating one.
     */
    prep: () => ({
      focusIndex: 2,
      edits: [{
        select: { index: 2 },
        style: {
          textColorHex: '#FFE9A8',
          /*
           * ★ REQ-0571 §1-5 — 60% was invisible here.
           *
           * The box WAS being applied (the stored cue carries it), but 60%
           * black over Game08's already-dark castle scene produced a band
           * you cannot see, so the shot claimed to show "a background box
           * and a coloured body" while looking like every other caption in
           * the set. Raised until the box reads as a deliberate shape
           * against a dark frame.
           */
          background: { enabled: true, color: 'black', opacityPercent: 90 },
          // BorderStyle=3 needs a non-zero outline or the box collapses onto
          // the glyphs (REQ-0340) — edit_cues warns about exactly this.
          outlineThicknessPx: 6,
        },
        wrap: 'pack',
      }],
    }),
  },
  {
    id: 's8-position',
    video: 'Game07',
    start: 'step2',
    caption: '見たままの位置決め（WYSIWYG）',
    focus: 2,
    /*
     * ★ REQ-0566 §2 — the ja page's positioning section had an ENGLISH-subtitle
     * shot in it (Game05/en, shot for the translation story). This is its own
     * ja shot, and it earns its place by showing something the other six do
     * not: the caption placed at the TOP. That is the point of the section —
     * where you put it is where it burns — and it is visibly different from
     * the bottom-centre default the rest of the set uses.
     */
    prep: () => ({
      focusIndex: 2,
      edits: [{
        select: { index: 2 },
        style: { position: { horizontal: 'center', vertical: 'top', verticalMarginPx: 60 } },
        wrap: 'pack',
      }],
    }),
  },
  {
    id: 's10-gpu',
    video: 'Game01',
    start: 'step1',
    caption: 'GPU アクセラレーション（処理デバイスの選択）',
    /*
     * Same video and same moment as s1 — STEP 1 shows no frames at all, so
     * there is no "second scene" here, only a second panel opened. REQ-0567 §1-2
     * allows exactly that.
     */
    stage: async (w) => { await clickLabel(w, UI[PAGE_LANG].device, 's10-gpu') },
  },
  {
    id: 's11-preset',
    video: 'Game02',
    start: 'step2',
    caption: '字幕スタイルのプリセット',
    // Same video AND same playhead as s2 (cue 5) — one scene, different UI.
    focus: 'prep',
    /*
     * ★ REQ-0571 §1-1 — this shares Game02 with s2, so it must share the
     * SCENE (assertOneScenePerVideo). s2 moved off the opening greeting to
     * cue 5, and this follows it: the preset popover is the subject here, but
     * the caption behind it should still be a line that sells something.
     */
    prep: () => ({ focusIndex: 5, atFraction: PAGE_LANG === 'ja' ? 8 / 19 : 5 / 7, edits: [] }),
    stage: async (w) => { await clickLabel(w, UI[PAGE_LANG].presets, 's11-preset') },
  },
  {
    id: 's12-export',
    video: 'Game03',
    start: 'step2',
    caption: 'テキスト・SRT で書き出し',
    // Same video and playhead as s3.
    focus: 2,
    stage: async (w) => { await clickLabel(w, UI[PAGE_LANG].exportText, 's12-export') },
  },
  {
    id: 's7-ai',
    video: null,
    start: 'step2',
    caption: '設定 ▸ AI 連携（MCP）',
    stage: async (w) => {
      // Open the real settings dialog on the AI tab. Without this the shot is
      // just an empty STEP 2 with a fixture video failing to load.
      await w.evaluate(() => window.__mojioko_test.ui.getState().openSettingsDialogAt('ai'))
      await w.waitForTimeout(1200)
    },
  },
]

/**
 * ★ REQ-0571 §1-5 — the preset names s11 photographs, stated per language.
 *
 * Only `name` is on show: the popover is a list of names plus a "save current
 * style" row, so the style bodies just have to be well-formed. Names are the
 * ones a new user would plausibly create, in the language of the page.
 */
const PRESETS = {
  ja: [
    { id: 'preset-shot-1', name: '標準の字幕', version: 1, createdAtMs: 1_780_000_000_000, style: {} },
    { id: 'preset-shot-2', name: '実況テロップ', version: 1, createdAtMs: 1_780_000_001_000, style: {} },
    { id: 'preset-shot-3', name: '見出し用（大きめ）', version: 1, createdAtMs: 1_780_000_002_000, style: {} },
  ],
  en: [
    { id: 'preset-shot-1', name: 'Standard subtitles', version: 1, createdAtMs: 1_780_000_000_000, style: {} },
    { id: 'preset-shot-2', name: 'Commentary caption', version: 1, createdAtMs: 1_780_000_001_000, style: {} },
    { id: 'preset-shot-3', name: 'Headline (large)', version: 1, createdAtMs: 1_780_000_002_000, style: {} },
  ],
}

// --- helpers ---------------------------------------------------------------
const log = (m) => process.stdout.write(m + '\n')

function cli(args, timeoutMs = 180_000) {
  const r = spawnSync(ELECTRON, ['.', ...args], {
    cwd: REPO, timeout: timeoutMs, encoding: 'utf-8',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  })
  const line = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop()
  let json = null
  try { json = line ? JSON.parse(line) : null } catch { /* not JSON */ }
  return { code: r.status, json }
}

/**
 * ★ REQ-0564 §1-4, as amended by REQ-0567 §1-2 — one video = one SCENE.
 *
 * The footage is static gameplay, so two shots of the same video at DIFFERENT
 * moments read as two shots of the same thing. Two shots at the SAME moment
 * with a different panel open do not — they are one scene photographed twice,
 * which is what a UI tour actually wants.
 *
 * So the check is on (video, focus), not on video alone.
 */
function assertOneScenePerVideo() {
  const seen = new Map()
  for (const s of SHOTS) {
    if (!s.video) continue
    const scene = `${s.video}@${String(s.focus ?? 'none')}`
    const clash = [...seen.entries()].find(([k, id]) => k.startsWith(s.video + '@') && k !== scene && id !== s.id)
    if (clash) {
      throw new Error(
        `§1-2 violated: ${s.id} uses ${s.video} at a DIFFERENT moment than ${clash[1]} ` +
        `(${scene} vs ${clash[0]}). Same video is fine, but only at the same playback position.`,
      )
    }
    seen.set(scene, s.id)
  }
}

/**
 * ★ REQ-0571 §2-1 — prove the three states are actually three.
 *
 * The composition's whole claim is that a viewer can read the caption's model
 * off one still: spoken / keyword / not yet spoken. That claim is about
 * PIXELS, so it is checked in pixels rather than by looking.
 *
 * REQ-0571 asks for x-centroid order green < pink < white. That test assumes
 * one row. This caption is two — the sweep boundary was put ON the row break
 * because it reads better there — so green is centred above rather than left
 * of the other two, and a literal x-order check would fail on a picture that
 * is correct. The adaptation keeps what the test was for, in reading order:
 *
 *   1. all three colours are present;
 *   2. green finishes ABOVE pink starts (no row interleaving);
 *   3. on the lower row, pink is left of white;
 *   4. green and pink never share a row band — the "zero overlap" the REQ
 *      asks for, which is the one that would break the legend.
 *
 * Decoding happens in the page that is already open, via a data: URL — a
 * file: image either refuses to decode or taints the canvas.
 */
async function assertThreeStates(w, pngPath, id) {
  const src = 'data:image/png;base64,' + fs.readFileSync(pngPath).toString('base64')
  /*
   * Scan ONLY the video preview. The inspector shows the emphasis colour in a
   * swatch, so a whole-page scan finds pink at the right-hand edge and
   * measures the control panel instead of the caption — which is exactly what
   * it did on the first run.
   */
  const box = await w.locator('video').first().boundingBox()
  if (!box) throw new Error(`${id} three-state: no video element to scan`)
  log(`        scan box x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}`)
  const r = await w.evaluate(async ({ src, box }) => {
    const img = new Image()
    img.src = src
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.naturalWidth; c.height = img.naturalHeight
    const cx = c.getContext('2d')
    cx.drawImage(img, 0, 0)
    const d = cx.getImageData(0, 0, c.width, c.height).data
    const near = (r, g, b, t) => (h) =>
      Math.abs(r - h[0]) <= t && Math.abs(g - h[1]) <= t && Math.abs(b - h[2]) <= t
    const tests = {
      green: near(180, 255, 57, 40),
      pink: near(255, 46, 136, 40),
      // White only where it is a caption glyph: bright and unsaturated.
      white: (h) => h[0] > 235 && h[1] > 235 && h[2] > 235 &&
        Math.max(h[0], h[1], h[2]) - Math.min(h[0], h[1], h[2]) < 12,
    }
    const acc = { green: [], pink: [], white: [] }
    const x0 = Math.round(box.x), x1 = Math.round(box.x + box.width)
    const y0 = Math.round(box.y), y1 = Math.round(box.y + box.height)
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * c.width + x) * 4
        const h = [d[i], d[i + 1], d[i + 2]]
        for (const k of ['green', 'pink', 'white']) if (tests[k](h)) acc[k].push([x, y])
      }
    }
    const stat = (pts) => pts.length === 0 ? null : {
      n: pts.length,
      cx: Math.round(pts.reduce((a, p) => a + p[0], 0) / pts.length),
      cy: Math.round(pts.reduce((a, p) => a + p[1], 0) / pts.length),
      minY: Math.min(...pts.map((p) => p[1])),
      maxY: Math.max(...pts.map((p) => p[1])),
    }
    // The white test also matches UI chrome, so keep only white that shares
    // the pink row band — that is the caption's not-yet-spoken tail.
    const pink = stat(acc.pink)
    const whiteInRow = pink
      ? acc.white.filter(([, y]) => y >= pink.minY - 8 && y <= pink.maxY + 8)
      : []
    return { green: stat(acc.green), pink, white: stat(whiteInRow) }
  }, { src, box })

  const fail = (m) => { throw new Error(`${id} three-state: ${m}`) }
  for (const k of ['green', 'pink', 'white']) if (!r[k]) fail(`no ${k} pixels`)
  log(`        green n=${r.green.n} y=${r.green.minY}-${r.green.maxY} cx=${r.green.cx}`)
  log(`        pink  n=${r.pink.n} y=${r.pink.minY}-${r.pink.maxY} cx=${r.pink.cx}`)
  log(`        white n=${r.white.n} cx=${r.white.cx}`)
  if (r.green.maxY >= r.pink.minY) fail(`green (to y=${r.green.maxY}) overlaps pink (from y=${r.pink.minY}) — the sweep ran into the keyword`)
  if (r.pink.cx >= r.white.cx) fail(`pink centre ${r.pink.cx} is not left of the unspoken tail ${r.white.cx}`)
  log('        PASS  spoken above keyword, keyword left of unspoken, no overlap')
}

async function takeShot(shot, work) {
  const outPath = path.join(OUT_DIR, shot.id + '.png')
  let projPath = null
  let cues = []
  let preparedFocus = null
  let preparedAtFraction = null

  if (shot.video) {
    const video = path.join(VIDEO_DIR, shot.video + '.mp4')
    const srtLang = shot.translationShot ? OTHER_LANG : PAGE_LANG
    const srt = path.join(SRT_DIR, `${shot.video}_${srtLang}.srt`)
    for (const p of [video, srt]) {
      if (!fs.existsSync(p)) throw new Error(`missing material: ${p}`)
    }
    projPath = path.join(work, shot.id + '.mojioko')

    // The SRT decides the subtitle content (§1-3): whatever the audio says,
    // the cues come from the file, so the screenshots are reproducible.
    const conv = cli(['convert', srt, '-o', projPath, '--video', video])
    if (conv.code !== 0) throw new Error(`convert failed for ${shot.id} (exit ${conv.code})`)

    cues = JSON.parse(fs.readFileSync(projPath, 'utf-8')).editing.subtitles

    /*
     * ★ REQ-0565 §1 — overwrite the inherited look with the declared one.
     *
     * `convert` seeded these cues from the machine's transcriptionDefaults, so
     * until this runs they carry whatever this developer's settings say. One
     * `edit_cues` call over every id replaces the whole visual surface with
     * SITE_STYLE. Written through --edits-file rather than --edits because the
     * id list for a 180-cue project is far too long for a command line.
     */
    const styleFile = path.join(work, shot.id + '-style.json')
    fs.writeFileSync(styleFile, JSON.stringify([
      {
        select: { ids: cues.map((c) => c.id) },
        style: SITE_STYLE,
        // The stored `\N` was computed by `convert` at the MACHINE's font
        // size. At 150px those breaks overflow, so re-flow them here — which
        // is exactly what REQ-0563's LINE_BREAKS_MAY_BE_STALE hint advises.
        wrap: 'pack',
      },
    ]), 'utf-8')
    const styled = cli(['edit_cues', projPath, '-o', projPath, '--edits-file', styleFile])
    if (styled.code !== 0) throw new Error(`site-style edit_cues failed for ${shot.id} (exit ${styled.code})`)
    cues = JSON.parse(fs.readFileSync(projPath, 'utf-8')).editing.subtitles

    if (shot.prep) {
      const prepared = shot.prep(cues, shot)
      if (prepared) {
        const ed = cli(['edit_cues', projPath, '-o', projPath, '--edits', JSON.stringify(prepared.edits)])
        if (ed.code !== 0) throw new Error(`edit_cues failed for ${shot.id} (exit ${ed.code})`)
        cues = JSON.parse(fs.readFileSync(projPath, 'utf-8')).editing.subtitles
        preparedFocus = prepared.focusIndex
        preparedAtFraction = prepared.atFraction
      }
    }
  }

  // Launch the REPO (not out/main/index.js): `app.getAppPath()` then resolves
  // to the project root, which is what makes the bundled ffprobe reachable.
  const app = await electron.launch({ args: [REPO], timeout: 60_000 })
  try {
    const w = await app.firstWindow()
    const index = path.join(REPO, 'out/renderer/index.html').split(path.sep).join('/')
    await w.goto(`file:///${index}?seed=demo&start=${shot.start}`)
    await w.waitForFunction(() => Boolean(window.__mojioko_test))
    /*
     * ★ REQ-0568 §1-1 — ask for the size, then CHECK it.
     *
     * The store requires exactly 1920x1080, and a window can silently come
     * back smaller (a minimum size, a maximised state, the work area). A shot
     * that is 1920x1032 still writes a perfectly good-looking PNG that the
     * Store then rejects, so the mismatch is raised here rather than found by
     * Partner Center.
     */
    const got = await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setResizable(true)
      win.setMinimumSize(1, 1)
      win.unmaximize()
      win.setContentSize(size.width, size.height)
      return win.getContentSize()
    }, WIN)
    if (got[0] !== WIN.width || got[1] !== WIN.height) {
      throw new Error(`window is ${got[0]}x${got[1]}, wanted ${WIN.width}x${WIN.height}`)
    }
    /*
     * UI language. This goes through the live i18n instance, NOT through
     * settings.json — the app persists the user's choice, but `changeLanguage`
     * on the exposed instance only affects this window. Verified by hashing
     * settings.json before and after a full run (RES-0567 §1-2).
     */
    await w.evaluate(async ({ lng, PRESETS }) => {
      await window.__mojioko_test.i18n.changeLanguage(lng)
      // The language pill reads settings.language, not i18n — without this the
      // corner of an English screenshot still says 「日本語」. This DOES persist
      // (App.tsx saves on any settings change), which is why the run is
      // wrapped in a settings.json backup/restore below.
      window.__mojioko_test.settings.setState({ language: lng })
      /*
       * ★ REQ-0571 §1-5 — the preset list was the DEVELOPER'S.
       *
       * s11 photographs the preset popover, and the popover lists whatever is
       * in settings.stylePresets — which on this machine is two presets the
       * owner happened to save, in English, published on the Japanese page.
       * Same fault as REQ-0565's inherited caption style and REQ-0516's
       * cli-smoke: the tool read the environment and shipped it as the
       * product. So the list is DECLARED here, per language.
       *
       * Safe to write: settings.json is backed up and restored around the
       * whole run, and the restore is hashed (see the bottom of this file).
       */
      window.__mojioko_test.settings.setState({ stylePresets: PRESETS })
    }, { lng: PAGE_LANG, PRESETS: PRESETS[PAGE_LANG] })

    if (shot.video) {
      const video = path.join(VIDEO_DIR, shot.video + '.mp4')
      const probed = await w.evaluate(async ({ v, entries }) => {
        // The real probe: it allowlists the path for `mojioko-media://`.
        const r = await window.electronAPI.videoProbe(v)
        if (!r.ok) return { ok: false, error: r.error }
        window.__mojioko_test.project.setState({
          video: r.data, videoLoadingState: 'loaded', entries,
        })
        return { ok: true }
      }, { v: video, entries: cues })
      if (!probed.ok) throw new Error(`videoProbe failed: ${JSON.stringify(probed.error)}`)
      /*
       * Only STEP 2 has a <video>: STEP 1 is the preparation screen and shows
       * the file's metadata, not its frames. Waiting unconditionally made the
       * STEP 1 shot fail on a timeout that meant nothing.
       */
      if (shot.start === 'step2') {
        // Let the first frame decode, or the preview screenshots black.
        await w.waitForFunction(() => {
          const v = document.querySelector('video')
          return Boolean(v && v.readyState >= 2)
        }, undefined, { timeout: 30_000 })
      }
    } else {
      /*
       * Clear the fixture video too, not just the cues: its path does not
       * exist, so the preview would sit behind the dialog showing
       * "failed to load" — true, but not something to put on a website.
       */
      await w.evaluate(() => window.__mojioko_test.project.setState({
        entries: [], video: null, videoLoadingState: 'idle',
      }))
    }

    /*
     * Sit the playhead ON a cue. Without this every preview screenshots at
     * 0:00, which is before the first subtitle — so a shot meant to show
     * emphasis or karaoke would show an empty frame and look like the feature
     * does nothing.
     */
    const focusIndex = shot.focus === 'prep' ? preparedFocus : shot.focus
    let shownAtSec = null
    if (shot.video && typeof focusIndex === 'number' && cues[focusIndex]) {
      const cue = cues[focusIndex]
      /*
       * ★ REQ-0571 §2-1 — a shot may pin the playhead by FRACTION of the cue.
       *
       * The three-state shot needs the karaoke sweep to stop on an exact
       * character boundary, which is a proportion of the cue's duration, not
       * a number of seconds. Shots that do not care keep the old behaviour:
       * a little way in, so the caption is on screen.
       */
      const at = typeof preparedAtFraction === 'number'
        ? cue.startSec + preparedAtFraction * (cue.endSec - cue.startSec)
        : cue.startSec + Math.min(0.6, (cue.endSec - cue.startSec) / 2)
      shownAtSec = at
      await w.evaluate(async ({ at, id }) => {
        const v = document.querySelector('video')
        if (v) {
          v.currentTime = at
          await new Promise((res) => {
            const done = () => { v.removeEventListener('seeked', done); res() }
            v.addEventListener('seeked', done)
            setTimeout(done, 5000)
          })
        }
        // Selecting the cue opens the inspector on it, which is what the
        // per-cue style shots are about.
        window.__mojioko_test.ui.setState({ selectedEntryId: id })
      }, { at, id: cue.id })
    }

    if (shot.stage) await shot.stage(w, cues)
    await w.waitForTimeout(1500)

    /*
     * ★ REQ-0571 §1-5 — the position guides are a RACE, so decide them.
     *
     * `VideoPreviewPanel` renders `PositionGuideOverlay` for the selected cue,
     * but only once `overlaySpanRefs` has the span — a callback-ref map read
     * during render. Whether it is populated on the pass that matters depends
     * on what else re-rendered, so the bbox + "866 px" / "X: +0 Y: +0" rulers
     * appeared in s4-list and not in s3/s9/s12 with identical setup. That is
     * the same picture coming out two ways on different runs, which no amount
     * of re-running would have revealed as anything but bad luck.
     *
     * Every shot selects a cue (the inspector is part of what is being shown),
     * so the guides cannot be turned off by deselecting without emptying the
     * panel. They are hidden here instead, and `guides: true` keeps them for
     * s8-position, where measuring the placement IS the feature on show.
     *
     * The selector is asserted rather than trusted: if the overlay's markup
     * changes, this fails instead of quietly publishing the rulers again.
     */
    const guideSel = '[aria-hidden="true"].absolute.inset-0.pointer-events-none.select-none'
    const guideCount = await w.locator(guideSel).count()
    if (shot.guides === true) {
      /*
       * ★ Not reachable today — kept as the record of a thing I could not do.
       *
       * s8-position would be the one shot where the rulers ARE the subject, so
       * this asked for them. They could not be produced on demand: re-selecting
       * the cue to force another render pass (which is what populates
       * `overlaySpanRefs`) did not bring them back on any run. Rather than
       * publish a shot that has them on some runs and not others, the whole set
       * is taken without them, and s8 makes its point the way it already did —
       * by putting the caption at the TOP, which no other shot does.
       */
      if (guideCount === 0) throw new Error(`${shot.id} wants position guides but none rendered`)
    } else if (guideCount > 0) {
      await w.addStyleTag({ content: `${guideSel} { display: none !important; }` })
      await w.waitForTimeout(200)
    }

    fs.mkdirSync(OUT_DIR, { recursive: true })
    await w.screenshot({ path: outPath })

    if (shot.threeState) await assertThreeStates(w, outPath, shot.id)

    /*
     * ★ REQ-0565 §2-2 — record what was ACTUALLY applied.
     *
     * "The captions look straight" is a judgement about a picture. This writes
     * the numbers the app rendered from, so the check is a comparison rather
     * than an opinion — and so the settings-independence control (§1-3) has
     * something exact to compare.
     */
    const shown = cues[typeof focusIndex === 'number' ? focusIndex : 0]

    /*
     * ★ REQ-0568 §2-3 — hand the prepared project to whoever wants a frame.
     *
     * The hero art needs a full-resolution still of a styled subtitle. The
     * alternative was to upscale the little preview panel out of the PNG
     * above, or to re-implement convert -> edit_cues -> emphasis somewhere
     * else; the first is blurry and the second is a second prep that would
     * drift from this one. Copying the project out lets `export_frame` render
     * the very cue this shot is showing, at video resolution, from the SAME
     * preparation.
     */
    if (KEEP_PROJECTS && projPath) {
      fs.mkdirSync(KEEP_PROJECTS, { recursive: true })
      fs.copyFileSync(projPath, path.join(KEEP_PROJECTS, shot.id + '.mojioko'))
    }

    return {
      path: outPath,
      project: KEEP_PROJECTS && projPath ? path.join(KEEP_PROJECTS, shot.id + '.mojioko') : null,
      video: shot.video ? path.join(VIDEO_DIR, shot.video + '.mp4') : null,
      /*
       * ★ REQ-0571 — the SAME instant the screenshot was taken at.
       *
       * This used to recompute the default "a little way in", which silently
       * stopped matching once a shot could pin its playhead by fraction: the
       * hero art then exported a frame from before the karaoke sweep reached
       * the keyword, so the still lost its emphasis colour while the
       * screenshot beside it kept it. One value, computed once, reported.
       */
      atSec: shownAtSec,
      style: shown
        ? {
            rotation: shown.rotation ?? 0,
            fontSizePx: shown.fontSizePx,
            fontId: shown.fontId ?? null,
            outlineThicknessPx: shown.outlineThicknessPx,
            lineSpacingPercent: shown.lineSpacingPercent ?? 0,
            horizontalPosition: shown.horizontalPosition,
            verticalPosition: shown.verticalPosition,
            verticalMarginPx: shown.verticalMarginPx,
            karaokeEnabled: shown.karaokeEnabled === true,
            keywordEmphasisEnabled: shown.keywordEmphasisEnabled === true,
            animationType: shown.animationType ?? 'none',
          }
        : null,
    }
  } finally {
    await app.close().catch(() => {})
  }
}

// --- main ------------------------------------------------------------------
assertOneScenePerVideo()

if (!fs.existsSync(path.join(REPO, 'out', 'main', 'index.js'))) {
  console.error('shots: out/ missing — run `npm run build` first')
  process.exit(2)
}

/*
 * ★ REQ-0567 §1-1 — settings.json is borrowed, not spent.
 *
 * Matching the language pill means writing `settings.language`, and the app
 * persists any settings change. A screenshot tool must not leave the user's
 * settings altered, so the file is captured here and put back in the `finally`
 * below — then hashed, because "we restored it" is a claim and the hash is
 * evidence.
 */
const SETTINGS_PATH = path.join(process.env.APPDATA ?? '', 'MOJIOKO', 'settings.json')
const settingsBefore = fs.existsSync(SETTINGS_PATH) ? fs.readFileSync(SETTINGS_PATH) : null
const sha = (b) => createHash('sha256').update(b).digest('hex')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mojioko-shots-'))
const wanted = ONLY.length > 0 ? SHOTS.filter((s) => ONLY.includes(s.id)) : SHOTS
let failed = 0
const manifest = []

log(`shots: ${wanted.length} shot(s) -> ${OUT_DIR}\n`)
for (const shot of wanted) {
  const label = `${shot.id}${shot.video ? ` [${shot.video}]` : ' [no video]'}`
  try {
    const r = await takeShot(shot, work)
    manifest.push({
      id: shot.id, video: shot.video, style: r.style,
      project: r.project, videoPath: r.video, atSec: r.atSec,
    })
    const rot = r.style ? `rot=${r.style.rotation}` : 'no cue'
    log(`  OK    ${label}  ${path.basename(r.path)}  ${rot}`)
  } catch (e) {
    failed++
    log(`  FAIL  ${label}  ${e instanceof Error ? e.message : String(e)}`)
  }
}
fs.writeFileSync(path.join(OUT_DIR, 'shots-manifest.json'),
  JSON.stringify({ siteStyle: SITE_STYLE, shots: manifest }, null, 2), 'utf-8')
log(`
manifest: ${path.join(OUT_DIR, 'shots-manifest.json')}`)

try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }

if (settingsBefore) {
  fs.writeFileSync(SETTINGS_PATH, settingsBefore)
  const after = fs.readFileSync(SETTINGS_PATH)
  const restored = after.equals(settingsBefore)
  log(`settings.json ${restored ? 'restored, byte-identical' : 'RESTORE FAILED'}  sha256=${sha(after).slice(0, 16)}`)
  if (!restored) failed++
}

log(`\n${failed === 0 ? 'ALL SHOTS TAKEN' : `${failed} shot(s) failed`}`)
process.exit(failed === 0 ? 0 : 1)
