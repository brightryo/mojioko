import { useState } from 'react'
import { HexColorPicker } from 'react-colorful'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger, PopoverAnchor } from '@/components/ui/popover'
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
   * REQ-0127 Phase 3 — heading shown at the top of the popover (e.g.
   * "フォントカラー選択" / "アウトラインカラー選択") so the modal picker
   * communicates which colour the user is editing.  Callers pass the
   * pre-translated string; `common.colorPicker.headingText` /
   * `.headingOutline` are the canonical i18n keys.  When omitted the
   * heading row is hidden (back-compat for future call sites that
   * don't want a heading).
   */
  heading?: string
  /**
   * Optional "commit" callback fired on popover close, once, with the
   * final value — only when the value actually changed since the popover
   * opened.  Use this from contexts that need a single coarse-grained
   * history op per pick session (e.g. BulkEditBar applying to N rows),
   * separately from `onChange` which fires per-pixel during a saturation
   * drag.  Existing per-row usage that wants live history per micro-move
   * simply omits this prop and continues to rely on `onChange`.
   *
   * REQ-0125 — the second argument carries the popover's open-time
   * value ("before"), so callers can hand it into a beforePatch on the
   * history push and Undo rewinds past any preview mutations from
   * `onChange` during the drag.
   */
  onCommit?: (hex: string, hexOnOpen: string) => void
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
  onPairApply,
  heading
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
        // REQ-0125 — pass the open-time value so the caller can build a
        // beforePatch on its history push (the preview mutations from
        // onChange have already moved the store past `valueOnOpen`, so
        // a naive snapshot at commit time would capture the after-value
        // and Undo would be a no-op).
        onCommit(normalise(value), valueOnOpen)
      }
      setValueOnOpen(null)
    }
    setOpen(next)
  }

  // REQ-0127 Phase 3 — explicit OK / Cancel buttons replace the outside-
  // click-to-commit affordance.  OK re-uses handleOpenChange(false)'s
  // commit path (value has moved via onChange during the session, so the
  // usual "value !== valueOnOpen" check fires onCommit as before).
  // Cancel rewinds the store to `valueOnOpen` via `onChange` (which
  // callers wire to the history-less updateEntryPreview / draft setter,
  // matching REQ-0125's preview stream), then suppresses the onCommit
  // fire by clearing `valueOnOpen` before closing — same trick as
  // handlePairClick.
  function handleConfirm() {
    handleOpenChange(false)
  }
  function handleCancel() {
    if (valueOnOpen !== null && normalise(value) !== valueOnOpen) {
      // Rewind preview state to the open-time value.  Bulk callers wire
      // onChange to setColorDraft + updateEntriesPreview, so this
      // restores both the picker's own displayed value and every
      // selected entry's store value.  Inspector callers wire onChange
      // to updateEntryPreview directly.
      onChange(valueOnOpen)
    }
    setValueOnOpen(null)
    setOpen(false)
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
    // REQ-0125 — the pair-apply path already pushed its own history op
    // via the caller's `onPairApply` closure, so suppress the coarse
    // onCommit that handleOpenChange(false) would otherwise fire (it
    // would double-push under the new preview / commit split).
    setValueOnOpen(null)
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

  // REQ-082: Enter handler removed.  Blur (= click elsewhere) commits the hex.

  // -------------------------------------------------------------------------
  // Popover content
  // -------------------------------------------------------------------------

  const pickerContent = (
    <PopoverContent
      // REQ-0127 Phase 3 — modal via `<Popover modal>` on Root.
      // Backdrop clicks disabled via onInteractOutside.
      // REQ-0128 Phase 2 — the popover is anchored to a fixed viewport
      // position (see PopoverAnchor below) rather than the trigger,
      // so it always fits regardless of where the color swatch sits.
      // The content is a flex column: a scrollable body (rare fallback
      // for constrained viewports) plus a sticky OK/Cancel footer.
      // `align="end"` + `side="bottom"` + `avoidCollisions={false}`
      // keeps Radix from flipping/shifting the popover away from the
      // fixed anchor, so the OK button is guaranteed reachable.
      className="w-[300px] p-0 flex flex-col max-h-[calc(100vh-56px)]"
      align="end"
      side="bottom"
      sideOffset={0}
      avoidCollisions={false}
      onInteractOutside={(e) => e.preventDefault()}
      onEscapeKeyDown={(e) => {
        // Esc = Cancel, per REQ-0127 §3 modal semantics.
        e.preventDefault()
        handleCancel()
      }}
    >
      {/* Scrollable body — grows to fill remaining vertical space, and
          scrolls internally in the rare case the palette is taller than
          the viewport allowance.  The sticky footer below stays pinned. */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
      {/* REQ-0127 Phase 3 — heading row.  Shows which colour is being
          edited (e.g. "フォントカラー選択" / "アウトラインカラー選択")
          + X close button that maps to Cancel (revert + no commit). */}
      {heading && (
        <div className="flex items-center justify-between border-b border-line pb-2 -mb-1">
          <p className="text-body font-semibold text-fg-primary">{heading}</p>
          <button
            type="button"
            onClick={handleCancel}
            className="-mr-1 flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg-secondary transition-colors"
            aria-label={t('colorPicker.close')}
            title={t('colorPicker.close')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {/* "Basic colours" group label + X close button.  When `heading`
          is set, the top-right X was rendered by the heading row above;
          the label here loses the paired X to avoid duplicate close
          affordances but is otherwise unchanged. */}
      <div className="flex items-start justify-between">
        <p className="text-label font-medium uppercase tracking-wider text-fg-muted">
          {t('colorPicker.basic')}
        </p>
        {!heading && (
          <button
            type="button"
            onClick={handleCancel}
            className="-mt-0.5 -mr-1 flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg-secondary transition-colors"
            aria-label={t('colorPicker.close')}
            title={t('colorPicker.close')}
          >
            <X className="h-3 w-3" />
          </button>
        )}
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
            <p className="text-label font-medium uppercase tracking-wider text-fg-muted">
              {t('colorPicker.pairs')}
            </p>
            <span className="text-caption text-fg-disabled">{t('colorPicker.pairsHint')}</span>
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
          <p className="text-label font-medium uppercase tracking-wider text-fg-muted">
            {t('colorPicker.cud')}
          </p>
          <span className="text-caption text-fg-disabled">{t('colorPicker.cudHint')}</span>
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
          <p className="mb-1.5 text-label font-medium uppercase tracking-wider text-fg-muted">
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
        maxLength={7}
        spellCheck={false}
        placeholder="#FFFFFF"
        className={cn(
          'h-8 w-full rounded-md border border-line-strong bg-surface-0 px-2 text-center',
          'font-mono text-body-sm text-fg-primary',
          'focus:outline-none focus-visible:border-surface-4 focus-visible:ring-1 focus-visible:ring-primary/30'
        )}
      />

      </div>{/* /scrollable body */}

      {/* REQ-0127 Phase 3 + REQ-0128 Phase 2 — footer sits OUTSIDE the
          scroll area, so OK / Cancel are guaranteed visible regardless
          of viewport height.  If the body overflows the popover's
          max-height, only the body scrolls; the footer stays pinned.
          OK confirms via the usual handleOpenChange(false) commit path
          (fires onCommit with the after value).  Cancel rewinds the
          preview stream to `valueOnOpen` via onChange(valueOnOpen)
          then closes without firing onCommit.  Aligned right so the
          primary action (OK) sits under the user's mouse in a common
          closing gesture. */}
      <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2 flex-shrink-0 bg-surface-1">
        <button
          type="button"
          onClick={handleCancel}
          className={cn(
            'inline-flex items-center justify-center h-8 px-3 rounded-md text-body-sm',
            'bg-transparent text-fg-secondary border border-line',
            'hover:bg-surface-1 hover:text-fg-primary',
            'transition-colors duration-150 focus:outline-none'
          )}
        >
          {t('colorPicker.cancel')}
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          className={cn(
            'inline-flex items-center justify-center h-8 px-3 rounded-md text-body-sm font-medium',
            'bg-primary text-fg-inverse',
            'hover:bg-primary-hover active:bg-primary-active',
            'transition-colors duration-150 focus:outline-none'
          )}
        >
          {t('colorPicker.ok')}
        </button>
      </div>
    </PopoverContent>
  )

  // -------------------------------------------------------------------------
  // Render — compact swatch or full-width button
  // -------------------------------------------------------------------------

  // REQ-0128 Phase 2 — a fixed-viewport anchor point so the popover
  // renders in a predictable region (top-right of viewport, at a
  // vertical offset that leaves room for the app's top nav +
  // breadcrumb) regardless of where the color-swatch trigger sits.
  // Without this, a trigger placed near the bottom of the viewport
  // gave Radix nowhere to render a ~500 px popover — the OK button
  // would fall below the viewport edge with no way to reach it.  The
  // anchor is a zero-size, pointer-events-none div at fixed
  // `top: 56px right: 12px` — approximately the inspector's top-right
  // corner in the Step 2 layout — and PopoverContent uses
  // `align="end"` `side="bottom"` `avoidCollisions={false}` above so
  // Radix doesn't flip/shift away from it.
  const anchorEl = (
    <PopoverAnchor asChild>
      <div
        aria-hidden
        style={{
          position: 'fixed',
          top: 56,
          right: 12,
          width: 0,
          height: 0,
          pointerEvents: 'none',
        }}
      />
    </PopoverAnchor>
  )

  if (swatchOnly) {
    return (
      <Popover open={open} onOpenChange={handleOpenChange} modal>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'h-6 w-6 flex-shrink-0 rounded border border-line-strong',
              'transition-all duration-150',
              'hover:border-fg-muted hover:scale-110',
              'focus:outline-none focus-visible:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-40',
              className
            )}
            style={{ backgroundColor: value }}
            aria-label={value}
          />
        </PopoverTrigger>
        {anchorEl}
        {pickerContent}
      </Popover>
    )
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange} modal>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex h-9 w-full items-center gap-2 rounded-md border border-line bg-surface-0 px-2.5',
            'transition-colors duration-150 hover:border-line-strong',
            'focus:outline-none focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-40',
            className
          )}
          aria-label={value}
        >
          <span
            className="h-5 w-5 flex-shrink-0 rounded border border-line-strong"
            style={{ backgroundColor: value }}
          />
          <span className="font-mono text-body-sm text-fg-secondary">{normalise(value)}</span>
        </button>
      </PopoverTrigger>
      {anchorEl}
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
          ? 'ring-2 ring-primary ring-offset-1 ring-offset-surface-1'
          : 'ring-1 ring-line-strong/60'
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
        'relative flex h-8 items-center justify-center rounded ring-1 ring-line-strong/60',
        'transition-transform duration-100 hover:scale-105 focus:outline-none',
        'hover:ring-fg-muted'
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
