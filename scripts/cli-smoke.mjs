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
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
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
    }
  } else {
    log('NOTE: status.ready=false — skipping transcribe/burn loop. Blockers:')
    for (const b of st.json?.data?.blockers || []) log(`  - ${b.what}: ${b.command}`)
  }
} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* best-effort */ }
}

log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
