/**
 * REQ-0555 §2 — the structural cue operations: `add_cue`, `duplicate_cue`,
 * `reset_cue`.
 *
 * ## One implementation, two callers
 *
 * Every decision these make is the GUI's decision, reached through the GUI's
 * own code: `computeAddInsertion` / `buildNewCue` / `buildResetPatch`
 * (`renderer/lib/cue-structure.ts`, extracted from `step2.tsx` and
 * `entry-row-actions.ts` in this REQ) and `buildDuplicateEntry`
 * (`renderer/lib/duplicate-entry.ts`, REQ-0322). Nothing about where a cue
 * lands or what fields it starts with is decided here.
 *
 * That is the whole point of §2-4. A second implementation written carefully
 * against the same spec would pass its own tests and still drift — REQ-0322
 * documents the duplication field list drifting SIXTEEN fields behind the type
 * before anyone noticed, because duplication was written out by hand once and
 * then the type grew.
 *
 * ## Why three commands rather than fields on `edit_cues`
 *
 * RES-0552's wave plan, unchanged: `edit_cues` patches cues that exist, and its
 * `select` is meaningless for a cue that does not exist yet. Folding "create"
 * into a patch tool would mean a `select` that sometimes addresses and
 * sometimes names.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { parseProjectFile, serializeProjectFile } from '../../../shared/project-file'
import { nextCueNumber } from '../../../shared/cue-number'
import { BURNIN_DEFAULTS } from '../../../shared/burnin-defaults'
import type { RenderNotice } from '../../../shared/render-notice'
import { buildDuplicateEntry } from '../../../renderer/lib/duplicate-entry'
import {
  buildNewCue,
  buildResetPatch,
  computeAddInsertion,
  hasResetTarget,
} from '../../../renderer/lib/cue-structure'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitSuccess, type CliContext } from '../output'
import { assertWritable } from '../overwrite'
import { detectFormat } from '../subtitle-io'
import type { ProjectFile } from '../../../shared/project-file'
import type { SubtitleEntry } from '../../../shared/types'

/** Load a `.mojioko`, refusing anything else with the reason. */
function loadProject(input: string, args: ParsedArgs, command: string): ProjectFile {
  if (!existsSync(input)) {
    throw new CliError('INPUT_NOT_FOUND', `入力が見つかりません: ${input}`, 'パスを確認してください。')
  }
  const fmt = detectFormat(input, optString(args.opts, 'from'))
  if (fmt !== 'mojioko') {
    throw new CliError('UNSUPPORTED_FORMAT', `${command} は .mojioko のみ対応です。`,
      'SRT には cue のスタイルも original も無いため、まず convert してください。')
  }
  const parsed = parseProjectFile(readFileSync(input, 'utf-8'))
  if (!parsed.ok) throw new CliError('UNSUPPORTED_FORMAT', `.mojioko を読み取れません（${parsed.reason}）。`)
  return parsed.project
}

function writeProject(project: ProjectFile, out: string): void {
  try {
    writeFileSync(out, serializeProjectFile(project), 'utf-8')
  } catch (e) {
    throw new CliError('OUTPUT_WRITE_FAILED', `出力を書き込めません: ${out}`,
      '出力先の権限・パスを確認してください。', { error: e instanceof Error ? e.message : String(e) })
  }
}

/** `read_subtitle`'s index (non-deleted cues only) → array position. */
function positionOfVisibleIndex(entries: readonly SubtitleEntry[], index: number): number {
  const visible = entries.map((e, i) => ({ e, i })).filter((x) => !x.e.isDeleted)
  if (index < 0 || index >= visible.length) {
    throw new CliError('USAGE', `--index ${index} は範囲外（cue 数 ${visible.length}）。`,
      'read_subtitle で番号を確認してください。')
  }
  return visible[index].i
}

/** The visible index a cue at array position `pos` has. */
function visibleIndexOf(entries: readonly SubtitleEntry[], pos: number): number {
  let n = 0
  for (let i = 0; i < pos; i++) if (!entries[i].isDeleted) n++
  return entries[pos].isDeleted ? -1 : n
}

/**
 * Resolve `--index` / `--id` to an array position. Shared by duplicate/reset,
 * which both address an existing cue.
 */
function selectOne(entries: readonly SubtitleEntry[], args: ParsedArgs): number {
  const id = optString(args.opts, 'id')
  const indexStr = optString(args.opts, 'index')
  if (id !== undefined && indexStr !== undefined) {
    throw new CliError('USAGE', '--id と --index は同時に指定できません。', 'どちらか一方にしてください。')
  }
  if (id !== undefined) {
    const pos = entries.findIndex((e) => e.id === id)
    if (pos === -1) throw new CliError('USAGE', `id が見つかりません: ${id}`, 'read_subtitle で id を確認してください。')
    return pos
  }
  if (indexStr === undefined) {
    throw new CliError('USAGE', '--index N か --id <cue-id> が必要です。')
  }
  const index = Number.parseInt(indexStr, 10)
  if (!Number.isInteger(index)) throw new CliError('USAGE', '--index は整数です。')
  return positionOfVisibleIndex(entries, index)
}

/*
 * A fresh id. The GUI uses `new-<uuid>` / `srt-<uuid>`; headless additions are
 * tagged `cli-` so a project's provenance stays readable, and the prefix set
 * stays the thing that distinguishes them rather than the uuid shape.
 */
const mintId = (prefix: string): string => `${prefix}-${randomUUID()}`

// ---------------------------------------------------------------------------
// add_cue
// ---------------------------------------------------------------------------

export async function runAddCueCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const input = args.positionals[0] ?? optString(args.opts, 'input')
  if (!input) throw new CliError('USAGE', '入力字幕が必要です。', 'mojioko add_cue <in.mojioko> -o <out> --start 1.0 --end 3.0')
  const out = optString(args.opts, 'out') ?? input
  if (out !== input) assertWritable(out, args.opts)

  const project = loadProject(input, args, 'add_cue')
  const entries = project.editing.subtitles

  const num = (key: string): number | undefined => {
    const raw = optString(args.opts, key)
    if (raw === undefined) return undefined
    const v = Number.parseFloat(raw)
    if (!Number.isFinite(v)) throw new CliError('USAGE', `--${key} は秒数（数値）です: ${raw}`)
    return v
  }
  const startSec = num('start')
  const endSec = num('end')
  if (startSec === undefined || endSec === undefined) {
    throw new CliError('USAGE', '--start と --end（秒）が必要です。', '--start 1.0 --end 3.0')
  }
  if (!(endSec > startSec)) {
    throw new CliError('USAGE', 'end は start より後である必要があります。')
  }

  const warnings: RenderNotice[] = []
  /*
   * The GUI clamps a cue to the video's duration and TELLS the user it did
   * (REQ-0528 §2). Headless gets the same treatment — silently keeping a cue
   * that starts after the video ends would produce a project the GUI then
   * shows differently from what the caller asked for.
   */
  const durationSec = project.source?.durationSec
  if (typeof durationSec === 'number' && durationSec > 0 && startSec >= durationSec) {
    warnings.push({
      code: 'CUE_BEYOND_DURATION',
      message: '追加した cue の開始時刻が動画の長さを超えています（焼き込みでは描画されません）。',
      detail: { startSec, durationSec, remedy: '--start を動画の長さ未満にしてください。' },
    })
  }

  const { fullIdx, visiblePos } = computeAddInsertion(entries, startSec)
  const built = buildNewCue({
    id: mintId('cli'),
    startSec,
    endSec,
    text: optString(args.opts, 'text') ?? '',
    // The GUI seeds this from `settings.fadeDurationSec`; headless has no
    // settings store, so it uses the same fixed default that setting itself
    // starts from.
    fadeDurationSec: BURNIN_DEFAULTS.fadeDurationSec,
    defaults: project.editing.defaults,
    videoWidthPx: project.source?.resolution?.width,
    videoHeightPx: project.source?.resolution?.height,
  })
  // The store's `addEntry` mints the display number; headless does the same so
  // a cue added either way is numbered the same way (REQ-0400).
  const entry: SubtitleEntry = { ...built, cueNumber: nextCueNumber(entries) }
  entries.splice(fullIdx, 0, entry)

  writeProject(project, out)
  return emitSuccess(ctx, 'add_cue', {
    inputPath: input,
    outputPath: out,
    id: entry.id,
    index: visibleIndexOf(entries, fullIdx),
    visiblePosition: visiblePos,
    cueCount: entries.filter((e) => !e.isDeleted).length,
  }, warnings)
}

// ---------------------------------------------------------------------------
// duplicate_cue
// ---------------------------------------------------------------------------

export async function runDuplicateCueCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const input = args.positionals[0] ?? optString(args.opts, 'input')
  if (!input) throw new CliError('USAGE', '入力字幕が必要です。', 'mojioko duplicate_cue <in.mojioko> -o <out> --index 0')
  const out = optString(args.opts, 'out') ?? input
  if (out !== input) assertWritable(out, args.opts)

  const project = loadProject(input, args, 'duplicate_cue')
  const entries = project.editing.subtitles
  const pos = selectOne(entries, args)
  const source = entries[pos]

  // REQ-0322's exhaustively-typed duplication — the same call `duplicateRow`
  // makes. A hand-written copy here is exactly the bug that module exists for.
  const duplicate: SubtitleEntry = {
    ...buildDuplicateEntry(source, mintId('cli-dup')),
    cueNumber: nextCueNumber(entries),
  }
  // GUI insertion order: immediately after its source (`addEntry(dup, idx + 1)`).
  entries.splice(pos + 1, 0, duplicate)

  writeProject(project, out)
  return emitSuccess(ctx, 'duplicate_cue', {
    inputPath: input,
    outputPath: out,
    sourceId: source.id,
    id: duplicate.id,
    index: visibleIndexOf(entries, pos + 1),
    cueCount: entries.filter((e) => !e.isDeleted).length,
  })
}

// ---------------------------------------------------------------------------
// reset_cue
// ---------------------------------------------------------------------------

export async function runResetCueCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const input = args.positionals[0] ?? optString(args.opts, 'input')
  if (!input) throw new CliError('USAGE', '入力字幕が必要です。', 'mojioko reset_cue <in.mojioko> -o <out> --index 0')
  const out = optString(args.opts, 'out') ?? input
  if (out !== input) assertWritable(out, args.opts)

  const project = loadProject(input, args, 'reset_cue')
  const entries = project.editing.subtitles
  const pos = selectOne(entries, args)
  const entry = entries[pos]

  const warnings: RenderNotice[] = []
  if (!hasResetTarget(entry)) {
    /*
     * REQ-0555 §2-3 — a warning and NO change, not an error. A cue with no
     * `original` is already in its initial state as far as anything can tell;
     * failing the call would make "reset everything" unusable on a project that
     * contains one such cue, for no benefit.
     */
    warnings.push({
      code: 'RESET_NO_ORIGINAL',
      message: 'この cue には復元元（original）が無いため、リセットしても何も変わりません。',
      detail: { cueId: entry.id, index: visibleIndexOf(entries, pos),
        reason: 'original はプロジェクト作成時に記録されます。',
        remedy: '意図した cue か read_subtitle で確認してください。' },
    })
    writeProject(project, out)
    return emitSuccess(ctx, 'reset_cue', {
      inputPath: input, outputPath: out, id: entry.id,
      index: visibleIndexOf(entries, pos), changed: false,
    }, warnings)
  }

  entries[pos] = { ...entry, ...buildResetPatch(entry) } as SubtitleEntry

  writeProject(project, out)
  return emitSuccess(ctx, 'reset_cue', {
    inputPath: input,
    outputPath: out,
    id: entry.id,
    index: visibleIndexOf(entries, pos),
    changed: true,
  }, warnings)
}
