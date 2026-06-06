import { useState } from 'react'
import { HexColorPicker } from 'react-colorful'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui-store'
import { BASIC_COLORS, COLOR_PAIRS, CUD_COLORS, type ColorPair } from '@/lib/color-palette'

const HEX_RE = /^#[0-9a-fA-F]{6}$/

interface ColorPickerProps {
  value: string
  onChange: (hex: string) => void
  className?: string
  disabled?: boolean
  /**
   * When true, render a compact 24×24 swatch button (used in table cells).
   * When false (default), render a full-width h-9 button (used in settings rows).
   */
  swatchOnly?: boolean
  /**
   * Optional "commit" callback fired on popover close, once, with the
   * final value — only when the value actually changed since the popover
   * opened.  Use this from contexts that need a single coarse-grained
   * history op per pick session (e.g. BulkEditBar applying to N rows),
   * separately from `onChange` which fires per-pixel during a saturation
   * drag.  Existing per-row usage that wants live history per micro-move
   * simply omits this prop and continues to rely on `onChange`.
   */
  onCommit?: (hex: string) => void
  /**
   * Optional pair-apply callback.  When provided, the popover renders
   * the "Suggested pairs" group (REQ-033 §2) — clicking a pair calls
   * this with BOTH halves so the calling surface can write the row's
   * text colour and outline colour together.  Hidden when omitted; that
   * lets a future caller use ColorPicker for a single isolated colour
   * (e.g. some highlight) without surfacing a control that would only
   * change half of nothing relevant.
   *
   * Every current call site (per-row, bulk-edit, default-style) holds
   * both setters in its closure, so all three pass this callback —
   * pair group is therefore visible everywhere in the current app.
   */
  onPairApply?: (textHex: string, outlineHex: string) => void
}

export function ColorPicker({
  value,
  onChange,
  className,
  disabled,
  swatchOnly,
  onCommit,
  onPairApply
}: ColorPickerProps) {
  const { t } = useTranslation('common')
  const recentColors = useUiStore((s) => s.recentColors)
  const addRecentColor = useUiStore((s) => s.addRecentColor)

  const [open, setOpen] = useState(false)
  const [hexDraft, setHexDraft] = useState(value)
  // Snapshot taken when the popover opens; compared on close to decide
  // whether onCommit should fire.  Holds null while the popover is closed.
  const [valueOnOpen, setValueOnOpen] = useState<string | null>(null)

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function normalise(hex: string): string {
    return hex.toUpperCase()
  }

  function applyColor(hex: string) {
    const upper = normalise(hex)
    onChange(upper)
    setHexDraft(upper)
  }

  function applyAndRecord(hex: string) {
    applyColor(hex)
    addRecentColor(hex)
  }

  // -------------------------------------------------------------------------
  // Popover lifecycle
  // -------------------------------------------------------------------------

  function handleOpenChange(next: boolean) {
    if (next) {
      // Sync draft when opening + snapshot the open-time value so close
      // can decide whether onCommit should fire.
      const upper = normalise(value)
      setHexDraft(upper)
      setValueOnOpen(upper)
    } else {
      // Record the final chosen color on close (captures drag-to-pick usage)
      if (HEX_RE.test(value)) {
        addRecentColor(value)
      }
      // Coarse-grained commit hook: fire exactly once per pick session and
      // only when the value moved.  Callers that need it (BulkEditBar) use
      // it to register a single undoable op per popover open/close cycle.
      if (onCommit && valueOnOpen !== null && normalise(value) !== valueOnOpen) {
        onCommit(normalise(value))
      }
      setValueOnOpen(null)
    }
    setOpen(next)
  }

  function handlePickerChange(hex: string) {
    applyColor(hex)
  }

  function handleSwatchClick(hex: string) {
    applyAndRecord(hex)
  }

  function handlePairClick(pair: ColorPair) {
    if (!onPairApply) return
    onPairApply(normalise(pair.text), normalise(pair.outline))
    // Remember both colours in the recent list so subsequent single picks
    // can hit them quickly.
    addRecentColor(pair.text)
    addRecentColor(pair.outline)
    // Close the popover so the user sees the result immediately — pair
    // clicks are a fully-committed action, not an exploratory pick.
    handleOpenChange(false)
  }

  // -------------------------------------------------------------------------
  // Hex text input
  // -------------------------------------------------------------------------

  function handleHexChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value
    setHexDraft(raw)
    if (HEX_RE.test(raw)) {
      onChange(normalise(raw))
    }
  }

  function commitHexInput() {
    if (HEX_RE.test(hexDraft)) {
      const upper = normalise(hexDraft)
      onChange(upper)
      addRecentColor(upper)
    } else {
      setHexDraft(normalise(value))
    }
  }

  function handleHexKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      commitHexInput()
      ;(e.target as HTMLInputElement).blur()
    }
  }

  // -------------------------------------------------------------------------
  // Popover content
  // -------------------------------------------------------------------------

  const pickerContent = (
    <PopoverContent
      // REQ-035: 3-group palette + saturation/hue picker + recent row +
      // hex input is ~530 px tall — exceeds Settings dialog's modest
      // height when the trigger sits near the dialog's middle, causing
      // top/bottom clipping.  Radix already flips side to avoid the
      // viewport edge; we additionally cap max-height to the *available*
      // vertical space exposed by Radix (`--radix-popover-content-
      // available-height`) and let the body scroll inside the popover
      // when content doesn't fit.  Generous PopoverContent positions
      // (字幕スタイルダイアログ, STEP 2 行) still render without a
      // scrollbar because available-height covers the full popover.
      className="w-[280px] p-3 space-y-3 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto"
      align="start"
      sideOffset={8}
      collisionPadding={12}
      onInteractOutside={() => handleOpenChange(false)}
    >
      {/* Close X — explicit affordance.  Outside-click also closes the
          popover via onInteractOutside, but REQ-033 asks for a visible
          dismiss control. */}
      <div className="flex items-start justify-between">
        <p className="text-label font-medium uppercase tracking-wider text-zinc-500">
          {t('colorPicker.basic')}
        </p>
        <button
          type="button"
          onClick={() => handleOpenChange(false)}
          className="-mt-0.5 -mr-1 flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          aria-label={t('colorPicker.close')}
          title={t('colorPicker.close')}
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {/* Group 1: Basic colours (10) */}
      <div className="grid grid-cols-10 gap-1.5">
        {BASIC_COLORS.map((c) => (
          <ColorSwatch
            key={c}
            color={c}
            isSelected={normalise(value) === c}
            onClick={() => handleSwatchClick(c)}
          />
        ))}
      </div>

      {/* Group 2: Recommended pairs (5).  Only rendered when the caller
          owns both text + outline setters; otherwise omitted entirely so
          users don't get a half-functional control. */}
      {onPairApply && (
        <div>
          <div className="mb-1.5 flex items-baseline gap-2">
            <p className="text-label font-medium uppercase tracking-wider text-zinc-500">
              {t('colorPicker.pairs')}
            </p>
            <span className="text-caption text-zinc-600">{t('colorPicker.pairsHint')}</span>
          </div>
          <div className="grid grid-cols-5 gap-1.5">
            {COLOR_PAIRS.map((p) => (
              <PairSwatch
                key={`${p.text}-${p.outline}`}
                pair={p}
                tooltip={t('colorPicker.pairTooltip', { text: p.text, outline: p.outline })}
                onClick={() => handlePairClick(p)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Group 3: CUD palette (10) */}
      <div>
        <div className="mb-1.5 flex items-baseline gap-2">
          <p className="text-label font-medium uppercase tracking-wider text-zinc-500">
            {t('colorPicker.cud')}
          </p>
          <span className="text-caption text-zinc-600">{t('colorPicker.cudHint')}</span>
        </div>
        <div className="grid grid-cols-10 gap-1.5">
          {CUD_COLORS.map((c) => (
            <ColorSwatch
              key={c}
              color={c}
              isSelected={normalise(value) === c}
              onClick={() => handleSwatchClick(c)}
            />
          ))}
        </div>
      </div>

      {/* Recent colors (capped to 5 by useUiStore.addRecentColor) */}
      {recentColors.length > 0 && (
        <div>
          <p className="mb-1.5 text-label font-medium uppercase tracking-wider text-zinc-500">
            {t('colorPicker.recent')}
          </p>
          <div className="flex gap-1.5">
            {recentColors.map((c, i) => (
              <ColorSwatch
                key={`${c}-${i}`}
                color={c}
                isSelected={normalise(value) === normalise(c)}
                onClick={() => handleSwatchClick(c)}
              />
            ))}
          </div>
        </div>
      )}

      {/* HexColorPicker (saturation + hue) */}
      <div className="mojioko-cp">
        <HexColorPicker
          color={value.toLowerCase()}
          onChange={handlePickerChange}
        />
      </div>

      {/* Hex text input */}
      <input
        type="text"
        value={hexDraft}
        onChange={handleHexChange}
        onBlur={commitHexInput}
        onKeyDown={handleHexKeyDown}
        maxLength={7}
        spellCheck={false}
        placeholder="#FFFFFF"
        className={cn(
          'h-8 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-center',
          'font-mono text-body-sm text-zinc-100',
          'focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-green-500/30'
        )}
      />
    </PopoverContent>
  )

  // -------------------------------------------------------------------------
  // Render — compact swatch or full-width button
  // -------------------------------------------------------------------------

  if (swatchOnly) {
    return (
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'h-6 w-6 flex-shrink-0 rounded border border-zinc-700',
              'transition-all duration-150',
              'hover:border-zinc-500 hover:scale-110',
              'focus:outline-none focus-visible:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-40',
              className
            )}
            style={{ backgroundColor: value }}
            aria-label={value}
          />
        </PopoverTrigger>
        {pickerContent}
      </Popover>
    )
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex h-9 w-full items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-2.5',
            'transition-colors duration-150 hover:border-zinc-700',
            'focus:outline-none focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-40',
            className
          )}
          aria-label={value}
        >
          <span
            className="h-5 w-5 flex-shrink-0 rounded border border-zinc-700"
            style={{ backgroundColor: value }}
          />
          <span className="font-mono text-body-sm text-zinc-300">{normalise(value)}</span>
        </button>
      </PopoverTrigger>
      {pickerContent}
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// ColorSwatch — single colour swatch used in the basic / CUD / recent rows
// ---------------------------------------------------------------------------

interface ColorSwatchProps {
  color: string
  isSelected: boolean
  onClick: () => void
}

function ColorSwatch({ color, isSelected, onClick }: ColorSwatchProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-5 w-5 flex-shrink-0 rounded transition-transform duration-100',
        'hover:scale-110 focus:outline-none',
        isSelected
          ? 'ring-2 ring-green-500 ring-offset-1 ring-offset-zinc-900'
          : 'ring-1 ring-zinc-700/60'
      )}
      style={{ backgroundColor: color }}
      aria-label={color}
      title={color}
    />
  )
}

// ---------------------------------------------------------------------------
// PairSwatch — two-colour preview tile shown in the "Suggested pairs" group.
// Renders a small subtitle-style sample ("Aa" in text colour with outline
// colour stroke) on top of a stacked text+outline swatch.  Single click
// applies both halves.
// ---------------------------------------------------------------------------

interface PairSwatchProps {
  pair: ColorPair
  tooltip: string
  onClick: () => void
}

function PairSwatch({ pair, tooltip, onClick }: PairSwatchProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      aria-label={tooltip}
      className={cn(
        'relative flex h-8 items-center justify-center rounded ring-1 ring-zinc-700/60',
        'transition-transform duration-100 hover:scale-105 focus:outline-none',
        'hover:ring-zinc-500'
      )}
      style={{ backgroundColor: '#404040' }}
    >
      {/* Subtitle-style preview text — text colour with outline-colour
          stroke, exactly how the burn-in renders.  paint-order: stroke
          fill mirrors SubtitleOverlay so the visible stroke is the
          OUTSIDE half. */}
      <span
        className="text-body font-bold leading-none"
        style={{
          color: pair.text,
          WebkitTextStrokeWidth: '1.5px',
          WebkitTextStrokeColor: pair.outline,
          paintOrder: 'stroke fill'
        }}
      >
        Aa
      </span>
    </button>
  )
}
