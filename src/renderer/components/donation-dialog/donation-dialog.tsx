import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { useUiStore } from '@/stores/ui-store'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { shellOpenExternal } from '@/services/dialog'
import { DOCUMENTATION_URLS } from '../../../shared/app-info'

interface DonationCardProps {
  title: string
  subtitle: string
  cta: string
  url: string
}

function DonationCard({ title, subtitle, cta, url }: DonationCardProps) {
  function handleClick() {
    shellOpenExternal(url).catch(() => {})
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3 gap-4">
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-zinc-100">{title}</p>
        {/* REQ-067 phase B: was text-zinc-500.  Subtitle is a description
            line under each donation channel — body-adjacent, not a hint —
            lifted to text-zinc-400 (AAA pass). */}
        <p className="mt-0.5 text-[11px] text-zinc-400">{subtitle}</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="flex-shrink-0 gap-1.5"
        onClick={handleClick}
      >
        <ExternalLink className="h-3.5 w-3.5" />
        {cta}
      </Button>
    </div>
  )
}

export function DonationDialog() {
  const { t } = useTranslation('donation')
  const isOpen = useUiStore((s) => s.isDonationDialogOpen)
  const setOpen = useUiStore((s) => s.setDonationDialogOpen)

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogContent className="w-[520px] max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription className="text-[14px] text-zinc-400">
            {t('description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 pt-1">
          <DonationCard
            title={t('buymeacoffee.title')}
            subtitle={t('buymeacoffee.subtitle')}
            cta={t('buymeacoffee.cta')}
            url={DOCUMENTATION_URLS.donationBuyMeACoffee}
          />
          <DonationCard
            title={t('booth.title')}
            subtitle={t('booth.subtitle')}
            cta={t('booth.cta')}
            url={DOCUMENTATION_URLS.donationBooth}
          />
          <DonationCard
            title={t('github.title')}
            subtitle={t('github.subtitle')}
            cta={t('github.cta')}
            url={DOCUMENTATION_URLS.donationGitHub}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
