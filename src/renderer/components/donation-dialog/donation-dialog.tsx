import { useTranslation } from 'react-i18next'
import { useUiStore } from '@/stores/ui-store'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { DonationContent } from './donation-content'

export function DonationDialog() {
  const { t } = useTranslation('donation')
  const isOpen = useUiStore((s) => s.isDonationDialogOpen)
  const setOpen = useUiStore((s) => s.setDonationDialogOpen)

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogContent className="w-[520px] max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription className="text-body text-fg-tertiary">
            {t('description')}
          </DialogDescription>
        </DialogHeader>
        <div className="pt-1">
          <DonationContent />
        </div>
      </DialogContent>
    </Dialog>
  )
}
