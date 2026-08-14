import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { allAdvertisedOptions } from '../../src/main/cli/help'

/**
 * REQ-0499 §3 — structural gate: every option `help.ts` advertises must have a
 * READ SITE in the code that command actually runs.
 *
 * ## Why this test exists
 *
 * "Advertised but never read" has shipped FOUR times in this codebase:
 *   1. REQ-0460 — `burn --position` was a no-op; the result JSON echoed the
 *      SETTINGS value, so it looked confirmed.
 *   2. REQ-0461 — `--font-size` / `--text-color` / `--outline-color` /
 *      `--outline` / `--weight` were all no-ops; `--margin-v` only fed the
 *      overflow budget and never the ASS margin.
 *   3. REQ-0467/0468 — `export_frame` was missing `--position`, so the tool
 *      that exists to preview a burn did not preview it.
 *   4. REQ-0498 — `transcribe --vad-threshold` / `--min-speech-ms` /
 *      `--min-silence-ms`, `translate --device` / `--strict`, `burn --device`,
 *      and `--verbose` were all unread.
 *
 * Fixing instances does not stop the fifth. This does: adding a flag to
 * `help.ts` without wiring it fails here.
 *
 * ## What it can and cannot see
 *
 * It is a source-text scan, so it proves a read site EXISTS — not that the value
 * reaches pixels. A flag that is parsed and then dropped on the floor still
 * passes. Real-pixel proof is the job of `verify:cli-smoke` (byte-diff with and
 * without style flags) and `verify:pos-parity` et al. Those two layers are
 * complementary: this one is cheap and total, those are expensive and sampled.
 */

const SRC = join(__dirname, '..', '..', 'src', 'main')

/**
 * Files that may legitimately read a given command's options.
 *
 * Explicit rather than "scan all of src/main" so the gate is per-command: that
 * is what catches `burn --device`, where `'device'` IS read elsewhere in the
 * tree (tools.ts, transcribe.ts) but never by burn. A whole-tree scan would
 * have called that flag wired and missed the bug.
 *
 * A new command, or an existing one that starts reading options from a new
 * helper, must be added here. The resulting failure is the intended prompt.
 */
const OVERWRITE = 'cli/overwrite.ts'
const PLACEMENT = ['cli/placement.ts', 'cli/style-overrides.ts']

const COMMAND_SOURCES: Readonly<Record<string, readonly string[]>> = {
  status: [],
  tools: ['cli/commands/tools.ts'],
  transcribe: ['cli/commands/transcribe.ts', OVERWRITE],
  translate: ['cli/commands/translate.ts', OVERWRITE],
  burn: ['cli/commands/burn.ts', ...PLACEMENT, OVERWRITE],
  export_frame: ['cli/commands/export-frame.ts', ...PLACEMENT, OVERWRITE],
  probe: ['cli/commands/probe.ts'],
  read_subtitle: ['cli/commands/read-subtitle.ts'],
  edit_subtitle: ['cli/commands/edit-subtitle.ts', OVERWRITE],
  convert: ['cli/commands/convert.ts', OVERWRITE],
  'export-mcpb': ['cli/commands/export-mcpb.ts', OVERWRITE],
  // `run` spreads `{ ...args.opts }` into the transcribe / translate / burn
  // stages (run.ts), so every flag those read is legitimately readable here.
  run: [
    'cli/commands/run.ts',
    'cli/commands/transcribe.ts',
    'cli/commands/translate.ts',
    'cli/commands/burn.ts',
    ...PLACEMENT,
    OVERWRITE,
  ],
}

/**
 * True when `text` contains a read of option `key`.
 *
 * Two accepted forms, matching how the CLI actually reads options:
 *   - a quoted literal — `optString(args.opts, 'margin-v')`, `opts['dry-run']`
 *   - dot access — `args.opts.strict` (only possible for identifier-safe keys)
 */
export function readsOption(text: string, key: string): boolean {
  if (text.includes(`'${key}'`) || text.includes(`"${key}"`)) return true
  if (/^[A-Za-z_$][\w$]*$/.test(key) && new RegExp(`opts\\.${key}\\b`).test(text)) return true
  return false
}

/**
 * The advertised options with no read site in their command's sources.
 *
 * Pure over an injected file map, so the negative control below can feed it a
 * deliberately broken tree instead of mutating the repo.
 */
export function findUnwiredOptions(
  advertised: readonly { command: string; key: string }[],
  sources: Readonly<Record<string, readonly string[]>>,
  fileText: (path: string) => string,
): { command: string; key: string }[] {
  return advertised.filter(({ command, key }) => {
    const files = sources[command]
    if (files === undefined) {
      throw new Error(
        `COMMAND_SOURCES has no entry for "${command}". Add the files that read its options.`,
      )
    }
    return !files.some((f) => readsOption(fileText(f), key))
  })
}

const realFileText = (p: string): string => readFileSync(join(SRC, p), 'utf-8')

describe('REQ-0499 §3 — every advertised CLI option has a read site', () => {
  it('finds no unwired options in the real tree', () => {
    const unwired = findUnwiredOptions(allAdvertisedOptions(), COMMAND_SOURCES, realFileText)
    // Named in the message so a failure says WHICH flag lies, not just a count.
    expect(unwired.map((u) => `${u.command} --${u.key}`)).toEqual([])
  })

  it('covers every command help advertises (no silently skipped command)', () => {
    const commands = new Set(allAdvertisedOptions().map((o) => o.command))
    for (const c of commands) expect(COMMAND_SOURCES[c], `missing sources for ${c}`).toBeDefined()
  })
})

/**
 * ★ Negative controls (REQ-0499 §3-2).
 *
 * A gate that cannot go red proves nothing. This project has already shipped a
 * negative control that silently exercised the FIXED code and therefore passed
 * unconditionally, so both controls below run the real checker against a tree
 * that is broken on purpose and assert it reports the breakage.
 */
describe('REQ-0499 §3-2 — the gate detects an unwired option (negative control)', () => {
  it('flags a synthetic option that no source reads', () => {
    const unwired = findUnwiredOptions(
      [{ command: 'burn', key: 'never-read-flag' }],
      { burn: ['fake.ts'] },
      () => `const x = optString(args.opts, 'out')`,
    )
    expect(unwired).toEqual([{ command: 'burn', key: 'never-read-flag' }])
  })

  it('reproduces the REQ-0498 bug: strip the vad-threshold read → the gate goes red', () => {
    // The REAL transcribe.ts with this REQ's fix removed, i.e. the exact tree
    // that shipped before REQ-0499. If the checker cannot catch this, it would
    // not have caught the historical bug either.
    const broken = realFileText('cli/commands/transcribe.ts')
      .replace(/'vad-threshold'/g, "'__removed__'")
      .replace(/'min-speech-ms'/g, "'__removed__'")
      .replace(/'min-silence-ms'/g, "'__removed__'")
    expect(broken).not.toContain("'vad-threshold'")

    const unwired = findUnwiredOptions(
      allAdvertisedOptions().filter((o) => o.command === 'transcribe'),
      { transcribe: ['cli/commands/transcribe.ts', OVERWRITE] },
      (p) => (p === 'cli/commands/transcribe.ts' ? broken : realFileText(p)),
    )
    expect(unwired.map((u) => u.key).sort()).toEqual([
      'min-silence-ms',
      'min-speech-ms',
      'vad-threshold',
    ])
  })

  it('reproduces the REQ-0498 bug: burn --device is caught when re-advertised', () => {
    // `burn --device` was removed from help by this REQ. Re-adding it without
    // wiring must fail — a whole-tree scan would MISS this (device is read by
    // tools.ts and transcribe.ts), which is why COMMAND_SOURCES is per-command.
    const unwired = findUnwiredOptions(
      [{ command: 'burn', key: 'device' }],
      COMMAND_SOURCES,
      realFileText,
    )
    expect(unwired).toEqual([{ command: 'burn', key: 'device' }])
  })
})
