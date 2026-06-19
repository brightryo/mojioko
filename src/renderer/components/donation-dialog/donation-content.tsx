import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
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
    <div className="flex items-center justify-between rounded-lg border border-line bg-surface-0 px-4 py-3 gap-4">
      <div className="min-w-0">
        <p className="text-body font-medium text-fg-primary">{title}</p>
        <p className="mt-0.5 text-body-sm text-fg-tertiary">{subtitle}</p>
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

/**
 * REQ-20260615-023: shared donation card stack used by both the standalone
 * DonationDialog and the burn-in completion dialog's embedded support
 * section.  Centralising the cards here keeps the two surfaces in sync
 * without one importing the other.
 */
export function DonationContent() {
  const { t } = useTranslation('donation')
  return (
    <div className="space-y-2">
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
  )
}
