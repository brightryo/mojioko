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
