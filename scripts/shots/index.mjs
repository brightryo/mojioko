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
  emphasis: { enabled: false, color: '#FFD400', scalePercent: 150 },
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
    emphasis: {
      ja: {
        cueIndex: 0,
        expectText: 'はい、みなさんこんばんはー',
        start: 7,
        end: 13,
        word: 'こんばんはー',
      },
      en: {
        cueIndex: 0,
        expectText: 'Hey everyone, good evening!',
        start: 14,
        end: 27,
        word: 'good evening!',
      },
    },
    prep: (cues, shot) => {
      const { cueIndex, expectText, start, end, word } = shot.emphasis[PAGE_LANG]
      const cue = cues[cueIndex]
      if (!cue || cue.text !== expectText) {
        throw new Error(
          `s2 emphasis (${PAGE_LANG}) is pinned to cue ${cueIndex} = "${expectText}", but the SRT now has ` +
          `"${cue ? cue.text : '(missing)'}". Re-pick the span rather than letting the ` +
          'highlight land on whatever happens to be there.',
        )
      }
      if (cue.text.slice(start, end) !== word) {
        throw new Error(`s2 emphasis offsets ${start}..${end} no longer spell "${word}".`)
      }
      return {
        focusIndex: cueIndex,
        edits: [{
          select: { index: cueIndex },
          style: {
            // On top of SITE_STYLE, which already pinned rotation to 0.
            fontSizePx: 160,
            emphasis: { enabled: true, color: '#FFD400', scalePercent: 150 },
            /*
             * ★ Karaoke OFF for this shot only (REQ-0566 §1-2).
             *
             * The sweep fills from the START of the line and the emphasis was
             * also at the start, so two accent colours advanced from the same
             * edge and neither could be read. This shot's job is to show
             * keyword emphasis; the other five all carry the karaoke sweep, so
             * nothing is lost by letting emphasis stand alone here.
             */
            karaoke: { enabled: false, style: 'sweep', highlightColor: '#B4FF39' },
          },
          emphasisSpans: [{ start, end, text: word }],
          wrap: 'pack',
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
          background: { enabled: true, color: 'black', opacityPercent: 60 },
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
    // Same video AND same playhead as s2 (cue 0) — one scene, different UI.
    focus: 'prep',
    emphasis: { ja: null, en: null },
    prep: () => ({ focusIndex: 0, edits: [] }),
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

async function takeShot(shot, work) {
  const outPath = path.join(OUT_DIR, shot.id + '.png')
  let projPath = null
  let cues = []
  let preparedFocus = null

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
    await w.evaluate(async (lng) => {
      await window.__mojioko_test.i18n.changeLanguage(lng)
      // The language pill reads settings.language, not i18n — without this the
      // corner of an English screenshot still says 「日本語」. This DOES persist
      // (App.tsx saves on any settings change), which is why the run is
      // wrapped in a settings.json backup/restore below.
      window.__mojioko_test.settings.setState({ language: lng })
    }, PAGE_LANG)

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
    if (shot.video && typeof focusIndex === 'number' && cues[focusIndex]) {
      const cue = cues[focusIndex]
      const at = cue.startSec + Math.min(0.6, (cue.endSec - cue.startSec) / 2)
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

    fs.mkdirSync(OUT_DIR, { recursive: true })
    await w.screenshot({ path: outPath })

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
      atSec: shot.video && typeof focusIndex === 'number' && cues[focusIndex]
        ? cues[focusIndex].startSec + Math.min(0.6, (cues[focusIndex].endSec - cues[focusIndex].startSec) / 2)
        : null,
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
