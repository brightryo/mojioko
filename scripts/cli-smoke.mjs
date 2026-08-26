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
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
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
function cli(args, timeoutMs = 300000, extraEnv = {}) {
  const r = spawnSync(ELECTRON, ['.', ...args], {
    cwd: ROOT,
    timeout: timeoutMs,
    encoding: 'utf-8',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ...extraEnv },
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
// REQ-0531 — `durationSec` is a parameter (default 2, so every existing caller
// is unchanged) because a cut gate needs a clip long enough to hold a cut plus
// material on both sides of it.
function makeSolidClip(path, size, color = 'navy', durationSec = 2) {
  spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:rate=30:duration=${durationSec}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSec}`, '-c:v', 'h264_mf', '-c:a', 'aac', '-shortest', path], { encoding: 'utf-8' })
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

/** SRT line terminator (the format's spec is CRLF). */
const CRLF = String.fromCharCode(13, 10)

/** SHA-256 of a file, for "is this the same image" assertions. */
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
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
  // ★ REQ-0516 §2 — the Whisper model contract, WITHOUT assuming what this
  // machine happens to have downloaded.
  //
  // The contract `tools use whisper --model <id>` implements has two halves,
  // and they are different errors on purpose (src/main/cli/commands/tools.ts):
  //
  //   - an id that is not a known model      → USAGE / exit 2   ("no such model")
  //   - a known id that is not installed     → MODEL_NOT_FOUND / exit 5 + remedy
  //
  // This assertion used to hardcode `--model large-v3` and assume it was NOT
  // installed.  On a machine that has downloaded it — the owner's, since
  // REQ-0514 — the smoke failed for a reason that had nothing to do with the
  // build.  Same family as the REQ-0511 audit: an assertion that encodes the
  // author's environment.
  //
  // So the not-installed model is now DISCOVERED from `tools list`, never
  // named here.  Swapping in a different hardcoded id would only move the
  // problem to whoever downloads that one next.
  const toolsList = cli(['tools', 'list', '--json'], 60000)
  const whisperModels = toolsList.json?.data?.whisperModels?.models ?? []
  check('tools list --json reports the whisper model inventory',
    Array.isArray(whisperModels) && whisperModels.length > 0,
    `${whisperModels.length} models`)

  // Half 1 — always reachable, on every machine, whatever is installed.
  // This is the half that distinguishes the two errors, and it had no test.
  const bogus = cli(['tools', 'use', 'whisper', '--model', 'no-such-model-req0516'], 40000)
  check('unknown model id → USAGE / exit 2 (NOT MODEL_NOT_FOUND)',
    bogus.code === 2 && bogus.json?.code === 'USAGE',
    `${bogus.code}/${bogus.json?.code}`)

  // Half 2 — needs a known model that is genuinely absent, so it runs only
  // when this machine has one.  On a fully-downloaded machine there is no
  // input for it; rather than fake the coverage, assert the complementary
  // deterministic fact (an installed model IS selectable) and say out loud
  // which branch ran, so the gap is visible in the log instead of silent.
  // `status` is a THREE-value enum — `not-installed` | `installed` | `active`
  // (src/main/ipc/transcription.ts:94-98).  Test for the absent value
  // explicitly: `!== 'installed'` also matches the ACTIVE model, which is
  // installed, and would send this assertion after a model that is present.
  const absent = whisperModels.find((m) => m.status === 'not-installed')
  if (absent) {
    const notInstalled = cli(['tools', 'use', 'whisper', '--model', absent.id], 40000)
    check(`uninstalled model "${absent.id}" → MODEL_NOT_FOUND / exit 5 + remedy`,
      notInstalled.code === 5 && notInstalled.json?.code === 'MODEL_NOT_FOUND' && !!notInstalled.json?.remedy,
      notInstalled.json?.remedy || '')
  } else {
    // ★ Deliberately assert NOTHING here, and say so.
    //
    // The obvious filler — "an installed model is selectable" — would run
    // `tools use`, which WRITES `settings.activeModelId`.  A smoke test must
    // not mutate the developer's real settings: doing exactly that during
    // REQ-0516 switched the owner's active model out from under them and took
    // eight later `run --burn` assertions down with it.  There is no
    // read-only way to reach the MODEL_NOT_FOUND branch on a machine where
    // every known model is present, so the honest outcome is a visible gap
    // rather than a fake green.
    console.log(`  NOTE  every known Whisper model is installed here, so the `
      + `MODEL_NOT_FOUND branch had no input and was NOT exercised this run. `
      + `It runs on any machine missing a model (fresh checkout, CI). Making it `
      + `deterministic everywhere needs a models-dir override in production `
      + `paths — see RES-0516 §2.`)
  }

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

    // REQ-0508 §3 — FONT TIER gate, in REAL PIXELS, BOTH SIDES.
    //
    // RES-0507 proved the leak here: a free-tier `export_frame` drew Anton.
    // The two sides are not optional. Checking only "free does not draw Anton"
    // stays green if the paid tier breaks too (e.g. someone hard-codes Noto),
    // which would delete the feature being sold rather than protect it.
    //
    // ★ The warning is NOT the gate. While building this, the enforcement was
    // removed on purpose and `FONT_TIER_SUBSTITUTED` still appeared in the
    // response — the CLI derives the warning from the policy independently of
    // the render. A warning-only assertion would have passed on a build that
    // renders the paid font. Hence: pixels, and the SHA.
    const tierClip = makeClipFor('tier.mp4', '1280x720')
    const tierSrt = join(work, 'tier.srt')
    writeFileSync(tierSrt, ['1', '00:00:00,200 --> 00:00:01,800', 'HAMBURGEFONS', '', ''].join(CRLF), 'utf-8')
    const tierBase = join(work, 'tier.mojioko')
    const cvTier = cli(['convert', tierSrt, '-o', tierBase, '--video', tierClip], 30000)
    const PAID_FONT = 'anton'
    const SUBSTITUTE = 'noto-sans-jp-regular'
    // The 12 paid families are DOWNLOADED, not bundled (RES-0507 §2.1), so a
    // machine without them cannot exercise the paid side. Skip loudly rather
    // than pass quietly — a silently-skipped tier gate is the failure this
    // whole sequence of REQs is about.
    const paidTtf = join(process.env.APPDATA || '', 'MOJIOKO', 'fonts', PAID_FONT)
    if (!cvTier.code === 0 || !existsSync(tierBase)) {
      check('REQ-0508 fixture built', false)
    } else if (!existsSync(paidTtf)) {
      log(`NOTE: REQ-0508 font tier gate SKIPPED — ${PAID_FONT} is not installed at ${paidTtf}.`)
      log('      (Install it from the paid GUI, or drop the TTF there, to run the two-sided pixel check.)')
    } else {
      const withFont = (id, name) => {
        const j = JSON.parse(readFileSync(tierBase, 'utf-8'))
        for (const c of j.editing.subtitles) { c.fontId = id; c.fontSizePx = 96 }
        const out = join(work, name)
        writeFileSync(out, JSON.stringify(j), 'utf-8')
        return out
      }
      const projPaidFont = withFont(PAID_FONT, 'tier-paid-font.mojioko')
      const projSubstitute = withFont(SUBSTITUTE, 'tier-noto.mojioko')

      const shot = (proj, tier, name) => {
        const png = join(work, name)
        const r = cli(['export_frame', tierClip, proj, '-o', png, '--time', '1.0'], 60000, { MOJIOKO_FORCE_TIER: tier })
        return { png, r, sha: existsSync(png) ? sha256(png) : '', ink: existsSync(png) ? inkStats(png) : null }
      }
      const free = shot(projPaidFont, 'free', 'tier-free.png')
      const paid = shot(projPaidFont, 'paid', 'tier-paid.png')
      // The reference: what the free tier SHOULD look like, rendered by asking
      // for the substitute directly. Equality with this is a stronger claim
      // than "different from paid" — it names the font that was drawn.
      const ref = shot(projSubstitute, 'free', 'tier-ref.png')

      check('REQ-0508 all three tier renders succeeded', free.r.code === 0 && paid.r.code === 0 && ref.r.code === 0,
        `${free.r.code}/${paid.r.code}/${ref.r.code}`)
      check('REQ-0508 FREE tier renders the SUBSTITUTE, byte-identical to asking for Noto directly',
        free.sha === ref.sha, `free=${free.sha.slice(0, 12)} ref=${ref.sha.slice(0, 12)}`)
      check('REQ-0508 PAID tier still renders the paid font (the other side of the gate)',
        paid.sha !== ref.sha, `paid=${paid.sha.slice(0, 12)} ref=${ref.sha.slice(0, 12)}`)
      // Geometry, so a future change that swaps fonts but happens to collide on
      // a hash still trips: Anton is markedly narrower than Noto at the same
      // point size (RES-0507 measured 333px vs 539px on its fixture).
      check('REQ-0508 the paid face is geometrically different (not just a different file)',
        paid.ink && free.ink && Math.abs(paid.ink.w - free.ink.w) > 50,
        `paidW=${paid.ink?.w} freeW=${free.ink?.w}`)
      const codes = (r) => (r.json?.warnings || []).map((w) => w.code)
      check('REQ-0508 free tier WARNS about the substitution',
        codes(free.r).includes('FONT_TIER_SUBSTITUTED'), codes(free.r).join(','))
      check('REQ-0508 paid tier does NOT warn', !codes(paid.r).includes('FONT_TIER_SUBSTITUTED'), codes(paid.r).join(','))
      check('REQ-0508 free tier + a BUNDLED font does not warn (the warning is not always-on)',
        !codes(ref.r).includes('FONT_TIER_SUBSTITUTED'), codes(ref.r).join(','))
      // §2-4 — the reported enforcement point must match the behaviour above.
      const tierStatus = cli(['status'], 60000, { MOJIOKO_FORCE_TIER: 'free' }).json?.data?.tier
      check('REQ-0508 status reports tier=free and fontEnforcement=render-path',
        tierStatus?.tier === 'free' && tierStatus?.fontEnforcement === 'render-path', JSON.stringify(tierStatus))

      // REQ-0509 §3 — a MISSING font file must cost that cue its typeface, not
      // the whole render. Measured before the fix: `BURN_FAILED`, exit 7, no
      // output file, from `stageFontsDir`'s copyFile ENOENT.
      //
      // Creating the condition needs a font that is genuinely absent, and this
      // machine has all of them, so the TTF is renamed IN PLACE and restored in
      // a `finally`. In place (not moved to a temp dir) so that a hard kill
      // between the two leaves an obviously-named sibling next to the original
      // rather than a file somewhere the user will never look — and the block
      // below cleans up such a leftover before it starts. `%APPDATA%` cannot be
      // redirected for this: Electron reads the user-data path from the OS, not
      // from the environment (measured — setting APPDATA changes nothing).
      const paidTtfDir = paidTtf
      const ttfName = existsSync(paidTtfDir)
        ? readdirSync(paidTtfDir).find((n) => n.toLowerCase().endsWith('.ttf'))
        : undefined
      if (!ttfName) {
        log(`NOTE: REQ-0509 missing-font gate SKIPPED — no .ttf under ${paidTtfDir}.`)
      } else {
        const livePath = join(paidTtfDir, ttfName)
        const hiddenPath = livePath + '.req0509-hidden'
        // Leftover from an earlier interrupted run.
        if (existsSync(hiddenPath) && !existsSync(livePath)) renameSync(hiddenPath, livePath)
        const sizeBefore = statSync(livePath).size
        try {
          renameSync(livePath, hiddenPath)
          // PAID tier throughout: the tier substitution would otherwise mask the
          // missing file and this would test REQ-0508 again instead.
          const gone = shot(projPaidFont, 'paid', 'missing-font.png')
          const codesGone = (gone.r.json?.warnings || []).map((w) => w.code)
          check('REQ-0509 a missing font no longer kills the render (was BURN_FAILED / exit 7)',
            gone.r.code === 0 && existsSync(gone.png), `exit=${gone.r.code}`)
          check('REQ-0509 it warns FONT_UNAVAILABLE', codesGone.includes('FONT_UNAVAILABLE'), codesGone.join(','))
          check('REQ-0509 and NOT the tier warning — the cause decides the remedy',
            !codesGone.includes('FONT_TIER_SUBSTITUTED'), codesGone.join(','))
          check('REQ-0509 the remedy tells the user to download it (not to buy anything)',
            /ダウンロード/.test(JSON.stringify(gone.r.json?.warnings || [])), '')
          // The substitute is DEFAULT_FONT_ID (SemiBold) — deliberately NOT the
          // weight-matched Regular the TIER path uses (REQ-0508 §1-2). Pixels,
          // because the warning fires whether or not the render obeys it.
          const semibold = shot(withFont('noto-sans-jp-semibold', 'tier-semibold.mojioko'), 'paid', 'missing-ref.png')
          check('REQ-0509 the substitute is Noto SemiBold, byte-identical to asking for it directly',
            gone.sha === semibold.sha, `missing=${gone.sha.slice(0, 12)} semibold=${semibold.sha.slice(0, 12)}`)
          check('REQ-0509 and NOT the tier path\'s weight-matched Regular',
            gone.sha !== free.sha, `missing=${gone.sha.slice(0, 12)} tierFree=${free.sha.slice(0, 12)}`)
        } finally {
          if (existsSync(hiddenPath)) renameSync(hiddenPath, livePath)
        }
        // Never leave the user's font set worse than we found it. This is an
        // assertion, not a hope: a silent restore failure would take a font
        // away permanently.
        check('REQ-0509 the borrowed font file was restored intact',
          existsSync(livePath) && !existsSync(hiddenPath) && statSync(livePath).size === sizeBefore,
          `${ttfName} ${existsSync(livePath) ? statSync(livePath).size : 'MISSING'} (was ${sizeBefore})`)
      }
    }

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
    // REQ-0506 §2-1 — every check built on this MUST also assert `code === 0`.
    // `?? []` means a crashed invocation yields an empty code list, so a
    // "warning must NOT appear" check would read as green on a hard failure.
    const warnCodesOf = (...flags) => {
      const r = cli(['burn', s2clip, s2srt, '--dry-run', ...flags], 20000)
      return { code: r.code, codes: (r.json?.warnings ?? []).map((w) => w.code) }
    }
    const wBoxNoBorder = warnCodesOf('--background', 'on', '--outline', '0')
    check('background box + outline 0 → BACKGROUND_BOX_NOT_DRAWN',
      wBoxNoBorder.codes.includes('BACKGROUND_BOX_NOT_DRAWN'), JSON.stringify(wBoxNoBorder.codes))
    const wBoxOk = warnCodesOf('--background', 'on', '--outline', '2', '--shadow', '0')
    check('background box + outline 2 → NO box warning (the other half of the gate)',
      wBoxOk.code === 0 && !wBoxOk.codes.includes('BACKGROUND_BOX_NOT_DRAWN'),
      `code=${wBoxOk.code} ${JSON.stringify(wBoxOk.codes)}`)
    const wEmph = warnCodesOf('--emphasis', 'on')
    check('--emphasis on with no spans → EMPHASIS_NO_SPANS', wEmph.codes.includes('EMPHASIS_NO_SPANS'), JSON.stringify(wEmph.codes))
    const wIgnored = warnCodesOf('--karaoke', 'off', '--karaoke-color', '#FF00FF')
    check('--karaoke-color with karaoke off → KARAOKE_FLAGS_WITHOUT_KARAOKE',
      wIgnored.codes.includes('KARAOKE_FLAGS_WITHOUT_KARAOKE'), JSON.stringify(wIgnored.codes))
    const wIgnoredOff = warnCodesOf('--karaoke', 'on', '--karaoke-color', '#FF00FF')
    check('--karaoke-color with karaoke on → NO ignored-flag warning',
      wIgnoredOff.code === 0 && !wIgnoredOff.codes.includes('KARAOKE_FLAGS_WITHOUT_KARAOKE'),
      `code=${wIgnoredOff.code} ${JSON.stringify(wIgnoredOff.codes)}`)
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
        wNoPin.code === 0 && !(wNoPin.json?.warnings ?? []).some((w) => w.code === 'PRESET_CLEARED_POSITION'),
        `code=${wNoPin.code} ${JSON.stringify((wNoPin.json?.warnings ?? []).map((w) => w.code))}`)
      const wNoStyle = cli(['burn', s2clip, pinned, '--dry-run'], 40000)
      check('pinned cues WITHOUT --style do not warn',
        wNoStyle.code === 0 && !(wNoStyle.json?.warnings ?? []).some((w) => w.code === 'PRESET_CLEARED_POSITION'),
        `code=${wNoStyle.code} ${JSON.stringify((wNoStyle.json?.warnings ?? []).map((w) => w.code))}`)
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


  // REQ-0504 — style presets from the CLI: list / show / save / delete, and the
  // round trip that makes them a bridge rather than a one-way door.
  //
  // NOTE: this writes to the REAL settings.json (that IS the shared store — a
  // preset the GUI cannot see would be pointless). The name is namespaced, the
  // preset is deleted at the end, and the count is asserted back to its
  // starting value so a failure here cannot quietly leave residue behind.
  {
    const before = cli(['preset', 'list'], 30000)
    const startCount = before.json?.data?.count
    check('preset list works and reports a count', before.code === 0 && typeof startCount === 'number', `count=${startCount}`)

    const pclip = makeClipFor('preset.mp4', '1280x720')
    const psrt = join(work, 'preset.srt')
    writeFileSync(psrt, '1\n00:00:00,200 --> 00:00:02,000\npreset probe\n', 'utf-8')
    const pmoj = join(work, 'preset.mojioko')
    cli(['convert', psrt, '-o', pmoj, '--video', pclip], 40000)

    const NAME = 'CLI Smoke Preset (REQ-0504)'
    const FLAGS = ['--karaoke', 'off', '--text-color', '#FF00FF', '--font-size', '90', '--shadow', '0']

    // SRT must be refused — it holds no style, so it could only mint defaults.
    const fromSrt = cli(['preset', 'save', NAME, '--from', psrt], 30000)
    check('preset save --from an SRT is refused (no style to capture)',
      fromSrt.code === 4 && fromSrt.json?.code === 'UNSUPPORTED_FORMAT', `${fromSrt.code}/${fromSrt.json?.code}`)

    const saved = cli(['preset', 'save', NAME, '--from', pmoj, ...FLAGS, '--overwrite'], 40000)

    /*
     * ★ REQ-0533 — the app being OPEN is not a build failure.
     *
     * `preset save` / `delete` refuse while MOJIOKO holds the single-instance
     * lock, because `stylePresets` is renderer-owned ('incoming-wins') and the
     * app's next settings save would silently discard a CLI write. That refusal
     * is correct. What was wrong is that this block asserted straight through
     * it, so the whole preset section went red — SIX checks — whenever the
     * owner happened to have the app running. It was found exactly that way:
     * the owner had MOJIOKO open from their manual A–E pass, and a smoke that
     * had been green an hour earlier reported six failures that had nothing to
     * do with any code change.
     *
     * This is the third recurrence of the CLAUDE.md §18 rule
     * ("環境を仮定したアサーションを書かない" — REQ-0511, REQ-0516 ×3). The
     * rule's other half applies too: do NOT go quietly green. The skip is
     * printed, and it is keyed off `detail.reason` (REQ-0533) rather than a
     * localised message, so a real USAGE bug here still fails.
     */
    const appRunning = saved.json?.detail?.reason === 'app-running'
    if (appRunning) {
      // Not a PASS. A skipped check that prints "PASS" is a lie of exactly the
      // kind this project keeps removing, so the checks below are not emitted
      // at all — the reason is, and it names what is left uncovered.
      log('  SKIP  preset WRITE checks — MOJIOKO is running and holds the settings lock.')
      log('        Uncovered: save / show-after-save / list-after-save / duplicate /')
      log('        --style round-trip / delete.  Close the app and re-run to cover them.')
      log('        (read-only preset checks and the no-residue check still ran)')
    } else {
      check('preset save succeeds and echoes the resolved style',
        saved.code === 0 && saved.json?.data?.style?.fontSizePx === 90 && saved.json?.data?.style?.textColorHex === '#FF00FF',
        `code=${saved.code} fs=${saved.json?.data?.style?.fontSizePx}`)

      const shown = cli(['preset', 'show', NAME], 30000)
      check('a CLI-saved preset is readable back by name', shown.code === 0 && shown.json?.data?.name === NAME)
      const listed = cli(['preset', 'list'], 30000)
      check('a CLI-saved preset appears in list (this is what the GUI reads)',
        (listed.json?.data?.presets ?? []).some((p) => p.name === NAME))

      // Saving the same name again must refuse, like every other output command.
      const dup = cli(['preset', 'save', NAME, '--from', pmoj], 30000)
      check('duplicate preset save → OUTPUT_EXISTS / exit 8',
        dup.code === 8 && dup.json?.code === 'OUTPUT_EXISTS', `${dup.code}/${dup.json?.code}`)
    }

    // ★ ROUND TRIP in real pixels: the saved preset must reproduce the look
    // that the equivalent flags produce. Both halves measured, so a preset that
    // renders nothing cannot pass by accident.
    const pFlags = join(work, 'preset-flags.png')
    const pStyle = join(work, 'preset-style.png')
    cli(['export_frame', pclip, pmoj, '-o', pFlags, '--time', '1.0', ...FLAGS], 60000)
    const MAGENTA = [0xff, 0x00, 0xff]
    const mFlags = countColor(pFlags, MAGENTA)
    // The flag half does not need the preset, so it runs either way and keeps
    // its value as a control.
    check('the flag-rendered frame actually has the colour (control)', mFlags > 500, `magenta=${mFlags}`)
    if (!appRunning) {
      cli(['export_frame', pclip, pmoj, '-o', pStyle, '--time', '1.0', '--style', NAME], 60000)
      const mStyle = countColor(pStyle, MAGENTA)
      check('--style <saved preset> reproduces the flag-rendered look (real pixels)',
        mStyle > 500 && Math.abs(mFlags - mStyle) <= Math.max(50, mFlags * 0.02), `flags=${mFlags} preset=${mStyle}`)
    }

    // Deleting something absent must not report success.
    const delMissing = cli(['preset', 'delete', 'no-such-preset-req-0504'], 30000)
    // REQ-0533 — `requireLock` ALSO raises USAGE, so the exit code alone cannot
    // tell "no such preset" from "the app is open". `runDelete` checks
    // existence BEFORE taking the lock, so the not-found path is reachable
    // either way and must NOT carry the lock's reason — which is what pins this
    // check to the behaviour it is named after.
    check('deleting a missing preset → USAGE (never a silent success)',
      delMissing.code === 2 && delMissing.json?.code === 'USAGE' &&
        delMissing.json?.detail?.reason !== 'app-running',
      `${delMissing.code}/${delMissing.json?.code} reason=${delMissing.json?.detail?.reason}`)

    if (!appRunning) {
      const del = cli(['preset', 'delete', NAME], 30000)
      check('preset delete removes it', del.code === 0 && del.json?.data?.deleted === NAME)
    }
    const after = cli(['preset', 'list'], 30000)
    // Residue check stays live in BOTH cases: if the app is running nothing was
    // written, so the count must still be unchanged.  That is what makes the
    // skip safe — it can never leave a preset behind in the owner's settings.
    check('preset count is back to where it started (no residue)',
      after.json?.data?.count === startCount, `${startCount} -> ${after.json?.data?.count}`)
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
    // ★ REQ-0517 §1-3 — an explicit `--track` for a track the file does not
    // have is REFUSED, not quietly redirected to another one.  Env-independent:
    // the fixture always has exactly one audio stream, so track 9 never exists
    // on any machine, whatever the caller's `defaultAudioTrackIndex` is.
    //
    // §1-5 — the `--track 1` pins added in REQ-0516 STAY.  The rounding added
    // in REQ-0517 would keep them passing without it, but pinning the track
    // states what the fixture actually is and keeps these assertions
    // independent of the runner's settings; the rounding itself is covered by
    // `tests/unit/track-pick-req-0517.test.ts` and by the end-to-end runs in
    // RES-0517 §1-5.  This assertion is the one thing the smoke can check
    // about tracks that no machine's settings can change.
    const trackClip = join(work, 'track-probe.mp4')
    makeClip(trackClip, '320x180')
    const badTrack = cli(['transcribe', trackClip, '-o', join(work, 'bad-track.mojioko'), '--track', '9'], 60000)
    check('explicit --track for a track the file lacks → USAGE / exit 2',
      badTrack.code === 2 && badTrack.json?.code === 'USAGE',
      `${badTrack.code}/${badTrack.json?.code}`)

    const sizes = ['640x360', '1280x720']
    for (let i = 0; i < sizes.length; i++) {
      const clip = join(work, `clip${i}.mp4`)
      const out = join(work, `out${i}.mp4`)
      makeClip(clip, sizes[i])
      // ★ REQ-0516 §2 — `--track 1` is a FACT about the fixture, not a
      // workaround: `makeClip` writes exactly one audio stream, so track 1 is
      // the only one that exists.  Without it the run inherits
      // `settings.defaultAudioTrackIndex` from whoever is running the smoke
      // (`src/main/cli/commands/transcribe.ts:97`), and a developer who has
      // ever picked track 2 in Settings gets `-map 0:a:1` against a one-track
      // clip — eight assertions here failed for that reason during REQ-0516,
      // with a raw ffmpeg message that never mentions the track.  Second
      // instance of the same family as the model assertion above.
      // The unclamped CLI default itself is reported in RES-0516 §2, not fixed
      // here.
      const run = cli(['run', clip, '--burn', '--track', '1', '-o', out], 300000)
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

    /*
     * REQ-0529 — cues past the end of the video are reported headlessly.
     *
     * The fixture clip is 2 s (`makeSolidClip`), stated explicitly rather than
     * assumed (CLAUDE.md §18 "環境を仮定したアサーションを書かない"): the cue
     * times below are chosen against that known length, and the assertions read
     * `videoDurationSec` back out of the result instead of hardcoding 2.
     *
     * Three cases, because the warning makes two DIFFERENT claims and both have
     * to be true:
     *   - in-range  → silent (a warning that always fires is not read)
     *   - overhangs → "truncated": libass draws it up to the last frame
     *   - past end  → "not shown": nothing is drawn at all
     */
    /*
     * A SOLID clip of its own, not the shared `efClip`. `efClip` is `testsrc`,
     * whose colour bars contain large white areas — measuring "near-white
     * pixels" there reads the PATTERN, not the caption, and the first version of
     * this check failed because of it (the "absent" cue scored 0.108 of pure
     * background). REQ-0468 hit the same wall and drew the same conclusion.
     * On navy, white pixels can only be caption ink.
     */
    const bdClip = makeClipFor('bd.mp4', '640x360')   // solid navy, 2 s
    const bdBase = join(work, 'bd-base.mojioko')
    cli(['convert', efSrt, '-o', bdBase, '--video', bdClip], 40000)
    const bdVariant = (name, mutate) => {
      const j = JSON.parse(readFileSync(bdBase, 'utf-8'))
      mutate(j.editing.subtitles)
      const p = join(work, name)
      writeFileSync(p, JSON.stringify(j), 'utf-8')
      return p
    }
    const bdIn = bdVariant('bd-in.mojioko', (cues) => { for (const c of cues) { c.startSec = 0.2; c.endSec = 1.0 } })
    const bdOver = bdVariant('bd-over.mojioko', (cues) => { for (const c of cues) { c.startSec = 0.5; c.endSec = 30 } })
    const bdPast = bdVariant('bd-past.mojioko', (cues) => { for (const c of cues) { c.startSec = 20; c.endSec = 25 } })
    const bdWarn = (r) => (r.json?.warnings ?? []).find((w) => w.code === 'CUE_BEYOND_VIDEO_END')

    const bdInR = cli(['burn', bdClip, bdIn, '--dry-run'], 40000)
    check('REQ-0529 in-range cues produce NO beyond-duration warning',
      bdInR.code === 0 && !bdWarn(bdInR) && bdInR.json?.data?.beyondDuration?.cueCount === 0,
      JSON.stringify(bdInR.json?.data?.beyondDuration))

    const bdOverR = cli(['burn', bdClip, bdOver, '--dry-run'], 40000)
    const ow = bdWarn(bdOverR)
    check('REQ-0529 a cue overhanging the end warns as TRUNCATED (not "missing")',
      !!ow && ow.detail?.truncatedCount === 1 && ow.detail?.notShownCount === 0 && !!ow.detail?.remedy,
      JSON.stringify(ow?.detail))

    const bdPastR = cli(['burn', bdClip, bdPast, '--dry-run'], 40000)
    const pw = bdWarn(bdPastR)
    check('REQ-0529 a cue starting past the end warns as NOT SHOWN',
      !!pw && pw.detail?.notShownCount === 1 && pw.detail?.truncatedCount === 0,
      JSON.stringify(pw?.detail))

    /*
     * ★ §3-2 — the warning's CLAIM must match the output, not merely appear.
     * Burn for real and read the pixels: the fixture is a solid navy clip and
     * the caption is white, so "is the cue on screen at time t" is just "are
     * there near-white pixels". A frame near the very end must show the
     * overhanging cue (it is truncated, NOT dropped) and must be blank for the
     * one that starts past the end.
     */
    const bdOverMp4 = join(work, 'bd-over.mp4')
    const bdPastMp4 = join(work, 'bd-past.mp4')
    const rOver = cli(['burn', bdClip, bdOver, '-o', bdOverMp4], 120000)
    const rPast = cli(['burn', bdClip, bdPast, '-o', bdPastMp4], 120000)
    const whiteAt = (video, t) => {
      const raw = join(work, `bd-${String(t).replace('.', '_')}-${video.length}.rgb`)
      spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', String(t), '-i', video,
        '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw], { encoding: 'utf-8' })
      if (!existsSync(raw)) return -1
      const buf = readFileSync(raw)
      let white = 0
      for (let i = 0; i + 2 < buf.length; i += 3) if (buf[i] > 200 && buf[i + 1] > 200 && buf[i + 2] > 200) white++
      return white / (buf.length / 3)
    }
    const overLate = rOver.code === 0 ? whiteAt(bdOverMp4, 1.8) : -1
    const pastLate = rPast.code === 0 ? whiteAt(bdPastMp4, 1.8) : -1
    check('REQ-0529 §3-2 the "truncated" cue really IS drawn to the end of the video',
      overLate > 0.001, `whiteFraction@1.8s=${overLate.toFixed(4)}`)
    check('REQ-0529 §3-2 the "not shown" cue really is absent from every frame',
      pastLate === 0, `whiteFraction@1.8s=${pastLate.toFixed(4)}`)
    check('REQ-0529 the real burn carries the warning too (not just --dry-run)',
      rOver.code === 0 && !!bdWarn(rOver))

    // REQ-0529 §2-1 — `run --burn` forwards burn-stage warnings. It used to
    // pass NO warnings argument at all, so every burn warning (fonts, no-ops)
    // vanished when the same work was driven through `run`.
    const bdRunMp4 = join(work, 'bd-run.mp4')
    const rRun = cli(['run', bdClip, '--subtitle', bdOver, '--burn', '-o', bdRunMp4], 120000)
    check('REQ-0529 run --burn forwards the burn stage\'s warnings',
      rRun.code === 0 && !!bdWarn(rRun) && rRun.json?.data?.beyondDuration?.cueCount === 1,
      JSON.stringify((rRun.json?.warnings ?? []).map((w) => w.code)))

    /*
     * ══════════════════════════════════════════════════════════════════════
     * REQ-0533 §2 — the rest of "F", so none of it is left to a human.
     * ══════════════════════════════════════════════════════════════════════
     *
     * The REQ-0529 block above already covers most of it (warning fires, the
     * two counts are separated, in-range stays silent, the pixels agree, the
     * real burn carries it, `run --burn` forwards it). What was missing is
     * below.
     */

    // (1) §2-3 for the `run` path. `run --burn` was only checked for the
    // WARNING; a stage that forwards the warning while dropping the cue would
    // pass. `bdRunMp4` was burned from `bdOver`, so the truncated cue must be
    // on screen at the last frame exactly as the direct burn's was.
    const runLate = rRun.code === 0 ? whiteAt(bdRunMp4, 1.8) : -1
    check('REQ-0533 run --burn really DRAWS the truncated cue (not just warns)',
      runLate > 0.001, `whiteFraction@1.8s=${runLate.toFixed(4)}`)
    check('REQ-0533 run --burn output matches the direct burn at the same instant',
      Math.abs(runLate - overLate) < 0.02, `run=${runLate.toFixed(4)} burn=${overLate.toFixed(4)}`)

    /*
     * (2) A MIXED project. Every fixture above is homogeneous — all cues get
     * the same times — so "the two counts are separated" has only ever been
     * observed one bucket at a time. A classifier that put every affected cue
     * in whichever bucket the FIRST one landed in, or that stopped counting
     * after the first hit, passes all of them.
     *
     * Three cues, one per outcome, against the same 2 s clip:
     *   in range [0.2, 1.0]  → neither bucket
     *   overhang [0.5, 30]   → truncated
     *   past end [20, 25]    → not shown
     *
     * `cueCount` is derived as `notShown + truncated` in `cue-duration.ts`, so
     * asserting the sum would be a tautology — what is asserted is that each
     * bucket holds exactly the cue that belongs in it.
     */
    const bdMixed = bdVariant('bd-mixed.mojioko', (cues) => {
      const proto = cues[0]
      cues.length = 0
      cues.push(
        { ...proto, id: 'bd-mix-in', startSec: 0.2, endSec: 1.0 },
        { ...proto, id: 'bd-mix-over', startSec: 0.5, endSec: 30 },
        { ...proto, id: 'bd-mix-past', startSec: 20, endSec: 25 },
      )
    })
    const bdMixedR = cli(['burn', bdClip, bdMixed, '--dry-run'], 40000)
    const bdMixedD = bdMixedR.json?.data?.beyondDuration
    check('REQ-0533 a MIXED project counts each cue into its own bucket',
      bdMixedR.code === 0 && bdMixedD?.cueCount === 2 &&
        bdMixedD?.truncatedCount === 1 && bdMixedD?.notShownCount === 1,
      JSON.stringify(bdMixedD))

    /*
     * (3) ★ §3-1 NEGATIVE CONTROLS, by input perturbation — no `git checkout`,
     * nothing to rot.
     *
     * The judgement under test is a COMPARISON: "does this cue's end reach past
     * this video's duration". Two ways it can be wrong, and the existing checks
     * only catch one of them:
     *
     *   - REMOVED / never fires — caught by the positive assertions above (they
     *     go red immediately). Also pinned at unit level by
     *     `cue-beyond-video-end-req-0529.test.ts`'s "the pre-REQ-0529 path
     *     emitted nothing at all".
     *   - CONSTANT / always fires, or off by one — caught by NOTHING until now.
     *     A detector hardcoded to warn, or one written with `>=` instead of
     *     `>`, passes every assertion above.
     *
     * So: perturb the comparison's OTHER side. Same cues, a video they fit in;
     * and a cue that ends exactly ON the duration.
     */
    // (3a) The very same over-length projects, against a 35 s clip they fit in.
    // A constant detector still warns here.
    const bdLongClip = join(work, 'bd-long.mp4')
    makeSolidClip(bdLongClip, '640x360', 'navy', 35)
    const bdOverLong = cli(['burn', bdLongClip, bdOver, '--dry-run'], 40000)
    const bdPastLong = cli(['burn', bdLongClip, bdPast, '--dry-run'], 40000)
    check('REQ-0533 §3-1 NEGATIVE CONTROL: the SAME cues on a long enough clip do NOT warn',
      bdOverLong.code === 0 && !bdWarn(bdOverLong) && bdOverLong.json?.data?.beyondDuration?.cueCount === 0 &&
      bdPastLong.code === 0 && !bdWarn(bdPastLong) && bdPastLong.json?.data?.beyondDuration?.cueCount === 0,
      `over=${JSON.stringify(bdOverLong.json?.data?.beyondDuration)} past=${JSON.stringify(bdPastLong.json?.data?.beyondDuration)}`)

    // (3b) The boundary. A cue ending EXACTLY at the duration is not truncated
    // — it plays to the last frame and stops. A `>=` re-implementation flags
    // it; the shipping `>` does not. The clip's real length is read back out of
    // the result rather than assumed (CLAUDE.md §18).
    const bdDurSec = bdInR.json?.data?.beyondDuration?.videoDurationSec
    if (typeof bdDurSec === 'number' && bdDurSec > 0.5) {
      const bdEdge = bdVariant('bd-edge.mojioko', (cues) => {
        for (const c of cues) { c.startSec = Math.max(0, bdDurSec - 1); c.endSec = bdDurSec }
      })
      const bdEdgeR = cli(['burn', bdClip, bdEdge, '--dry-run'], 40000)
      check('REQ-0533 §3-1 NEGATIVE CONTROL: a cue ending EXACTLY at the duration is not flagged',
        bdEdgeR.code === 0 && !bdWarn(bdEdgeR) && bdEdgeR.json?.data?.beyondDuration?.cueCount === 0,
        `dur=${bdDurSec} ${JSON.stringify(bdEdgeR.json?.data?.beyondDuration)}`)
    } else {
      // Not silently green: say which assumption failed instead (CLAUDE.md §18).
      check('REQ-0533 §3-1 boundary control could read the video duration', false,
        `videoDurationSec=${JSON.stringify(bdDurSec)} — result shape changed?`)
    }

    /*
     * ══════════════════════════════════════════════════════════════════════
     * REQ-0531 — the still export honours `cuts`, on the EDITED axis.
     * ══════════════════════════════════════════════════════════════════════
     *
     * The claim under test: `export_frame --time t` and the frame at t of
     * `burn`'s output are the SAME PICTURE. Before this, `export_frame` never
     * read `editing.cuts`, so on a trimmed project it returned an image of a
     * moment the burned video does not contain.
     *
     * Method (REQ-0529/0530's): solid navy clip, white captions, so "which cue
     * is on screen" reduces to "how much white ink is there". The three cues
     * are given DIFFERENT lengths (1 / 8 / 4 chars) so the ink count identifies
     * WHICH one is drawn — a gate that only asked "is there ink" would pass
     * while showing the wrong caption, which is precisely the bug.
     *
     * Fixture facts, stated rather than assumed (CLAUDE.md §18):
     *   clip = 6 s, 30 fps, solid navy, ONE audio track.
     *   cut  = [2, 4) ⇒ edited duration 4 s.
     *   A "A"        [0.2, 1.8]  → edited [0.2, 1.8]   (ahead of the cut)
     *   B "BBBBBBBB" [2.2, 3.8]  → CONSUMED by the cut, must never be drawn
     *   C "CCCC"     [4.2, 5.8]  → edited [2.2, 3.8]   (after the cut)
     *
     * §3-1 — the sampled times MUST include one the cut moves. t=3.0 is that
     * time: it is source 5.0 (cue C) after the fix and source 3.0 (cue B)
     * before it. Sampling only t=1.0 would go green on the broken build.
     */
    const cutClip = join(work, 'cut.mp4')
    makeSolidClip(cutClip, '640x360', 'navy', 6)
    const cutBase = join(work, 'cut-base.mojioko')
    const convR = cli(['convert', efSrt, '-o', cutBase, '--video', cutClip], 40000)
    check('REQ-0531 fixture: convert produced a .mojioko for the 6 s clip', convR.code === 0, convR.stderr?.slice(-160))

    // One builder, two projects: identical cues, differing ONLY in whether the
    // cut list is present. That difference is the whole experiment.
    const cutProject = (name, cuts) => {
      const j = JSON.parse(readFileSync(cutBase, 'utf-8'))
      const proto = j.editing.subtitles[0]
      const mk = (id, startSec, endSec, text) => ({
        ...proto, id, startSec, endSec, text,
        fontSizePx: 40, isDeleted: false, isEdited: false,
        /*
         * ★ REQ-0544 §2 — no animation, DECLARED.
         *
         * These cues test frame selection and still/burn agreement, not
         * animation; whatever the cue's opacity is at time T, both sides must
         * report it. But `proto` inherits `animationType` from the dev
         * machine's `transcriptionDefaults`, so on a machine defaulting to a
         * 1 s blur the cue at t=2.5 is mid-entrance and BOTH sides measure
         * white=0 — which the relative comparison reads as total disagreement
         * (`rel=1.000`) and fails. Measured: perturbing the machine default to
         * blur/1 s turns "§3-1 still == burn at edited t=2.5s" red while
         * nothing about the code under test changed.
         *
         * Pinning `none` keeps these cues fully opaque for their whole life, so
         * the comparison measures what it is named after.
         */
        animationType: 'none',
        animationInEnabled: true,
        animationOutEnabled: true,
        animationDurationSec: 0.4,
        animationStartScalePercent: 70,
        animationBlurPx: 30,
        fadeDurationSec: 0,
        original: { ...(proto.original ?? proto), startSec, endSec, text },
        // `words` from the SRT prototype describe different text; drop them so
        // karaoke cannot reject the cue for a reason unrelated to this gate.
        words: undefined,
      })
      j.editing.subtitles = [
        mk('cue-a', 0.2, 1.8, 'A'),
        mk('cue-b', 2.2, 3.8, 'BBBBBBBB'),
        mk('cue-c', 4.2, 5.8, 'CCCC'),
      ]
      j.editing.cuts = cuts
      const p = join(work, name)
      writeFileSync(p, JSON.stringify(j), 'utf-8')
      return p
    }
    const CUT = [{ id: 'cut-0', startSec: 2, endSec: 4 }]
    const projCut = cutProject('cut-with.mojioko', CUT)
    /*
     * ★ §3-4 NEGATIVE CONTROL — same cues, empty cut list.
     *
     * This is the pre-REQ-0531 behaviour reproduced EXACTLY, because ignoring
     * `cuts` and having no `cuts` are the same computation: the seek is
     * `timeSec` itself, cue B is present, cue C sits at its raw times. It
     * perturbs the single judgement under test (does the still see the cut?)
     * through an INPUT, so there is no source injection to rot and no `git
     * checkout` to eat the working tree (CLAUDE.md §18).
     */
    const projNoCut = cutProject('cut-without.mojioko', [])

    const cutMp4 = join(work, 'cut-burn.mp4')
    const rCutBurn = cli(['burn', cutClip, projCut, '-o', cutMp4], 180000)
    check('REQ-0531 fixture: the trimmed burn succeeded', rCutBurn.code === 0, rCutBurn.stderr?.slice(-200))

    /** A PNG of `video` at `t`, measured with the same `inkStats` as a still. */
    const videoFramePng = (video, t, tag) => {
      const p = join(work, `f-${tag}.png`)
      spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', video, '-ss', String(t),
        '-frames:v', '1', '-c:v', 'png', p], { encoding: 'utf-8' })
      return existsSync(p) ? inkStats(p) : null
    }
    /** A still from `proj` at `t`, measured the same way. */
    const stillInk = (proj, t, tag) => {
      const p = join(work, `s-${tag}.png`)
      const r = cli(['export_frame', cutClip, proj, '-o', p, '--time', String(t)], 90000)
      return { r, stats: existsSync(p) ? inkStats(p) : null, png: p }
    }

    if (rCutBurn.code === 0) {
      // Times on exact 30 fps frame boundaries so neither side is comparing
      // across a frame edge. 1.0 is untouched by the cut (the control); 2.5 and
      // 3.0 both sit after it, where the axes diverge by the full 2 s.
      for (const [t, tag, expectCue] of [[1.0, 't10', 'A'], [2.5, 't25', 'C'], [3.0, 't30', 'C']]) {
        const burn = videoFramePng(cutMp4, t, tag)
        const still = stillInk(projCut, t, `fix-${tag}`)
        const ok = burn && still.stats && still.r.code === 0
        // h264 vs PNG-from-source differ in compression noise, so the tolerance
        // is on the ink COUNT, not on bytes. The three cues differ by 2-8x, far
        // outside this band — a wrong cue cannot pass as noise.
        const rel = ok && burn.white > 0 ? Math.abs(still.stats.white - burn.white) / burn.white : 1
        check(`REQ-0531 §3-1 still == burn at edited t=${t}s (cue ${expectCue})`,
          ok && rel < 0.15,
          `burnWhite=${burn?.white} stillWhite=${still.stats?.white} rel=${rel.toFixed(3)}`)
      }

      // ★ The negative control has to actually FAIL, or the gate above proves
      // nothing. At t=3.0 the un-cut project draws cue B (8 chars); the burn
      // draws cue C (4 chars).
      const burn30 = videoFramePng(cutMp4, 3.0, 't30')
      const pre30 = stillInk(projNoCut, 3.0, 'pre-t30')
      const preRel = burn30 && pre30.stats && burn30.white > 0
        ? Math.abs(pre30.stats.white - burn30.white) / burn30.white : 0
      check('REQ-0531 §3-4 NEGATIVE CONTROL: ignoring cuts disagrees with the burn at t=3.0',
        preRel > 0.5,
        `burnWhite=${burn30?.white} preFixWhite=${pre30.stats?.white} rel=${preRel.toFixed(3)}`)

      // A cue a cut consumed is drawn NOWHERE. Sampled across the whole edited
      // range rather than at one point: "B is absent at t=3.0" would also hold
      // if B had merely moved.
      const bWhite = pre30.stats?.white ?? 0
      let bLeak = 0
      for (const t of [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5]) {
        const s = stillInk(projCut, t, `leak-${String(t).replace('.', '_')}`)
        if (s.stats && bWhite > 0 && Math.abs(s.stats.white - bWhite) / bWhite < 0.15) bLeak++
      }
      check('REQ-0531 a cue the cut consumed is never drawn by the still', bLeak === 0,
        `frames matching cue B's ink signature=${bLeak} (B=${bWhite}px)`)
    }

    /*
     * §2-5 — the `--time` ceiling is the EDITED duration (4 s), not the file's
     * 6 s. The window [4, 6) used to be accepted and returned a frame that
     * exists nowhere in the burn.
     */
    const overCeil = cli(['export_frame', cutClip, projCut, '-o', join(work, 'over.png'), '--time', '5.0'], 60000)
    // The ceiling is REPORTED, not just enforced: a caller that hits this needs
    // to see 4 s (and the 6 s source length) to understand why.
    check('REQ-0531 §2-5 a time past the EDITED duration is rejected (USAGE)',
      overCeil.code === 2 && overCeil.json?.code === 'USAGE'
        && Math.abs((overCeil.json?.detail?.durationSec ?? 0) - 4) < 0.2
        && Math.abs((overCeil.json?.detail?.sourceDurationSec ?? 0) - 6) < 0.2,
      `code=${overCeil.code} durationSec=${overCeil.json?.detail?.durationSec} source=${overCeil.json?.detail?.sourceDurationSec}`)
    // Both sides: the same time is FINE on the untrimmed project, so this is a
    // narrower ceiling, not a blanket rejection.
    const underCeil = cli(['export_frame', cutClip, projNoCut, '-o', join(work, 'under.png'), '--time', '5.0'], 60000)
    check('REQ-0531 §2-5 the same time is still accepted without cuts', underCeil.code === 0,
      `code=${underCeil.code}`)

    /*
     * §3-2 — NO-CUTS INERTNESS. The new `cuts` plumbing must not perturb the
     * overwhelmingly common path, so a project with an EMPTY cut list and one
     * with NO cut list at all must produce byte-identical PNGs.
     */
    {
      const jNo = JSON.parse(readFileSync(projNoCut, 'utf-8'))
      delete jNo.editing.cuts
      const projAbsent = join(work, 'cut-absent.mojioko')
      writeFileSync(projAbsent, JSON.stringify(jNo), 'utf-8')
      const pA = join(work, 'inert-empty.png')
      const pB = join(work, 'inert-absent.png')
      const rA = cli(['export_frame', cutClip, projNoCut, '-o', pA, '--time', '1.0'], 60000)
      const rB = cli(['export_frame', cutClip, projAbsent, '-o', pB, '--time', '1.0'], 60000)
      check('REQ-0531 §3-2 empty cuts and absent cuts give a byte-identical still',
        rA.code === 0 && rB.code === 0 && existsSync(pA) && existsSync(pB) && sha256(pA) === sha256(pB),
        `${rA.code}/${rB.code}`)
    }

    /*
     * ★ §3(追加) — ENTRANCE-ANIMATION PHASE, which is strictly stronger than
     * frame selection.
     *
     * libass resolves `\fad` from the gap between the cue's own start and the
     * clock, so a still can extract the RIGHT frame and still draw the caption
     * at the wrong point in its entrance. Here both builds read the SAME source
     * frame — only the phase differs.
     *
     * Fixture: cut [0,2] clamps cue D's head from 1 to 2, which the burn places
     * at edited 0. With a 1 s fade, edited t=0.5 is HALF-WAY into the entrance.
     * The pre-fix pairing (raw cue times, source clock) put t=0.5 before D
     * started at all, so it drew nothing.
     */
    {
      const j = JSON.parse(readFileSync(cutBase, 'utf-8'))
      const proto = j.editing.subtitles[0]
      const d = {
        ...proto, id: 'cue-d', startSec: 1, endSec: 5, text: 'DDDD',
        fontSizePx: 40, isDeleted: false, isEdited: false, fadeDurationSec: 1,
        /*
         * ★ REQ-0544 — DECLARE the animation instead of inheriting it.
         *
         * `proto` comes from `convert`, which stamps `animationFieldsForNewCue`
         * from the DEV MACHINE's `settings.json` → `transcriptionDefaults`.  On a
         * machine whose saved default is "pop, 0.4 s, no exit" — the owner's —
         * every cue built here carries `animationType: 'pop'`, and
         * `resolveAnimation` then IGNORES `fadeDurationSec` entirely (that field
         * is only the legacy migration path, consulted when `animationType` is
         * absent).  So the 1 s fade this case is named after never existed: at
         * edited t=0.5 the 0.4 s pop had already settled and the caption was
         * fully opaque.  Measured: white 477 at t=0.5 against a 176 reference,
         * i.e. the exact inversion the assertion reports.
         *
         * CLAUDE.md §18 — the fixture's properties are STATED, not inherited.
         * These six fields are the whole animation input, so the case now means
         * the same thing on every machine regardless of what the user saved.
         * Deleting them entirely (letting `fadeDurationSec` migrate) produces
         * byte-identical stills — measured — but leaves the case one settings
         * change away from silently testing something else again.
         */
        animationType: 'fade',
        animationInEnabled: true,
        animationOutEnabled: true,
        animationDurationSec: 1,
        animationStartScalePercent: 70,
        animationBlurPx: 30,
        original: { ...(proto.original ?? proto), startSec: 1, endSec: 5, text: 'DDDD' },
        words: undefined,
      }
      j.editing.subtitles = [d]
      j.editing.cuts = [{ id: 'cut-head', startSec: 0, endSec: 2 }]
      const projFade = join(work, 'fade-cut.mojioko')
      writeFileSync(projFade, JSON.stringify(j), 'utf-8')

      const mid = stillInk(projFade, 0.5, 'fade-mid')       // 50% through the fade
      const full = stillInk(projFade, 2.0, 'fade-full')     // fade long finished
      /*
       * MEASURE `ink`, NOT `white`. A half-faded white caption composited over
       * navy lands near (128,128,192) — plainly "not the background", but NOT
       * over the r,g,b > 200 bar that `white` counts. The first version of this
       * check read `white` and scored the mid-fade frame 0, i.e. it could not
       * tell "drawn at 50% alpha" from "not drawn at all" — which is exactly
       * the distinction the gate exists to make.
       *
       * So: `ink` says the glyphs are on screen, `white` says how opaque they
       * are. Both are needed.
       */
      const midInk = mid.stats?.ink ?? -1
      const fullInk = full.stats?.ink ?? -1
      const midW = mid.stats?.white ?? -1
      const fullW = full.stats?.white ?? -1
      // Three claims, all needed. `midInk > 0` separates the fixed build from
      // the pre-fix one (which drew NOTHING at 0.5). `midW < fullW/2` proves
      // the caption is genuinely mid-fade rather than fully opaque — i.e. the
      // PHASE came from the edited axis, not merely the frame.
      check('REQ-0531 §6-2 the still draws the entrance MID-FADE at edited t=0.5s',
        midInk > 0 && fullInk > 0 && fullW > 0 && midW < fullW * 0.5,
        `midInk=${midInk} midWhite=${midW} fullInk=${fullInk} fullWhite=${fullW}`)

      // ★ NEGATIVE CONTROL for the phase, same input-perturbation shape: with
      // the cut removed, cue D starts at 1 s and edited t=0.5 is before it.
      const jNo = JSON.parse(readFileSync(projFade, 'utf-8'))
      jNo.editing.cuts = []
      const projFadeNo = join(work, 'fade-nocut.mojioko')
      writeFileSync(projFadeNo, JSON.stringify(jNo), 'utf-8')
      const preMid = stillInk(projFadeNo, 0.5, 'fade-pre')
      check('REQ-0531 §3-4 NEGATIVE CONTROL: ignoring cuts draws nothing at edited t=0.5s',
        (preMid.stats?.ink ?? -1) === 0,
        `preFixInk=${preMid.stats?.ink} preFixWhite=${preMid.stats?.white}`)
    }
  } else {
    log('NOTE: status.ready=false — skipping transcribe/burn loop. Blockers:')
    for (const b of st.json?.data?.blockers || []) log(`  - ${b.what}: ${b.command}`)
  }

  /*
   * ★ REQ-0554 §3-2 — the edit_cues ROUND TRIP: write, read it back, SEE it.
   *
   * Before this REQ, keyword emphasis could be switched on headlessly but the
   * WORDS could not be chosen from anywhere except the GUI, so `--emphasis on`
   * produced `EMPHASIS_NO_SPANS` and a picture identical to emphasis off. The
   * gate therefore has to end in pixels: "the file now says so" would have been
   * satisfied by the broken build too.
   *
   * The negative control is the pre-REQ state reproduced through an INPUT: the
   * same cue, emphasis on, spans EMPTY. Same code, same command — only the
   * patch differs.
   */
  {
    const clip = join(work, 'ec.mp4')
    makeSolidClip(clip, '640x360', 'navy', 3)
    const srt = join(work, 'ec.srt')
    writeFileSync(srt, ['1', '00:00:00,100 --> 00:00:02,500', 'AAAA BBBB', ''].join(CRLF), 'utf-8')
    const proj = join(work, 'ec.mojioko')
    const conv = cli(['convert', srt, '-o', proj, '--video', clip], 60000)
    check('REQ-0554 fixture: convert produced a .mojioko', conv.code === 0, conv.stderr?.slice(-200))

    if (conv.code === 0) {
      const editsPath = join(work, 'ec-edits.json')
      // Emphasise "BBBB" — offsets 5..9 of "AAAA BBBB".
      const spans = [{ start: 5, end: 9, text: 'BBBB' }]
      const stylePatch = {
        fontSizePx: 80,
        emphasis: { enabled: true, color: '#FF2E88', scalePercent: 200 },
        karaoke: { enabled: false },
      }
      writeFileSync(editsPath, JSON.stringify([
        { select: { index: 0 }, style: stylePatch, emphasisSpans: spans },
      ]), 'utf-8')

      const ed = cli(['edit_cues', proj, '-o', proj, '--edits-file', editsPath], 60000)
      check('REQ-0554 edit_cues applied the patch', ed.code === 0 && ed.json?.data?.applied === 1,
        `code=${ed.code} applied=${ed.json?.data?.applied} ${ed.stderr?.slice(-160)}`)

      // --- read it back: the same values, in the same shape ---
      const rd = cli(['read_subtitle', proj, '--with-style'], 60000)
      const cue0 = rd.json?.data?.cues?.[0]
      // ★ The spans must EXIST before anything is measured. An empty set would
      // make every comparison below trivially true — the trap this gate is
      // named after (EMPHASIS_NO_SPANS).
      check('REQ-0554 §3-2 read_subtitle returns the spans that were written',
        Array.isArray(cue0?.emphasisSpans) && cue0.emphasisSpans.length === 1
        && cue0.emphasisSpans[0].start === 5 && cue0.emphasisSpans[0].end === 9
        && cue0.emphasisSpans[0].text === 'BBBB',
        JSON.stringify(cue0?.emphasisSpans))
      check('REQ-0554 §3-2 read_subtitle returns the style that was written',
        cue0?.style?.fontSizePx === 80
        && cue0?.style?.emphasis?.enabled === true
        && cue0?.style?.emphasis?.scalePercent === 200
        && cue0?.style?.emphasis?.color === '#FF2E88',
        JSON.stringify(cue0?.style?.emphasis))

      // --- and now the picture ---
      const frameOf = (project, tag) => {
        const png = join(work, `ec-${tag}.png`)
        const r = cli(['export_frame', clip, project, '-o', png, '--time', '1.0'], 90000)
        return { code: r.code, stats: existsSync(png) ? inkStats(png) : null, png }
      }
      const withSpans = frameOf(proj, 'with')

      // NEGATIVE CONTROL: identical patch, spans removed. This is exactly what
      // a caller could express before edit_cues existed.
      const ctlProj = join(work, 'ec-ctl.mojioko')
      cli(['convert', srt, '-o', ctlProj, '--video', clip], 60000)
      const ctlEdits = join(work, 'ec-ctl-edits.json')
      writeFileSync(ctlEdits, JSON.stringify([
        { select: { index: 0 }, style: stylePatch, emphasisSpans: [] },
      ]), 'utf-8')
      const ctlEd = cli(['edit_cues', ctlProj, '-o', ctlProj, '--edits-file', ctlEdits], 60000)
      const noSpans = frameOf(ctlProj, 'ctl')

      /*
       * The control has to differ in ONE thing. If its style patch had failed to
       * apply, the cue would still be at the default 60 px and every "bigger"
       * comparison below would pass for the wrong reason — the classic way a
       * negative control quietly stops controlling anything.
       */
      const ctlRead = cli(['read_subtitle', ctlProj, '--with-style'], 60000)
      const ctlCue = ctlRead.json?.data?.cues?.[0]
      check('REQ-0554 §3-3 NEGATIVE CONTROL differs in exactly one input (spans), not in style',
        ctlEd.code === 0 && ctlCue?.style?.fontSizePx === 80
        && ctlCue?.style?.emphasis?.enabled === true
        && ctlCue?.style?.emphasis?.scalePercent === 200
        && (ctlCue?.emphasisSpans?.length ?? 0) === 0,
        `code=${ctlEd.code} size=${ctlCue?.style?.fontSizePx} emph=${JSON.stringify(ctlCue?.style?.emphasis)} spans=${ctlCue?.emphasisSpans?.length}`)

      if (withSpans.stats && noSpans.stats) {
        // The emphasised word is drawn at 200 %, so the cue's ink box is WIDER
        // and there is more ink. Geometry, not colour, is the primary signal:
        // it cannot be produced by anything else in this fixture.
        check('★ REQ-0554 §3-2 the emphasised cue is visibly bigger than the same cue without spans',
          withSpans.stats.w > noSpans.stats.w * 1.1 && withSpans.stats.ink > noSpans.stats.ink * 1.1,
          `withSpans w=${withSpans.stats.w} ink=${withSpans.stats.ink} | noSpans w=${noSpans.stats.w} ink=${noSpans.stats.ink}`)

        // …and the emphasis COLOUR is actually on screen.
        const pink = countColor(withSpans.png, [0xFF, 0x2E, 0x88], 40)
        const pinkCtl = countColor(noSpans.png, [0xFF, 0x2E, 0x88], 40)
        check('★ REQ-0554 §3-2 the emphasis colour appears in the frame (and not in the control)',
          pink > 100 && pinkCtl < pink / 10,
          `pink=${pink} pinkControl=${pinkCtl}`)
      } else {
        check('REQ-0554 §3-2 both frames were exported', false,
          `with=${withSpans.code} ctl=${noSpans.code}`)
      }

      // --- reject_all leaves the file untouched, byte for byte ---
      const beforeHash = sha256(proj)
      const badEdits = join(work, 'ec-bad.json')
      writeFileSync(badEdits, JSON.stringify([
        { select: { index: 0 }, style: { fontSizePx: 40 } },
        { select: { index: 0 }, style: { nonsenseField: 1 } },
      ]), 'utf-8')
      const rejected = cli(['edit_cues', proj, '-o', proj, '--edits-file', badEdits], 60000)
      check('★ REQ-0554 §2-3 reject_all: one bad edit writes NOTHING',
        rejected.code !== 0 && sha256(proj) === beforeHash,
        `code=${rejected.code} hashUnchanged=${sha256(proj) === beforeHash}`)

      const applyValid = cli(['edit_cues', proj, '-o', proj, '--edits-file', badEdits, '--on-error', 'apply_valid'], 60000)
      check('REQ-0554 §2-3 apply_valid applies the good edit and reports the bad one',
        applyValid.code === 0 && applyValid.json?.data?.applied === 1 && applyValid.json?.data?.failed === 1,
        `applied=${applyValid.json?.data?.applied} failed=${applyValid.json?.data?.failed}`)
    }
  }

} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* best-effort */ }
}

log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
