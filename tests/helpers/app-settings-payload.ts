import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * REQ-0511 M4 — the ONE parser of App.tsx's settings-save payload.
 *
 * REQ-0341 introduced this parse to pin "the renderer sends every
 * `incoming-wins` key"; `font-set-version-preserved-across-save` needs the same
 * fact to check its hand-written payload copy has not drifted. Two parsers of
 * the same literal would be a second thing to keep in sync — the shape of
 * problem both tests exist to catch — so it lives here and both import it.
 *
 * The parse is deliberately crude (top-level `key:` lines of the one object
 * literal annotated `AppSettings`). If App.tsx restructures the payload, the
 * callers' guard assertions fail loudly rather than passing vacuously: a
 * failure means "re-point the parser AND re-check the invariant", not "delete
 * the test".
 */
const APP_TSX = path.resolve(__dirname, '../../src/renderer/App.tsx')

/**
 * Top-level keys of the `const settings: AppSettings = { ... }` literal.
 *
 * Throws rather than returning `[]` when the literal cannot be found — an empty
 * list would make every caller's assertion trivially satisfiable, which is the
 * exact failure mode this helper is meant to remove.
 */
export function appSettingsPayloadKeys(): string[] {
  const src = readFileSync(APP_TSX, 'utf8')
  const start = src.indexOf('const settings: AppSettings = {')
  if (start === -1) throw new Error('settings payload literal not found in App.tsx')
  const open = src.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end <= open) throw new Error('unbalanced braces in the settings payload literal')
  const body = src.slice(open + 1, end)
  // Strip nested objects/arrays so only top-level `key:` survives.
  let flat = ''
  let d = 0
  for (const ch of body) {
    if (ch === '{' || ch === '[') d++
    else if (ch === '}' || ch === ']') d--
    else if (d === 0) flat += ch
  }
  const keys = Array.from(flat.matchAll(/(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*:/g)).map((m) => m[1])
  if (keys.length === 0) throw new Error('no top-level keys parsed from the settings payload literal')
  return keys
}
