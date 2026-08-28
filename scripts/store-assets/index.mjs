/**
 * REQ-0568 — Microsoft Store listing artwork, built deterministically.
 *
 *   npm run shots -- --target store --lang ja --only s2-step2-emphasis,s9-inspector,s3-timeline,s7-ai --keep-projects dev-docs/shots/store/projects
 *   npm run store-assets -- --lang ja
 *
 * ## What this makes
 *
 *   assets/store-listing/<lang>/01..04-*.png   4 screenshots, exactly 1920x1080
 *   assets/store-listing/<lang>/hero-16x9-1920x1080.png
 *   assets/store-listing/<lang>/hero-16x9-3840x2160.png
 *
 * ## Why the compositing happens in a browser
 *
 * There is no image library in this project's dependencies, and REQ-0568 is
 * not a reason to add one: Playwright is already here, and a Chromium page
 * sized to the exact output is a compositor with real typography, the app's
 * own fonts and its own design tokens. Every input is a file on disk and every
 * position is a constant in this file, so re-running writes the same picture.
 *
 * ## Why nothing is scaled
 *
 * The store wants exactly 1920x1080. `--target store` captures the app at
 * 1920x976 and the caption band occupies the remaining 104 — see
 * `layout.mjs` for why that beats overlaying or downscaling a full-height
 * capture. `--no-caption` reads the `store-full` capture (1920x1080) instead
 * and passes it through untouched. In neither path is a screenshot pixel
 * resampled.
 */
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STORE } from './layout.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
const FONT_DIR = path.join(REPO, 'resources', 'fonts', 'Noto_Sans_JP', 'static')
const ICON = path.join(REPO, 'docs', 'images', 'icon.png')

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes('--' + name)

const LANG = arg('lang', 'ja') === 'en' ? 'en' : 'ja'
/** ★ REQ-0568 §1-3 — the owner can drop the band without a code change. */
const CAPTION = !has('no-caption')
const TARGET = CAPTION ? 'store' : 'store-full'
const SHOT_DIR = arg('shots', path.join(REPO, 'dev-docs', 'shots', TARGET, ...(LANG === 'en' ? ['en'] : [])))
const OUT_DIR = arg('out', path.join(REPO, 'assets', 'store-listing', LANG))

/**
 * ★ REQ-0568 §1-2 — the four, and why these four.
 *
 * A store listing is skimmed, so the set has to say what the app is in four
 * pictures: what makes it different (emphasis + per-cue style), that the
 * editing is deep (inspector), that timing is direct (timeline), and the one
 * thing no comparable tool has (MCP). Ordered so the strongest is first —
 * Partner Center shows screenshot 1 largest.
 *
 * The captions reuse the download site's own section headings wherever the
 * site has one, so this is copy that has already been through the wording
 * audit rather than new marketing text written at packaging time.
 */
const PICKS = [
  {
    id: 's2-step2-emphasis',
    ja: 'キーワード強調と、字幕1行ごとのスタイル',
    en: 'Keyword emphasis, and styling per subtitle',
  },
  { id: 's9-inspector', ja: '多彩な字幕編集', en: 'Flexible subtitle editing' },
  {
    id: 's3-timeline',
    // The site shows the timeline under a broader heading, so this one is
    // written here — kept to a plain statement of what the picture shows.
    ja: 'タイムラインで表示タイミングを調整',
    en: 'Adjust timing on the timeline',
  },
  { id: 's7-ai', ja: 'AI 連携（MCP）', en: 'AI integration (MCP)' },
]

/**
 * ★ REQ-0568 §2-4 — the only prose in the artwork.
 *
 * Deliberately says nothing about where processing happens. The site's
 * "everything on your PC" family of claims is exactly what RES-0559 had to
 * qualify once MCP shipped, and a static image cannot carry the footnote that
 * makes such a claim true. So the tagline is about the OUTPUT, which is a
 * claim the app keeps unconditionally.
 *
 * ja is REQ-0568 §2-4's own suggested wording; en is its plain equivalent.
 */
const TAGLINE = {
  ja: '動画に、伝わる字幕を。',
  en: 'Subtitles that get your video across.',
}

// --- helpers ---------------------------------------------------------------
const log = (m) => process.stdout.write(m + '\n')
const fileUrl = (p) => 'file:///' + p.split(path.sep).join('/').replace(/^\/+/, '')

/** PNG header fields, straight out of the IHDR chunk. No decoder needed. */
function pngInfo(p) {
  const b = fs.readFileSync(p)
  const isPng = b.length > 24 && b.readUInt32BE(0) === 0x89504e47
  return {
    ok: isPng,
    width: isPng ? b.readUInt32BE(16) : 0,
    height: isPng ? b.readUInt32BE(20) : 0,
    /** 6 = RGBA, 2 = RGB. The Store accepts both; reported so it is not a guess. */
    colorType: isPng ? b[25] : -1,
    bytes: b.length,
  }
}

const FONT_CSS = `
@font-face { font-family: 'MJ'; font-weight: 700;
  src: url('${fileUrl(path.join(FONT_DIR, 'NotoSansJP-Bold.ttf'))}') format('truetype'); }
@font-face { font-family: 'MJ'; font-weight: 900;
  src: url('${fileUrl(path.join(FONT_DIR, 'NotoSansJP-Black.ttf'))}') format('truetype'); }
@font-face { font-family: 'MJ'; font-weight: 500;
  src: url('${fileUrl(path.join(FONT_DIR, 'NotoSansJP-Medium.ttf'))}') format('truetype'); }
`

/**
 * Render one HTML document at an exact pixel size.
 *
 * The document is written next to its images so relative/file: URLs resolve,
 * and `deviceScaleFactor` is how the 4K hero is produced — same layout, twice
 * the raster, rather than an upscale of the 1080p output.
 */
async function render(browser, html, { width, height, scale = 1, out }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mojioko-store-'))
  const doc = path.join(dir, 'compose.html')
  fs.writeFileSync(doc, html, 'utf-8')
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale })
  const page = await ctx.newPage()
  try {
    await page.goto(fileUrl(doc))
    await page.evaluate(() => document.fonts.ready)
    // Decode every image before capturing: a half-decoded <img> screenshots as
    // a blank box and still reports success.
    await page.evaluate(() => Promise.all(
      [...document.images].map((i) => (i.complete ? null : i.decode().catch(() => null))),
    ))
    await page.waitForTimeout(250)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    await page.screenshot({ path: out })
  } finally {
    await ctx.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return out
}

// --- 1. screenshots + caption band ----------------------------------------
function screenshotHtml(shotPng, caption) {
  const app = STORE.height - (CAPTION ? STORE.bandHeight : 0)
  return `<!doctype html><meta charset="utf-8"><style>
${FONT_CSS}
html,body{margin:0;padding:0;background:#0b0d10}
.sheet{width:${STORE.width}px;height:${STORE.height}px;position:relative;overflow:hidden}
/* The band is its own strip, so the app image below is a 1:1 blit. */
.band{position:absolute;left:0;top:0;width:${STORE.width}px;height:${STORE.bandHeight}px;
  background:#0b0d10;border-bottom:2px solid #3fd585;
  display:flex;align-items:center;gap:22px;padding:0 56px;box-sizing:border-box}
.band img{width:52px;height:52px;display:block}
.band span{font-family:'MJ';font-weight:700;font-size:40px;line-height:1;color:#fff;
  letter-spacing:.01em;white-space:nowrap}
.app{position:absolute;left:0;top:${CAPTION ? STORE.bandHeight : 0}px;
  width:${STORE.width}px;height:${app}px;display:block}
</style>
<div class="sheet">
  ${CAPTION ? `<div class="band"><img src="${fileUrl(ICON)}" alt=""><span>${caption}</span></div>` : ''}
  <img class="app" src="${fileUrl(shotPng)}" alt="">
</div>`
}

// --- 2. super hero art -----------------------------------------------------
/**
 * ★ REQ-0568 §2-2 — laid out for a canvas that will be cropped and overdrawn.
 *
 * Two hard constraints drive every number below:
 *   - the top and bottom edges may be cropped, so everything that matters sits
 *     in the vertical middle (content spans y 275..740 of 1080);
 *   - the system may lay text or a gradient over the bottom third, so NOTHING
 *     below y=720 is anything but background — including the burned-in caption
 *     inside the still, which lands around y=667.
 *
 * The still on the right is a real `export_frame` render of the very cue the
 * first screenshot shows, at video resolution, so the artwork is showing the
 * product's actual output rather than an illustration of it.
 */
function heroHtml(framePng) {
  const W = STORE.width, H = STORE.height
  return `<!doctype html><meta charset="utf-8"><style>
${FONT_CSS}
html,body{margin:0;padding:0}
.art{width:${W}px;height:${H}px;position:relative;overflow:hidden;background:#0b0d10}
/* Content, not chrome — DESIGN_SYSTEM allows gradients here. Kept to a single
   soft accent glow behind the still so the dark field is not flat. */
.glow{position:absolute;inset:0;
  background:radial-gradient(1100px 620px at 68% 42%, rgba(63,213,133,.20), rgba(63,213,133,0) 70%)}
.left{position:absolute;left:132px;top:275px;width:760px}
.left img{width:104px;height:104px;display:block;margin-bottom:26px}
.wordmark{font-family:'MJ';font-weight:900;font-size:126px;line-height:1;color:#fff;
  letter-spacing:.045em;margin:0}
.tagline{font-family:'MJ';font-weight:500;font-size:42px;line-height:1.45;color:#aab2be;
  margin:30px 0 0;max-width:720px}
.rule{width:96px;height:6px;background:#3fd585;border-radius:3px;margin:36px 0 0}
/* Radius 10 = the design system's lg. Border, not a shadow. */
.still{position:absolute;left:980px;top:275px;width:820px;height:461px;
  border:1px solid #2a2f38;border-radius:10px;overflow:hidden;background:#000}
.still img{width:100%;height:100%;object-fit:cover;display:block}
</style>
<div class="art">
  <div class="glow"></div>
  <div class="left">
    <img src="${fileUrl(ICON)}" alt="">
    <p class="wordmark">MOJIOKO</p>
    <p class="tagline">${TAGLINE[LANG]}</p>
    <div class="rule"></div>
  </div>
  <div class="still"><img src="${fileUrl(framePng)}" alt=""></div>
</div>`
}

/** Render the hero's still with the real burn pipeline, not a screenshot crop. */
function exportHeroFrame(manifest, work) {
  const entry = manifest.shots.find((s) => s.id === 's2-step2-emphasis')
  if (!entry?.project || !entry.videoPath || entry.atSec == null) {
    throw new Error('no kept project for s2-step2-emphasis — re-run shots with --keep-projects')
  }
  if (!fs.existsSync(entry.project)) throw new Error(`kept project missing: ${entry.project}`)
  const out = path.join(work, 'hero-frame.png')
  const r = spawnSync(ELECTRON, ['.', 'export_frame', entry.videoPath, entry.project,
    '-o', out, '--time', String(entry.atSec.toFixed(2))], {
    cwd: REPO, timeout: 180_000, encoding: 'utf-8',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  })
  if (r.status !== 0 || !fs.existsSync(out)) {
    throw new Error(`export_frame failed (exit ${r.status})\n${(r.stdout || '') + (r.stderr || '')}`)
  }
  return out
}

/**
 * ★ REQ-0568 §3 — count a colour in a finished PNG.
 *
 * The hero's whole claim is that it shows the product's own output, so the
 * emphasis colour has to actually be in the file. Without this the artwork
 * could lose the burned caption entirely — a font id that loads nothing does
 * exactly that (RES-0565 §5) — and every step would still report OK.
 *
 * Chromium is the decoder because nothing else here can read a PNG. The bytes
 * go in as a data: URL rather than a file: URL — a file: image would either
 * refuse to decode from about:blank or taint the canvas, and `getImageData`
 * would throw instead of counting.
 */
async function countColour(browser, png, hex, tol = 18) {
  const src = 'data:image/png;base64,' + fs.readFileSync(png).toString('base64')
  const ctx = await browser.newContext({ viewport: { width: 64, height: 64 } })
  const page = await ctx.newPage()
  try {
    return await page.evaluate(async ({ src, hex, tol }) => {
      const img = new Image()
      img.src = src
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.naturalWidth; c.height = img.naturalHeight
      c.getContext('2d').drawImage(img, 0, 0)
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
      let n = 0
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - r) <= tol && Math.abs(d[i + 1] - g) <= tol && Math.abs(d[i + 2] - b) <= tol) n++
      }
      return n
    }, { src, hex, tol })
  } finally {
    await ctx.close()
  }
}

// --- main ------------------------------------------------------------------
const manifestPath = path.join(SHOT_DIR, 'shots-manifest.json')
if (!fs.existsSync(manifestPath)) {
  console.error(`store-assets: no shots at ${SHOT_DIR}\n` +
    `  run: npm run shots -- --target ${TARGET} --lang ${LANG} --only ${PICKS.map((p) => p.id).join(',')} --keep-projects ${path.join(SHOT_DIR, 'projects')}`)
  process.exit(2)
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mojioko-hero-'))
const browser = await chromium.launch()
const made = []
let failed = 0

log(`store-assets: lang=${LANG} caption=${CAPTION ? 'on' : 'off'} -> ${OUT_DIR}\n`)
try {
  for (const [i, pick] of PICKS.entries()) {
    const src = path.join(SHOT_DIR, pick.id + '.png')
    const out = path.join(OUT_DIR, `${String(i + 1).padStart(2, '0')}-${pick.id}.png`)
    try {
      if (!fs.existsSync(src)) throw new Error(`missing shot: ${src}`)
      const got = pngInfo(src)
      const wantH = STORE.height - (CAPTION ? STORE.bandHeight : 0)
      if (got.width !== STORE.width || got.height !== wantH) {
        throw new Error(`shot is ${got.width}x${got.height}, expected ${STORE.width}x${wantH} — wrong --target?`)
      }
      await render(browser, screenshotHtml(src, pick[LANG]), { width: STORE.width, height: STORE.height, out })
      made.push({ file: out, caption: CAPTION ? pick[LANG] : '(none)' })
      log(`  OK    ${path.basename(out)}`)
    } catch (e) {
      failed++
      log(`  FAIL  ${path.basename(out)}  ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  try {
    const frame = exportHeroFrame(manifest, work)
    for (const scale of [1, 2]) {
      const out = path.join(OUT_DIR, `hero-16x9-${STORE.width * scale}x${STORE.height * scale}.png`)
      await render(browser, heroHtml(frame), { width: STORE.width, height: STORE.height, scale, out })
      made.push({ file: out, caption: `MOJIOKO / ${TAGLINE[LANG]}` })
      log(`  OK    ${path.basename(out)}`)
    }
    /*
     * The emphasis yellow and the accent rule are the two things the hero is
     * asserting: that this is a real burn, and that it is MOJIOKO's palette.
     * Both are counted rather than looked at.
     */
    const hero = path.join(OUT_DIR, `hero-16x9-${STORE.width}x${STORE.height}.png`)
    /*
     * The emphasis is measured at #E8C500, not at the #FFD400 the style asks
     * for, and the difference is real rather than a fudged tolerance: the
     * still is a frame of VIDEO, so libass paints #FFD400 and the video's
     * limited (16-235) range brings it back as ~(232,197,0). Measured, not
     * assumed — a histogram of the caption area peaks there with 6041 px.
     * The accent below never leaves CSS, so it is checked at its exact value.
     */
    const emph = await countColour(browser, hero, '#E8C500')
    const accent = await countColour(browser, hero, '#3FD585')
    log(`\n  hero pixels: emphasis (burned #FFD400, measured at #E8C500) = ${emph}, accent #3FD585 = ${accent}`)
    if (emph < 500) { failed++; log('  FAIL  hero still has no emphasised caption') }
    else log('  PASS  hero still carries the burned emphasis')
    if (accent < 500) { failed++; log('  FAIL  hero has no accent mark') }
    else log('  PASS  hero carries the brand accent')
  } catch (e) {
    failed++
    log(`  FAIL  hero art  ${e instanceof Error ? e.message : String(e)}`)
  }
} finally {
  await browser.close()
  fs.rmSync(work, { recursive: true, force: true })
}

/*
 * ★ REQ-0568 §3-1 — check the deliverables, do not assume them.
 *
 * Partner Center rejects a wrong size after the upload, which is a slow way to
 * find out. Everything written above is measured from its own PNG header here.
 */
log('\nfile                                dimensions   type  size')
for (const m of made) {
  const p = pngInfo(m.file)
  const want = /hero-16x9-(\d+)x(\d+)/.exec(path.basename(m.file))
  const wantW = want ? Number(want[1]) : STORE.width
  const wantH = want ? Number(want[2]) : STORE.height
  const ok = p.ok && p.width === wantW && p.height === wantH
  if (!ok) failed++
  log(`${ok ? 'OK  ' : 'BAD '}${path.basename(m.file).padEnd(32)}${`${p.width}x${p.height}`.padEnd(13)}` +
    `${(p.colorType === 6 ? 'RGBA' : p.colorType === 2 ? 'RGB' : '?').padEnd(6)}${(p.bytes / 1024 | 0)}KB`)
}

fs.writeFileSync(path.join(OUT_DIR, 'store-assets-manifest.json'), JSON.stringify({
  lang: LANG, caption: CAPTION, tagline: TAGLINE[LANG],
  files: made.map((m) => ({ file: path.basename(m.file), text: m.caption, ...pngInfo(m.file) })),
}, null, 2), 'utf-8')

log(`\n${failed === 0 ? 'ALL STORE ASSETS OK' : `${failed} problem(s)`}`)
process.exit(failed === 0 ? 0 : 1)
