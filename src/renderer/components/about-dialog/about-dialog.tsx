import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '@/stores/ui-store'
import { getBuildInfo } from '@/services/build-info'
import type { BuildInfo } from '@/services/build-info'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { APP_NAME, APP_VERSION } from '../../../shared/app-info'

export function AboutDialog() {
  const { t } = useTranslation(['settings', 'common'])
  const isOpen = useUiStore((s) => s.isAboutDialogOpen)
  const setOpen = useUiStore((s) => s.setAboutDialogOpen)

  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null)

  useEffect(() => {
    if (!isOpen) return
    getBuildInfo()
      .then(setBuildInfo)
      .catch(() => setBuildInfo(null))
  }, [isOpen])

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogContent className="max-w-[380px]">
        <DialogHeader>
          <DialogTitle>{t('common:menu.about')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {/* App name + version — the CSS-rendered green "M" badge that used
              to sit next to these lines was removed in v1.0.0.  The Windows
              window icon (build/icon.ico) is the canonical brand mark. */}
          <div>
            <p className="text-[14px] font-semibold text-zinc-50">{APP_NAME}</p>
            <p className="text-[12px] text-zinc-500">{t('settings:about.version')} {APP_VERSION}</p>
          </div>
          <div className="border-t border-zinc-800 pt-3 space-y-2">
            <InfoRow label={t('settings:about.license')} value={t('settings:about.licenseValue')} />
            <InfoRow label="Electron" value={buildInfo?.electronVersion ?? '…'} />
            <InfoRow label="Node.js" value={buildInfo?.nodeVersion ?? '…'} />
            <InfoRow label="Chromium" value={buildInfo?.chromeVersion ?? '…'} />
            <InfoRow
              label="Python 3.11"
              value={buildInfo === null ? '…' : buildInfo.pythonAvailable ? t('settings:about.available') : t('settings:about.notAvailable')}
            />
            <button
              type="button"
              onClick={() => {
                // Close About first, then open Font Licenses on the next
                // tick.  Doing both synchronously confuses Radix's focus
                // restoration — the close handler steals focus before the
                // new dialog mounts, and the user sees nothing happen.
                setOpen(false)
                setTimeout(() => useUiStore.getState().setFontLicensesDialogOpen(true), 100)
              }}
              className="text-[12px] text-primary hover:underline text-left pt-1"
            >
              {t('common:fontLicenses.title')} →
            </button>
          </div>
          {/* TODO: add a "Support this project" link row here.  The
              DonationDialog already exists (uiStore.setDonationDialogOpen)
              and the Help menu / command palette / Step 3 success footer
              all reach it; About is currently the only canonical "what is
              this app" surface that does not offer the door.  Deferred —
              not part of the UI redesign branch's required scope. */}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] text-zinc-400">{label}</span>
      <span className="text-[12px] text-zinc-100 font-mono">{value}</span>
    </div>
  )
}
