import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

/**
 * REQ-0406 §1 — the "[オプション]" badge shared by the optional STEP 1 sections
 * (processing device, translation tool) so they render identically.  Display
 * only.  Reads the shared `common.optional` label.
 */
export function OptionalBadge({ className }: { className?: string }) {
  const { t } = useTranslation('common')
  return (
    <span
      className={cn(
        // REQ-0421 — overlay reassignment: [オプション] caption → body-sm.
        'text-body-sm font-medium text-fg-muted border border-line rounded px-1.5 py-0.5 flex-shrink-0',
        className,
      )}
    >
      {t('optional')}
    </span>
  )
}
