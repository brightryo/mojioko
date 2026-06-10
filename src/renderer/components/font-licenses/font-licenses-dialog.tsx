import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { useUiStore } from '@/stores/ui-store'
import { readFontOfl } from '@/services/font'
import { FONT_REGISTRY, type FontId, type FontMeta } from '../../../shared/fonts'

/**
 * Per-font OFL attribution surface.  Lists every font in the registry,
 * surfaces the copyright line from the registry verbatim, and offers a
 * deep-link to the upstream source page.
 *
 * For downloaded fonts the panel can also read the local OFL.txt sibling
 * via `fontReadOfl` so the user can verify the licence text without
 * leaving the app.  Bundled fonts (Noto) fall back to a synthesised
 * one-liner — the full Noto OFL text ships separately in installer/
 * licenses/noto-ofl.txt and is acceptable to surface via the upstream
 * link.
 */
export function FontLicensesDialog() {
  const { t } = useTranslation('common')
  const isOpen = useUiStore((s) => s.isFontLicensesDialogOpen)
  const setOpen = useUiStore((s) => s.setFontLicensesDialogOpen)

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogContent className="max-w-[600px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('fontLicenses.title')}</DialogTitle>
          <DialogDescription className="text-body-sm text-muted-foreground">
            {t('fontLicenses.intro')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-2">
          {FONT_REGISTRY.map((meta) => (
            <FontLicenseEntry key={meta.id} meta={meta} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function FontLicenseEntry({ meta }: { meta: FontMeta }) {
  const { t } = useTranslation('common')
  const [oflText, setOflText] = useState<string | null>(null)
  const [oflLoaded, setOflLoaded] = useState(false)

  async function loadOfl() {
    if (oflLoaded) {
      // Toggle — hide on a second click so the dialog stays compact.
      setOflLoaded(false)
      return
    }
    const r = await readFontOfl(meta.id as FontId)
    if (r.ok) {
      setOflText(r.data)
      setOflLoaded(true)
    }
  }

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span
          className="text-body font-medium text-foreground truncate"
          style={{ fontFamily: `'${meta.cssFontFamily}'`, fontWeight: meta.weight }}
        >
          {meta.displayName}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={loadOfl}
            className="text-caption text-muted-foreground hover:text-foreground transition-colors"
          >
            {oflLoaded ? '−' : '+'} {t('fontLicenses.viewOnDisk')}
          </button>
          <a
            href={meta.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground transition-colors"
            onClick={(e) => {
              e.preventDefault()
              window.electronAPI?.shellOpenExternal(meta.sourceUrl).catch(() => {})
            }}
          >
            <ExternalLink className="h-3 w-3" />
            {t('fontLicenses.openSource')}
          </a>
        </div>
      </div>
      <div className="text-body-sm text-muted-foreground">
        <span className="font-medium text-foreground/80">{t('fontLicenses.copyrightHeader')}:</span>{' '}
        {meta.copyright}
      </div>
      {oflLoaded && oflText && (
        <pre className="mt-2 max-h-[200px] overflow-y-auto text-caption font-mono text-muted-foreground/80 bg-muted/30 rounded p-2 whitespace-pre-wrap">
          {oflText}
        </pre>
      )}
    </div>
  )
}

// Defer the empty-effect-shaped placeholder for future per-font cache work.
// Kept so the diff is easy to extend (currently unused).
function _useNoop() {
  useEffect(() => undefined, [])
}
void _useNoop
