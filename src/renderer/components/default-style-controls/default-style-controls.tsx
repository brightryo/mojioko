import { useTranslation } from 'react-i18next'
import { Switch } from '@/components/ui/switch'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { OutlineThicknessSlider } from '@/components/subtitle-table/outline-thickness-slider'
import { ShadowDepthSlider } from '@/components/subtitle-table/shadow-depth-slider'
import { FadeDurationSlider } from '@/components/subtitle-table/fade-duration-slider'
import { NumberStepperInput } from '@/components/subtitle-table/number-stepper-input'
import { StyleRow } from '@/components/subtitle-table/style-row'
import { SegmentGroup } from '@/components/subtitle-table/segment-group'
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

/**
 * REQ-0296 §1 — right-column width for every row's control.  A single
 * class shared across every row keeps slider bars and stepper widths
 * visually aligned (previous layout let each control size itself,
 * which made the shadow / fade sliders look ~2× wider than outline
 * width).
 *
 * REQ-0298 §2 — widened from `w-48` (192px) to `w-72` (288px) so the
 * X/Y offset row (2 NumberStepperInputs + X/Y labels + gaps, ~280 px
 * of intrinsic content) fits without overflowing.  Pre-REQ-0298 the
 * offset row's content overflowed a 192-px wrapper, and the tab
 * wrapper's implicit `overflow-x: auto` (Chromium's default when
 * `overflow-y: auto` is set) surfaced a horizontal scrollbar on the
 * whole 字幕スタイル tab.  Widening the column removes the
 * overflow at source without touching dialog width or per-tab
 * height classes (REQ-0283 invariant preserved).
 */
const CONTROL_COL_CLASS = 'w-72 shrink-0'

/**
 * REQ-0298 §4 — StyleRow moved to `subtitle-table/style-row.tsx` so
 * inspector + bulk-edit + settings-default-style share the same shell.
 * The wrapper below just applies this file's `CONTROL_COL_CLASS`
 * (settings-tab-specific width) around the child so slider bars stay
 * uniformly wide inside the settings tab.  Other surfaces use the
 * shared StyleRow directly (control column width is whatever the
 * per-row wrapper sets, typically `w-[50%]` in the inspector).
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
    <StyleRow label={label} help={help} labelVariant="settings">
      <div className={CONTROL_COL_CLASS}>{children}</div>
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
  onSetFadeDurationSec,
  isMsix,
}: DefaultStyleControlsProps) {
  const { t } = useTranslation(['step1', 'step2', 'common'])
  const showKaraokeUi = canUseKaraokeInTier(isMsix)
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

      <SettingsStyleRow label={t('subtitleDefaults.textColor')} help={t('subtitleDefaults.helpTextColor')}>
        <ColorPicker
          value={defaults.textColorHex}
          onChange={(hex) => onUpdateDefaults({ textColorHex: hex })}
          onPairApply={(text, outline) =>
            onUpdateDefaults({ textColorHex: text, outlineColorHex: outline })
          }
        />
      </SettingsStyleRow>

      <SettingsStyleRow label={t('subtitleDefaults.outlineColor')} help={t('subtitleDefaults.helpOutlineColor')}>
        <ColorPicker
          value={defaults.outlineColorHex}
          onChange={(hex) => onUpdateDefaults({ outlineColorHex: hex })}
          onPairApply={(text, outline) =>
            onUpdateDefaults({ textColorHex: text, outlineColorHex: outline })
          }
        />
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
          {/* REQ-0299 §3 — karaoke state text removed. */}
          <div className="flex items-center gap-2 w-full">
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
            <div className="flex-1" />
            <ColorPicker
              value={defaults.karaokeHighlightColor ?? KARAOKE_DEFAULT_HIGHLIGHT_COLOR}
              onChange={(hex) => onUpdateDefaults({ karaokeHighlightColor: hex })}
              swatchOnly
              heading={t('step2:styleCell.karaokeHighlightColor')}
            />
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

      <SettingsStyleRow label={t('step2:styleCell.fade')}>
        <FadeDurationSlider
          value={fadeDurationSec}
          onCommit={onSetFadeDurationSec}
          ariaLabel={t('step2:styleCell.fade')}
          fullWidth
        />
      </SettingsStyleRow>

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
