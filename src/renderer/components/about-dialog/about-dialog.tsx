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
          {/* App name + version + developer credit.
              REQ-20260615-043: the two stacked lines (name on top, "バージョン
              X.Y.Z" below) were collapsed to "MOJIOKO <version>" on one line
              with a smaller version tail next to the name, and the second
              line now carries the developer-credit sentence.  APP_VERSION is
              the JSON-imported `package.json` version (see app-info.ts) so a
              `npm version` bump flows here automatically.  The CSS-rendered
              green "M" badge that used to sit next to these lines was
              removed in v1.0.0; the Windows window icon is the canonical
              brand mark. */}
          <div>
            <p className="text-body font-semibold text-fg-primary">
              {APP_NAME}
              {/* Smaller, secondary-tier tail so the name remains primary.
                  font-mono + tabular-nums so version digits don't shift
                  the baseline when the dialog opens at different widths. */}
              <span className="ml-2 text-body-sm font-mono tabular-nums text-fg-tertiary">
                {APP_VERSION}
              </span>
            </p>
            <p className="text-body-sm text-fg-tertiary">
              {t('settings:about.developedBy')}
            </p>
          </div>
          <div className="border-t border-line pt-3 space-y-2">
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
                // REQ-0258 — same close-then-open sequencing pattern as
                // the Font Licenses button below.  Opening the EULA
                // synchronously mid-close confuses Radix's focus
                // restoration (About steals focus back before the EULA
                // Content mounts, and the user sees nothing happen).
                setOpen(false)
                setTimeout(() => useUiStore.getState().setEulaDialogOpen(true), 100)
              }}
              className="text-body-sm text-primary hover:underline text-left pt-1"
            >
              {t('common:eula.openButton')} →
            </button>
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
              className="text-body-sm text-primary hover:underline text-left"
            >
              {t('common:fontLicenses.title')} →
            </button>
            <button
              type="button"
              onClick={() => {
                // Opens the bundled `<resourcesPath>/licenses/` directory in
                // the OS file explorer so the user can read each component's
                // licence text (electron-mit, react-mit, ffmpeg-lgpl,
                // faster-whisper-mit, noto-sans-jp-ofl).  Satisfies the
                // EULA §1.2 "THIRD_PARTY_LICENSES" pointer with a real
                // surface the user can reach.
                window.electronAPI?.shellOpenThirdPartyLicensesFolder().catch(() => {})
              }}
              className="text-body-sm text-primary hover:underline text-left"
            >
              {t('common:thirdPartyLicenses.openFolder')} →
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
      <span className="text-body-sm text-fg-tertiary">{label}</span>
      <span className="text-body-sm text-fg-primary font-mono">{value}</span>
    </div>
  )
}
