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
 * Usage:
 *   node scripts/verify-package-fresh.mjs <loose-tree | app.asar> [--out <dir>]
 *
 * Exits non-zero when a bundle differs, is missing, or when NOTHING was
 * compared — an empty comparison is a failure, not a pass (REQ-0511 §"環境を
 * 仮定したアサーションを書かない": a gate that silently checks zero things
 * reads as green while guarding nothing).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

const argv = process.argv.slice(2)
const outFlag = argv.indexOf('--out')
const outDir = resolve(outFlag === -1 ? 'out' : argv[outFlag + 1])
const targetArg = argv.find((a, i) => outFlag === -1 || (i !== outFlag && i !== outFlag + 1))

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
      // `out/renderer/{fonts,bin,icons}` are copied assets, not build output;
      // they are large and unchanged by a code edit, so skip them.
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
