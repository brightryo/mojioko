import { useState } from 'react'
import { HexColorPicker } from 'react-colorful'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui-store'

/** Preset palette displayed at the top of the picker popover. */
const PRESET_COLORS = [
  '#FFFFFF', // white
  '#000000', // black
  '#EF4444', // red
  '#EAB308', // yellow
  '#06B6D4', // cyan
  '#22C55E', // green
  '#3B82F6', // blue
  '#EC4899', // pink
  '#F97316', // orange
  '#A855F7', // purple
]

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
}

export function ColorPicker({ value, onChange, className, disabled, swatchOnly }: ColorPickerProps) {
  const { t } = useTranslation('common')
  const recentColors = useUiStore((s) => s.recentColors)
  const addRecentColor = useUiStore((s) => s.addRecentColor)

  const [open, setOpen] = useState(false)
  const [hexDraft, setHexDraft] = useState(value)

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
      // Sync draft when opening
      setHexDraft(normalise(value))
    } else {
      // Record the final chosen color on close (captures drag-to-pick usage)
      if (HEX_RE.test(value)) {
        addRecentColor(value)
      }
    }
    setOpen(next)
  }

  // -------------------------------------------------------------------------
  // Picker callbacks
  // -------------------------------------------------------------------------

  function handlePickerChange(hex: string) {
    // react-colorful fires with lowercase; normalise immediately
    applyColor(hex)
  }

  function handleSwatchClick(hex: string) {
    applyAndRecord(hex)
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
      // Revert draft to current committed value
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
  // Popover content (shared between both trigger styles)
  // -------------------------------------------------------------------------

  const pickerContent = (
    <PopoverContent
      className="w-[240px] p-3 space-y-3"
      align="start"
      sideOffset={8}
      onInteractOutside={() => handleOpenChange(false)}
    >
      {/* Presets */}
      <div>
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
          {t('colorPicker.presets')}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {PRESET_COLORS.map((c) => (
            <ColorSwatch
              key={c}
              color={c}
              isSelected={normalise(value) === c}
              onClick={() => handleSwatchClick(c)}
            />
          ))}
        </div>
      </div>

      {/* Recent colors */}
      {recentColors.length > 0 && (
        <div>
          <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
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
          'font-mono text-[12px] text-zinc-100',
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
              'focus:outline-none focus:ring-2 focus:ring-green-500/30',
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
            'focus:outline-none focus:ring-2 focus:ring-green-500/30',
            'disabled:cursor-not-allowed disabled:opacity-40',
            className
          )}
          aria-label={value}
        >
          <span
            className="h-5 w-5 flex-shrink-0 rounded border border-zinc-700"
            style={{ backgroundColor: value }}
          />
          <span className="font-mono text-[12px] text-zinc-300">{normalise(value)}</span>
        </button>
      </PopoverTrigger>
      {pickerContent}
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// ColorSwatch — small clickable color square used inside the picker popover
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
    />
  )
}
