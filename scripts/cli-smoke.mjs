/**
 * REQ-0449 §6 — MOJIOKO CLI agent-flow smoke (reusable gate).
 *
 * Drives the CLI exactly as a first-time agent would:
 *   status → (resolve blockers) → loop over videos: run --burn → verify.
 * Also checks an error path recovers via its `remedy`. Asserts: no window ever
 * opens, no interactive wait, exit codes match the spec, artifacts are real
 * (ffprobe). Exits non-zero on any failure (this is a GATE, not a report).
 *
 * Usage: node scripts/cli-smoke.mjs
 * Requires a set-up box (Whisper model present). Skips the transcribe/burn loop
 * with a clear message if `status.ready` is false and blockers can't be auto-
 * cleared without a multi-GB download.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const FFMPEG = join(ROOT, 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')
const FFPROBE = join(ROOT, 'resources', 'bin', 'ffmpeg', 'ffprobe.exe')

let failures = 0
const log = (m) => process.stdout.write(m + '\n')
function check(name, cond, extra = '') {
  log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

/** Run the CLI headless with a hard timeout; return {code, json}. */
function cli(args, timeoutMs = 300000) {
  const r = spawnSync(ELECTRON, ['.', ...args], {
    cwd: ROOT,
    timeout: timeoutMs,
    encoding: 'utf-8',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  })
  const line = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop()
  let json = null
  try { json = line ? JSON.parse(line) : null } catch { json = null }
  return { code: r.status, json, timedOut: r.error?.code === 'ETIMEDOUT' }
}

function probeWH(path) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path], { encoding: 'utf-8' })
  return (r.stdout || '').trim()
}

/** REQ-0460 — video-stream bitrate in kbps (falls back to container total). */
function probeBitrate(path) {
  const v = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=bit_rate', '-of', 'csv=p=0', path], { encoding: 'utf-8' })
  const vn = parseInt((v.stdout || '').trim(), 10)
  if (Number.isFinite(vn) && vn > 0) return Math.round(vn / 1000)
  const f = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=bit_rate', '-of', 'csv=p=0', path], { encoding: 'utf-8' })
  const fn = parseInt((f.stdout || '').trim(), 10)
  return Number.isFinite(fn) && fn > 0 ? Math.round(fn / 1000) : 0
}

function makeClip(path, size) {
  spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=30:duration=2`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'h264_mf', '-c:a', 'aac', '-shortest', path], { encoding: 'utf-8' })
}

// REQ-0468 — a SOLID-colour clip so a white caption is trivially isolatable
// (flat background compresses near-losslessly, so the burn frame and the
// export_frame still differ only in h264 noise + caption anti-aliasing).
function makeSolidClip(path, size, color = 'navy') {
  spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:rate=30:duration=2`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'h264_mf', '-c:a', 'aac', '-shortest', path], { encoding: 'utf-8' })
}

// REQ-0468 — the vertical centre (px) of the white caption ink in a PNG, found
// by dumping raw rgb24 and averaging the rows of near-white pixels.  Used to
// assert the caption lands at the SAME Y in an export_frame still and a frame
// pulled from the burn — the "preview == burn" placement gate.
function whiteCaptionCenterY(png) {
  const wh = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', png], { encoding: 'utf-8' }).stdout.trim().split(',')
  const w = +wh[0], h = +wh[1]
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })
  const buf = r.stdout
  if (!buf || buf.length < w * h * 3) return { centerY: NaN, count: 0 }
  let sumY = 0, n = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3
    if (buf[i] > 190 && buf[i + 1] > 190 && buf[i + 2] > 190) { sumY += y; n++ }
  }
  return { centerY: n > 0 ? Math.round(sumY / n) : NaN, count: n }
}

/**
 * REQ-0500 §2 — count pixels matching an RGB triple (with tolerance for h264 /
 * anti-aliasing noise).  Used for the karaoke gate: `--karaoke off` must drive
 * the highlight-colour count to exactly zero.
 */
function countColor(png, [r, g, b], tol = 24) {
  const out = spawnSync(FFMPEG, ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  })
  const buf = out.stdout
  if (!buf || buf.length === 0) return -1
  let n = 0
  for (let i = 0; i + 2 < buf.length; i += 3) {
    if (Math.abs(buf[i] - r) <= tol && Math.abs(buf[i + 1] - g) <= tol && Math.abs(buf[i + 2] - b) <= tol) n++
  }
  return n
}

/**
 * REQ-0501 §3 — caption ink measurements on a SOLID-colour clip.
 *
 * `ink` = every pixel that is not the flat background, so the bounding box
 * (`w`/`h`) tracks geometry changes (rotation, line spacing, ALL CAPS) while
 * `white`/`black` track fill and outline coverage. Only meaningful against a
 * `makeSolidClip` background — on `testsrc` everything is "ink".
 */
function inkStats(png, bg = [0, 0, 128], tol = 60) {
  const out = spawnSync(FFMPEG, ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  })
  const wh = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', png], { encoding: 'utf-8' }).stdout.trim().split(',')
  const W = +wh[0], H = +wh[1]
  const b = out.stdout
  if (!b || b.length < W * H * 3) return { ink: 0, white: 0, black: 0, w: 0, h: 0 }
  let ink = 0, white = 0, black = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3, r = b[i], g = b[i + 1], bl = b[i + 2]
    if (r > 200 && g > 200 && bl > 200) white++
    if (r < 40 && g < 40 && bl < 40) black++
    const isBg = Math.abs(r - bg[0]) <= tol && Math.abs(g - bg[1]) <= tol && Math.abs(bl - bg[2]) <= tol
    if (!isBg) { ink++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
  }
  return { ink, white, black, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** Make a solid-colour clip under `work` and return its path. */
function makeClipFor(name, size) {
  const p = join(work, name)
  makeSolidClip(p, size)
  return p
}

if (!existsSync(ELECTRON) || !existsSync(FFMPEG)) {
  log('SKIP: electron or bundled ffmpeg not found (run `npm run build` first).')
  process.exit(0)
}

const work = mkdtempSync(join(tmpdir(), 'mojioko-cli-smoke-'))
try {
  // 1) status — never opens a window, exits 0, structured.
  const st = cli(['status'], 60000)
  check('status exits 0', st.code === 0)
  check('status not timed out (no hang/window)', !st.timedOut)
  check('status has ready + blockers[]', st.json?.data && typeof st.json.data.ready === 'boolean' && Array.isArray(st.json.data.blockers))
  // REQ-0457 A1 — status returns the FULL resolved subtitle style.
  const style = st.json?.data?.settings?.subtitleStyle
  check('status subtitleStyle has karaoke/emphasis/animation/shadow', !!style?.karaoke && !!style?.emphasis && !!style?.animation && !!style?.shadow, style ? Object.keys(style).join(',') : 'missing')

  // REQ-0458 §2/§5 — a bundle launched with an OLD launch-spec revision is
  // detected as stale (agent can advise a re-export). Current rev → not stale.
  check('current launch → not stale', st.json?.data?.mcpBundle?.stale === false, JSON.stringify(st.json?.data?.mcpBundle))
  const staleR = spawnSync(ELECTRON, ['.', 'status', '--json'], {
    cwd: ROOT, timeout: 60000, encoding: 'utf-8',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', MOJIOKO_LAUNCH_SPEC_REV: '999' },
  })
  const staleLine = (staleR.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop()
  let staleJson = null
  try { staleJson = staleLine ? JSON.parse(staleLine) : null } catch { staleJson = null }
  check('stale bundle (old launch-spec rev) → status flags stale + STALE_MCP_BUNDLE warning',
    staleJson?.data?.mcpBundle?.stale === true && (staleJson?.warnings || []).some((w) => w.code === 'STALE_MCP_BUNDLE'),
    JSON.stringify(staleJson?.data?.mcpBundle))

  // 2) help --json — full coverage present.
  const help = cli(['help', '--json'], 60000)
  check('help --json exits 0', help.code === 0)
  check('help lists all commands', (help.json?.data?.commands || []).length >= 6)
  check('help exposes error codes', (help.json?.data?.errorCodes || []).length >= 10)

  // 3) error path returns the spec code + a remedy.
  const badModel = cli(['transcribe', join(work, 'nope.mp4'), '-o', join(work, 'o.mojioko')], 40000)
  check('missing input → INPUT_NOT_FOUND / exit 3', badModel.code === 3 && badModel.json?.code === 'INPUT_NOT_FOUND', `got ${badModel.code}/${badModel.json?.code}`)
  const notInstalled = cli(['tools', 'use', 'whisper', '--model', 'large-v3'], 40000)
  check('uninstalled model → MODEL_NOT_FOUND / exit 5 + remedy', notInstalled.code === 5 && notInstalled.json?.code === 'MODEL_NOT_FOUND' && !!notInstalled.json?.remedy, notInstalled.json?.remedy || '')

  // REQ-0459 §1/§5 — the .mojioko file-association change must NOT swallow CLI:
  // an unknown token, and a .mojioko path that does NOT exist, both stay CLI
  // (exit 2 / USAGE) rather than silently opening a GUI window.
  const unknownTok = cli(['frobnicate'], 40000)
  check('unknown token → USAGE / exit 2 (CLI preserved)', unknownTok.code === 2 && unknownTok.json?.code === 'USAGE', `${unknownTok.code}/${unknownTok.json?.code}`)
  const ghostProj = cli([join(work, 'does-not-exist.mojioko')], 40000)
  check('non-existent .mojioko → USAGE (not a GUI open)', ghostProj.code === 2 && ghostProj.json?.code === 'USAGE', `${ghostProj.code}/${ghostProj.json?.code}`)

  // REQ-0460 — quality regression: the resolution-scaling path must NOT collapse
  // the bitrate.  Before the fix, `--resolution` ran a separate no-rate-control
  // `h264_mf` pre-encode that dropped the output to ~2/3 even when the target
  // matched the source.  Now scaling is folded into the single cq-quality burn,
  // so a native burn and an equal-size `--resolution` burn should land within a
  // small margin.  Needs no Whisper model (burn takes an SRT directly).
  {
    const brClip = join(work, 'br.mp4')
    makeClip(brClip, '540x960')
    const brSrt = join(work, 'br.srt')
    writeFileSync(brSrt, '1\n00:00:00,000 --> 00:00:02,000\nbitrate regression cue\n', 'utf-8')
    const nativeOut = join(work, 'br-native.mp4')
    const scaledOut = join(work, 'br-scaled.mp4')
    const bNative = cli(['burn', brClip, brSrt, '-o', nativeOut], 120000)
    const bScaled = cli(['burn', brClip, brSrt, '-o', scaledOut, '--resolution', '540x960'], 120000)
    check('burn native exits 0 + produced a video', bNative.code === 0 && existsSync(nativeOut), `code=${bNative.code}`)
    check('burn --resolution exits 0 + produced a video', bScaled.code === 0 && existsSync(scaledOut), `code=${bScaled.code}`)
    // REQ-0460 (d) — result exposes the measured bitrate + the concrete encoder.
    check('burn result reports videoBitrateKbps (number) + resolvedEncoder',
      typeof bNative.json?.data?.videoBitrateKbps === 'number' && bNative.json.data.videoBitrateKbps > 0 && !!bNative.json?.data?.resolvedEncoder,
      `br=${bNative.json?.data?.videoBitrateKbps} enc=${bNative.json?.data?.resolvedEncoder}`)
    const brN = probeBitrate(nativeOut)
    const brS = probeBitrate(scaledOut)
    check('scaled-to-source burn bitrate does NOT collapse vs native (>=70%)', brS >= brN * 0.7, `native=${brN}kbps scaled=${brS}kbps`)
    // REQ-0460 (b) — an explicit --bitrate override is honored end-to-end.  A
    // LOW cap is the content-robust probe: `testsrc` is near-static so a high
    // target would just VBR-undershoot (nothing to encode), but a tight cap must
    // actually constrain the encoder below the cq baseline.  (The exact
    // -b:v/-maxrate/-bufsize arg mapping is unit-tested in encode-quality-req-0460.)
    const brCapOut = join(work, 'br-cap.mp4')
    const bCap = cli(['burn', brClip, brSrt, '-o', brCapOut, '--bitrate', '150k'], 120000)
    check('burn --bitrate 150k exits 0 + video', bCap.code === 0 && existsSync(brCapOut), `code=${bCap.code}`)
    const brCap = probeBitrate(brCapOut)
    check('--bitrate 150k constrains below the cq baseline', brCap < brN, `capped=${brCap}kbps baseline=${brN}kbps`)
  }

  // REQ-0461 — the per-cue style flags must ACTUALLY change the render.  Before
  // the fix, --weight/--font-size/--text-color/--outline-color/--outline were
  // advertised but never read (no-ops), and --margin-v only fed the overflow
  // budget, never the ASS verticalMarginPx.  Two gates, both without a Whisper
  // model (burn/export_frame take an SRT): (1) burn --dry-run returns the ACTUAL
  // applied style (not the settings default); (2) export_frame with an override
  // changes real pixels vs the default frame.
  {
    const clip = join(work, 'style.mp4')
    makeClip(clip, '640x360')
    const srt = join(work, 'style.srt')
    writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,000\nSTYLE\n', 'utf-8')

    // (1) dry-run echoes the resolved style actually used (no encode).
    const dry = cli(['burn', clip, srt, '--dry-run', '--font-size', '72', '--text-color', '#FFEE00', '--outline-color', '#112233', '--outline', '5', '--weight', 'Bold', '--margin-v', '120'], 30000)
    const s = dry.json?.data?.subtitleStyle
    check('burn --dry-run subtitleStyle reflects overrides (font-size/colors/outline/margin)',
      dry.code === 0 && s?.fontSizePx === 72 && s?.textColorHex === '#FFEE00' && s?.outlineColorHex === '#112233' && s?.outlineThicknessPx === 5 && s?.position?.verticalMarginPx === 120,
      JSON.stringify(s))
    check('burn --dry-run reflects --weight (fontId is a Bold face)', /bold/i.test(s?.fontId || ''), s?.fontId || 'missing')

    // (2) real-pixel gate: a text-color/size override changes the exported PNG.
    // If the flags were still no-ops, the two frames would be byte-identical.
    const pDefault = join(work, 'style-default.png')
    const pOverride = join(work, 'style-override.png')
    const efA = cli(['export_frame', clip, srt, '-o', pDefault, '--time', '1.0'], 60000)
    const efB = cli(['export_frame', clip, srt, '-o', pOverride, '--time', '1.0', '--text-color', '#FF0000', '--font-size', '110', '--outline', '0'], 60000)
    check('export_frame default + style-override both exit 0', efA.code === 0 && efB.code === 0, `${efA.code}/${efB.code}`)
    const framesDiffer = existsSync(pDefault) && existsSync(pOverride) && !readFileSync(pDefault).equals(readFileSync(pOverride))
    check('export_frame style override changes real pixels (frame != default)', framesDiffer)

    // (3) invalid override is a clean USAGE error (exit 2), not a silent ignore.
    const badColor = cli(['burn', clip, srt, '--dry-run', '--text-color', 'red'], 20000)
    check('burn --text-color red → USAGE / exit 2', badColor.code === 2 && badColor.json?.code === 'USAGE', `${badColor.code}/${badColor.json?.code}`)

    // REQ-0499 §1 / §3-4 — UNKNOWN OPTION gate.
    // Before this, a flag that does not exist returned ok:true with zero
    // warnings, so a hallucinated flag looked like it worked. Default is now a
    // warning; `--strict-args` makes it exit 2.
    //
    // Specimen choice has churned twice: `--karaoke` (REQ-0500 made it real),
    // then `--shadow` (REQ-0501 made it real). `--shadow-color` is the stable
    // pick — it is a real cue FIELD that no GUI surface can set (auto-seeded to
    // #000000), so REQ-0501 deliberately did NOT add a flag for it and the
    // "GUI-settable only" rule means it should stay unknown. It is also exactly
    // what an agent guesses once it sees `--shadow` work.
    const warned = cli(['burn', clip, srt, '--dry-run', '--shadow-color', '#FF0000'], 20000)
    const warnCodes = (warned.json?.warnings ?? []).map((x) => x.code)
    check(
      'unknown option warns but still succeeds (default)',
      warned.code === 0 && warnCodes.includes('UNKNOWN_OPTION'),
      `code=${warned.code} warnings=${JSON.stringify(warnCodes)}`,
    )
    const strictArgs = cli(['burn', clip, srt, '--dry-run', '--shadow-color', '#FF0000', '--strict-args'], 20000)
    check(
      'unknown option + --strict-args → USAGE / exit 2',
      strictArgs.code === 2 && strictArgs.json?.code === 'USAGE',
      `${strictArgs.code}/${strictArgs.json?.code}`,
    )
    // A REAL flag must not be mistaken for unknown — the hidden-alias allowlist
    // (`--at`, `--overwrite`, `burn --format`, …) is what makes this pass.
    const hiddenOk = cli(['burn', clip, srt, '--dry-run', '--format', 'srt', '--strict-args'], 20000)
    check(
      'hidden-but-real option (burn --format) survives --strict-args',
      hiddenOk.code === 0,
      `${hiddenOk.code}/${hiddenOk.json?.code ?? ''}`,
    )

    // REQ-0500 §2 / §3-4 — KARAOKE ESCAPE gate, in REAL PIXELS.
    // Cues inherit `karaokeEnabled` from the app settings, so before this a
    // headless caller on a karaoke-ON machine could not produce a plain
    // subtitle at all. Assert the highlight colour vanishes with `--karaoke off`.
    //
    // Self-controlling: the `on` case must find highlight pixels. If it finds
    // none the environment has karaoke off / the colour changed, and a green
    // `off` case would prove nothing — so `on` failing is what keeps this gate
    // from silently degrading into a tautology.
    const kOn = join(work, 'karaoke-on.png')
    const kOff = join(work, 'karaoke-off.png')
    const kHue = join(work, 'karaoke-hue.png')
    const HL = [0xb4, 0xff, 0x39] // settings highlight (#B4FF39)
    const MAGENTA = [0xff, 0x00, 0xff]
    cli(['export_frame', clip, srt, '-o', kOn, '--time', '1.0', '--karaoke', 'on'], 60000)
    cli(['export_frame', clip, srt, '-o', kOff, '--time', '1.0', '--karaoke', 'off'], 60000)
    cli(['export_frame', clip, srt, '-o', kHue, '--time', '1.0', '--karaoke', 'on', '--karaoke-color', '#FF00FF'], 60000)
    const onHl = countColor(kOn, HL)
    const offHl = countColor(kOff, HL)
    check('karaoke ON renders highlight pixels (control for the gate below)', onHl > 200, `px=${onHl}`)
    check('--karaoke off removes EVERY highlight pixel', offHl === 0, `px=${offHl} (was ${onHl})`)
    check('--karaoke-color repaints the highlight', countColor(kHue, MAGENTA) > 200 && countColor(kHue, HL) === 0,
      `magenta=${countColor(kHue, MAGENTA)} oldHighlight=${countColor(kHue, HL)}`)

    // REQ-0501 §3 — the second-wave style axes, in REAL PIXELS.
    //
    // Every check is a COMPARISON between two renders, so it cannot degrade
    // into a tautology the way a bare "== 0" could: the baseline side has to
    // exhibit the thing that is expected to change. Karaoke is forced off
    // throughout so the sweep highlight cannot confound the colour counts.
    //
    // Own fixture rather than the `clip`/`srt` above: `inkStats` measures
    // "pixels that are not the flat background", which requires a SOLID clip
    // (the style-override block uses `testsrc`, where everything is ink).
    const s2clip = makeClipFor('s2.mp4', '1280x720')
    const s2srt = join(work, 's2.srt')
    writeFileSync(s2srt, '1\n00:00:00,300 --> 00:00:02,000\nhello world test\n', 'utf-8')
    const style2 = (name, ...flags) => {
      const p = join(work, `s2-${name}.png`)
      const r = cli(['export_frame', s2clip, s2srt, '-o', p, '--time', '1.0', '--karaoke', 'off', ...flags], 60000)
      if (r.code !== 0) { check(`style2 ${name} exits 0`, false, `code=${r.code}/${r.json?.code ?? ''}`); return null }
      return inkStats(p)
    }
    const s2base = style2('base')
    check('style2 baseline renders a caption (control for the comparisons below)',
      !!s2base && s2base.ink > 1000 && s2base.white > 1000 && s2base.black > 1000,
      s2base ? `ink=${s2base.ink} white=${s2base.white} black=${s2base.black}` : 'no frame')

    if (s2base) {
      const sShadow = style2('shadow', '--shadow', '40')
      check('--shadow adds dark pixels', sShadow && sShadow.black > s2base.black * 1.2,
        `black ${s2base.black} -> ${sShadow?.black}`)

      const sRot = style2('rot', '--rotation', '20')
      check('--rotation tilts the caption (ink box grows taller)', sRot && sRot.h > s2base.h + 20,
        `inkH ${s2base.h} -> ${sRot?.h}`)

      const sUpper = style2('upper', '--uppercase', 'on')
      check('--uppercase widens the caption (ALL CAPS is wider)', sUpper && sUpper.w > s2base.w + 20,
        `inkW ${s2base.w} -> ${sUpper?.w}`)

      const sAlpha = style2('talpha', '--text-alpha', '0')
      check('--text-alpha 0 removes every white fill pixel (and 100 had them)',
        sAlpha && s2base.white > 1000 && sAlpha.white === 0,
        `white ${s2base.white} -> ${sAlpha?.white}`)

      const sOut = style2('oalpha', '--outline-alpha', '0')
      check('--outline-alpha 0 removes outline pixels', sOut && sOut.black < s2base.black * 0.9,
        `black ${s2base.black} -> ${sOut?.black}`)

      const sBg = style2('bg', '--background', 'on', '--background-color', 'white', '--background-opacity', '100')
      check('--background on paints a box behind the caption', sBg && sBg.white > s2base.white * 3,
        `white ${s2base.white} -> ${sBg?.white}`)

      // Line spacing only exists BETWEEN lines, so a single-line cue cannot show
      // it (the writer skips the split entirely). Needs its own 2-line fixture.
      const multi = join(work, 's2-multi.srt')
      writeFileSync(multi, '1\n00:00:00,300 --> 00:00:02,000\nfirst line\nsecond line\n', 'utf-8')
      const lsPng = (v) => {
        const p = join(work, `s2-ls${v}.png`)
        cli(['export_frame', s2clip, multi, '-o', p, '--time', '1.0', '--karaoke', 'off', '--line-spacing', String(v)], 60000)
        return inkStats(p)
      }
      const ls0 = lsPng(0)
      const ls80 = lsPng(80)
      check('--line-spacing separates the two lines (two-line cue)',
        ls0.ink > 1000 && ls80.h > ls0.h + 40, `inkH ${ls0.h} -> ${ls80.h}`)
    }

    // REQ-0502 §1 — MULTI-TIME capture. The failure mode worth guarding is not
    // "no files" but "N copies of the same frame", so this compares the bytes.
    const mt = cli(['export_frame', s2clip, s2srt, '-o', join(work, 'mt.png'), '--time', '0.3,0.9,1.5'], 90000)
    const mtFrames = mt.json?.data?.frames ?? []
    check('export_frame --time a,b,c renders one frame per time', mt.code === 0 && mt.json?.data?.frameCount === 3 && mtFrames.length === 3,
      `code=${mt.code} frameCount=${mt.json?.data?.frameCount}`)
    check('multi-time reports the time each frame was taken AT',
      mtFrames.map((f) => f.timeSec).join(',') === '0.3,0.9,1.5', JSON.stringify(mtFrames.map((f) => f.timeSec)))
    const mtPaths = mtFrames.map((f) => f.outputPath)
    check('multi-time writes distinct, time-labelled files', mtPaths.every((p) => existsSync(p)) && new Set(mtPaths).size === 3,
      mtPaths.map((p) => p.split(/[\\/]/).pop()).join(' '))
    // ★ the real check: different timestamps must be different pictures.
    const digests = new Set(mtPaths.filter((p) => existsSync(p)).map((p) => createHash('sha256').update(readFileSync(p)).digest('hex')))
    check('multi-time frames are DISTINCT images (not N copies of one frame)', digests.size === 3, `distinct=${digests.size}/3`)
    // Backward compatibility: a single time keeps the exact -o path.
    const st1 = cli(['export_frame', s2clip, s2srt, '-o', join(work, 'single.png'), '--time', '1.0'], 60000)
    check('single --time still returns the exact -o path (backward compatible)',
      st1.code === 0 && st1.json?.data?.frameCount === 1 && String(st1.json?.data?.outputPath).endsWith('single.png'))
    // Out of range is a clear USAGE, not a bare ffmpeg exit code.
    const oob = cli(['export_frame', s2clip, s2srt, '-o', join(work, 'oob.png'), '--time', '9999'], 60000)
    check('a time past the end → USAGE naming the duration', oob.code === 2 && oob.json?.code === 'USAGE' && /秒/.test(String(oob.json?.message)),
      `${oob.code}/${oob.json?.code}`)

    // REQ-0502 §2 — "accepted, succeeds, renders nothing" warnings.
    // Each is checked in BOTH directions: a warning that fires on ordinary
    // input is noise, and noise is unread (§2-4).
    const warnCodesOf = (...flags) => {
      const r = cli(['burn', s2clip, s2srt, '--dry-run', ...flags], 20000)
      return { code: r.code, codes: (r.json?.warnings ?? []).map((w) => w.code) }
    }
    const wBoxNoBorder = warnCodesOf('--background', 'on', '--outline', '0')
    check('background box + outline 0 → BACKGROUND_BOX_NOT_DRAWN',
      wBoxNoBorder.codes.includes('BACKGROUND_BOX_NOT_DRAWN'), JSON.stringify(wBoxNoBorder.codes))
    const wBoxOk = warnCodesOf('--background', 'on', '--outline', '2', '--shadow', '0')
    check('background box + outline 2 → NO box warning (the other half of the gate)',
      !wBoxOk.codes.includes('BACKGROUND_BOX_NOT_DRAWN'), JSON.stringify(wBoxOk.codes))
    const wEmph = warnCodesOf('--emphasis', 'on')
    check('--emphasis on with no spans → EMPHASIS_NO_SPANS', wEmph.codes.includes('EMPHASIS_NO_SPANS'), JSON.stringify(wEmph.codes))
    const wIgnored = warnCodesOf('--karaoke', 'off', '--karaoke-color', '#FF00FF')
    check('--karaoke-color with karaoke off → KARAOKE_FLAGS_WITHOUT_KARAOKE',
      wIgnored.codes.includes('KARAOKE_FLAGS_WITHOUT_KARAOKE'), JSON.stringify(wIgnored.codes))
    const wIgnoredOff = warnCodesOf('--karaoke', 'on', '--karaoke-color', '#FF00FF')
    check('--karaoke-color with karaoke on → NO ignored-flag warning',
      !wIgnoredOff.codes.includes('KARAOKE_FLAGS_WITHOUT_KARAOKE'), JSON.stringify(wIgnoredOff.codes))
    const wClean = warnCodesOf()
    check('a plain burn emits NO no-op warnings (warnings stay rare)', wClean.code === 0 && wClean.codes.length === 0, JSON.stringify(wClean.codes))

    // REQ-0503 §1 — a downscale must not delete the outline (and with it the
    // background box). 4K → shorts is factor 0.28, where `--outline 1` used to
    // round to 0. Both halves: the effect survives, and an explicit 0 stays 0.
    const uhd = makeClipFor('uhd.mp4', '3840x2160')
    const shrunk = cli(['burn', uhd, s2srt, '--dry-run', '--preset', 'shorts', '--outline', '1', '--shadow', '1'], 40000)
    check('4K → shorts keeps outline 1 (was rounded to 0)',
      shrunk.json?.data?.subtitleStyle?.outlineThicknessPx === 1, `outline=${shrunk.json?.data?.subtitleStyle?.outlineThicknessPx}`)
    check('4K → shorts keeps shadow 1', shrunk.json?.data?.subtitleStyle?.shadow?.depthPx === 1,
      `shadow=${shrunk.json?.data?.subtitleStyle?.shadow?.depthPx}`)
    const zeroed = cli(['burn', uhd, s2srt, '--dry-run', '--preset', 'shorts', '--outline', '0', '--shadow', '0'], 40000)
    check('an explicit --outline 0 is NOT pushed up to 1 (the other half)',
      zeroed.json?.data?.subtitleStyle?.outlineThicknessPx === 0 && zeroed.json?.data?.subtitleStyle?.shadow?.depthPx === 0,
      `outline=${zeroed.json?.data?.subtitleStyle?.outlineThicknessPx} shadow=${zeroed.json?.data?.subtitleStyle?.shadow?.depthPx}`)
    // ...and the box survives in REAL pixels, which is the harm that motivated it.
    const boxPng = join(work, 's3-box.png')
    cli(['export_frame', uhd, s2srt, '-o', boxPng, '--time', '1.0', '--preset', 'shorts', '--karaoke', 'off',
      '--outline', '1', '--background', 'on', '--background-color', 'white', '--background-opacity', '100', '--shadow', '0'], 90000)
    const boxWhite = existsSync(boxPng) ? inkStats(boxPng).white : -1
    check('4K → shorts still paints the background box (real pixels)', boxWhite > 1500, `white=${boxWhite}`)

    // REQ-0503 §2 — the overflow budget defaulted from `--margin-v` used to be a
    // SOURCE-space number compared against the OUTPUT canvas. It must now match
    // the margin actually drawn.
    const mv = cli(['burn', uhd, s2srt, '--dry-run', '--preset', 'shorts', '--margin-v', '200'], 40000)
    const drawnMargin = mv.json?.data?.subtitleStyle?.position?.verticalMarginPx
    const budget = mv.json?.data?.overflow?.marginY
    check('--margin-v default budget is converted to output space (drawn === budget)',
      drawnMargin === budget, `drawn=${drawnMargin} budget=${budget}`)
    // An EXPLICIT --margin-y is already output-space and must stay untouched.
    const my = cli(['burn', uhd, s2srt, '--dry-run', '--preset', 'shorts', '--margin-v', '200', '--margin-y', '300'], 40000)
    check('an explicit --margin-y is NOT scaled', my.json?.data?.overflow?.marginY === 300, `budget=${my.json?.data?.overflow?.marginY}`)

    // REQ-0503 §3 — a preset carries position, so applying one un-pins cues.
    // Intended and documented, but invisible; warn. Both halves.
    const pinned = join(work, 's3-pinned.mojioko')
    const unpinnedP = join(work, 's3-unpinned.mojioko')
    cli(['convert', s2srt, '-o', pinned, '--video', s2clip], 40000)
    const proj = JSON.parse(readFileSync(pinned, 'utf-8'))
    const bare = JSON.parse(JSON.stringify(proj))
    for (const c of proj.editing.subtitles) { c.posX = 500; c.posY = 800 }
    writeFileSync(pinned, JSON.stringify(proj), 'utf-8')
    writeFileSync(unpinnedP, JSON.stringify(bare), 'utf-8')
    const presetName = (st.json?.data?.settings?.stylePresets ?? [])[0]
    if (presetName) {
      const wPin = cli(['burn', s2clip, pinned, '--dry-run', '--style', presetName], 40000)
      check('applying a preset to PINNED cues warns that positions were cleared',
        (wPin.json?.warnings ?? []).some((w) => w.code === 'PRESET_CLEARED_POSITION'),
        JSON.stringify((wPin.json?.warnings ?? []).map((w) => w.code)))
      const wNoPin = cli(['burn', s2clip, unpinnedP, '--dry-run', '--style', presetName], 40000)
      check('applying the same preset to UNPINNED cues does NOT warn',
        !(wNoPin.json?.warnings ?? []).some((w) => w.code === 'PRESET_CLEARED_POSITION'),
        JSON.stringify((wNoPin.json?.warnings ?? []).map((w) => w.code)))
      const wNoStyle = cli(['burn', s2clip, pinned, '--dry-run'], 40000)
      check('pinned cues WITHOUT --style do not warn',
        !(wNoStyle.json?.warnings ?? []).some((w) => w.code === 'PRESET_CLEARED_POSITION'),
        JSON.stringify((wNoStyle.json?.warnings ?? []).map((w) => w.code)))
    } else {
      log('SKIP: no saved style preset on this box — PRESET_CLEARED_POSITION gate not exercised.')
    }

    // Emphasis is echoed rather than measured: enabling it changes NO pixels
    // without `emphasisSpans` (which words to emphasise), and spans are per-cue
    // character offsets deliberately out of scope for this REQ. Verified with
    // real pixels that the frame is unchanged, so the echo is the only signal.
    const emph = cli(['burn', s2clip, s2srt, '--dry-run', '--emphasis', 'on', '--emphasis-color', '#FF00FF', '--emphasis-scale', '175'], 20000)
    const em = emph.json?.data?.subtitleStyle?.emphasis
    check('--emphasis on/color/scale reach the resolved style (echo; see comment)',
      emph.code === 0 && em?.enabled === true && em?.color === '#FF00FF' && em?.scalePercent === 175,
      JSON.stringify(em))
  }

  // REQ-0500 §3-1 — `run --burn --dry-run` must not claim a burn that never
  // happened. It used to return `burned:true` + an outputPath for a missing file.
  {
    const clip = makeClipFor('dryrun.mp4', '640x360')
    const srt = join(work, 'dryrun.srt')
    writeFileSync(srt, '1\n00:00:00,300 --> 00:00:01,500\ndry run cue\n', 'utf-8')
    const out = join(work, 'dryrun-out.mp4')
    const r = cli(['run', clip, '-o', out, '--subtitle', srt, '--burn', '--dry-run'], 60000)
    check('run --burn --dry-run exits 0', r.code === 0, `code=${r.code}/${r.json?.code ?? ''}`)
    check('run --dry-run reports dryRun:true and burned:false', r.json?.data?.dryRun === true && r.json?.data?.burned === false,
      `dryRun=${r.json?.data?.dryRun} burned=${r.json?.data?.burned}`)
    check('run --dry-run wrote NO file (the claim matches the disk)', !existsSync(out))
  }

  // REQ-0500 §1 — `read_subtitle --with-style` must expose per-cue style, and
  // `styleVaries` must distinguish a uniform project from a hand-tuned one.
  {
    const clip = makeClipFor('style-read.mp4', '640x360')
    const srt = join(work, 'style-read.srt')
    writeFileSync(srt, '1\n00:00:00,300 --> 00:00:01,000\nfirst\n\n2\n00:00:01,200 --> 00:00:02,000\nsecond\n', 'utf-8')
    const moj = join(work, 'style-read.mojioko')
    cli(['convert', srt, '-o', moj, '--video', clip], 40000)

    const plain = cli(['read_subtitle', moj], 30000)
    check('read_subtitle default shape is unchanged (no style key)', plain.code === 0 && plain.json?.data?.cues?.[0]?.style === undefined)

    const styled = cli(['read_subtitle', moj, '--with-style'], 30000)
    const c0 = styled.json?.data?.cues?.[0]
    check('read_subtitle --with-style returns per-cue style', styled.code === 0 && !!c0?.style?.karaoke && !!c0?.style?.animation && !!c0?.style?.background,
      c0?.style ? Object.keys(c0.style).join(',') : 'missing')
    // REQ-0500 §1-3 — `index` is recomputed per read, so a stable handle matters.
    // `cueNumber` only exists because `entriesFromSegments` now assigns it; if
    // that regresses, the field silently becomes undefined and this catches it.
    const c1 = styled.json?.data?.cues?.[1]
    check('read_subtitle --with-style returns stable ids (id + cueNumber)',
      typeof c0?.id === 'string' && c0.id.length > 0 && c0?.cueNumber === 1 && c1?.cueNumber === 2,
      `id=${c0?.id} cueNumbers=${c0?.cueNumber},${c1?.cueNumber}`)
    check('uniform project reports styleVaries:false', styled.json?.data?.styleVaries === false, String(styled.json?.data?.styleVaries))

    // Diverge ONE cue, exactly as a GUI hand-edit would, and require detection.
    const proj = JSON.parse(readFileSync(moj, 'utf-8'))
    proj.editing.subtitles[1].textColorHex = '#FF0000'
    const moj2 = join(work, 'style-read-varied.mojioko')
    writeFileSync(moj2, JSON.stringify(proj), 'utf-8')
    const varied = cli(['read_subtitle', moj2, '--with-style'], 30000)
    const colors = (varied.json?.data?.cues ?? []).map((c) => c.style?.textColorHex)
    check('one hand-edited cue → styleVaries:true and only THAT cue differs',
      varied.json?.data?.styleVaries === true && colors[0] === '#FFFFFF' && colors[1] === '#FF0000',
      `varies=${varied.json?.data?.styleVaries} colors=${JSON.stringify(colors)}`)
  }


  // REQ-0468 — PREVIEW == BURN placement gate.  With the SAME placement flags
  // (--position bottom --margin-v <v>), the caption must land at the SAME Y in an
  // export_frame still and in a frame pulled from the burn output.  Both now run
  // the shared `resolvePlacementAndLayout`, so this fails the moment a placement
  // arg is added to one command but not the other.  Solid-colour clip so the
  // white caption isolates cleanly (flat bg → burn re-encode is near-lossless).
  {
    const clip = join(work, 'parity.mp4')
    makeSolidClip(clip, '1280x720', 'navy')
    const srt = join(work, 'parity.srt')
    writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,000\nPARITY\n', 'utf-8')
    const T = '1.0'
    const efPng = join(work, 'parity-ef.png')
    const burnMp4 = join(work, 'parity-burn.mp4')
    const bfPng = join(work, 'parity-burn-frame.png')
    const posArgs = ['--position', 'bottom', '--margin-v', '200']
    const ef = cli(['export_frame', clip, srt, '-o', efPng, '--time', T, ...posArgs], 60000)
    const bn = cli(['burn', clip, srt, '-o', burnMp4, ...posArgs], 120000)
    check('preview==burn: export_frame + burn both exit 0', ef.code === 0 && bn.code === 0, `${ef.code}/${bn.code}`)
    spawnSync(FFMPEG, ['-y', '-ss', T, '-i', burnMp4, '-frames:v', '1', bfPng], { encoding: 'utf-8' })
    const yEf = whiteCaptionCenterY(efPng)
    const yBf = whiteCaptionCenterY(bfPng)
    check('preview==burn: caption is present in both frames', yEf.count > 500 && yBf.count > 500, `efPx=${yEf.count} bfPx=${yBf.count}`)
    check('preview==burn: caption Y matches within 8px (placement identical)',
      Number.isFinite(yEf.centerY) && Number.isFinite(yBf.centerY) && Math.abs(yEf.centerY - yBf.centerY) <= 8,
      `ef.centerY=${yEf.centerY} burn.centerY=${yBf.centerY} Δ=${Math.abs(yEf.centerY - yBf.centerY)}`)
  }

  // REQ-0467 §2 — headless .mcpb export.  Same launch spec + manifest the GUI
  // button writes; result carries path/appVersion/launchSpecRevision/proxyExists.
  {
    const mcpb = join(work, 'mojioko.mcpb')
    const ex = cli(['export-mcpb', '-o', mcpb], 30000)
    const d = ex.json?.data
    check('export-mcpb exits 0 + writes a .mcpb file',
      ex.code === 0 && existsSync(mcpb) && d?.path === mcpb, `code=${ex.code}`)
    check('export-mcpb result has appVersion/launchSpecRevision/proxyExists',
      typeof d?.appVersion === 'string' && typeof d?.launchSpecRevision === 'number' && typeof d?.proxyExists === 'boolean',
      `rev=${d?.launchSpecRevision} proxyExists=${d?.proxyExists}`)
    // The bundle is a ZIP with manifest.json at its root (PK.. signature).
    const isZip = existsSync(mcpb) && readFileSync(mcpb).subarray(0, 2).toString('latin1') === 'PK'
    check('export-mcpb output is a ZIP (.mcpb envelope)', isZip)
    // Overwrite guard (REQ-0457 D13): a second write without --overwrite refuses.
    const ex2 = cli(['export-mcpb', '-o', mcpb], 20000)
    check('export-mcpb refuses to overwrite (OUTPUT_EXISTS / exit 8)', ex2.code === 8 && ex2.json?.code === 'OUTPUT_EXISTS', `${ex2.code}/${ex2.json?.code}`)
    const ex3 = cli(['export-mcpb', '-o', mcpb, '--overwrite'], 20000)
    check('export-mcpb --overwrite proceeds', ex3.code === 0)
  }

  // 4) agent loop — only if the box is ready (avoids a multi-GB download here).
  if (st.json?.data?.ready) {
    const sizes = ['640x360', '1280x720']
    for (let i = 0; i < sizes.length; i++) {
      const clip = join(work, `clip${i}.mp4`)
      const out = join(work, `out${i}.mp4`)
      makeClip(clip, sizes[i])
      const run = cli(['run', clip, '--burn', '-o', out], 300000)
      check(`run --burn #${i} exits 0`, run.code === 0, `code=${run.code}`)
      check(`run --burn #${i} stages transcribe+burn`, JSON.stringify(run.json?.data?.stages) === JSON.stringify(['transcribe', 'burn']))
      check(`run --burn #${i} produced a video`, existsSync(out) && probeWH(out).includes(','), probeWH(out))
      // REQ-0457 A2 — run transcribes burn details + subtitleStyle into its JSON.
      if (i === 0) {
        check('run result has burn details (resolution/encoder/overflow) + subtitleStyle',
          !!run.json?.data?.resolution && !!run.json?.data?.encoder && !!run.json?.data?.overflow && !!run.json?.data?.subtitleStyle,
          `res=${JSON.stringify(run.json?.data?.resolution)}`)
        check('run result has A3 signals (hasWordTimestamps present)', run.json?.data && 'hasWordTimestamps' in run.json.data)
      }
    }

    // REQ-0457 A4 — export_frame renders a real still (agent visual check).
    const efClip = join(work, 'ef.mp4')
    makeClip(efClip, '640x360')
    const efSrt = join(work, 'ef.srt')
    writeFileSync(efSrt, '1\n00:00:00,000 --> 00:00:02,000\nexport_frame regression cue\n', 'utf-8')
    const efPng = join(work, 'ef.png')
    const ef = cli(['export_frame', efClip, efSrt, '-o', efPng, '--time', '1.0'], 60000)
    check('export_frame exits 0', ef.code === 0, `code=${ef.code}/${ef.json?.code || ''}`)
    check('export_frame produced a PNG (real pixels)', existsSync(efPng) && probeWH(efPng) === '640,360', probeWH(efPng))
    check('export_frame reports cueVisible + sizeBytes', ef.json?.data?.cueVisible === true && ef.json?.data?.sizeBytes > 0)

    // REQ-0457 Phase C — probe / read_subtitle / edit_subtitle / convert.
    const pr = cli(['probe', efClip], 30000)
    check('probe returns dims + fps + audio', pr.code === 0 && pr.json?.data?.width === 640 && pr.json?.data?.height === 360 && typeof pr.json?.data?.fps === 'number', `${pr.json?.data?.width}x${pr.json?.data?.height}`)
    const rd = cli(['read_subtitle', efSrt], 30000)
    check('read_subtitle returns cues', rd.code === 0 && rd.json?.data?.cueCount === 1 && !!rd.json?.data?.cues?.[0]?.text)
    const edited = join(work, 'edited.srt')
    const ed = cli(['edit_subtitle', efSrt, '-o', edited, '--index', '0', '--text', 'corrected cue'], 30000)
    const rd2 = cli(['read_subtitle', edited], 30000)
    check('edit_subtitle replaces cue text', ed.code === 0 && rd2.json?.data?.cues?.[0]?.text === 'corrected cue', rd2.json?.data?.cues?.[0]?.text)
    const cvMoj = join(work, 'conv.mojioko')
    const cv = cli(['convert', edited, '-o', cvMoj, '--video', efClip], 30000)
    check('convert srt→.mojioko round-trips the cue', cv.code === 0 && existsSync(cvMoj) && cli(['read_subtitle', cvMoj], 30000).json?.data?.cues?.[0]?.text === 'corrected cue')

    // REQ-0457 Phase D — D11 run --subtitle skips transcribe; D13 overwrite guard.
    const d11 = join(work, 'd11.mp4')
    const r11 = cli(['run', efClip, '--subtitle', efSrt, '--burn', '-o', d11], 120000)
    check('run --subtitle skips transcribe (stages=subtitle,burn)', r11.code === 0 && JSON.stringify(r11.json?.data?.stages) === JSON.stringify(['subtitle', 'burn']) && existsSync(d11), JSON.stringify(r11.json?.data?.stages))
    const d13a = cli(['export_frame', efClip, efSrt, '-o', efPng, '--time', '1.0'], 30000)
    check('D13 refuses to overwrite (OUTPUT_EXISTS / exit 8)', d13a.code === 8 && d13a.json?.code === 'OUTPUT_EXISTS', `${d13a.code}/${d13a.json?.code}`)
    const d13b = cli(['export_frame', efClip, efSrt, '-o', efPng, '--time', '1.0', '--overwrite'], 30000)
    check('D13 --overwrite proceeds', d13b.code === 0)

    // REQ-0457 Phase E — burn --dry-run reports overflow without encoding (no -o).
    const dry = cli(['burn', efClip, efSrt, '--dry-run'], 30000)
    check('burn --dry-run returns overflow judgement, no encode', dry.code === 0 && dry.json?.data?.dryRun === true && !!dry.json?.data?.overflow)
  } else {
    log('NOTE: status.ready=false — skipping transcribe/burn loop. Blockers:')
    for (const b of st.json?.data?.blockers || []) log(`  - ${b.what}: ${b.command}`)
  }
} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* best-effort */ }
}

log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
