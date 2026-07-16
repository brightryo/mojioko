import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { useStoreUpsellStore } from '@/stores/store-upsell-store'
import { shellOpenExternal } from '@/services/dialog'
import { MS_STORE_APP_URL } from '../../../shared/app-info'

/**
 * REQ-091 — "this font is paid-only" upsell shown when a free-tier
 * (NSIS build) user clicks a tier-locked font.  Mounted exactly once at
 * the App root; trigger surfaces flip the global slot in
 * `useStoreUpsellStore` rather than mounting their own dialog instance.
 *
 * Voice / tone (per the REQ): facts only, no emotional language, no
 * price.  The user is told the free version has the default font and
 * the Microsoft Store version unlocks more — no "thank you", no
 * "support us", no "100 % free", no price.  The strings live in
 * `common.json:storeUpsell` because three different namespaces
 * (`settings`, `step1`, `step2`) trigger this dialog and `common` is
 * the only namespace they all already pull in.
 *
 * The "View in Microsoft Store" button deep-links to the Store app via
 * the `ms-windows-store://` URL handler that every Windows 10/11 install
 * registers.  Routing through `shell.openExternal` (allowlisted in
 * `app-info.ts:ALLOWED_EXTERNAL_URLS`) keeps the renderer's CSP /
 * sandbox boundaries intact.  The web fallback
 * `MS_STORE_WEB_URL` is also allowlisted for the rare environment
 * where the Store protocol handler is absent, but the dialog itself
 * always tries the app form first; if `shell.openExternal` reports
 * failure the user simply sees nothing happen and can retry / use the
 * Store app directly — within scope, a richer fallback path isn't
 * warranted for what is a marketing prompt.
 *
 * Dialog never appears in MSIX builds because no surface ever calls
 * `openUpsell()` there (font-tier policy doesn't lock anything in MSIX);
 * mounting it unconditionally costs nothing.
 */
export function StoreUpsellDialog() {
  const { t } = useTranslation('common')
  const isOpen = useStoreUpsellStore((s) => s.open)
  const setOpen = useStoreUpsellStore((s) => s.setOpen)

  function handleOpenStore() {
    // Best effort: failures here would just leave the user looking at
    // a closed dialog with nothing visible happening.  Logging via
    // catch is enough — no toast, no retry; the user can always reach
    // the Store via their own search.
    shellOpenExternal(MS_STORE_APP_URL).catch((err) => {
      console.error('[store-upsell] openExternal failed', err)
    })
    setOpen(false)
  }

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogContent
        className="max-w-[480px]"
        // REQ-0138 §2.1 — Enter opens the Store link (safe: launches
        // the OS browser, no encoding / no destructive action).
        onEnterConfirm={handleOpenStore}
      >
        <DialogHeader>
          <DialogTitle>{t('storeUpsell.title')}</DialogTitle>
          <DialogDescription className="whitespace-pre-line text-body-sm text-muted-foreground">
            {t('storeUpsell.body')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="md" onClick={() => setOpen(false)}>
            {t('storeUpsell.close')}
          </Button>
          <Button variant="primary" size="md" onClick={handleOpenStore}>
            <ExternalLink className="h-4 w-4 mr-1.5" />
            {t('storeUpsell.openStore')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
