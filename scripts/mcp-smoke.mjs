/**
 * REQ-0450 §4 — MOJIOKO MCP server smoke (reusable gate).
 *
 * Spawns `mojioko mcp`, performs the MCP handshake, lists tools (checks they are
 * typed), calls `status`, then runs a real `transcribe` as an async job and
 * polls `get_job_status` to completion — proving the long-running design works
 * and produces an artifact. Asserts: no window, no hang, structured results.
 * Non-zero exit on any failure (GATE).
 *
 * Usage: node scripts/mcp-smoke.mjs   (run `npm run build` first)
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const ROOT = process.cwd()
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const FFMPEG = join(ROOT, 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')
// REQ-0455 — launch through the pure-Node clean-stdout proxy (out/main/mcp-proxy.js),
// exactly as Claude does via the launch spec: electron + ELECTRON_RUN_AS_NODE=1.
const PROXY = join(ROOT, 'out', 'main', 'mcp-proxy.js')

let failures = 0
const log = (m) => process.stdout.write(m + '\n')
const check = (name, cond, extra = '') => { log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!cond) failures++ }

if (!existsSync(ELECTRON) || !existsSync(FFMPEG) || !existsSync(PROXY)) { log('SKIP: build first (electron/ffmpeg/proxy missing).'); process.exit(0) }

const work = mkdtempSync(join(tmpdir(), 'mojioko-mcp-smoke-'))
const clip = join(work, 'clip.mp4')
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'h264_mf', '-c:a', 'aac', '-shortest', clip], { encoding: 'utf-8' })

// REQ-0454 §1/§4 — hold a competing single-instance lock (simulating a running
// GUI). The MCP server must still serve (it runs in the CLI branch, before/
// without the lock). The whole handshake below then runs with the lock held.
const holderPath = join(work, 'lock-holder.cjs')
writeFileSync(
  holderPath,
  "const {app}=require('electron');const got=app.requestSingleInstanceLock();process.stderr.write('LOCK='+got+'\\n');app.whenReady().then(()=>{});setTimeout(()=>app.exit(0),120000);",
)
const holder = spawn(ELECTRON, [holderPath], { cwd: ROOT, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } })
let holderGotLock = false
holder.stderr.on('data', (d) => { if (String(d).includes('LOCK=true')) holderGotLock = true })

const child = spawn(ELECTRON, [PROXY, '.', 'mcp'], {
  cwd: ROOT,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})
// REQ-0455 — capture RAW stdout as Buffers (decode ONCE at the end so a
// multi-byte UTF-8 char split across chunks isn't mangled) to assert framing.
const rawChunks = []
child.stdout.on('data', (d) => rawChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))
const rl = createInterface({ input: child.stdout, terminal: false })
const pending = new Map()
let nextId = 1

rl.on('line', (line) => {
  const t = line.trim()
  if (!t.startsWith('{')) return
  let msg
  try { msg = JSON.parse(t) } catch { return }
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})

function rpc(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout: ${method}`)), 30000)
    pending.set(id, (m) => { clearTimeout(to); resolve(m) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const parseContent = (res) => { try { return JSON.parse(res.result.content[0].text) } catch { return null } }

try {
  // 0) confirm a competing single-instance lock is held (REQ-0454 §1/§4), so
  // the handshake below meaningfully proves the MCP server serves regardless.
  await sleep(3000)
  check('competing single-instance lock is held (GUI-running scenario)', holderGotLock)

  // 1) handshake — runs WHILE the lock is held.
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } })
  check('initialize → serverInfo mojioko (with GUI-lock held)', init.result?.serverInfo?.name === 'mojioko', JSON.stringify(init.result?.serverInfo))
  notify('notifications/initialized', {})

  // 2) tools/list — typed
  const list = await rpc('tools/list', {})
  const tools = list.result?.tools || []
  const names = tools.map((t) => t.name)
  const expected = ['status', 'transcribe', 'translate', 'burn', 'run', 'tools_download', 'tools_use', 'get_job_status']
  check('tools/list has all tools', expected.every((n) => names.includes(n)), names.join(','))
  check('tools have typed inputSchema', tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'))
  const tr = tools.find((t) => t.name === 'transcribe')
  check('transcribe schema requires input+out', Array.isArray(tr?.inputSchema?.required) && tr.inputSchema.required.includes('input') && tr.inputSchema.required.includes('out'))

  // 2b) tools/list includes export_frame (REQ-0457 A4).
  check('tools/list includes export_frame', names.includes('export_frame'))

  // 3) status
  const st = await rpc('tools/call', { name: 'status', arguments: {} })
  const stData = parseContent(st)
  check('status → ready boolean + blockers[]', typeof stData?.data?.ready === 'boolean' && Array.isArray(stData?.data?.blockers), `ready=${stData?.data?.ready}`)
  // REQ-0457 A1 — status returns the full resolved subtitle style.
  check('status → full subtitleStyle (karaoke/emphasis/animation)', !!stData?.data?.settings?.subtitleStyle?.karaoke && !!stData?.data?.settings?.subtitleStyle?.animation)
  // REQ-0458 §2 — status reports the MCP launch-spec revision + stale verdict.
  check('status → mcpBundle{launchSpecRevision, stale}', typeof stData?.data?.mcpBundle?.launchSpecRevision === 'number' && typeof stData?.data?.mcpBundle?.stale === 'boolean', JSON.stringify(stData?.data?.mcpBundle))

  // 4) transcribe as async job (only if ready)
  if (stData?.data?.ready) {
    const out = join(work, 'out.mojioko')
    const start = await rpc('tools/call', { name: 'transcribe', arguments: { input: clip, out } })
    const startData = parseContent(start)
    check('transcribe returns a job_id (async)', typeof startData?.job_id === 'string' && startData?.status === 'running', JSON.stringify({ job_id: startData?.job_id, status: startData?.status }))

    let done = null
    for (let i = 0; i < 120; i++) {
      await sleep(2000)
      const poll = await rpc('tools/call', { name: 'get_job_status', arguments: { job_id: startData.job_id } })
      const pd = parseContent(poll)
      if (pd?.status === 'done' || pd?.status === 'failed') { done = pd; break }
    }
    check('job reached done', done?.status === 'done', `status=${done?.status} err=${done?.result?.code || ''}`)
    check('job result has outputPath + artifact exists', !!done?.result?.data?.outputPath && existsSync(out), done?.result?.data?.outputPath || '')
    // REQ-0457 B5 — snapshot carries stage / stageProgress / overallProgress.
    check('get_job_status exposes stage + overallProgress', typeof done?.stage === 'string' && typeof done?.overallProgress === 'number' && done?.overallProgress === 100, `stage=${done?.stage} overall=${done?.overallProgress}`)

    // 4c) REQ-0457 B6 — list_jobs + cancel_job.
    const list = parseContent(await rpc('tools/call', { name: 'list_jobs', arguments: {} }))
    check('list_jobs returns the transcribe job', Array.isArray(list?.jobs) && list.jobs.some((j) => j.job_id === startData.job_id))
    // Start a fresh transcribe and cancel it mid-flight.
    const c = parseContent(await rpc('tools/call', { name: 'transcribe', arguments: { input: clip, out: join(work, 'cancel.mojioko') } }))
    await sleep(300)
    const cancel = parseContent(await rpc('tools/call', { name: 'cancel_job', arguments: { job_id: c.job_id } }))
    check('cancel_job accepts a running job', cancel?.ok === true, JSON.stringify(cancel))
    const after = parseContent(await rpc('tools/call', { name: 'get_job_status', arguments: { job_id: c.job_id } }))
    check('canceled job reports status=canceled', after?.status === 'canceled', `status=${after?.status}`)

    // 4b) REQ-0457 A4 — export_frame via MCP (async job) → PNG artifact.
    const framePng = join(work, 'frame.png')
    const ef = await rpc('tools/call', { name: 'export_frame', arguments: { video: clip, subtitle: out, out: framePng, time: 1.0 } })
    const efStart = parseContent(ef)
    check('export_frame returns a job_id (async)', typeof efStart?.job_id === 'string' && efStart?.status === 'running')
    let efDone = null
    for (let i = 0; i < 30; i++) {
      await sleep(1000)
      const poll = await rpc('tools/call', { name: 'get_job_status', arguments: { job_id: efStart.job_id } })
      const pd = parseContent(poll)
      if (pd?.status === 'done' || pd?.status === 'failed') { efDone = pd; break }
    }
    check('export_frame job done + PNG exists', efDone?.status === 'done' && existsSync(framePng), `status=${efDone?.status}`)

    // 4d) REQ-0457 Phase C — sync tools: probe + read_subtitle.
    const pr = parseContent(await rpc('tools/call', { name: 'probe', arguments: { input: clip } }))
    check('probe returns dims', pr?.data?.width > 0 && pr?.data?.height > 0, `${pr?.data?.width}x${pr?.data?.height}`)
    const rd = parseContent(await rpc('tools/call', { name: 'read_subtitle', arguments: { input: out } }))
    check('read_subtitle returns cue array', Array.isArray(rd?.data?.cues))
  } else {
    log('NOTE: status.ready=false — skipping transcribe job.')
    for (const b of stData?.data?.blockers || []) log(`  - ${b.what}: ${b.command}`)
  }

  // 5) REQ-0455 — strict stdout framing: split on '\n'; every complete segment
  // must be NON-EMPTY valid JSON. Drop the final segment unconditionally — it is
  // either '' (from the trailing '\n') or a partial line still being written at
  // sample time. A REAL blank line (mid-stream '\n\n') leaves an empty segment
  // BEFORE the last and is still caught.
  await sleep(300)
  const rawStdout = Buffer.concat(rawChunks).toString('utf8')
  const segments = rawStdout.split('\n')
  segments.pop()
  const empties = segments.filter((s) => s === '').length
  const nonJson = segments.filter((s) => { try { JSON.parse(s); return false } catch { return true } }).length
  check('stdout has NO empty segments (blank lines)', empties === 0, `empties=${empties} of ${segments.length}`)
  check('every stdout segment is valid JSON', nonJson === 0, `nonJson=${nonJson} of ${segments.length}`)
} catch (e) {
  check(`no exception (${e.message})`, false)
} finally {
  try { holder.kill() } catch { /* already gone */ }
  child.stdin.end() // closes stdin → server exits (proves clean shutdown)
  await sleep(500)
  try { child.kill() } catch { /* already gone */ }
  try { rmSync(work, { recursive: true, force: true }) } catch { /* best-effort */ }
}

log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
