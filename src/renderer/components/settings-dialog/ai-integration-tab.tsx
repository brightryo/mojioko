import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Copy, Download, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { saveFileDialog, writeTextFile } from '@/services/dialog'

/**
 * REQ-0450 §5 — Settings ▸ AI連携 tab.
 *
 * A one-screen "connect MOJIOKO to Claude" flow (MCP). No CLI reference table —
 * the goal is: export the MCP config, drop it into Claude Desktop, restart, and
 * ask Claude. The exe path is resolved at runtime (NSIS/MSIX differ). Claude
 * Code registration is secondary (collapsible). i18n ja/en.
 */
function desktopConfig(cliPath: string): string {
  return JSON.stringify({ mcpServers: { mojioko: { command: cliPath, args: ['mcp'] } } }, null, 2)
}
function claudeCodeCommand(cliPath: string): string {
  return `claude mcp add mojioko -- "${cliPath}" mcp`
}

export function AiIntegrationTab() {
  const { t } = useTranslation(['settings'])
  const [showCode, setShowCode] = useState(false)

  const cliPath = (): Promise<string> => window.electronAPI.getCliPath()

  const handleExport = async (): Promise<void> => {
    try {
      const path = await cliPath()
      const savePath = await saveFileDialog('claude_desktop_config.json', undefined, [{ name: 'JSON', extensions: ['json'] }])
      if (!savePath) return
      await writeTextFile(savePath, desktopConfig(path))
      toast.success(t('ai.exportToast'))
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

  return (
    <div className="space-y-4 pt-1">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary flex-shrink-0" />
        <p className="text-body font-medium text-fg-primary">{t('ai.title')}</p>
      </div>
      <p className="text-body-sm text-fg-secondary leading-relaxed whitespace-pre-line">{t('ai.lead')}</p>

      {/* Claude Desktop — primary flow */}
      <div className="rounded-md border border-line p-3 space-y-3">
        <p className="text-caption font-medium text-fg-secondary">{t('ai.desktopTitle')}</p>
        <ol className="space-y-3">
          <li className="flex gap-2.5 items-start">
            {stepNum(1)}
            <div className="flex-1 space-y-2">
              <p className="text-body-sm text-fg-primary">{t('ai.step1')}</p>
              <div className="flex gap-2 flex-wrap">
                <Button variant="secondary" size="sm" onClick={handleExport} className="gap-1.5">
                  <Download className="h-3.5 w-3.5" />
                  {t('ai.exportButton')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => cliPath().then((p) => copy(desktopConfig(p)))} className="gap-1.5">
                  <Copy className="h-3.5 w-3.5" />
                  {t('ai.copyConfigButton')}
                </Button>
              </div>
            </div>
          </li>
          <li className="flex gap-2.5 items-start">
            {stepNum(2)}
            <p className="text-body-sm text-fg-primary flex-1">{t('ai.step2')}</p>
          </li>
          <li className="flex gap-2.5 items-start">
            {stepNum(3)}
            <p className="text-body-sm text-fg-primary flex-1">{t('ai.step3')}</p>
          </li>
          <li className="flex gap-2.5 items-start">
            {stepNum(4)}
            <p className="text-body-sm text-fg-primary flex-1">{t('ai.step4')}</p>
          </li>
        </ol>
      </div>

      {/* Claude Code — secondary, collapsible */}
      <div className="rounded-md border border-line">
        <button
          type="button"
          onClick={() => setShowCode((v) => !v)}
          className="w-full flex items-center gap-1.5 px-3 py-2 text-caption text-fg-secondary hover:text-fg-primary transition-colors"
        >
          {showCode ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {t('ai.codeTitle')}
        </button>
        {showCode && (
          <div className="px-3 pb-3 space-y-2">
            <p className="text-caption text-fg-muted leading-relaxed">{t('ai.codeDesc')}</p>
            <Button variant="ghost" size="sm" onClick={() => cliPath().then((p) => copy(claudeCodeCommand(p)))} className="gap-1.5">
              <Copy className="h-3.5 w-3.5" />
              {t('ai.copyCodeButton')}
            </Button>
          </div>
        )}
      </div>

      <p className="text-caption text-fg-muted leading-relaxed">{t('ai.clientsNote')}</p>
      <p className="text-caption text-fg-muted">{t('ai.cliRef')}</p>
    </div>
  )
}
