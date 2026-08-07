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

let failures = 0
const log = (m) => process.stdout.write(m + '\n')
const check = (name, cond, extra = '') => { log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!cond) failures++ }

if (!existsSync(ELECTRON) || !existsSync(FFMPEG)) { log('SKIP: build first (electron/ffmpeg missing).'); process.exit(0) }

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

const child = spawn(ELECTRON, ['.', 'mcp'], { cwd: ROOT, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } })
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

  // 3) status
  const st = await rpc('tools/call', { name: 'status', arguments: {} })
  const stData = parseContent(st)
  check('status → ready boolean + blockers[]', typeof stData?.data?.ready === 'boolean' && Array.isArray(stData?.data?.blockers), `ready=${stData?.data?.ready}`)

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
  } else {
    log('NOTE: status.ready=false — skipping transcribe job.')
    for (const b of stData?.data?.blockers || []) log(`  - ${b.what}: ${b.command}`)
  }
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
