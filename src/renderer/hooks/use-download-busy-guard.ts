import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  useDownloadActiveStore,
  isOtherDownloadActive,
} from '@/stores/download-active-store'
import type { DownloadKind, ActiveDownloadInfo } from '../../shared/ipc-contracts'

/**
 * REQ-0241 — the shared "is another download active?" gate used by the
 * whisper-model manager, GPU-tool card, and font picker.  Returns:
 *
 *   - `blocked`: true when a DL of a *different* kind is in flight.
 *     Same-kind activity is treated as this manager's own progress
 *     (each manager keeps its own inline progress UI) and does NOT
 *     block the caller's controls.  Passing `myKind: null` makes any
 *     active DL blocking (used by helper surfaces that don't own a
 *     particular kind).
 *   - `active`: the raw ActiveDownloadInfo snapshot (null when idle).
 *   - `tooltip`: the localized string to attach to a disabled trigger
 *     button's tooltip (`""` when not blocked, so `disabled && tooltip`
 *     branches cleanly).
 *   - `showBusyToast()`: helper the click handler calls when the user
 *     nevertheless triggers the action (e.g. keyboard shortcut, or
 *     the UI let the click through).  Also called by DL start paths
 *     when the DownloadManager surfaces a busy error late.
 *
 * The `kindDesc` lookup names the *active* kind (so the message says
 * "a Whisper model download is in progress" even when the user
 * clicked a font button), not the caller's own kind.  This matches the
 * REQ intent ("進行中である旨と対象を表示").
 */
export function useDownloadBusyGuard(myKind: DownloadKind | null): {
  blocked: boolean
  active: ActiveDownloadInfo | null
  tooltip: string
  showBusyToast: () => void
  describeBusy: (info: ActiveDownloadInfo | { activeKind: DownloadKind | 'unknown'; activeLabel: string }) => { kindDesc: string; label: string }
} {
  const active = useDownloadActiveStore((s) => s.active)
  const { t } = useTranslation('common')

  const describeBusy = useCallback(
    (info: ActiveDownloadInfo | { activeKind: DownloadKind | 'unknown'; activeLabel: string }) => {
      const kind = 'kind' in info ? info.kind : info.activeKind
      const label = 'kind' in info ? info.label : info.activeLabel
      const kindDescKey =
        kind === 'model'
          ? 'download.busy.kind_model'
          : kind === 'gpu-tool'
            ? 'download.busy.kind_gpuTool'
            : kind === 'font'
              ? 'download.busy.kind_font'
              : 'download.busy.kind_unknown'
      return { kindDesc: t(kindDescKey), label }
    },
    [t],
  )

  const blocked = isOtherDownloadActive(active, myKind)

  const tooltip = blocked && active
    ? t('download.busy.tooltip', describeBusy(active))
    : ''

  const showBusyToast = useCallback(() => {
    if (!active) return
    toast.warning(t('download.busy.toast', describeBusy(active)))
  }, [active, t, describeBusy])

  return { blocked, active, tooltip, showBusyToast, describeBusy }
}
