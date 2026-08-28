/**
 * REQ-0534 §3 — "is this artefact built from the tree I have?"
 *
 * A packaging REQ always ends with the same question, and "the build
 * succeeded" is not an answer to it: electron-builder reuses `win-unpacked`,
 * and a stale `out/` produces a perfectly successful build of the wrong code.
 * RES-0513's artefacts sat on disk for ten days looking exactly like fresh
 * ones.
 *
 * The obvious way to answer it is a list of per-REQ marker strings, but that
 * list needs editing every single REQ, and a gate nobody maintains is a gate
 * that quietly stops discriminating (§18 追記2, and the REQ-0514 lesson about
 * controls that rot).  So this gate asserts a property that needs no
 * maintenance instead:
 *
 *   every JS/CSS bundle inside the package's `app.asar` is BYTE-IDENTICAL to
 *   the corresponding file in `out/`.
 *
 * `out/` is whatever `npm run build` last produced, so the gate re-derives its
 * own expectations each run.  It cannot go stale, and it needs no knowledge of
 * which REQ changed what.
 *
 * ## REQ-0575 — and the same question about everything ELSE in the package
 *
 * The check above covers `app.asar`, which is the code this repo compiles. It
 * does not cover what is copied in beside it: the Python sidecar bundle, the
 * ffmpeg binaries, the fonts, the licences. REQ-0574 shipped a loose tree in
 * which two of the sidecar's 955 files had been RENAMED — `libstdc++-6.dll`
 * arrived as `libstdc%2B%2B-6.dll`, because an .appx stores URI-encoded entry
 * names and a plain ZIP extract leaves them that way. Transcription failed with
 * "faster-whisper is not installed", and this gate said OK, because the bundles
 * it checks were all perfect.
 *
 * So the second half compares the bundled resources too: exact filename set
 * plus sha256 of every file. A rename, an omission and an extra file all fail.
 *
 * The list of what to compare is DERIVED from the electron-builder config's
 * `extraResources`, not written out here. A hand-kept list is a list that stops
 * matching what is actually shipped — and it would have to be updated by the
 * same person who just added the thing it is meant to notice.
 *
 * Usage:
 *   node scripts/verify-package-fresh.mjs <loose-tree | app.asar> [--out <dir>]
 *                                          [--config <electron-builder yml>]
 *                                          [--bundles-only]
 *
 * Exits non-zero when a bundle differs, is missing, or when NOTHING was
 * compared — an empty comparison is a failure, not a pass (REQ-0511 §"環境を
 * 仮定したアサーションを書かない": a gate that silently checks zero things
 * reads as green while guarding nothing).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const yaml = require('js-yaml')
const { minimatch } = require('minimatch')

const argv = process.argv.slice(2)
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const outDir = resolve(flagValue('--out', 'out'))
const configPath = resolve(flagValue('--config', 'electron-builder.yml'))
const bundlesOnly = argv.includes('--bundles-only')
const flagged = new Set()
for (const name of ['--out', '--config']) {
  const i = argv.indexOf(name)
  if (i !== -1) { flagged.add(i); flagged.add(i + 1) }
}
const targetArg = argv.find((a, i) => !flagged.has(i) && !a.startsWith('--'))

if (!targetArg) {
  console.error('usage: node scripts/verify-package-fresh.mjs <loose-tree | app.asar> [--out <dir>]')
  process.exit(2)
}

// Accept either the loose tree root or the .asar itself, so this works on a
// registered MSIX layout, on `dist/win-unpacked`, and on `dist-appx/win-unpacked`.
const target = resolve(targetArg)
const asarPath = statSync(target).isDirectory()
  ? [
      join(target, 'app', 'resources', 'app.asar'), // MSIX loose layout
      join(target, 'resources', 'app.asar'), // win-unpacked layout
    ].find((p) => existsSync(p))
  : target

if (!asarPath) {
  console.error(`FAIL  no app.asar found under ${target}`)
  process.exit(1)
}
if (!existsSync(outDir)) {
  console.error(`FAIL  ${outDir} does not exist — run \`npm run build\` first.`)
  process.exit(1)
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

/** Every JS/CSS bundle electron-vite emits, relative to `out/`. */
function bundlesUnder(dir, prefix = '') {
  const found = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(full).isDirectory()) {
      // Copied assets, not build output: large, and unchanged by a code edit.
      //
      // REQ-0547 — since that REQ only `fonts` is actually published (`bin` and
      // `icons` were 441 MB that no renderer code ever fetched). The other two
      // are kept in this skip list deliberately: if a future change starts
      // copying them again, this gate should still ignore them rather than
      // start hashing 440 MB of ffmpeg. The gate that CATCHES the re-copy is
      // `tests/unit/renderer-assets-req-0547.test.ts`.
      if (/^renderer\/(fonts|bin|icons)$/.test(rel)) continue
      found.push(...bundlesUnder(full, rel))
    } else if (/\.(js|css|html)$/i.test(name)) {
      found.push(rel)
    }
  }
  return found
}

const expected = bundlesUnder(outDir)
const inArchive = new Set(
  asar.listPackage(asarPath).map((p) => p.replace(/^[\\/]/, '').replace(/\\/g, '/'))
)

console.log(`package : ${asarPath}`)
console.log(`built   : ${outDir}`)
console.log(`checking ${expected.length} bundle(s)\n`)

let bad = 0
for (const rel of expected) {
  const inner = `out/${rel}`
  if (!inArchive.has(inner)) {
    console.log(`  MISSING   ${rel}`)
    bad++
    continue
  }
  // `extractFile` wants the archive's own separator.
  const packed = asar.extractFile(asarPath, inner.replace(/\//g, process.platform === 'win32' ? '\\' : '/'))
  const local = readFileSync(join(outDir, rel))
  const same = sha(packed) === sha(local)
  if (!same) bad++
  console.log(`  ${same ? 'SAME    ' : 'DIFFERS '}  ${rel}  ${sha(local).slice(0, 12)}${same ? '' : ` != ${sha(packed).slice(0, 12)}`}`)
}

if (expected.length === 0) {
  console.error('\nFAIL  compared zero bundles — that is a broken gate, not a pass.')
  process.exit(1)
}
if (bad > 0) {
  console.error(`\nFAIL  ${bad} of ${expected.length} bundle(s) do not match the current build.`)
  console.error('      The package was built from a different tree. Rebuild before shipping it.')
  process.exit(1)
}
console.log(`\nOK — all ${expected.length} bundle(s) match the current build.`)

// --- REQ-0575: the bundled resources -------------------------------------
if (bundlesOnly) process.exit(0)

/**
 * Where the package keeps its `resources/`.
 *
 * MSIX loose trees nest one level deeper than `win-unpacked` does, and this
 * gate is pointed at both, so the layout is discovered rather than assumed.
 */
const pkgResources = statSync(target).isDirectory()
  ? [join(target, 'app', 'resources'), join(target, 'resources')].find((p) => existsSync(p))
  : null

if (!pkgResources) {
  console.log('\nresources: skipped (target is a bare .asar, not a package tree)')
  process.exit(0)
}
if (!existsSync(configPath)) {
  console.error(`\nFAIL  no electron-builder config at ${configPath}`)
  process.exit(1)
}

/**
 * Files that may legitimately differ in CONTENT, with the reason.
 *
 * A NAME difference is never allowed — that is the REQ-0574 failure, and there
 * is no version of it that is acceptable.
 *
 * Keys are package-relative paths. An entry naming a file that is not bundled
 * at all is a DEAD entry and fails: a stale excuse list is how a gate quietly
 * stops discriminating (RES-0572 §1-3). Note the test is "is it shipped", not
 * "did it differ" — the store package is unsigned, so these three match there
 * exactly, and that must not read as dead.
 */
const CONTENT_ALLOWED = {
  'bin/transcriber/mojioko-transcriber.exe': 'electron-builder Authenticode-signs it for sideload builds',
  'bin/ffmpeg/ffmpeg.exe': 'same signing step',
  'bin/ffmpeg/ffprobe.exe': 'same signing step',
}

/**
 * Files the PACKAGER adds, which no `extraResources` entry declares.
 *
 * Allowed when present, never required: `elevate.exe` is electron-builder's
 * NSIS UAC helper and appears only in installer builds, so demanding it would
 * fail every appx. That means these get no dead-entry check — unlike
 * CONTENT_ALLOWED above, whose keys must be shipped by every target. Stated
 * here rather than silently skipped, because "extra file in the package" is
 * one half of how a rename shows up.
 */
const PACKAGER_ADDED = {
  'elevate.exe': 'electron-builder NSIS UAC helper, injected for installer targets',
}

const config = yaml.load(readFileSync(configPath, 'utf-8'))
const extra = config.extraResources ?? []
if (extra.length === 0) {
  console.error(`\nFAIL  ${configPath} declares no extraResources — nothing to compare, which is a broken gate.`)
  process.exit(1)
}

/** Every file under `dir`, as paths relative to it, with forward slashes. */
function filesUnder(dir, prefix = '') {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, rel))
    else out.push(rel)
  }
  return out
}

/*
 * Build the expected map from the config: for each `extraResources` entry,
 * every repo file under `from` that its `filter` globs accept, keyed by the
 * package path it lands at.
 */
const expectedRes = new Map()
for (const entry of extra) {
  const from = resolve(entry.from)
  if (!existsSync(from)) {
    console.error(`\nFAIL  config points at a missing source: ${entry.from}`)
    process.exit(1)
  }
  const globs = entry.filter ?? ['**/*']
  for (const rel of filesUnder(from)) {
    if (!globs.some((g) => minimatch(rel, g, { dot: true, nocase: true }))) continue
    expectedRes.set(`${entry.to}/${rel}`, join(from, rel))
  }
}

const shippedRes = new Set(
  filesUnder(pkgResources).filter((r) => r !== 'app.asar' && !r.startsWith('app.asar.unpacked/')),
)

console.log(`\nresources: ${expectedRes.size} expected from ${basename(configPath)}`)

const missing = [...expectedRes.keys()].filter((r) => !shippedRes.has(r))
const extraneous = [...shippedRes].filter((r) => !expectedRes.has(r) && !(r in PACKAGER_ADDED))
let resBad = 0
let allowedUsed = 0

for (const rel of expectedRes.keys()) {
  if (!shippedRes.has(rel)) continue
  const a = readFileSync(expectedRes.get(rel))
  const b = readFileSync(join(pkgResources, rel))
  if (sha(a) === sha(b)) continue
  if (rel in CONTENT_ALLOWED) { allowedUsed++; continue }
  console.log(`  DIFFERS   ${rel}`)
  resBad++
}

for (const rel of missing) console.log(`  MISSING   ${rel}`)
for (const rel of extraneous) console.log(`  EXTRA     ${rel}`)

// A dead allow-list entry means the excuse outlived the file it excused.
const dead = Object.keys(CONTENT_ALLOWED).filter((k) => !expectedRes.has(k))
for (const k of dead) console.log(`  DEAD-ALLOW ${k} (allow-listed but not shipped)`)

const resFail = resBad + missing.length + extraneous.length + dead.length
if (resFail > 0) {
  console.error(
    `\nFAIL  resources: ${resBad} differ, ${missing.length} missing, ${extraneous.length} extra, ` +
    `${dead.length} dead allow-list entr(ies).`,
  )
  console.error('      A renamed file counts as one MISSING plus one EXTRA — that is the REQ-0574 case.')
  process.exit(1)
}
console.log(`  OK — ${expectedRes.size} resource file(s) match (${allowedUsed} signed, content-allowed)`)
