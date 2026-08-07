import { useState, useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Copy, Download, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  return JSON.stringify({ mcpServers: { mojioko: { command: spec.command, args: spec.args } } }, null, 2)
}
function claudeCodeCommand(spec: McpLaunchSpec): string {
  const argsStr = spec.args.map((a) => `"${a}"`).join(' ')
  return `claude mcp add mojioko -- "${spec.command}" ${argsStr}`.trim()
}

export function AiIntegrationTab() {
  const { t } = useTranslation(['settings'])
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [spec, setSpec] = useState<McpLaunchSpec | null>(null)

  useEffect(() => {
    void window.electronAPI.getMcpLaunchSpec().then(setSpec).catch(() => setSpec(null))
  }, [])

  const isDev = spec != null && !spec.isPackaged

  const handleExport = async (): Promise<void> => {
    try {
      const savePath = await saveFileDialog('mojioko.mcpb', undefined, [{ name: 'MCP Bundle', extensions: ['mcpb'] }])
      if (!savePath) return
      const result = await window.electronAPI.exportMcpBundle(savePath)
      if (!result.commandExists) {
        toast.warning(t('ai.commandMissing'))
      } else if (!result.isPackaged) {
        toast.warning(t('ai.devExportToast'))
      } else {
        toast.success(t('ai.exportToast'))
      }
      void shellShowInFolder(result.path)
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
              <Button variant="secondary" size="sm" onClick={handleExport} className="gap-1.5">
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
        </ol>
      </div>

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
              <Button variant="ghost" size="sm" disabled={!spec} onClick={() => spec && copy(desktopConfig(spec))} className="gap-1.5">
                <Copy className="h-3.5 w-3.5" />
                {t('ai.copyConfigButton')}
              </Button>
            </div>
            <div className="space-y-1.5">
              <p className="text-caption text-fg-muted leading-relaxed">{t('ai.codeDesc')}</p>
              <Button variant="ghost" size="sm" disabled={!spec} onClick={() => spec && copy(claudeCodeCommand(spec))} className="gap-1.5">
                <Copy className="h-3.5 w-3.5" />
                {t('ai.copyCodeButton')}
              </Button>
            </div>
          </div>
        )}
      </div>

      <p className="text-caption text-fg-muted leading-relaxed">{t('ai.clientsNote')}</p>
      <p className="text-caption text-fg-muted">{t('ai.cliRef')}</p>
    </div>
  )
}
