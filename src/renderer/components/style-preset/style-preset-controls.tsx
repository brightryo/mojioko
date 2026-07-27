import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Palette, Trash2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { useSettingsStore } from '@/stores/settings-store'
import {
  STYLE_PRESET_MAX,
  STYLE_PRESET_NAME_MAX_LEN,
  validatePresetName,
  type PresetNameError,
  type StylePreset,
} from '../../../shared/style-preset'
import { cn } from '@/lib/utils'

/**
 * REQ-0335 §3-6 — the one preset surface, shared by the Step 2 inspector
 * (single cue) and the bulk-edit bar (every selected cue).
 *
 * It owns the picker, the naming dialog and deletion; it deliberately does
 * NOT own application.  The caller passes `onApply`, because "one undoable
 * operation" means something different on each surface: the inspector pushes
 * a single-row history entry, the bulk-edit bar pushes one entry covering
 * the whole selection.  Putting `applyStyleEdit` / `applyBulk` behind one
 * abstraction here would have meant re-implementing one of them.
 */
export interface StylePresetControlsProps {
  /**
   * Snapshot source for "save current style as a preset".  `null` disables
   * saving (nothing unambiguous to snapshot — e.g. a multi-row selection
   * whose rows differ), while applying and deleting stay available.
   */
  onSaveCurrent: ((name: string) => void) | null
  /** Apply `preset` to the caller's target row(s), as ONE undoable op. */
  onApply: (preset: StylePreset) => void
  /** Extra classes for the trigger button. */
  className?: string
  /** Render a compact icon-only trigger (bulk-edit bar). */
  compact?: boolean
}

export function StylePresetControls({
  onSaveCurrent,
  onApply,
  className,
  compact = false,
}: StylePresetControlsProps) {
  const { t } = useTranslation(['step2', 'common'])
  const presets = useSettingsStore((s) => s.stylePresets)
  const deleteStylePreset = useSettingsStore((s) => s.deleteStylePreset)

  const [saveOpen, setSaveOpen] = useState(false)
  const [draftName, setDraftName] = useState('')

  // Validate on every keystroke so the Save button's disabled state and the
  // reason shown under the field never disagree.
  const nameError: PresetNameError | null = saveOpen
    ? validatePresetName(draftName, presets)
    : null
  // An empty field is the initial state, not a mistake worth shouting about.
  const showError = nameError !== null && (nameError !== 'empty' || draftName.length > 0)

  function errorText(err: PresetNameError): string {
    switch (err) {
      case 'empty':
        return t('preset.error.empty')
      case 'too-long':
        return t('preset.error.tooLong', { max: STYLE_PRESET_NAME_MAX_LEN })
      case 'duplicate':
        return t('preset.error.duplicate')
      case 'cap-reached':
        return t('preset.error.capReached', { max: STYLE_PRESET_MAX })
    }
  }

  function openSave() {
    setDraftName('')
    setSaveOpen(true)
  }

  function confirmSave() {
    if (nameError !== null || onSaveCurrent === null) return
    onSaveCurrent(draftName.trim())
    setSaveOpen(false)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="md"
            className={cn('gap-1.5', className)}
            title={t('preset.menu')}
          >
            <Palette className="h-3.5 w-3.5" />
            {!compact && <span>{t('preset.menu')}</span>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>{t('preset.apply')}</DropdownMenuLabel>
          {presets.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {t('preset.empty')}
            </div>
          ) : (
            presets.map((p) => (
              <DropdownMenuItem
                key={p.id}
                className="justify-between gap-2"
                onSelect={() => onApply(p)}
              >
                <span className="truncate">{p.name}</span>
                <button
                  type="button"
                  aria-label={t('preset.delete', { name: p.name })}
                  title={t('preset.delete', { name: p.name })}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    // Deleting must not also apply the preset it sits on.
                    e.preventDefault()
                    e.stopPropagation()
                    deleteStylePreset(p.id)
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={onSaveCurrent === null}
            onSelect={(e) => {
              // Keep the menu's close animation from racing the dialog mount.
              e.preventDefault()
              openSave()
            }}
          >
            <Plus className="mr-2 h-3.5 w-3.5" />
            {t('preset.saveCurrent')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('preset.saveTitle')}</DialogTitle>
            <DialogDescription>{t('preset.saveDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              autoFocus
              value={draftName}
              maxLength={STYLE_PRESET_NAME_MAX_LEN}
              placeholder={t('preset.namePlaceholder')}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  confirmSave()
                }
              }}
            />
            {showError && nameError !== null && (
              <p className="text-xs text-destructive">{errorText(nameError)}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="lg" onClick={() => setSaveOpen(false)}>
              {t('common:action.cancel')}
            </Button>
            <Button variant="primary" size="lg" onClick={confirmSave} disabled={nameError !== null}>
              {t('common:action.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
