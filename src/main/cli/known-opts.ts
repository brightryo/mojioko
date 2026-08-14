/**
 * REQ-0499 §1 — detect unknown CLI options instead of silently swallowing them.
 *
 * ## Why this exists
 *
 * Before this module, `mojioko burn … --karaoke on` returned `ok:true` with zero
 * warnings.  So did `--shadow 40`, `--layer 3`, and `--totally-bogus-flag`.  An
 * agent that hallucinates a flag — which agents do constantly — got a success
 * envelope back and had no way to learn the flag did nothing.
 *
 * That is a strictly worse failure than the REQ-0460/0461 no-op family (flags
 * that were advertised but unread): there, at least the flag existed.  Here the
 * CLI confirms flags that were never designed.
 *
 * ## Why help.ts alone cannot be the source of truth
 *
 * Several options are READ by commands but deliberately absent from `help.ts`'s
 * `optionSpecs` (aliases, input fallbacks, format overrides).  Treating help as
 * the whole truth would make this module reject working invocations.  So the
 * known set is `advertised (help) ∪ hidden (below) ∪ global`, and the hidden
 * list is an explicit, commented allowlist rather than an absence — the same
 * "state it, don't omit it" discipline as `BURNIN_FIELD_DISPOSITION` and
 * `TRANSCRIPTION_DEFAULTS_TO_ENTRY`.
 *
 * Adding a new option therefore means adding it to `help.ts` (preferred) or to
 * `HIDDEN_OPTION_KEYS` with a reason.  Anything else warns at runtime.
 */
import { advertisedOptionKeys } from './help'

/**
 * Options accepted on every command, handled by the dispatcher rather than by
 * any command function.  `no-json` is listed because the parser rewrites it to
 * `json` (`args.ts`) — the raw token still has to be recognized here.
 */
export const GLOBAL_OPTION_KEYS: readonly string[] = [
  'json',
  'no-json',
  'quiet',
  'verbose',
  'help',
  'version',
  // REQ-0499 §1-2 — opt-in strict mode: unknown options become USAGE instead of
  // a warning.  Kept as a flag (not the default) so existing scripts that pass a
  // stray option keep working; flipping the default is an owner decision.
  'strict-args',
]

/**
 * Options a command genuinely reads but does NOT advertise in `help.ts`.
 *
 * Every entry is a real read site verified by grep over `src/main` (REQ-0498
 * §1.2 / REQ-0499 §1-4).  Listing one here is a statement that the omission
 * from help is intentional — not a licence to skip documenting new flags.
 */
export const HIDDEN_OPTION_KEYS: Readonly<Record<string, readonly string[]>> = {
  // `--overwrite` is enforced by `overwrite.ts:assertWritable` on these five
  // commands but advertised only on burn/run/export-mcpb.  The OUTPUT_EXISTS
  // remedy string names it, so it is discoverable — just not in help.
  transcribe: ['overwrite', 'auto-break'],
  translate: ['overwrite'],
  convert: ['overwrite', 'input', 'from', 'to'],
  edit_subtitle: ['overwrite', 'input', 'from', 'to'],
  read_subtitle: ['input'],
  probe: ['input'],
  // `--at` is an accepted alias for `--time` (`export-frame.ts` reads both).
  export_frame: ['overwrite', 'at'],
  // `burn` reads `--format` to override subtitle-format detection on the
  // <subtitle> positional; advertised on transcribe/translate/export_frame but
  // not on burn.
  burn: ['format'],
} as const

/**
 * Commands whose options are forwarded wholesale to other commands.
 *
 * `run.ts` spreads `{ ...args.opts }` into the transcribe / translate / burn
 * stages, so every flag those commands accept is legal on `run` even though
 * `help.ts` advertises only eight.  Modelling that here keeps the detector from
 * warning about a flag that demonstrably works (REQ-0498 verified `run --burn
 * --text-color …` reaches the burn stage).
 */
const FORWARDS_TO: Readonly<Record<string, readonly string[]>> = {
  run: ['transcribe', 'translate', 'burn'],
}

/** Dispatch aliases → the canonical command name used by `help.ts`. */
const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  'export-frame': 'export_frame',
  'read-subtitle': 'read_subtitle',
  'edit-subtitle': 'edit_subtitle',
  export_mcpb: 'export-mcpb',
}

/**
 * Normalize a dispatch token to the canonical command name.
 *
 * `index.ts` accepts both `export_frame` and `export-frame`, but `help.ts`
 * stores only one spelling.  Without this, per-command help for an alias
 * silently fell through to top-level help (REQ-0498 §1.2 B9).
 */
export function canonicalCommandName(command: string): string {
  return COMMAND_ALIASES[command] ?? command
}

/** Every option key legal on `command`, including globals and hidden aliases. */
export function knownOptionKeys(command: string): Set<string> {
  const canonical = canonicalCommandName(command)
  const keys = new Set<string>(GLOBAL_OPTION_KEYS)
  const collect = (name: string): void => {
    for (const k of advertisedOptionKeys(name)) keys.add(k)
    for (const k of HIDDEN_OPTION_KEYS[name] ?? []) keys.add(k)
  }
  collect(canonical)
  for (const target of FORWARDS_TO[canonical] ?? []) collect(target)
  return keys
}

/** Levenshtein distance, capped early — only used for "did you mean" hints. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * The closest known option to `key`, or undefined when nothing is close enough.
 *
 * Threshold scales with length so `--outlin` → `--outline` is suggested but two
 * unrelated short flags are not. A prefix match wins outright, which is what
 * catches the common `--margin` → `--margin-v` truncation.
 */
export function suggestOption(key: string, known: Iterable<string>): string | undefined {
  let best: string | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (const candidate of known) {
    if (candidate.startsWith(key) || key.startsWith(candidate)) return candidate
    const d = editDistance(key, candidate)
    if (d < bestScore) {
      bestScore = d
      best = candidate
    }
  }
  const limit = Math.max(2, Math.floor(bestScore === 0 ? 0 : Math.min(3, Math.ceil(key.length / 3))))
  return bestScore <= limit ? best : undefined
}

export interface UnknownOption {
  key: string
  /** Closest known option, when one is near enough to be worth printing. */
  suggestion?: string
}

/**
 * Unknown option keys present in `opts` for `command`.
 *
 * Pure — the caller decides whether that is a warning or a `USAGE` failure.
 * Returned in the order they appear so the message is stable across runs.
 */
export function detectUnknownOptions(
  command: string,
  opts: Readonly<Record<string, string | boolean>>,
): UnknownOption[] {
  const known = knownOptionKeys(command)
  const unknown: UnknownOption[] = []
  for (const key of Object.keys(opts)) {
    if (known.has(key)) continue
    const suggestion = suggestOption(key, known)
    unknown.push(suggestion ? { key, suggestion } : { key })
  }
  return unknown
}

/** Human-readable one-liner for a set of unknown options. */
export function formatUnknownOptions(unknown: readonly UnknownOption[]): string {
  return unknown
    .map((u) => (u.suggestion ? `--${u.key}（もしかして --${u.suggestion}?）` : `--${u.key}`))
    .join(', ')
}
