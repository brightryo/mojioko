/**
 * REQ-0504 — `mojioko preset list | show | save | delete`.
 *
 * ## Why this exists
 *
 * Presets were apply-only from the CLI (`burn --style <name>`). Since per-cue
 * styling is still GUI-only, a preset is currently the ONLY way to move a
 * worked-out look between the app and a headless run — and the bridge only had
 * a deck on one side.
 *
 * ## Where presets live
 *
 * `AppSettings.stylePresets[]` in `%APPDATA%/MOJIOKO/settings.json`. The merge
 * rule for that key is `'incoming-wins'` (`ipc/settings-merge.ts`) with the
 * comment "written only by the renderer … the payload is authoritative". That
 * is precisely why the write path here MUST take the single-instance lock: a
 * running GUI saving settings for any unrelated reason would send its whole
 * in-memory list and silently erase whatever the CLI just wrote.
 *
 * ## What a saved preset is built from
 *
 * A cue in a `.mojioko` (`--from`, `--index`), with the ordinary style flags
 * applied on top. Two reasons over "build it from flags alone":
 *   - Strictly more expressive. Animation has no CLI flags at all, so a
 *     flags-only preset could never carry one; a cue can.
 *   - No new vocabulary. The agent describes the look exactly as it would for a
 *     burn, and saves it instead of rendering it.
 * SRT is rejected: it holds no style, so it could only ever mint a preset of
 * pure defaults while looking like it captured something.
 */
import { existsSync, readFileSync } from 'node:fs'
import { app } from 'electron'
import { loadSettings, mutateSettings } from '../../services/settings-store'
import { parseProjectFile } from '../../../shared/project-file'
import {
  STYLE_PRESET_MAX,
  STYLE_PRESET_NAME_MAX_LEN,
  validatePresetName,
  type StylePreset,
} from '../../../shared/style-preset'
import { buildStylePreset } from '../../../renderer/lib/style-preset-apply'
import type { FontId } from '../../../shared/fonts'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitSuccess, type CliContext, type CliWarning } from '../output'
import { detectFormat } from '../subtitle-io'
import { applyStyleOverrides, parseStyleOverrides } from '../style-overrides'
import { findStylePreset } from '../style-preset-cli'
import { summarizeSubtitleStyle } from '../subtitle-style'

/** A compact per-preset row for `list` (full contents come from `show`). */
function summarize(p: StylePreset): Record<string, unknown> {
  const style = p.style as unknown as Record<string, unknown>
  const has = (k: string): boolean => style[k] !== undefined
  return {
    name: p.name,
    id: p.id,
    version: p.version,
    createdAtMs: p.createdAtMs,
    fieldCount: Object.keys(style).length,
    // The axes an agent is most likely to be choosing between.
    fontSizePx: style.fontSizePx ?? null,
    textColorHex: style.textColorHex ?? null,
    karaokeEnabled: style.karaokeEnabled ?? null,
    emphasisEnabled: style.keywordEmphasisEnabled ?? null,
    animationType: style.animationType ?? null,
    backgroundEnabled: (style.subtitleBackground as { enabled?: boolean } | undefined)?.enabled ?? null,
    /** REQ-0504 §1-2 — whether this preset will pin cues when applied. */
    carriesPosition: has('posOffsetX') && has('posOffsetY'),
  }
}

/**
 * Refuse to write while the MOJIOKO app is running.
 *
 * The GUI holds the single-instance lock, so failing to acquire it means the
 * app is up.
 *
 * ## Why there is no `--force` escape (REQ-0505 §2)
 *
 * `tools use` has one, and this command shipped with a copy of it. But the two
 * are not analogous: `stylePresets` is `'incoming-wins'` and documented as
 * renderer-owned, so the GUI's very next settings save replaces the WHOLE array
 * with its in-memory copy. A forced write therefore reports success and then
 * disappears — which is exactly the "succeeds but does not take effect" class
 * REQ-0499 onwards has been removing. Shipping a flag whose entire purpose is
 * to produce that outcome would undo the point of the last six REQs, so the
 * flag is gone rather than merely discouraged.
 */
function requireLock(action: string): void {
  if (app.requestSingleInstanceLock()) return
  throw new CliError(
    'USAGE',
    `MOJIOKO アプリ起動中は CLI からプリセットを${action}できません（競合回避）。`,
    'MOJIOKO を終了してから再実行してください。アプリ起動中の書き込みはアプリ側の保存で失われるため、強制する手段は用意していません。',
    // REQ-0533 — machine-readable, because "the app happens to be open" is not
    // a usage mistake and a caller has to be able to tell the two apart. An
    // agent that retries on USAGE would otherwise rewrite its arguments
    // forever; the fix is to close the app, which no argument expresses.
    // `verify:cli-smoke` keys its skip off this instead of pattern-matching a
    // localised message.
    { reason: 'app-running' },
  )
}

/** Translate the shared name-rule verdict into a CLI error. */
function assertNameOk(name: string, existing: readonly StylePreset[], ignoreId?: string): void {
  // REQ-0504 §1-2 — the GUI's rules, reused verbatim. A CLI-specific rule set
  // would let the CLI mint names the GUI then refuses to rename or re-save.
  const verdict = validatePresetName(name, existing, ignoreId ? { ignoreId } : undefined)
  if (verdict === null) return
  const messages: Record<string, [string, string]> = {
    empty: ['プリセット名が空です。', '名前を指定してください。'],
    'too-long': [`プリセット名が長すぎます（最大 ${STYLE_PRESET_NAME_MAX_LEN} 文字）。`, '短い名前にしてください。'],
    duplicate: [`プリセット "${name.trim()}" は既に存在します。`, '--overwrite で置き換えるか、別名にしてください。'],
    'cap-reached': [`プリセットは最大 ${STYLE_PRESET_MAX} 件までです。`, '不要なプリセットを preset delete で削除してください。'],
  }
  const [message, remedy] = messages[verdict]
  throw new CliError(verdict === 'duplicate' ? 'OUTPUT_EXISTS' : 'USAGE', message, remedy, { name: name.trim(), reason: verdict })
}

export async function runPresetCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? 'list'
  switch (sub) {
    case 'list':
      return runList(ctx)
    case 'show':
      return runShow(ctx, args)
    case 'save':
      return runSave(ctx, args)
    case 'delete':
      return runDelete(ctx, args)
    default:
      throw new CliError('USAGE', `unknown preset subcommand: "${sub}"`, 'list | show <name> | save <name> --from <sub.mojioko> | delete <name>')
  }
}

async function runList(ctx: CliContext): Promise<number> {
  const settings = await loadSettings()
  const presets = settings.stylePresets ?? []
  return emitSuccess(ctx, 'preset', {
    subcommand: 'list',
    count: presets.length,
    max: STYLE_PRESET_MAX,
    presets: presets.map(summarize),
  })
}

async function runShow(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const name = args.positionals[1] ?? optString(args.opts, 'name')
  if (!name) throw new CliError('USAGE', 'プリセット名が必要です。', 'mojioko preset show <name>')
  const settings = await loadSettings()
  const presets = settings.stylePresets ?? []
  const preset = findStylePreset(presets, name)
  if (!preset) {
    throw new CliError('USAGE', `プリセット "${name}" が見つかりません。`, `利用可能: ${presets.map((p) => p.name).join(', ') || '(なし)'}`)
  }
  return emitSuccess(ctx, 'preset', {
    subcommand: 'show',
    ...summarize(preset),
    // The raw stored payload, so an agent can diff two presets exactly.
    style: preset.style,
  })
}

async function runSave(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const name = args.positionals[1] ?? optString(args.opts, 'name')
  if (!name) throw new CliError('USAGE', 'プリセット名が必要です。', 'mojioko preset save <name> --from <sub.mojioko>')

  const from = optString(args.opts, 'from')
  if (!from) {
    throw new CliError('USAGE', '--from <subtitle.mojioko> が必要です。', 'プリセットは .mojioko の cue から作ります（スタイルフラグは上乗せできます）。')
  }
  if (!existsSync(from)) throw new CliError('INPUT_NOT_FOUND', `字幕が見つかりません: ${from}`, 'パスを確認してください。')
  if (detectFormat(from, optString(args.opts, 'format')) !== 'mojioko') {
    throw new CliError(
      'UNSUPPORTED_FORMAT',
      'プリセットの元にできるのは .mojioko だけです。',
      'SRT はスタイルを保持しないため、既定値だけのプリセットになってしまいます。mojioko convert で .mojioko にしてください。',
    )
  }

  const parsed = parseProjectFile(readFileSync(from, 'utf-8'))
  if (!parsed.ok) throw new CliError('UNSUPPORTED_FORMAT', `.mojioko を読み取れません（${parsed.reason}）。`)

  const cues = parsed.project.editing.subtitles.filter((e) => !e.isDeleted)
  if (cues.length === 0) throw new CliError('USAGE', 'cue がありません。', '字幕を含む .mojioko を指定してください。')
  const indexRaw = optString(args.opts, 'index')
  const index = indexRaw === undefined ? 0 : Number.parseInt(indexRaw, 10)
  if (!Number.isInteger(index) || index < 0 || index >= cues.length) {
    throw new CliError('USAGE', `--index ${indexRaw ?? 0} は範囲外（cue 数 ${cues.length}）。`, 'read_subtitle で番号を確認してください。')
  }

  // Style flags layer on top of the captured cue, using the same parser the
  // burn path uses — so "the flags that produced the look I want" and "the
  // preset that reproduces it" are written the same way.
  const settings = await loadSettings()
  const fontId = (settings.activeFontId ?? 'noto-sans-jp-semibold') as FontId
  const [entry] = applyStyleOverrides([cues[index]], parseStyleOverrides(args.opts, fontId))

  // Geometry for the `\pos` → anchor-offset conversion comes from the project's
  // own `source.resolution`; no `--video` needed.
  const geometry = {
    videoWidthPx: parsed.project.source.resolution.width,
    videoHeightPx: parsed.project.source.resolution.height,
  }

  const warnings: CliWarning[] = []
  // REQ-0504 §1-2 — if the cue IS pinned but geometry is unusable, the offset
  // cannot be computed and the position is dropped. Saying so is the mirror of
  // the RES-0503 complaint: a silent drop here would produce a preset that
  // quietly fails to reproduce the look it was saved from.
  const pinned = entry.posX !== undefined && entry.posY !== undefined
  if (pinned && !(geometry.videoWidthPx && geometry.videoHeightPx)) {
    warnings.push({
      code: 'PRESET_POSITION_NOT_SAVED',
      message: 'cue は固定座標を持っていますが、動画の解像度が不明なため位置はプリセットに保存されません。',
      detail: {
        reason: '位置はアンカーからのオフセットとして保存するため、動画の幅・高さが要ります。',
        remedy: '動画情報を含む .mojioko（mojioko convert --video で作成）を --from に指定してください。',
      },
    })
  }

  const existing = settings.stylePresets ?? []
  const prior = findStylePreset(existing, name)
  const overwrite = args.opts.overwrite === true
  if (prior && !overwrite) {
    // Matches every other output-producing command: refuse, name the flag.
    throw new CliError('OUTPUT_EXISTS', `プリセット "${prior.name}" は既に存在します。`, '--overwrite で置き換えるか、別名にしてください。', { name: prior.name })
  }
  assertNameOk(name, existing, prior?.id)

  requireLock('保存')

  // Reuse of the id on overwrite is deliberate: anything already referring to
  // this preset keeps referring to the same thing.
  const preset = buildStylePreset(entry, name, geometry, prior?.id)

  const saved = await mutateSettings((s) => {
    const list = [...(s.stylePresets ?? [])]
    const at = prior ? list.findIndex((p) => p.id === prior.id) : -1
    if (at >= 0) list[at] = preset
    else list.push(preset)
    s.stylePresets = list
    return { save: s, value: list.length }
  })

  return emitSuccess(
    ctx,
    'preset',
    {
      subcommand: 'save',
      ...summarize(preset),
      replaced: prior !== undefined,
      sourceSubtitle: from,
      sourceCueIndex: index,
      presetCount: saved,
      // What the preset will actually reproduce, in the same shape `status` and
      // `burn` report — so the agent can verify without applying it.
      style: summarizeSubtitleStyle(entry, settings.autoLineBreak ?? true),
    },
    warnings,
  )
}

async function runDelete(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const name = args.positionals[1] ?? optString(args.opts, 'name')
  if (!name) throw new CliError('USAGE', 'プリセット名が必要です。', 'mojioko preset delete <name>')

  const settings = await loadSettings()
  const existing = settings.stylePresets ?? []
  const preset = findStylePreset(existing, name)
  // REQ-0504 §2-4 — never a silent success. Deleting something that is not
  // there means the caller's model of the world is wrong, and it should learn.
  if (!preset) {
    throw new CliError('USAGE', `プリセット "${name}" が見つかりません。`, `利用可能: ${existing.map((p) => p.name).join(', ') || '(なし)'}`)
  }

  requireLock('削除')

  const remaining = await mutateSettings((s) => {
    const list = (s.stylePresets ?? []).filter((p) => p.id !== preset.id)
    s.stylePresets = list
    return { save: s, value: list.length }
  })

  return emitSuccess(ctx, 'preset', {
    subcommand: 'delete',
    deleted: preset.name,
    id: preset.id,
    presetCount: remaining,
    /**
     * REQ-0506 §2-3 — the FULL deleted preset, so an accidental delete is
     * recoverable from the command's own output.
     *
     * Not hypothetical: RES-0505 §4 records exactly that mistake — a
     * `preset delete` run to inspect an error message, against a machine with
     * no GUI open, which succeeded. Recovery there needed a settings backup
     * taken for an unrelated reason.
     *
     * No confirmation prompt (the REQ rules it out, rightly — it would break
     * every scripted and agent-driven use). Returning the payload is the
     * cheaper answer: the delete stays a one-liner, and the undo is a copy of
     * the JSON that just came back.
     */
    removed: preset,
    restoreHint:
      'この JSON の `removed` が削除されたプリセットの全内容です。' +
      '復元するには settings.json の stylePresets に戻すか、同じスタイルの cue から preset save し直してください。',
  })
}
