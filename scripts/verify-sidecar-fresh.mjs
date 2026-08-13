/**
 * REQ-0334 §1 — PyInstaller sidecar staleness gate.
 *
 *   npm run verify:sidecar          # check  (exits 1 only when provably stale)
 *   npm run sidecar:stamp           # re-stamp after a rebuild
 *
 * ## The failure this exists to catch
 *
 * `resources/bin/transcriber/` is a ~241 MB PyInstaller `--onedir` artifact
 * that is TRACKED IN GIT and built BY HAND (`dev-docs/BUILD_GUIDE.md` §4).
 * Editing `python-sidecar/main.py` does not rebuild it, and — critically —
 * `npm run dev` never runs the exe at all (it spawns `.venv\Scripts\python.exe
 * main.py` directly, see `transcription-sidecar.ts:resolveSidecarSpawn`).  So
 * a stale binary is invisible during development and only surfaces in a
 * packaged build, where it silently runs old code.
 *
 * That is not hypothetical: REQ-0287 shipped a sidecar **9 days** behind its
 * source, and the symptom presented as a karaoke bug rather than as a build
 * problem.  Before this script the only guard was a sentence in BUILD_GUIDE.
 *
 * ## Why a content hash rather than timestamps
 *
 * Git does not preserve mtimes, so on a fresh clone every file gets the
 * checkout time in arbitrary order — an mtime comparison would fire at random.
 * Commit dates (`git log -1 --format=%ct`) are clone-stable but wrong in the
 * other direction: they go stale the moment you edit the working tree without
 * committing, which is most of the time you are actually working.  A content
 * hash of the source side answers exactly the question being asked and needs
 * no VCS at all.
 *
 * The 241 MB artifact is NEVER hashed.  Reading ~44 KB of Python is enough,
 * because the stamp records what the binary was BUILT FROM; the binary itself
 * only has to be believed to match the stamp at the moment it was written.
 *
 * ## Conservative by construction
 *
 * A false positive blocks a release build, which is worse than a miss.  So
 * this exits non-zero in exactly ONE case: the stamp exists, every source
 * file exists, and a hash differs.  Every ambiguity — missing stamp, missing
 * source file, missing binary (a dev machine that has never built it) —
 * prints a note and exits 0.
 *
 * Content is normalised CRLF → LF before hashing.  The repo has no
 * `.gitattributes` and `core.autocrlf=true` on the owner's machine, so the
 * same commit checks out with different bytes elsewhere; without this the
 * gate would fire on a clone rather than on a real staleness.
 *
 * ## Why this lives in scripts/ and not in the scratchpad
 *
 * CLAUDE.md §18 says delete one-off verification scripts once their result is
 * recorded — but §18's "残す対象（追記2）" carves out the gates you re-run on
 * every change of a given kind.  This is one: it must run on every packaged
 * build, forever.  Its result is not a measurement, it is a permission.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The files PyInstaller actually compiles into the binary.
 *
 * - `main.py`      — `Analysis([...])` entry point in the spec.
 * - `word_split.py` — declared as `hiddenimports`, so it IS bundled.
 * - `translate.py` — REQ-0494: the MADLAD translation sidecar, reached via
 *   main.py's `translate` subcommand and declared as a `hiddenimport`, so it IS
 *   bundled.  Editing it without a rebuild ships old TRANSLATION code — the same
 *   class of stale-binary bug (REQ-0287) this gate exists for, now that
 *   translation runs from the bundled exe rather than the .venv (REQ-0494).
 * - `gpu_dll.py` — shared CUDA preload, also a `hiddenimport`, also bundled.
 * - the spec itself — changes `hiddenimports` / `collect_all` / onedir-ness.
 *
 * Deliberately EXCLUDED, to keep false positives at zero:
 * - `test_*.py` — not bundled; editing a test must not block a build.
 * - `requirements*.txt` — the real input is the state of `.venv`, which these
 *   files only describe.  A pin change without a rebuild IS stale, but a
 *   comment edit is not, and this script cannot tell them apart.  Hashing
 *   them would trade a guaranteed detection for an occasional false stop.
 */
const SOURCE_FILES = [
  'python-sidecar/main.py',
  'python-sidecar/word_split.py',
  'python-sidecar/translate.py',
  'python-sidecar/gpu_dll.py',
  'mojioko-transcriber.spec',
]

/**
 * Kept OUTSIDE `resources/bin/transcriber/` on purpose: the documented build
 * step is `robocopy ... /MIR`, which deletes anything in the destination that
 * is not in the source tree — a stamp placed inside would be wiped by the
 * very rebuild that just produced it.
 */
const STAMP_PATH = 'resources/bin/transcriber.sources.json'

/** The artifact whose freshness is in question. */
const ARTIFACT_PATH = 'resources/bin/transcriber/mojioko-transcriber.exe'

/** SHA-256 of the file with line endings normalised to LF. */
function hashSource(absPath) {
  const raw = readFileSync(absPath)
  // Normalise in the byte domain so a stray lone CR cannot shift the result.
  const normalised = Buffer.from(raw.toString('binary').replace(/\r\n/g, '\n'), 'binary')
  return createHash('sha256').update(normalised).digest('hex')
}

function collectHashes() {
  const hashes = {}
  const missing = []
  for (const rel of SOURCE_FILES) {
    const abs = path.join(REPO_ROOT, rel)
    if (!existsSync(abs)) {
      missing.push(rel)
      continue
    }
    hashes[rel] = hashSource(abs)
  }
  return { hashes, missing }
}

function writeStamp() {
  const { hashes, missing } = collectHashes()
  if (missing.length > 0) {
    console.error(`FAILED: cannot stamp, source file(s) not found: ${missing.join(', ')}`)
    process.exit(1)
  }
  const stamp = {
    _comment:
      'REQ-0334 §1 — SHA-256 (LF-normalised) of the Python sources the tracked ' +
      'PyInstaller binary in resources/bin/transcriber/ was built from. ' +
      'Rewrite with `npm run sidecar:stamp` immediately after every rebuild. ' +
      'Checked by `npm run verify:sidecar`, which runs as part of `npm run build:win`.',
    stampedAt: new Date().toISOString().slice(0, 10),
    sources: hashes,
  }
  writeFileSync(path.join(REPO_ROOT, STAMP_PATH), JSON.stringify(stamp, null, 2) + '\n', 'utf8')
  console.log(`Stamped ${Object.keys(hashes).length} source file(s) into ${STAMP_PATH}:`)
  for (const [rel, h] of Object.entries(hashes)) console.log(`  ${h.slice(0, 12)}  ${rel}`)
  console.log('OK — the sidecar binary is now recorded as matching these sources.')
}

function verify() {
  const stampAbs = path.join(REPO_ROOT, STAMP_PATH)

  // --- ambiguity cases: say so, do not block --------------------------------
  if (!existsSync(path.join(REPO_ROOT, ARTIFACT_PATH))) {
    console.log(
      `SKIP — no sidecar binary at ${ARTIFACT_PATH}.\n` +
        '       Nothing can be stale.  (electron-builder drops the missing ' +
        'files and the runtime falls back to the .venv route.)',
    )
    return
  }
  if (!existsSync(stampAbs)) {
    console.log(
      `SKIP — no stamp at ${STAMP_PATH}, so there is nothing to compare against.\n` +
        '       Run `npm run sidecar:stamp` right after a rebuild to create it.',
    )
    return
  }

  let stamp
  try {
    stamp = JSON.parse(readFileSync(stampAbs, 'utf8'))
  } catch (err) {
    console.log(`SKIP — ${STAMP_PATH} is not readable JSON (${err.message}); not blocking.`)
    return
  }
  const recorded = stamp?.sources
  if (!recorded || typeof recorded !== 'object') {
    console.log(`SKIP — ${STAMP_PATH} has no \`sources\` map; not blocking.`)
    return
  }

  const { hashes, missing } = collectHashes()
  if (missing.length > 0) {
    console.log(`SKIP — source file(s) not found: ${missing.join(', ')}; not blocking.`)
    return
  }

  // --- the one blocking case ------------------------------------------------
  const changed = []
  const unrecorded = []
  for (const [rel, actual] of Object.entries(hashes)) {
    const expected = recorded[rel]
    // A source that the stamp never knew about is an ambiguity (the stamp
    // predates the file), not proof of staleness.
    if (typeof expected !== 'string') unrecorded.push(rel)
    else if (expected !== actual) changed.push({ rel, expected, actual })
  }

  for (const rel of unrecorded) {
    console.log(`note: ${rel} is not in the stamp — re-stamp to start tracking it.`)
  }

  console.log(`checked ${Object.keys(hashes).length} source file(s) against ${STAMP_PATH}`)

  if (changed.length > 0) {
    console.error(
      `\nFAILED: the sidecar binary is STALE — ${changed.length} source file(s) ` +
        'changed since it was built:',
    )
    for (const c of changed) {
      console.error(`  ${c.rel}\n    stamped ${c.expected.slice(0, 16)}…\n    now     ${c.actual.slice(0, 16)}…`)
    }
    console.error(
      '\nA packaged build would ship OLD transcription code (this is REQ-0287, ' +
        'which shipped 9 days stale).\n' +
        'Rebuild it — dev-docs/BUILD_GUIDE.md §4:\n' +
        '  pyinstaller mojioko-transcriber.spec --noconfirm ' +
        '--workpath python-sidecar\\build --distpath python-sidecar\\dist\n' +
        '  robocopy python-sidecar\\dist\\mojioko-transcriber resources\\bin\\transcriber /MIR\n' +
        '  npm run sidecar:stamp\n' +
        '\nIf you ALREADY rebuilt and only forgot the last line, run ' +
        '`npm run sidecar:stamp` and re-run this check.',
    )
    process.exit(1)
  }

  console.log('OK — the sidecar binary was built from these exact sources.')
}

if (process.argv.includes('--write')) writeStamp()
else verify()
