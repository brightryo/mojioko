import { useTranslation } from 'react-i18next'
import { Switch } from '@/components/ui/switch'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { OutlineThicknessSlider } from '@/components/subtitle-table/outline-thickness-slider'
import { ShadowDepthSlider } from '@/components/subtitle-table/shadow-depth-slider'
import { LineSpacingSlider } from '@/components/subtitle-table/line-spacing-slider'
import { LINE_SPACING_DEFAULT_PERCENT } from '../../../shared/line-spacing'
import { AnimationControls } from '@/components/animation-controls/animation-controls'
import { resolveAnimation, ANIMATION_BLUR_ENABLED } from '../../../shared/cue-animation'
import { OpacityPercentSlider } from '@/components/subtitle-table/opacity-percent-slider'
import { clampOpacityPercent } from '../../../shared/alpha'
import { NumberStepperInput } from '@/components/subtitle-table/number-stepper-input'
import { StyleRow, styleRowColumns } from '@/components/subtitle-table/style-row'
import { SegmentGroup } from '@/components/subtitle-table/segment-group'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX, MARGIN_V_MIN_PX, MARGIN_V_MAX_PX } from '../../../shared/constants'
import { canUseKaraokeInTier, KARAOKE_DEFAULT_HIGHLIGHT_COLOR } from '../../../shared/karaoke-gate'
import {
  canUseKeywordEmphasisInTier,
  EMPHASIS_DEFAULT_COLOR,
  EMPHASIS_DEFAULT_SCALE_PERCENT,
  EMPHASIS_SCALE_MIN_PERCENT,
  EMPHASIS_SCALE_MAX_PERCENT,
  EMPHASIS_SCALE_STEP_PERCENT,
} from '../../../shared/emphasis'
import type { TranscriptionDefaults } from '../../../shared/types'

/**
 * REQ-088 #2 — font-size step for the ± chevron buttons.  10 px matches
 * the convention requested in REQ-088 and is the same magnitude the
 * inspector's per-row size stepper uses, so the two surfaces feel
 * consistent.
 */
const FONT_SIZE_STEP_PX = 10

/**
 * REQ-0298 §4 / REQ-0300 §2 — StyleRow lives in
 * `subtitle-table/style-row.tsx` and provides its own control-column
 * wrapper.  Settings' 「字幕スタイル」 tab wants a wider column than
 * the inspector default (288 px vs 224 px).
 *
 * REQ-0333 §3 — the widths themselves moved to `styleRowColumns()` in
 * `style-row.tsx` so that this wrapper and `AnimationControls` (which
 * renders four `StyleRow`s of its own into this same panel) run the
 * SAME calculation instead of two independent sets of literals.
 */
function SettingsStyleRow({
  label,
  help,
  children,
}: {
  label: string
  help?: string
  children: React.ReactNode
}) {
  return (
    <StyleRow label={label} help={help} {...styleRowColumns('settings')}>
      {children}
    </StyleRow>
  )
}

interface DefaultStyleControlsProps {
  /**
   * REQ-0295 — consolidated TranscriptionDefaults object.  Both call
   * sites already hold this object (SubtitleStyleDialog reads
   * projectStore.defaults; Settings dialog reads
   * settingsStore.transcriptionDefaults), so passing it whole avoids
   * the discrete-prop explosion that adding every REQ-0295 field
   * individually would cause.
   */
  defaults: TranscriptionDefaults
  /**
   * Updates one or more TranscriptionDefaults fields.  Same shape at
   * both call sites: `projectStore.setDefaults` /
   * `settingsStore.updateTranscriptionDefaults` both accept
   * `Partial<TranscriptionDefaults>`.
   */
  onUpdateDefaults: (patch: Partial<TranscriptionDefaults>) => void
  /**
   * `autoLineBreak` lives on `settingsStore` directly (not inside
   * `TranscriptionDefaults`) because it drives Step 1's post-
   * transcription line-wrap pass rather than a per-cue style field.
   */
  autoLineBreak: boolean
  onSetAutoLineBreak: (v: boolean) => void
  /**
   * REQ-0325 §2 — READ-ONLY legacy input.  The animation row replaced the
   * fade slider, and the default a new cue receives now lives in
   * `defaults.animation*`.  This value is still needed for one thing: a
   * settings file written before REQ-0325 has no `animation*`, and
   * `resolveAnimation` uses this to display (and seed) the fade such a
   * user already configured.  It is deliberately not settable from here
   * any more — setting the animation writes `defaults.animation*` instead.
   */
  fadeDurationSec: number
  /**
   * REQ-0295 — tier gate for the karaoke default row.  Karaoke is
   * paid-only (`canUseKaraokeInTier(isMsix)`); hiding the row on
   * free tier keeps the "no free-tier state can be created" invariant
   * from REQ-0286 §0.
   */
  isMsix: boolean
}

/**
 * Default-style controls shared by Step 1's SubtitleStyleDialog and the
 * Settings dialog's "字幕スタイル" tab.  REQ-0295 grew this from the
 * original 4 fields into the full inspector-parity list minus
 * font/weight/text (owned by the Fonts tab) and background (owner
 * declined 2026-07-26).  REQ-0296 §1 rewrote the layout from stacked
 * `[label above / control below]` to `[label | control]` rows so it
 * matches the "Whisper設定" tab; every slider now sits in the same
 * `CONTROL_COL_CLASS` right column so bar widths are visually equal.
 *
 * The component stays presentational: no store subscription, no local
 * draft.  Every control commits through `onUpdateDefaults` (or the
 * paired autoLineBreak / fadeDurationSec setters) so the callers own
 * where the value goes.
 *
 * REQ-0293 final shape enforced:
 *   - Shadow: single 0–50 slider, 0=OFF (no separate Switch).
 *   - Karaoke: Switch + highlight ColorPicker on ONE row, both
 *     always visible (REQ-0296 §2 unification).  Base = textColor
 *     always, no per-cue base override.
 */
export function DefaultStyleControls({
  defaults,
  onUpdateDefaults,
  autoLineBreak,
  onSetAutoLineBreak,
  fadeDurationSec,
  isMsix,
}: DefaultStyleControlsProps) {
  const { t } = useTranslation(['step1', 'step2', 'common'])
  const showKaraokeUi = canUseKaraokeInTier(isMsix)

  // REQ-0325 §2 — resolve through `resolveAnimation` so a settings file
  // written before this REQ (only `fadeDurationSec`) displays as the fade it
  // actually still produces, rather than as "none".  Same migration the cues
  // themselves go through.
  const defaultsAnimation = resolveAnimation({
    animationType: defaults.animationType,
    animationInEnabled: defaults.animationInEnabled,
    animationOutEnabled: defaults.animationOutEnabled,
    animationDurationSec: defaults.animationDurationSec,
    animationStartScalePercent: defaults.animationStartScalePercent,
    animationBlurPx: defaults.animationBlurPx,
    fadeDurationSec,
  })
  const showEmphasisUi = canUseKeywordEmphasisInTier(isMsix)
  // REQ-0298 §4-1 — segButton removed; H/V rows use the shared
  // SegmentGroup component from `@/components/subtitle-table/segment-group`
  // so the settings tab matches the inspector's pill styling.

  return (
    <div className="space-y-0.5">
      <SettingsStyleRow label={t('subtitleDefaults.size')} help={t('subtitleDefaults.helpSize')}>
        <NumberStepperInput
          value={defaults.fontSizePx}
          min={FONT_SIZE_MIN_PX}
          max={FONT_SIZE_MAX_PX}
          step={FONT_SIZE_STEP_PX}
          onCommit={(v) => onUpdateDefaults({ fontSizePx: v })}
          ariaLabel={t('subtitleDefaults.size')}
          title={t('subtitleDefaults.sizeHint', { min: FONT_SIZE_MIN_PX, max: FONT_SIZE_MAX_PX })}
        />
      </SettingsStyleRow>

      {/* REQ-0310 §1 — colour + opacity.  This surface's ColorPicker is the
          full-width variant (it shows the hex, which is worth keeping here), so
          the row is stacked in TWO lines inside its control column rather than
          squeezed onto one — the same local restack the emphasis row uses.
          `SettingsStyleRow`'s label / filler / control structure is untouched,
          so alignment with every other settings row is unaffected. */}
      <SettingsStyleRow label={t('subtitleDefaults.textColor')} help={t('subtitleDefaults.helpTextColor')}>
        <div className="flex flex-col gap-1.5">
          <ColorPicker
            value={defaults.textColorHex}
            onChange={(hex) => onUpdateDefaults({ textColorHex: hex })}
            onPairApply={(text, outline) =>
              onUpdateDefaults({ textColorHex: text, outlineColorHex: outline })
            }
          />
          <OpacityPercentSlider
            value={clampOpacityPercent(defaults.textAlpha)}
            onCommit={(v) => onUpdateDefaults({ textAlpha: v })}
            ariaLabel={t('step2:styleCell.textOpacity')}
            fullWidth
          />
        </div>
      </SettingsStyleRow>

      <SettingsStyleRow label={t('subtitleDefaults.outlineColor')} help={t('subtitleDefaults.helpOutlineColor')}>
        <div className="flex flex-col gap-1.5">
          <ColorPicker
            value={defaults.outlineColorHex}
            onChange={(hex) => onUpdateDefaults({ outlineColorHex: hex })}
            onPairApply={(text, outline) =>
              onUpdateDefaults({ textColorHex: text, outlineColorHex: outline })
            }
          />
          <OpacityPercentSlider
            value={clampOpacityPercent(defaults.outlineAlpha)}
            onCommit={(v) => onUpdateDefaults({ outlineAlpha: v })}
            ariaLabel={t('step2:styleCell.outlineOpacity')}
            fullWidth
          />
        </div>
      </SettingsStyleRow>

      <SettingsStyleRow label={t('subtitleDefaults.stroke')} help={t('subtitleDefaults.helpStroke')}>
        <OutlineThicknessSlider
          value={defaults.outlineThicknessPx}
          onCommit={(v) => onUpdateDefaults({ outlineThicknessPx: v })}
          ariaLabel={t('subtitleDefaults.stroke')}
          fullWidth
        />
      </SettingsStyleRow>

      {/* Shadow (REQ-0293 final: 0–50 slider, 0=OFF). */}
      <SettingsStyleRow label={t('step2:styleCell.shadow')}>
        <ShadowDepthSlider
          value={defaults.shadowDepth ?? 0}
          onCommit={(v) => onUpdateDefaults({
            shadowDepth: v,
            ...(v > 0 && defaults.shadowColor === undefined ? { shadowColor: '#000000' } : {}),
            ...(v > 0 && defaults.shadowAlpha === undefined ? { shadowAlpha: 100 } : {}),
          })}
          ariaLabel={t('step2:styleCell.shadowDepth')}
          fullWidth
        />
      </SettingsStyleRow>

      {/* Karaoke (REQ-0293 final + REQ-0296 §2: single row, Switch +
          highlight picker always visible). */}
      {showKaraokeUi && (
        <SettingsStyleRow label={t('step2:styleCell.karaokeRowLabel')}>
          {/* REQ-0299 §3 — karaoke state text removed.
              REQ-0300 §1 — Switch + Picker adjacent (no flex-1 spacer);
              both sit at the LEFT of the control column so there's
              no unnatural gap between them. */}
          <div className="flex items-center gap-2">
            <Switch
              checked={defaults.karaokeEnabled === true}
              onCheckedChange={(v) => onUpdateDefaults({
                karaokeEnabled: v,
                ...(v && defaults.karaokeHighlightColor === undefined
                  ? { karaokeHighlightColor: KARAOKE_DEFAULT_HIGHLIGHT_COLOR }
                  : {}),
              })}
              aria-label={t('step2:styleCell.karaoke')}
            />
            <ColorPicker
              value={defaults.karaokeHighlightColor ?? KARAOKE_DEFAULT_HIGHLIGHT_COLOR}
              onChange={(hex) => onUpdateDefaults({ karaokeHighlightColor: hex })}
              swatchOnly
              heading={t('step2:styleCell.karaokeHighlightColor')}
            />
          </div>
        </SettingsStyleRow>
      )}

      {/* REQ-0305 — keyword emphasis default (Switch + colour + size %).
          Per-word selection is per-cue (inspector only); the settings
          screen only exposes the master toggle + style defaults. */}
      {showEmphasisUi && (
        <SettingsStyleRow label={t('step2:styleCell.emphasisRowLabel')}>
          <div className="flex items-center gap-2">
            <Switch
              checked={defaults.keywordEmphasisEnabled === true}
              onCheckedChange={(v) => onUpdateDefaults({
                keywordEmphasisEnabled: v,
                ...(v && defaults.emphasisColorHex === undefined
                  ? { emphasisColorHex: EMPHASIS_DEFAULT_COLOR }
                  : {}),
                ...(v && defaults.emphasisScalePercent === undefined
                  ? { emphasisScalePercent: EMPHASIS_DEFAULT_SCALE_PERCENT }
                  : {}),
              })}
              aria-label={t('step2:styleCell.emphasis')}
            />
            <ColorPicker
              value={defaults.emphasisColorHex ?? EMPHASIS_DEFAULT_COLOR}
              onChange={(hex) => onUpdateDefaults({ emphasisColorHex: hex })}
              swatchOnly
              heading={t('step2:styleCell.emphasisColor')}
            />
            <NumberStepperInput
              value={defaults.emphasisScalePercent ?? EMPHASIS_DEFAULT_SCALE_PERCENT}
              min={EMPHASIS_SCALE_MIN_PERCENT}
              max={EMPHASIS_SCALE_MAX_PERCENT}
              step={EMPHASIS_SCALE_STEP_PERCENT}
              onCommit={(v) => onUpdateDefaults({ emphasisScalePercent: v })}
              ariaLabel={t('step2:styleCell.emphasisSize')}
              widthClass="w-16"
            />
            {/* REQ-0308 §4-3 — mark the value as a multiplier, matching the
                inspector.  This row has no 「編集」 button so its four
                controls still fit on one line in the wider settings column;
                only the inspector needed the two-line restack. */}
            <span className="text-caption text-fg-secondary">%</span>
          </div>
        </SettingsStyleRow>
      )}

      {/* REQ-0299 §3 — casing state text removed. */}
      <SettingsStyleRow label={t('step2:styleCell.casing')}>
        <Switch
          checked={defaults.casing === 'uppercase'}
          onCheckedChange={(v) => onUpdateDefaults({ casing: v ? 'uppercase' : 'none' })}
          aria-label={t('step2:styleCell.casing')}
        />
      </SettingsStyleRow>

      <SettingsStyleRow label={t('step2:styleCell.rotation')}>
        <NumberStepperInput
          value={defaults.rotation ?? 0}
          min={0}
          max={359}
          step={15}
          onCommit={(v) => onUpdateDefaults({ rotation: ((v % 360) + 360) % 360 })}
          ariaLabel={t('step2:styleCell.rotation')}
        />
      </SettingsStyleRow>

      {/* REQ-0325 §2 — the fade slider is replaced by the full animation
          control, and it is bound to `defaults` (TranscriptionDefaults)
          rather than straight to the settings store.  Two reasons:
          (a) after RES-0324 folded fade into the animation UI, a lone fade
              slider could no longer express the default a new cue would get;
          (b) every other row here is bound to `defaults`, and the settings-
              store binding was the asymmetry REQ-0322 §3-6 reported. */}
      <AnimationControls
        value={{
          type: defaultsAnimation.type,
          inEnabled: defaultsAnimation.inEnabled,
          outEnabled: defaultsAnimation.outEnabled,
          durationSec: defaultsAnimation.durationSec,
          startScalePercent: Math.round(defaultsAnimation.startScale * 100),
          blurPx: defaultsAnimation.blurMaxPx,
        }}
        onChange={(patch) => onUpdateDefaults({
          animationType: patch.type ?? defaultsAnimation.type,
          animationInEnabled: patch.inEnabled ?? defaultsAnimation.inEnabled,
          animationOutEnabled: patch.outEnabled ?? defaultsAnimation.outEnabled,
          animationDurationSec: patch.durationSec ?? defaultsAnimation.durationSec,
          animationStartScalePercent:
            patch.startScalePercent ?? Math.round(defaultsAnimation.startScale * 100),
          animationBlurPx: patch.blurPx ?? defaultsAnimation.blurMaxPx,
        })}
        includeBlur={ANIMATION_BLUR_ENABLED}
        surface="settings"
      />

      {/* ── Layout section header ── */}
      <div className="pt-2 mt-2 border-t border-border/60">
        <p className="text-label font-medium uppercase tracking-wider text-foreground mb-1 px-2">
          {t('step2:timeline.inspector.layoutSection')}
        </p>

        <SettingsStyleRow label={t('step2:styleCell.layoutH')}>
          <SegmentGroup<'left' | 'center' | 'right'>
            value={defaults.horizontalPosition ?? 'center'}
            onChange={(v) => onUpdateDefaults({ horizontalPosition: v })}
            ariaLabel={t('step2:styleCell.layoutH')}
            fullWidth
            options={[
              { value: 'left', label: t('step2:subtitlePosition.left') },
              { value: 'center', label: t('step2:subtitlePosition.center') },
              { value: 'right', label: t('step2:subtitlePosition.right') },
            ]}
          />
        </SettingsStyleRow>

        <SettingsStyleRow label={t('step2:styleCell.layoutV')}>
          <SegmentGroup<'top' | 'center' | 'bottom'>
            value={defaults.verticalPosition ?? 'bottom'}
            onChange={(v) => onUpdateDefaults({ verticalPosition: v })}
            ariaLabel={t('step2:styleCell.layoutV')}
            fullWidth
            options={[
              { value: 'top', label: t('step2:subtitlePosition.top') },
              { value: 'center', label: t('step2:subtitlePosition.center') },
              { value: 'bottom', label: t('step2:subtitlePosition.bottom') },
            ]}
          />
        </SettingsStyleRow>

        <SettingsStyleRow label={t('step2:styleCell.marginV')}>
          <NumberStepperInput
            value={defaults.verticalMarginPx ?? 40}
            min={MARGIN_V_MIN_PX}
            max={MARGIN_V_MAX_PX}
            step={10}
            onCommit={(v) => onUpdateDefaults({ verticalMarginPx: v })}
            ariaLabel={t('step2:styleCell.marginV')}
            widthClass="w-16"
          />
        </SettingsStyleRow>

        {/* REQ-0332 §5 — 行間.  Sits in the レイアウト section next to the
            margin because it is the other "how much room does the caption
            take" control, and it is the default for NEW cues only (like
            every other row in this panel). */}
        <SettingsStyleRow label={t('step2:styleCell.lineSpacing')}>
          <LineSpacingSlider
            value={defaults.lineSpacingPercent ?? LINE_SPACING_DEFAULT_PERCENT}
            onCommit={(v) => onUpdateDefaults({ lineSpacingPercent: v })}
            ariaLabel={t('step2:styleCell.lineSpacing')}
            fullWidth
          />
        </SettingsStyleRow>

        <SettingsStyleRow label={t('step2:styleCell.offset')}>
          <div className="flex items-center gap-2">
            <span className="text-body-sm text-fg-tertiary">X</span>
            <NumberStepperInput
              value={defaults.posOffsetX ?? 0}
              min={-9999}
              max={9999}
              step={10}
              onCommit={(v) => onUpdateDefaults({ posOffsetX: v })}
              ariaLabel={t('step2:styleCell.offsetX')}
              widthClass="w-16"
            />
            <span className="text-body-sm text-fg-tertiary">Y</span>
            <NumberStepperInput
              value={defaults.posOffsetY ?? 0}
              min={-9999}
              max={9999}
              step={10}
              onCommit={(v) => onUpdateDefaults({ posOffsetY: v })}
              ariaLabel={t('step2:styleCell.offsetY')}
              widthClass="w-16"
            />
          </div>
        </SettingsStyleRow>
      </div>

      {/* Auto line break — separate section per the pre-REQ-0295
          convention (subtitle-formatting flag, not a per-cue style). */}
      <div className="pt-2 mt-2 border-t border-border/60">
        <SettingsStyleRow label={t('advanced.autoLineBreak')} help={t('advanced.autoLineBreakHelp')}>
          <div className="flex items-center gap-2">
            <Switch
              checked={autoLineBreak}
              onCheckedChange={(v) => onSetAutoLineBreak(v)}
            />
            <span className="text-body-sm text-muted-foreground">
              {autoLineBreak ? t('advanced.enabled') : t('advanced.disabled')}
            </span>
          </div>
        </SettingsStyleRow>
      </div>
    </div>
  )
}
