import { HelpCircle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface HelpIconProps {
  content: string
}

export function HelpIcon({ content }: HelpIconProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help text-fg-disabled hover:text-fg-tertiary transition-colors duration-150">
          <HelpCircle className="h-3.5 w-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[220px] text-center">
        {content}
      </TooltipContent>
    </Tooltip>
  )
}
