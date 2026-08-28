/**
 * REQ-0574 — unpack an .appx into a registrable loose tree, correctly.
 *
 *   node scripts/unpack-appx.mjs <in.appx> <out-dir>
 *
 * ## Why this exists
 *
 * An .appx is a ZIP, so extracting it with a ZIP tool looks like it works. It
 * does not: APPX follows the Open Packaging Conventions, where entry names are
 * URI-encoded. `libstdc++-6-<hash>.dll` is stored as `libstdc%2B%2B-6-…dll`,
 * and Windows' own installer decodes it on the way in. A plain ZIP extract
 * leaves the percent signs on disk.
 *
 * That is not cosmetic. PyAV loads `libstdc++-6.dll` by name; with the encoded
 * filename the load fails, `import av` fails, `import faster_whisper` fails,
 * and the sidecar reports **"faster-whisper is not installed"** — a message
 * that sends you looking for a missing package instead of a renamed file.
 * REQ-0574 lost an evening to exactly that, on a tree this developer had
 * hand-extracted with `System.IO.Compression.ZipFile`.
 *
 * Only two names in the whole 1075-entry package need decoding, which is
 * precisely why it survives a casual look at the output.
 *
 * ## What it guarantees
 *
 * Every entry name is decoded, and the result is then CHECKED: if any path
 * still contains a percent-escape, the unpack fails rather than producing a
 * tree that registers cleanly and breaks at run time.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const [src, dst] = process.argv.slice(2)
if (!src || !dst) {
  console.error('usage: node scripts/unpack-appx.mjs <in.appx> <out-dir>')
  process.exit(2)
}
if (!fs.existsSync(src)) {
  console.error(`unpack-appx: no such package: ${src}`)
  process.exit(2)
}

const ps = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead(${JSON.stringify(path.resolve(src))})
$n = 0; $dec = 0
foreach ($e in $z.Entries) {
  if ([string]::IsNullOrEmpty($e.Name)) { continue }
  $raw = $e.FullName
  $name = [System.Uri]::UnescapeDataString($raw)
  if ($name -ne $raw) { $dec++ }
  $out = Join-Path ${JSON.stringify(path.resolve(dst))} ($name -replace '/', '\\')
  New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $out, $true)
  $n++
}
$z.Dispose()
Write-Output ("entries=$n decoded=$dec")
`
fs.rmSync(dst, { recursive: true, force: true })
const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf-8' })
if (r.status !== 0) {
  console.error(`unpack-appx: extraction failed\n${r.stdout || ''}${r.stderr || ''}`)
  process.exit(1)
}
console.log(`unpack-appx: ${(r.stdout || '').trim()}`)

/*
 * The check that makes this a tool rather than a snippet: a percent-escape
 * left on disk is the exact failure this script exists to prevent, so finding
 * one is a hard error — not a warning printed into a log nobody reads.
 */
const offenders = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (/%[0-9A-Fa-f]{2}/.test(e.name)) offenders.push(p)
    if (e.isDirectory()) walk(p)
  }
}
walk(dst)
if (offenders.length > 0) {
  console.error(`unpack-appx: ${offenders.length} path(s) still URI-encoded:`)
  for (const o of offenders.slice(0, 10)) console.error(`  ${o}`)
  process.exit(1)
}
console.log(`unpack-appx: OK — no URI-encoded names remain in ${dst}`)
