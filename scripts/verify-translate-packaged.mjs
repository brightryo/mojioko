// REQ-0494 §3 — packaged translation smoke gate.
//
// WHY THIS EXISTS: translation ran only via a raw Python interpreter
// (`getPythonExecutable()` + translate.py), which does not exist in packaged
// builds → `PYTHON_MISSING` (RES-0493).  The old smokes ran in dev mode where
// `.venv` python is present, so the packaged break was invisible.
//
// WHAT THIS GATE DOES DIFFERENTLY: it spawns the STANDALONE PyInstaller sidecar
// exe (`resources/bin/transcriber/mojioko-transcriber.exe translate`) — the
// exact artifact that ships — NOT `.venv` python.  A dev `.venv` therefore
// cannot mask a regression here: if `translate.py` / `sentencepiece` /
// `ctranslate2` are not bundled INTO the exe, this gate fails.
//
// ASSERTIONS:
//   1. The bundled sidecar exe exists.               (else FAIL — build it)
//   2. `<exe> translate` accepts a `selftest` command that imports ctranslate2
//      + sentencepiece from INSIDE the bundle and returns ok.   (model-free)
//   3. No `PYTHON_MISSING` anywhere in the exchange.
//   4. If a MADLAD model is installed, a real 1-sentence translation returns
//      non-empty text.  (Skipped-with-warning when no model is present, so the
//      gate stays portable; the selftest above is the machine-independent core.)
//
// NEGATIVE CONTROL: run this against the pre-REQ-0494 exe (no `translate`
// subcommand, no sentencepiece) and it FAILS at step 2 — the `selftest` reply
// never arrives (the old exe ignores the arg, runs the transcription loop, and
// answers "Unknown command").
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = join(ROOT, 'resources', 'bin', 'transcriber',
  process.platform === 'win32' ? 'mojioko-transcriber.exe' : 'mojioko-transcriber')

function die(msg) { console.error(`FAIL: ${msg}`); process.exit(1) }
function ok(msg) { console.log(`OK   ${msg}`) }

if (!existsSync(EXE)) {
  die(`bundled sidecar exe not found: ${EXE}\n` +
      `     Build it first (PyInstaller) so this gate has a packaged artifact to test.`)
}

/** Find an installed MADLAD model dir (has both spiece.model + model.bin). */
function findModelDir() {
  const roots = [
    process.env.APPDATA && join(process.env.APPDATA, 'MOJIOKO', 'translation-tools'),
  ].filter(Boolean)
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const name of readdirSync(root)) {
      const dir = join(root, name)
      if (existsSync(join(dir, 'spiece.model')) && existsSync(join(dir, 'model.bin'))) return dir
    }
  }
  return null
}

const modelDir = findModelDir()

/**
 * Spawn `<exe> translate`, send each request line, resolve when every expected
 * id has replied (or reject on timeout / PYTHON_MISSING).  One resident process
 * for the whole exchange (mirrors translation-sidecar.ts).
 */
function runExchange(requests, expectIds, timeoutMs) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    if (modelDir) {
      env.MOJIOKO_TRANSLATION_MODEL_DIR = modelDir
      env.MOJIOKO_TRANSLATION_DEVICE = 'cpu' // CPU keeps the gate deterministic + GPU-independent
    }
    const proc = spawn(EXE, ['translate'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const got = new Map()
    let stderr = ''
    const timer = setTimeout(() => {
      try { proc.kill() } catch { /* ignore */ }
      reject(new Error(`timeout after ${timeoutMs}ms; got ids=[${[...got.keys()]}]; stderr tail:\n${stderr.slice(-800)}`))
    }, timeoutMs)

    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (!line.trim()) return
      if (line.includes('PYTHON_MISSING')) { clearTimeout(timer); try { proc.kill() } catch { /* */ }; reject(new Error('PYTHON_MISSING seen in sidecar output')); return }
      let msg
      try { msg = JSON.parse(line) } catch { return }
      if (msg.event === 'ready') { for (const r of requests) proc.stdin.write(JSON.stringify(r) + '\n'); return }
      if (typeof msg.id === 'number') {
        got.set(msg.id, msg)
        if (expectIds.every((id) => got.has(id))) {
          clearTimeout(timer)
          try { proc.stdin.end() } catch { /* */ }
          try { proc.kill() } catch { /* */ }
          resolve(got)
        }
      }
    })
    proc.stderr.on('data', (b) => { stderr += b.toString() })
    proc.on('error', (e) => { clearTimeout(timer); reject(e) })
    proc.on('exit', (code) => {
      if (!expectIds.every((id) => got.has(id))) {
        clearTimeout(timer)
        reject(new Error(`sidecar exited (code=${code}) before all replies; got ids=[${[...got.keys()]}]; stderr tail:\n${stderr.slice(-800)}`))
      }
    })
  })
}

const main = async () => {
  console.log(`translate-packaged gate — exe=${EXE}`)
  console.log(modelDir ? `model: ${modelDir}` : 'model: (none installed — real-translate step will be SKIPPED)')

  // Step 2/3 — model-free selftest: proves ctranslate2 + sentencepiece are
  // bundled and the `translate` subcommand dispatches.  This is the core,
  // machine-independent regression assertion.
  const reqs = [{ id: 1, cmd: 'selftest' }]
  const expect = [1]
  if (modelDir) { reqs.push({ id: 2, text: 'Hello, world.', target: 'ja' }); expect.push(2) }

  let got
  try {
    got = await runExchange(reqs, expect, 180_000)
  } catch (e) {
    die(`translate exchange failed: ${e.message}`)
  }

  const self = got.get(1)
  if (!self || self.ok !== true) die(`selftest did not return ok: ${JSON.stringify(self)}`)
  ok(`selftest ok (ctranslate2=${self.ct2}, sentencepiece=${self.spm}) — deps bundled, no PYTHON_MISSING`)

  if (modelDir) {
    const t = got.get(2)
    if (!t || t.ok !== true || typeof t.text !== 'string' || t.text.trim() === '') {
      die(`real translation returned nothing: ${JSON.stringify(t)}`)
    }
    ok(`real translate: "Hello, world." -> "${t.text}" (loadMs=${t.loadMs}, translateMs=${t.translateMs})`)
  } else {
    console.log('WARN skipped real-translate (no model installed); selftest still proves the packaged runtime')
  }

  console.log('\nPASS — packaged translation runtime is present and working.')
}

main().catch((e) => die(e?.message ?? String(e)))
