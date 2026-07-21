import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { useUiStore } from '@/stores/ui-store'
import { readEula } from '@/services/eula'

/**
 * REQ-0258 — full-text MOJIOKO EULA viewer opened from the About dialog.
 *
 * MSIX / AppX packaging has no install-time EULA hook (electron-builder's
 * AppXOptions carries no `license:` field), so paid-edition users would
 * otherwise never see the EULA body — the About dialog previously
 * exposed only a "License: Proprietary" one-liner.  This dialog reads
 * `build/license_<lang>.txt` (via extraResources under
 * `<resourcesPath>/eula/`) matched to the current i18n language and
 * shows it verbatim in a monospaced scroll area, so both editions
 * reach the same document.  See REQ-0258 §2.2.
 */
export function EulaDialog() {
  const { t, i18n } = useTranslation('common')
  const isOpen = useUiStore((s) => s.isEulaDialogOpen)
  const setOpen = useUiStore((s) => s.setEulaDialogOpen)

  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) {
      // Clear the previous language's cached text so re-opening after a
      // language switch (Settings → General) fetches the new file
      // rather than flashing the stale content for a frame.
      setText(null)
      setError(null)
      return
    }
    const lang: 'ja' | 'en' = i18n.language.startsWith('ja') ? 'ja' : 'en'
    let cancelled = false
    readEula(lang)
      .then((r) => {
        if (cancelled) return
        if (r.ok) {
          setText(r.data)
          setError(null)
        } else {
          setText(null)
          setError(r.error.code)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setText(null)
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, i18n.language])

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogContent className="max-w-[720px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('eula.title')}</DialogTitle>
          <DialogDescription className="text-body-sm text-muted-foreground">
            {t('eula.intro')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-md border border-border bg-muted/30 p-4">
          {text !== null && (
            <pre className="text-caption font-mono text-fg-secondary whitespace-pre-wrap break-words">
              {text}
            </pre>
          )}
          {text === null && error === null && (
            <p className="text-body-sm text-muted-foreground">
              {t('eula.loading')}
            </p>
          )}
          {error !== null && (
            <p className="text-body-sm text-red-500">
              {t('eula.error', { error })}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
