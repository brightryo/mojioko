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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')

// --- args ------------------------------------------------------------------
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const VIDEO_DIR = arg('videos', String.raw`C:\Users\MyPC\Videos\GamePlay`)
const SRT_DIR = arg('srt', String.raw`C:\Users\MyPC\Videos\SRT`)
const OUT_DIR = arg('out', path.join(REPO, 'dev-docs', 'shots'))
const ONLY = (arg('only', '') || '').split(',').filter(Boolean)

/** Window size for every shot: one size keeps the set visually consistent. */
const WIN = { width: 1600, height: 900 }

/**
 * The set. `video: null` means the shot shows no footage (a settings screen),
 * so it needs no assignment.
 *
 * `prep` receives the `.mojioko` path and may run further CLI commands on it.
 * `stage` runs in the page after the project is loaded.
 */
const SHOTS = [
  {
    id: 's1-step1',
    video: 'Game01',
    lang: 'ja',
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
    lang: 'ja',
    start: 'step2',
    caption: 'STEP2 — キーワード強調と cue 別スタイル',
    // The emphasis is set through the REAL edit_cues API — the same call an
    // agent makes, and the feature this release is about.
    prep: (cues) => {
      // A cue long enough that an emphasised word reads clearly in the preview.
      const focusIndex = cues.findIndex((c) => (c.text || '').length >= 8)
      if (focusIndex === -1) return null
      const word = (cues[focusIndex].text || '').slice(0, 4)
      return {
        focusIndex,
        edits: [{
          select: { index: focusIndex },
          style: {
            fontSizePx: 96,
            emphasis: { enabled: true, color: '#3FD585', scalePercent: 150 },
          },
          emphasisSpans: [{ start: 0, end: word.length, text: word }],
          // Re-wrap at the new size, exactly as REQ-0563's hint advises.
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
    lang: 'ja',
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
    lang: 'ja',
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
    lang: 'ja',
    srtLang: 'en',
    start: 'step2',
    caption: '翻訳した字幕（英語 SRT を読み込んだ状態）',
    focus: 2,
  },
  {
    id: 's6-burn',
    video: 'Game06',
    lang: 'ja',
    start: 'step2',
    caption: 'STEP3 — 焼き込み設定',
    focus: 2,
  },
  {
    id: 's7-ai',
    video: null,
    lang: 'ja',
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

/** ★ REQ-0564 §1-4 — no video may serve two shots. */
function assertOneVideoPerShot() {
  const used = SHOTS.map((s) => s.video).filter(Boolean)
  const dupes = used.filter((v, i) => used.indexOf(v) !== i)
  if (dupes.length > 0) {
    throw new Error(
      `§1-4 violated: ${[...new Set(dupes)].join(', ')} assigned to more than one shot. ` +
      'The footage is static, so two shots of one video read as two shots of the same scene.',
    )
  }
}

async function takeShot(shot, work) {
  const outPath = path.join(OUT_DIR, shot.id + '.png')
  let projPath = null
  let cues = []
  let preparedFocus = null

  if (shot.video) {
    const video = path.join(VIDEO_DIR, shot.video + '.mp4')
    const srt = path.join(SRT_DIR, `${shot.video}_${shot.srtLang ?? 'ja'}.srt`)
    for (const p of [video, srt]) {
      if (!fs.existsSync(p)) throw new Error(`missing material: ${p}`)
    }
    projPath = path.join(work, shot.id + '.mojioko')

    // The SRT decides the subtitle content (§1-3): whatever the audio says,
    // the cues come from the file, so the screenshots are reproducible.
    const conv = cli(['convert', srt, '-o', projPath, '--video', video])
    if (conv.code !== 0) throw new Error(`convert failed for ${shot.id} (exit ${conv.code})`)

    cues = JSON.parse(fs.readFileSync(projPath, 'utf-8')).editing.subtitles

    if (shot.prep) {
      const prepared = shot.prep(cues)
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
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height)
    }, WIN)
    await w.evaluate((lng) => window.__mojioko_test.i18n.changeLanguage(lng), shot.lang)

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
    return outPath
  } finally {
    await app.close().catch(() => {})
  }
}

// --- main ------------------------------------------------------------------
assertOneVideoPerShot()

if (!fs.existsSync(path.join(REPO, 'out', 'main', 'index.js'))) {
  console.error('shots: out/ missing — run `npm run build` first')
  process.exit(2)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mojioko-shots-'))
const wanted = ONLY.length > 0 ? SHOTS.filter((s) => ONLY.includes(s.id)) : SHOTS
let failed = 0

log(`shots: ${wanted.length} shot(s) -> ${OUT_DIR}\n`)
for (const shot of wanted) {
  const label = `${shot.id}${shot.video ? ` [${shot.video}]` : ' [no video]'}`
  try {
    const p = await takeShot(shot, work)
    log(`  OK    ${label}  ${path.basename(p)}`)
  } catch (e) {
    failed++
    log(`  FAIL  ${label}  ${e instanceof Error ? e.message : String(e)}`)
  }
}
try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }

log(`\n${failed === 0 ? 'ALL SHOTS TAKEN' : `${failed} shot(s) failed`}`)
process.exit(failed === 0 ? 0 : 1)
