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
import { isAnimationInert, resolveAnimation } from '../../shared/cue-animation'
import { ASS_HARD_BREAK } from '../../shared/line-spacing'
import { resolveEmphasis } from '../../shared/emphasis'
import { applyFontPolicy, groupFontSubstitutions, type FontTierSubstitution } from '../../shared/font-tier'
import { getFontMeta, type FontId } from '../../shared/fonts'
import type { TierResolution } from '../lib/tier'
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

  // (5) REQ-0516 §3 — a scale animation on a MULTI-LINE cue: the line pitch
  // does not scale in the burn, and the preview says otherwise.
  //
  // The all-`\pos` runtime emits a multi-line cue as one event PER LINE, so
  // libass scales each line about that line's own anchor and the distance
  // between the lines stays put.  The preview scales the whole block, gaps
  // included.  Measured at `\fs100`, S = 0.705 (RES-0514 §5-3), as the cue's
  // ink height against its settled height — a pure block scale would give
  // 0.705 for all of them:
  //
  //     1 line          0.732        2 lines, spacing 0     0.904
  //     2 lines, -20 %  0.890        2 lines, +100 %        0.941
  //
  // NOTE it fires at line spacing 0 as well: the per-line split is what the
  // all-`\pos` placement does, not something line spacing turns on.
  //
  // This is the one entry here that is a preview↔burn DIVERGENCE rather than a
  // pure no-op, which is the same shape `detectFontSubstitutions` has (it
  // reports a change, not an omission).  It belongs in this pass anyway: from
  // the caller's side the animation was accepted and part of it — the pitch —
  // provably does nothing, which is exactly what this function reports.
  //
  // Fixing it is not a warning's job: the per-line `\pos` values would have to
  // move over time, and `\t` cannot animate `\pos` (`\move` is one per event
  // and linear only — `dev-docs/specs/event-splitting.md`).  Owner decision,
  // REQ-0516 §3-1: warn, do not fix.
  const scaledMultiline = cues.filter((e) => {
    // The renderer's own resolver, not a re-derivation — same rule as the
    // emphasis check above.
    const spec = resolveAnimation(e)
    if (isAnimationInert(spec)) return false
    if (spec.type !== 'scale' && spec.type !== 'pop') return false
    // Lines with something ON them.  Counting raw `\N`s would fire on a cue
    // like `テスト\N` — the writer does emit two events for it, but the second
    // draws nothing, so there is no visible pitch to be wrong about and the
    // warning would be noise.  (`visible()` above cannot catch that: it trims
    // the whole cue, and a cue of `  \N  ` trims to the sentinel, not to ''.)
    return e.text.split(ASS_HARD_BREAK).filter((line) => line.trim() !== '').length > 1
  })
  if (scaledMultiline.length > 0) {
    warnings.push({
      code: 'SCALE_ANIM_LINE_PITCH_FIXED',
      message:
        `拡大縮小するアニメーション（scale / pop）が有効な複数行 cue が ${scaledMultiline.length} 件あります。` +
        '焼き込みでは行と行の間隔だけが拡大縮小しません（文字は拡大縮小します）。' +
        'プレビューは行間ごと拡大縮小するため、見え方が異なります。',
      detail: {
        cueCount: scaledMultiline.length,
        reason:
          '複数行の cue は 1 行 = 1 イベントとして出力され、libass は各行をその行自身の' +
          'アンカーを中心に拡大縮小するため、行のピッチは固定のままになります。行間の設定が 0 でも同じです。',
        remedy:
          '行間まで拡大縮小させたい場合は、その cue を 1 行にするか、アニメーションを ' +
          'none / fade / blur のいずれかにしてください。',
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

/**
 * REQ-0508 §1-3 / REQ-0509 §2 — a font was replaced, and the caller is told
 * which one, what with, and **why**.
 *
 * Two codes, because the two causes have different remedies (REQ-0509 §2-2):
 *
 *   - `FONT_TIER_SUBSTITUTED` — a paid family in a free build. Remedy: the paid
 *     edition. Downloading the font would not help.
 *   - `FONT_UNAVAILABLE` — the TTF is not on disk. Remedy: download it in
 *     Settings ▸ Fonts. Nothing to buy.
 *
 * A font that is BOTH gets the tier code only (see `FontSubstitutionReason`), so
 * one cue never produces two warnings.
 *
 * ## Which of the two families this belongs to
 *
 * **Cue-derived**, like `detectNoOpCombinations`: the condition is a property
 * of the cues about to be rendered, no matter where the font came from. A
 * `.mojioko` authored in the paid edition carries paid `fontId`s with no flag
 * involved at all, and that is the main case this REQ exists for. Keying it on
 * flags would report `--weight` while missing the project file entirely.
 *
 * It differs from its neighbours in one way worth stating: those warn that
 * something was ignored, this warns that something was CHANGED. Substituting
 * silently would be the exact failure mode REQ-0499 → REQ-0506 removed — an
 * output that is not what was asked for, reported as plain success.
 *
 * ## Why it recomputes rather than being handed the result
 *
 * The substitution happens deep inside `ffmpeg-burnin` / `frame-exporter`,
 * after the CLI has already built its warning list. Rather than thread a
 * channel back out, both sides call the same pure `applyFontPolicy` with the
 * same probe, so the warning cannot describe a substitution different from the
 * one performed.
 */
export function detectFontSubstitutions(
  entries: readonly SubtitleEntry[],
  defaultFontId: FontId,
  tier: TierResolution,
  isInstalled: (id: FontId) => boolean,
): CliWarning[] {
  const policy = applyFontPolicy({
    isPaid: tier.isPaid,
    isInstalled,
    defaultFontId,
    entries: visible(entries),
  })
  if (policy.substitutions.length === 0) return []

  const describe = (id: FontId): string => getFontMeta(id).displayName
  const pairs = (subs: FontTierSubstitution[]): string =>
    subs.map((s) => `${describe(s.from)} → ${describe(s.to)}`).join(' / ')

  /**
   * REQ-0510 §1-2 — the split into codes comes from `groupFontSubstitutions`,
   * shared with the GUI. This function now only writes the CLI's sentences; a
   * second copy of "tier ⇒ which code" here is what would let the two surfaces
   * disagree about the same burn.
   */
  return groupFontSubstitutions(policy, defaultFontId).map((notice) => {
    const scope = `（対象 ${notice.cueCount} cue${notice.defaultSubstituted ? '＋プロジェクト既定フォント' : ''}）`
    const detail: Record<string, unknown> = {
      tier: tier.tier,
      tierSource: tier.source,
      substitutedCueCount: notice.cueCount,
      defaultSubstituted: notice.defaultSubstituted,
      substitutions: notice.substitutions.map((s) => ({
        from: s.from,
        fromName: describe(s.from),
        to: s.to,
        toName: describe(s.to),
        cueCount: s.cueCount,
      })),
    }
    if (notice.code === 'FONT_TIER_SUBSTITUTED') {
      return {
        code: notice.code,
        message: `追加フォントは有料版の機能です。無料版のため ${pairs(notice.substitutions)} に置換して描画します${scope}。`,
        detail: {
          ...detail,
          remedy:
            '追加 12 書体を焼き込むには有料版（Microsoft Store 版）が必要です。' +
            '無料版では同梱の Noto Sans JP 全 9 ウェイトが使えます。',
        },
      }
    }
    return {
      code: notice.code,
      message:
        `フォントファイルが見つからないため ${pairs(notice.substitutions)} に置換して描画します${scope}。` +
        '焼き込み自体は続行しました。',
      detail: {
        ...detail,
        // REQ-0509 §2-4 — the user can fix this one themselves, so say how.
        // Naming the id matters: the GUI list is long and the display name
        // ("Poppins Bold") is not what the download row is keyed by.
        remedy:
          '設定 ▸ フォントから該当フォントをダウンロードしてください（' +
          notice.substitutions.map((s) => s.from).join(', ') +
          '）。ダウンロード済みのはずなら、ファイルが削除・移動されていないか確認してください。',
      },
    }
  })
}
