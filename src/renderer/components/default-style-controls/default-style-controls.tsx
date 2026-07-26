import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { HelpIcon } from '@/components/help-icon'
import { OutlineThicknessSlider } from '@/components/subtitle-table/outline-thickness-slider'
import { ShadowDepthSlider } from '@/components/subtitle-table/shadow-depth-slider'
import { FadeDurationSlider } from '@/components/subtitle-table/fade-duration-slider'
import { NumberStepperInput } from '@/components/subtitle-table/number-stepper-input'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX, MARGIN_V_MIN_PX, MARGIN_V_MAX_PX } from '../../../shared/constants'
import { canUseKaraokeInTier, KARAOKE_DEFAULT_HIGHLIGHT_COLOR } from '../../../shared/karaoke-gate'
import type { TranscriptionDefaults } from '../../../shared/types'

/**
 * REQ-088 #2 — font-size step for the ± chevron buttons.  10 px matches
 * the convention requested in REQ-088 and is the same magnitude the
 * inspector's per-row size stepper uses, so the two surfaces feel
 * consistent.
 */
const FONT_SIZE_STEP_PX = 10

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
   * REQ-0295 §1 「フェード」— fade duration default for new cues.
   * Lives on `settingsStore.fadeDurationSec` (single source of
   * truth); the General tab exposes the same slider.  Exposed here
   * too so the user can set every "style" default from a single
   * screen.
   */
  fadeDurationSec: number
  onSetFadeDurationSec: (v: number) => void
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
 * original 4 fields (font size / text colour / outline colour / outline
 * thickness) into the full inspector-parity list minus font/weight/text
 * (owned by the Fonts tab) and background (owner declined
 * 2026-07-26).  Row order matches the inspector post-REQ-0292 so users
 * switching between the two surfaces don't relearn the layout.
 *
 * The component stays presentational: no store subscription, no local
 * draft.  Every control commits through `onUpdateDefaults` (or the
 * paired autoLineBreak / fadeDurationSec setters) so the callers own
 * where the value goes.
 *
 * REQ-0293 final shape enforced:
 *   - Shadow: single 0–50 slider, 0=OFF (no separate Switch).
 *   - Karaoke: Switch + highlight ColorPicker ONLY (base = textColor
 *     always, no per-cue base override, so no default to configure).
 */
export function DefaultStyleControls({
  defaults,
  onUpdateDefaults,
  autoLineBreak,
  onSetAutoLineBreak,
  fadeDurationSec,
  onSetFadeDurationSec,
  isMsix,
}: DefaultStyleControlsProps) {
  const { t } = useTranslation(['step1', 'step2', 'common'])
  const showKaraokeUi = canUseKaraokeInTier(isMsix)

  return (
    <div className="space-y-3">
      {/* ────────── Size ────────── */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label>{t('subtitleDefaults.size')}</Label>
          <HelpIcon content={t('subtitleDefaults.helpSize')} />
        </div>
        <NumberStepperInput
          value={defaults.fontSizePx}
          min={FONT_SIZE_MIN_PX}
          max={FONT_SIZE_MAX_PX}
          step={FONT_SIZE_STEP_PX}
          onCommit={(v) => onUpdateDefaults({ fontSizePx: v })}
          ariaLabel={t('subtitleDefaults.size')}
          title={t('subtitleDefaults.sizeHint', { min: FONT_SIZE_MIN_PX, max: FONT_SIZE_MAX_PX })}
        />
        <p className="text-body-sm text-muted-foreground">
          {t('subtitleDefaults.sizeHint', { min: FONT_SIZE_MIN_PX, max: FONT_SIZE_MAX_PX })}
        </p>
      </div>

      {/* ────────── Text colour ────────── */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label>{t('subtitleDefaults.textColor')}</Label>
          <HelpIcon content={t('subtitleDefaults.helpTextColor')} />
        </div>
        <ColorPicker
          value={defaults.textColorHex}
          onChange={(hex) => onUpdateDefaults({ textColorHex: hex })}
          onPairApply={(text, outline) =>
            onUpdateDefaults({ textColorHex: text, outlineColorHex: outline })
          }
        />
      </div>

      {/* ────────── Outline colour ────────── */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label>{t('subtitleDefaults.outlineColor')}</Label>
          <HelpIcon content={t('subtitleDefaults.helpOutlineColor')} />
        </div>
        <ColorPicker
          value={defaults.outlineColorHex}
          onChange={(hex) => onUpdateDefaults({ outlineColorHex: hex })}
          onPairApply={(text, outline) =>
            onUpdateDefaults({ textColorHex: text, outlineColorHex: outline })
          }
        />
      </div>

      {/* ────────── Outline thickness ────────── */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label>{t('subtitleDefaults.stroke')}</Label>
          <HelpIcon content={t('subtitleDefaults.helpStroke')} />
        </div>
        <OutlineThicknessSlider
          value={defaults.outlineThicknessPx}
          onCommit={(v) => onUpdateDefaults({ outlineThicknessPx: v })}
          ariaLabel={t('subtitleDefaults.stroke')}
        />
      </div>

      {/* ────────── Shadow (REQ-0293 final: 0–50 slider, 0=OFF) ────────── */}
      <div className="space-y-1.5">
        <Label>{t('step2:styleCell.shadow')}</Label>
        <ShadowDepthSlider
          value={defaults.shadowDepth ?? 0}
          onCommit={(v) => onUpdateDefaults({
            shadowDepth: v,
            // Seed neutral colour + alpha the first time the user drags
            // past 0 so the shadow is visible immediately (matches the
            // inspector's REQ-0293 behaviour).
            ...(v > 0 && defaults.shadowColor === undefined ? { shadowColor: '#000000' } : {}),
            ...(v > 0 && defaults.shadowAlpha === undefined ? { shadowAlpha: 100 } : {}),
          })}
          ariaLabel={t('step2:styleCell.shadowDepth')}
          fullWidth
        />
      </div>

      {/* ────────── Karaoke (REQ-0293 final: Switch + highlight only) ────────── */}
      {showKaraokeUi && (
        <div className="space-y-1.5">
          <Label>{t('step2:styleCell.karaoke')}</Label>
          <div className="flex items-center gap-3">
            <Switch
              checked={defaults.karaokeEnabled === true}
              onCheckedChange={(v) => onUpdateDefaults({
                karaokeEnabled: v,
                // Seed the highlight colour default on the first ON so the
                // picker below has a starting swatch — mirrors the
                // inspector's toggle-on behaviour.
                ...(v && defaults.karaokeHighlightColor === undefined
                  ? { karaokeHighlightColor: KARAOKE_DEFAULT_HIGHLIGHT_COLOR }
                  : {}),
              })}
              aria-label={t('step2:styleCell.karaoke')}
            />
            <span className="text-body-sm text-muted-foreground">
              {defaults.karaokeEnabled === true ? t('step2:styleCell.karaokeOn') : t('step2:styleCell.karaokeOff')}
            </span>
          </div>
          {defaults.karaokeEnabled === true && (
            <div className="flex items-center justify-between gap-2 pl-2">
              <Label className="text-body-sm font-normal">
                {t('step2:styleCell.karaokeHighlightColor')}
              </Label>
              <ColorPicker
                value={defaults.karaokeHighlightColor ?? KARAOKE_DEFAULT_HIGHLIGHT_COLOR}
                onChange={(hex) => onUpdateDefaults({ karaokeHighlightColor: hex })}
                swatchOnly
                heading={t('step2:styleCell.karaokeHighlightColor')}
              />
            </div>
          )}
        </div>
      )}

      {/* ────────── Casing ────────── */}
      <div className="space-y-1.5">
        <Label>{t('step2:styleCell.casing')}</Label>
        <div className="flex items-center gap-3">
          <Switch
            checked={defaults.casing === 'uppercase'}
            onCheckedChange={(v) => onUpdateDefaults({ casing: v ? 'uppercase' : 'none' })}
            aria-label={t('step2:styleCell.casing')}
          />
          <span className="text-body-sm text-muted-foreground">
            {defaults.casing === 'uppercase' ? t('step2:styleCell.casingUppercase') : t('step2:styleCell.casingNone')}
          </span>
        </div>
      </div>

      {/* ────────── Rotation ────────── */}
      <div className="space-y-1.5">
        <Label>{t('step2:styleCell.rotation')}</Label>
        <NumberStepperInput
          value={defaults.rotation ?? 0}
          min={0}
          max={359}
          step={15}
          onCommit={(v) => onUpdateDefaults({ rotation: ((v % 360) + 360) % 360 })}
          ariaLabel={t('step2:styleCell.rotation')}
        />
      </div>

      {/* ────────── Fade (settings.fadeDurationSec, not TranscriptionDefaults) ────────── */}
      <div className="space-y-1.5">
        <Label>{t('step2:styleCell.fade')}</Label>
        <FadeDurationSlider
          value={fadeDurationSec}
          onCommit={onSetFadeDurationSec}
          ariaLabel={t('step2:styleCell.fade')}
          fullWidth
        />
      </div>

      {/* ────────── Layout section header ────────── */}
      <div className="pt-2 border-t border-border/60">
        <p className="text-body-sm font-semibold text-fg-secondary mb-2">
          {t('step2:timeline.inspector.layoutSection')}
        </p>

        {/* ── Horizontal ── */}
        <div className="space-y-1.5">
          <Label>{t('step2:styleCell.layoutH')}</Label>
          <div className="flex items-center gap-2 text-body-sm">
            {(['left', 'center', 'right'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => onUpdateDefaults({ horizontalPosition: v })}
                className={
                  'px-2 py-1 rounded border text-body-sm ' +
                  ((defaults.horizontalPosition ?? 'center') === v
                    ? 'border-primary text-fg-primary bg-primary/10'
                    : 'border-line-strong text-fg-secondary hover:text-fg-primary hover:bg-surface-2')
                }
              >
                {t(`step2:subtitlePosition.${v}`)}
              </button>
            ))}
          </div>
        </div>

        {/* ── Vertical ── */}
        <div className="space-y-1.5 mt-2">
          <Label>{t('step2:styleCell.layoutV')}</Label>
          <div className="flex items-center gap-2 text-body-sm">
            {(['top', 'center', 'bottom'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => onUpdateDefaults({ verticalPosition: v })}
                className={
                  'px-2 py-1 rounded border text-body-sm ' +
                  ((defaults.verticalPosition ?? 'bottom') === v
                    ? 'border-primary text-fg-primary bg-primary/10'
                    : 'border-line-strong text-fg-secondary hover:text-fg-primary hover:bg-surface-2')
                }
              >
                {t(`step2:subtitlePosition.${v}`)}
              </button>
            ))}
          </div>
        </div>

        {/* ── Margin (verticalMarginPx) ── */}
        <div className="space-y-1.5 mt-2">
          <Label>{t('step2:styleCell.marginV')}</Label>
          <NumberStepperInput
            value={defaults.verticalMarginPx ?? 40}
            min={MARGIN_V_MIN_PX}
            max={MARGIN_V_MAX_PX}
            step={10}
            onCommit={(v) => onUpdateDefaults({ verticalMarginPx: v })}
            ariaLabel={t('step2:styleCell.marginV')}
            widthClass="w-16"
          />
        </div>

        {/* ── Offset (posOffsetX / posOffsetY) ── */}
        <div className="space-y-1.5 mt-2">
          <Label>{t('step2:styleCell.offset')}</Label>
          <div className="flex items-center gap-2">
            <span className="text-body-sm text-fg-tertiary w-4">X</span>
            <NumberStepperInput
              value={defaults.posOffsetX ?? 0}
              min={-9999}
              max={9999}
              step={10}
              onCommit={(v) => onUpdateDefaults({ posOffsetX: v })}
              ariaLabel={t('step2:styleCell.offsetX')}
              widthClass="w-16"
            />
            <span className="text-body-sm text-fg-tertiary w-4 ml-2">Y</span>
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
        </div>
      </div>

      {/* ────────── Auto line break ────────── */}
      <div className="space-y-1.5 pt-2 border-t border-border/60">
        <div className="flex items-center gap-1">
          <Label>{t('advanced.autoLineBreak')}</Label>
          <HelpIcon content={t('advanced.autoLineBreakHelp')} />
        </div>
        <div className="flex items-center gap-2 h-9">
          <Switch
            checked={autoLineBreak}
            onCheckedChange={(v) => onSetAutoLineBreak(v)}
          />
          <span className="text-body-sm text-muted-foreground">
            {autoLineBreak ? t('advanced.enabled') : t('advanced.disabled')}
          </span>
        </div>
      </div>
    </div>
  )
}
