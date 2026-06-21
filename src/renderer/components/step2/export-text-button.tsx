import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/**
 * REQ-20260615-041 B — STEP2 footer's "transcript export" entry.  The
 * earlier DropdownMenu (テキスト出力 / SRT形式で出力 → two menu items)
 * is replaced by a popover mirroring `ExportFrameButton` so the three
 * footer-right exports (text / image / video) share one popover idiom:
 *
 *   文字起こしデータ出力形式を選択
 *   形式   [ テキストのみ | SRT形式 ]
 *           [ 保存... ]
 *
 * The TXT vs SRT routing logic is unchanged — the parent passes the
 * existing `onExportText` / `onExportSrt` callbacks (= `handleExportText`
 * / `handleExportSrt` in `step2.tsx`), and this component just decides
 * which one to fire based on the toggle's value.  Default = "txt"
 * (テキストのみ) to match the prior dropdown's first item.
 */
type TextFormat = 'txt' | 'srt'

export interface ExportTextButtonProps {
  onExportText: () => Promise<void> | void
  onExportSrt: () => Promise<void> | void
}

export function ExportTextButton({ onExportText, onExportSrt }: ExportTextButtonProps) {
  const { t } = useTranslation(['step2'])
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<TextFormat>('txt')
  const [busy, setBusy] = useState(false)

  async function handleSave() {
    if (busy) return
    setBusy(true)
    setOpen(false)
    try {
      if (format === 'srt') {
        await onExportSrt()
      } else {
        await onExportText()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="md" disabled={busy}>
          <FileText className="h-4 w-4 mr-1.5" />
          {t('action.exportTextLabel')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-64">
        <div className="flex flex-col gap-3">
          <div className="text-body-sm font-semibold text-fg-primary">
            {t('videoPreview.exportText.title')}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-body-sm text-fg-secondary">
              {t('videoPreview.exportText.format')}
            </span>
            <div
              role="radiogroup"
              aria-label={t('videoPreview.exportText.format')}
              className="flex h-7 items-stretch gap-0.5 rounded-md border border-line-strong bg-surface-0 p-0.5"
            >
              {(['txt', 'srt'] as const).map((f) => {
                const selected = format === f
                return (
                  <button
                    key={f}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setFormat(f)}
                    className={cn(
                      'inline-flex items-center justify-center rounded-[3px] px-3 text-caption font-medium transition-colors duration-150',
                      'focus:outline-none focus-visible:outline-none',
                      selected
                        ? 'bg-primary text-fg-inverse'
                        : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-2'
                    )}
                  >
                    {f === 'srt'
                      ? t('videoPreview.exportText.formatSrt')
                      : t('videoPreview.exportText.formatTxt')}
                  </button>
                )
              })}
            </div>
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy}
            className={cn(
              'h-8 inline-flex items-center justify-center rounded-md px-3 text-body-sm font-medium',
              'bg-primary text-fg-inverse hover:bg-primary-hover active:bg-primary-active',
              'transition-colors duration-150',
              'focus:outline-none focus-visible:outline-none',
              'disabled:opacity-40 disabled:cursor-not-allowed'
            )}
          >
            {busy
              ? t('videoPreview.exportText.saving')
              : t('videoPreview.exportText.save')}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
