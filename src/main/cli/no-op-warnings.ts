/**
 * REQ-0502 §2 — warn about combinations that are accepted, report success, and
 * change nothing in the render.
 *
 * ## Why this exists
 *
 * REQ-0499 → REQ-0501 removed the flags that were "advertised but unread" and
 * the arguments that were "accepted but undeclared". What survives is one layer
 * up: a flag that IS read, IS applied to the cue, and still produces an
 * identical frame because the renderer skips it under some condition. From the
 * caller's side those are indistinguishable from success — the same blindness,
 * arrived at differently.
 *
 * ## Why it reads the RESOLVED cues, not the flags
 *
 * A condition like "background on with a zero outline" is a property of the
 * cues that will be rendered, whoever produced it — a `.mojioko` authored in
 * the GUI can carry it just as easily as a `--background on` flag. Checking the
 * resolved entries catches both, and needs no bookkeeping about which flags the
 * caller happened to pass.
 *
 * ## Why each check calls the renderer's own resolver
 *
 * The emphasis check runs `resolveEmphasis`, the very function
 * `ass-generator.ts` uses to decide whether emphasis draws. Re-deriving the
 * condition here would create a second implementation that drifts from the
 * first — the failure this codebase has paid for repeatedly (see
 * `style-defaults-to-entry.ts`, which catalogues four instances).
 *
 * ## The bar for adding a check
 *
 * A warning must be *actionable* and *rare*. "Always fires" is the same as "not
 * read". Conditions that are simply correct behaviour — line spacing having no
 * gap to change on a single-line cue, a value that equals the default — are
 * deliberately NOT warned about; they are listed in RES-0502 instead.
 */
import { resolveEmphasis } from '../../shared/emphasis'
import type { SubtitleEntry } from '../../shared/types'
import type { CliWarning } from './output'

/** Cues that will actually be drawn. */
const visible = (entries: readonly SubtitleEntry[]): SubtitleEntry[] =>
  entries.filter((e) => !e.isDeleted && e.text.trim() !== '')

/**
 * Warnings for render conditions that silently produce no visible effect.
 *
 * Pure; the caller decides where they surface (both `burn` and `export_frame`
 * attach them to their success envelope).
 */
export function detectNoOpCombinations(entries: readonly SubtitleEntry[]): CliWarning[] {
  const warnings: CliWarning[] = []
  const cues = visible(entries)

  // (1) Background box + zero outline.
  //
  // libass draws the box as the border of the text, so `\bord0` means there is
  // no box to draw. The GUI prevents this by raising the outline slider's floor
  // to 1 whenever the box is enabled; the CLI deliberately does NOT rewrite the
  // caller's value (silently changing a requested number is its own kind of
  // lie), so the combination is reachable headlessly and has to be reported.
  const boxNoBorder = cues.filter((e) => e.subtitleBackground?.enabled === true && e.outlineThicknessPx <= 0)
  if (boxNoBorder.length > 0) {
    warnings.push({
      code: 'BACKGROUND_BOX_NOT_DRAWN',
      message: `背景ボックスが有効ですが縁の太さが 0 のため、${boxNoBorder.length} 件の cue で箱が描画されません。`,
      detail: {
        cueCount: boxNoBorder.length,
        reason: 'libass は縁（\\bord）として背景ボックスを描くため、太さ 0 では箱が出ません。',
        remedy: '--outline 1 以上を指定してください（GUI は背景 ON のとき縁の下限を 1 に上げています）。',
      },
    })
  }

  // (2) Emphasis enabled with nothing to emphasise.
  //
  // `keywordEmphasisEnabled` is only the master switch; the words come from
  // `emphasisSpans`, which is per-cue character offsets and has no CLI flag
  // (it is meaningless applied uniformly — see RES-0501 §1.2). So
  // `--emphasis on` alone changes zero pixels, which RES-0501 confirmed by
  // measuring. Same guard the writer uses: ranges empty ⇒ nothing drawn.
  const emphasisNoSpans = cues.filter(
    (e) => e.keywordEmphasisEnabled === true && resolveEmphasis(e).ranges.length === 0,
  )
  if (emphasisNoSpans.length > 0) {
    warnings.push({
      code: 'EMPHASIS_NO_SPANS',
      message: `キーワード強調が有効ですが強調対象の語が無いため、${emphasisNoSpans.length} 件の cue で見た目が変わりません。`,
      detail: {
        cueCount: emphasisNoSpans.length,
        reason: '強調は emphasisSpans（cue 内の文字範囲）で対象語を指定する必要があります。',
        remedy: '対象語はアプリの STEP2 インスペクタ「編集」で指定します（CLI からの指定は未対応）。',
      },
    })
  }

  // (3) Shadow with the background box on.
  //
  // The writer skips `\shad`/`\4c`/`\4a` entirely when the box is enabled
  // (`ass-generator.ts`: `if (rawDepth > 0 && !rowBgEnabled)`), and even the
  // animated path is handed `shadowPx: 0`, so a requested shadow cannot
  // reappear. Entry-level and rare — exactly the shape a warning should have.
  const shadowUnderBox = cues.filter((e) => e.subtitleBackground?.enabled === true && (e.shadowDepth ?? 0) > 0)
  if (shadowUnderBox.length > 0) {
    warnings.push({
      code: 'SHADOW_SUPPRESSED_BY_BACKGROUND',
      message: `背景ボックスが有効なため、${shadowUnderBox.length} 件の cue で影が描画されません。`,
      detail: {
        cueCount: shadowUnderBox.length,
        reason: '背景ボックス有効時、ASS ライタは影（\\shad）を出力しません。',
        remedy: '影を使うなら --background off、箱を使うなら --shadow 0 を指定してください。',
      },
    })
  }

  // (4) Background box at zero opacity.
  //
  // Worse than it looks: under BorderStyle=3 the box and the text outline share
  // the same alpha channel, so `--background-opacity 0` removes the box AND the
  // outline. A caller reading "opacity 0" expects an invisible box, not a
  // caption that also lost its border.
  const boxInvisible = cues.filter(
    (e) => e.subtitleBackground?.enabled === true && e.subtitleBackground.opacityPercent === 0,
  )
  if (boxInvisible.length > 0) {
    warnings.push({
      code: 'BACKGROUND_BOX_INVISIBLE',
      message: `背景ボックスの不透明度が 0 のため、${boxInvisible.length} 件の cue で箱と文字の縁が両方消えます。`,
      detail: {
        cueCount: boxInvisible.length,
        reason: '背景ボックスと縁は同じアルファチャンネル（\\3a）を共有するため、0 にすると縁も消えます。',
        remedy: '--background-opacity を 1 以上にするか、箱が不要なら --background off にしてください。',
      },
    })
  }

  return warnings
}

/**
 * REQ-0502 §2-3 — warnings that need to know what the caller ASKED FOR.
 *
 * The detector above reads resolved cues, which is right for conditions that
 * are true regardless of origin. But "you passed `--outline-color` and it was
 * ignored" cannot be seen in a cue: the resolved entry looks the same whether
 * the colour came from a flag, a preset, or the project file. Bending the
 * entry-level detector to cover these would make it fire on ordinary input
 * (every centred burn carries a default margin), so this is a separate,
 * explicitly flag-keyed pass rather than a widening of the first.
 *
 * Each case is: the caller passed X, and the render provably ignores X.
 */
export function detectIgnoredFlags(
  opts: Readonly<Record<string, string | boolean>>,
  entries: readonly SubtitleEntry[],
): CliWarning[] {
  const warnings: CliWarning[] = []
  const cues = visible(entries)
  if (cues.length === 0) return warnings
  const passed = (key: string): boolean => opts[key] !== undefined && opts[key] !== ''
  const all = (fn: (e: SubtitleEntry) => boolean): boolean => cues.every(fn)

  const ignored = (code: string, flags: string[], message: string, reason: string, remedy: string): void => {
    const used = flags.filter(passed)
    if (used.length === 0) return
    warnings.push({
      code,
      message: `${used.map((f) => `--${f}`).join(' / ')} は${message}`,
      detail: { ignoredFlags: used, reason, remedy },
    })
  }

  // The background box repaints the border channel, and the writer emits the
  // box tags AFTER the outline tags, so libass's last-write-wins discards them.
  if (all((e) => e.subtitleBackground?.enabled === true)) {
    ignored(
      'OUTLINE_OVERRIDDEN_BY_BACKGROUND',
      ['outline-color', 'outline-alpha'],
      '背景ボックスが有効なため無視されます。',
      '背景ボックスは縁の色・アルファ（\\3c / \\3a）を上書きします。',
      '縁の色を効かせたい場合は --background off を指定してください。',
    )
  }

  // Emphasis colour/scale are read only inside the `keywordEmphasisEnabled`
  // gate. `EMPHASIS_NO_SPANS` cannot cover this: it requires enabled === true.
  if (all((e) => e.keywordEmphasisEnabled !== true)) {
    ignored(
      'EMPHASIS_FLAGS_WITHOUT_EMPHASIS',
      ['emphasis-color', 'emphasis-scale'],
      'キーワード強調が無効なため無視されます。',
      '強調の色・拡大率は強調が有効な cue にのみ適用されます。',
      '--emphasis on を併せて指定してください。',
    )
  }

  // Karaoke colour/style are only consulted inside `if (karaokeActive)`.
  if (all((e) => e.karaokeEnabled !== true)) {
    ignored(
      'KARAOKE_FLAGS_WITHOUT_KARAOKE',
      ['karaoke-color', 'karaoke-style'],
      'カラオケが無効なため無視されます。',
      '発話色・表示方式はカラオケが有効な cue にのみ適用されます。',
      '--karaoke on を併せて指定してください。',
    )
  }

  // The whole background block is skipped when the box is off.
  if (all((e) => e.subtitleBackground?.enabled !== true)) {
    ignored(
      'BACKGROUND_FLAGS_WITHOUT_BACKGROUND',
      ['background-color', 'background-opacity'],
      '背景ボックスが無効なため無視されます。',
      '背景の色・不透明度は箱が有効な cue にのみ適用されます。',
      '--background on を併せて指定してください。',
    )
  }

  // `--margin-v` is the bottom/top offset; a centre-anchored cue is placed from
  // the frame midpoint and never reads it, and a `\pos`-pinned cue uses posY.
  // Entry-keyed detection is impossible here — every centred cue carries a
  // margin value, so it would fire on essentially every centred burn.
  if (passed('margin-v')) {
    if (all((e) => e.verticalPosition === 'center')) {
      ignored(
        'MARGIN_V_IGNORED',
        ['margin-v'],
        '縦位置が center のため無視されます。',
        'center 配置は画面中央から配置されるため縦マージンを参照しません。',
        '--position top または bottom を併せて指定してください。',
      )
    } else if (all((e) => e.posX !== undefined && e.posY !== undefined)) {
      ignored(
        'MARGIN_V_IGNORED',
        ['margin-v'],
        'cue が絶対座標に固定されているため無視されます。',
        '\\pos で固定された cue は縦マージンではなく posY を使います。',
        '--position を併せて指定すると固定が解除され、縦マージンが効きます。',
      )
    }
  }

  return warnings
}
