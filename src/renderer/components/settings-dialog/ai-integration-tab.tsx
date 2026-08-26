import { useState, useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Copy, Download, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AiConsentDialog } from '@/components/ai-consent-dialog/ai-consent-dialog'
import { useSettingsStore } from '@/stores/settings-store'
import { needsAiConsentGate, needsAiRetroactiveNotice } from '../../../shared/ai-consent'
import { toast } from '@/lib/toast'
import { saveFileDialog, shellShowInFolder } from '@/services/dialog'
import type { McpLaunchSpec } from '../../../shared/mcp'

/**
 * REQ-0450 §5 / REQ-0451 §2 / REQ-0452 — Settings ▸ AI連携 tab.
 *
 * Drag-and-drop MCP setup: Export .mcpb → drop into Claude Desktop ▸ Extensions
 * → restart → ask Claude. Manual config JSON + `claude mcp add` are in a
 * collapsible "advanced" section. All launch strings come from the SAME
 * dev/packaged-correct launch spec (REQ-0452), and dev exports show a warning.
 */
function desktopConfig(spec: McpLaunchSpec): string {
  // REQ-0455 — include env (ELECTRON_RUN_AS_NODE=1 for the clean-stdout proxy).
  return JSON.stringify(
    { mcpServers: { mojioko: { command: spec.command, args: spec.args, env: spec.env } } },
    null,
    2,
  )
}
function claudeCodeCommand(spec: McpLaunchSpec): string {
  const argsStr = spec.args.map((a) => `"${a}"`).join(' ')
  // REQ-0455 — pass env vars via `--env KEY=VALUE` before the `--` separator.
  const envStr = Object.entries(spec.env)
    .map(([k, v]) => `--env ${k}=${v}`)
    .join(' ')
  return `claude mcp add mojioko ${envStr} -- "${spec.command}" ${argsStr}`.replace(/\s+/g, ' ').trim()
}

export function AiIntegrationTab() {
  const { t } = useTranslation(['settings'])
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [spec, setSpec] = useState<McpLaunchSpec | null>(null)

  /*
   * ★ REQ-0551 — the consent gate.
   *
   * Every action on this tab that hands connection details to an assistant goes
   * through `runGated`, so "which buttons are gated" has ONE answer. The tab
   * has no enable switch: exporting the bundle and copying a config ARE the
   * enabling acts, and gating only the export would leave the two copy buttons
   * as an unguarded way to reach exactly the same place.
   */
  const consent = useSettingsStore((st) => st.aiIntegration)
  const acceptAiConsent = useSettingsStore((st) => st.acceptAiConsent)
  const markAiNoticeSeen = useSettingsStore((st) => st.markAiNoticeSeen)
  const [dialog, setDialog] = useState<null | { mode: 'gate' | 'notice'; run?: () => void }>(null)

  useEffect(() => {
    void window.electronAPI.getMcpLaunchSpec().then(setSpec).catch(() => setSpec(null))
  }, [])

  // REQ-0551 §1-4 — someone who set this up before the gate existed is told
  // once, when they next open this tab. Their setup is NOT revoked; the notice
  // says so. `lastExport` is the evidence that they are already configured.
  useEffect(() => {
    if (!spec) return
    if (!needsAiRetroactiveNotice(consent, Boolean(spec.lastExport))) return
    setDialog({ mode: 'notice' })
  }, [spec, consent])

  /** Run `action`, asking first if the user has never agreed. */
  const runGated = (action: () => void): void => {
    if (needsAiConsentGate(consent)) {
      setDialog({ mode: 'gate', run: action })
      return
    }
    action()
  }

  const isDev = spec != null && !spec.isPackaged

  const handleExport = async (): Promise<void> => {
    try {
      const savePath = await saveFileDialog('mojioko.mcpb', undefined, [{ name: 'MCP Bundle', extensions: ['mcpb'] }])
      if (!savePath) return
      const result = await window.electronAPI.exportMcpBundle(savePath)
      if (!result.commandExists) {
        toast.warning(t('ai.commandMissing'))
      } else if (result.isPackaged && !result.proxyExists) {
        // REQ-0463 — packaged build whose asarUnpack regressed: the proxy the
        // launch runs never shipped, so the bundle would silently do nothing.
        toast.warning(t('ai.proxyMissing'))
      } else if (!result.isPackaged) {
        toast.warning(t('ai.devExportToast'))
      } else {
        toast.success(t('ai.exportToast'))
      }
      void shellShowInFolder(result.path)
      // REQ-0458 §3 — refresh so the bundle-status block reflects this export.
      void window.electronAPI.getMcpLaunchSpec().then(setSpec).catch(() => {})
    } catch {
      toast.error(t('ai.actionError'))
    }
  }
  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t('ai.copyToast'))
    } catch {
      toast.error(t('ai.actionError'))
    }
  }

  const stepNum = (n: number) => (
    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-surface-3 text-fg-secondary text-caption font-medium inline-flex items-center justify-center">
      {n}
    </span>
  )
  const step = (n: number, text: string, extra?: ReactNode) => (
    <li className="flex gap-2.5 items-start">
      {stepNum(n)}
      <div className="flex-1 space-y-2">
        <p className="text-body-sm text-fg-primary">{text}</p>
        {extra}
      </div>
    </li>
  )

  return (
    <div className="space-y-4 pt-1">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary flex-shrink-0" />
        <p className="text-body font-medium text-fg-primary">{t('ai.title')}</p>
      </div>
      <p className="text-body-sm text-fg-secondary leading-relaxed whitespace-pre-line">{t('ai.lead')}</p>

      {/* Claude Desktop — drag-and-drop primary flow */}
      <div className="rounded-md border border-line p-3 space-y-3">
        <p className="text-caption font-medium text-fg-secondary">{t('ai.desktopTitle')}</p>
        <ol className="space-y-3">
          {step(
            1,
            t('ai.step1'),
            <div className="space-y-2">
              <Button variant="secondary" size="sm" onClick={() => runGated(() => { void handleExport() })} className="gap-1.5">
                <Download className="h-3.5 w-3.5" />
                {t('ai.exportButton')}
              </Button>
              {isDev && (
                <div className="flex items-start gap-1.5 text-caption text-warning">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                  <span>{t('ai.devNote')}</span>
                </div>
              )}
            </div>,
          )}
          {step(2, t('ai.step2'))}
          {step(3, t('ai.step3'))}
          {step(4, t('ai.step4'))}
          {step(5, t('ai.step5'))}
        </ol>
      </div>

      {/* REQ-0458 §3 — last-exported bundle info + staleness prompt */}
      {spec && (
        <div className="rounded-md border border-line p-3 space-y-1.5">
          <p className="text-caption font-medium text-fg-secondary">{t('ai.bundleStatusTitle')}</p>
          {spec.lastExport ? (
            <p className="text-caption text-fg-muted">
              {t('ai.lastExport', {
                version: spec.lastExport.appVersion,
                rev: spec.lastExport.launchSpecRevision,
                date: new Date(spec.lastExport.exportedAtMs).toLocaleString(),
              })}
            </p>
          ) : (
            <p className="text-caption text-fg-muted">{t('ai.neverExported')}</p>
          )}
          {spec.lastExport && spec.lastExport.launchSpecRevision !== spec.launchSpecRevision && (
            <div className="flex items-start gap-1.5 text-caption text-warning">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span>{t('ai.reexportNeeded', { rev: spec.launchSpecRevision })}</span>
            </div>
          )}
          <p className="text-caption text-fg-muted leading-relaxed">{t('ai.reinstallNote')}</p>
        </div>
      )}

      {/* Advanced — manual config / Claude Code (collapsible) */}
      <div className="rounded-md border border-line">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="w-full flex items-center gap-1.5 px-3 py-2 text-caption text-fg-secondary hover:text-fg-primary transition-colors"
        >
          {showAdvanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {t('ai.advancedTitle')}
        </button>
        {showAdvanced && (
          <div className="px-3 pb-3 space-y-3">
            <div className="space-y-1.5">
              <p className="text-caption text-fg-muted leading-relaxed">{t('ai.configDesc')}</p>
              <Button variant="ghost" size="sm" disabled={!spec} onClick={() => runGated(() => { if (spec) void copy(desktopConfig(spec)) })} className="gap-1.5">
                <Copy className="h-3.5 w-3.5" />
                {t('ai.copyConfigButton')}
              </Button>
            </div>
            <div className="space-y-1.5">
              <p className="text-caption text-fg-muted leading-relaxed">{t('ai.codeDesc')}</p>
              <Button variant="ghost" size="sm" disabled={!spec} onClick={() => runGated(() => { if (spec) void copy(claudeCodeCommand(spec)) })} className="gap-1.5">
                <Copy className="h-3.5 w-3.5" />
                {t('ai.copyCodeButton')}
              </Button>
            </div>
          </div>
        )}
      </div>

      <p className="text-caption text-fg-muted leading-relaxed">{t('ai.clientsNote')}</p>
      <p className="text-caption text-fg-muted">{t('ai.cliRef')}</p>
      {/* REQ-0551 — the same text in both modes; see the component. */}
      <AiConsentDialog
        open={dialog !== null}
        mode={dialog?.mode ?? 'gate'}
        onAccept={() => {
          const pending = dialog
          setDialog(null)
          acceptAiConsent()
          // The action the user was trying to take, resumed. A gate that made
          // them click twice would be a gate people learn to dismiss.
          pending?.run?.()
        }}
        onDismiss={() => {
          const wasNotice = dialog?.mode === 'notice'
          setDialog(null)
          // Dismissing the retroactive notice is not agreement, but it IS
          // "we told them" — recording it stops the nag without pretending
          // they consented (the gate still applies to future actions).
          if (wasNotice) markAiNoticeSeen()
        }}
      />
    </div>
  )
}
