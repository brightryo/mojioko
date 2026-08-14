/**
 * REQ-0447 — minimal, dependency-free CLI argument parser for MOJIOKO.
 *
 * Grammar (spec §2 / §3):
 *   - positionals: bare tokens (input paths, subcommand nouns like `list`).
 *   - `--key value` / `--key=value`: option with a value.
 *   - `--flag`: boolean option (present ⇒ true).
 *   - `--no-json`: sets `json=false`.
 *   - `-o <value>`: alias for `--out`.
 *   - `-h`: alias for `--help`.
 *
 * Options that take a value are enumerated in VALUE_OPTS so that a value that
 * happens to start with `-` (unlikely here) or a missing value is handled
 * predictably; every other `--x` is treated as a boolean flag.
 *
 * Pure (no I/O) so it is unit-testable.
 */

/** Long options that consume the following token as their value. */
const VALUE_OPTS: ReadonlySet<string> = new Set([
  'out',
  'model',
  'device',
  'lang',
  'to',
  'from',
  'track',
  'vad',
  'vad-threshold',
  'beam-size',
  'min-speech-ms',
  'min-silence-ms',
  'format',
  'auto-break',
  'resolution',
  'preset',
  'margin-x',
  'margin-y',
  'margin-v',
  'overflow',
  'time',
  'at',
  'index',
  'text',
  'video',
  'encoder',
  'audio',
  'container',
  'crf',
  'bitrate',
  'quality',
  'font-size',
  'text-color',
  'outline-color',
  'outline',
  'weight',
  // REQ-0500 §2 — `--karaoke on|off` takes a value (a bare boolean could not
  // express "off", which is the whole point of the flag).
  'karaoke',
  'karaoke-color',
  'karaoke-style',
  // REQ-0501 §1 — remaining GUI-settable style axes.  All take a value; the
  // on|off ones deliberately so, since "off" is the point of having them.
  'emphasis',
  'emphasis-color',
  'emphasis-scale',
  'shadow',
  'rotation',
  'uppercase',
  'line-spacing',
  'text-alpha',
  'outline-alpha',
  'background',
  'background-color',
  'background-opacity',
  'position',
  'translate',
  'style',
  'subtitle',
])

export interface ParsedArgs {
  positionals: string[]
  opts: Record<string, string | boolean>
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const opts: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h') {
      opts.help = true
      continue
    }
    if (a === '-o') {
      opts.out = argv[++i] ?? ''
      continue
    }
    if (a.startsWith('--')) {
      const body = a.slice(2)
      const eq = body.indexOf('=')
      if (eq !== -1) {
        opts[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      if (body === 'no-json') {
        opts.json = false
        continue
      }
      if (VALUE_OPTS.has(body)) {
        opts[body] = argv[++i] ?? ''
        continue
      }
      opts[body] = true
      continue
    }
    positionals.push(a)
  }

  return { positionals, opts }
}

/** Read a string option (with optional alias list); returns undefined if absent. */
export function optString(opts: ParsedArgs['opts'], ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = opts[k]
    if (typeof v === 'string') return v
    if (v === true) return '' // present as a bare flag — caller decides
  }
  return undefined
}

/** Read a boolean option; `undefined` when the flag is absent. */
export function optBool(opts: ParsedArgs['opts'], key: string): boolean | undefined {
  const v = opts[key]
  if (v === undefined) return undefined
  if (typeof v === 'boolean') return v
  // `--flag=true|false|on|off`
  return v === 'true' || v === 'on' || v === '1'
}
