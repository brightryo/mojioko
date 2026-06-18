import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * tailwind-merge instance teaching the merger about MOJIOKO's custom
 * font-size tokens (`text-display`, `text-heading`, `text-title`,
 * `text-headline`, `text-body`, `text-body-sm`, `text-callout`,
 * `text-caption`, `text-label`, `text-micro`).
 *
 * **Why this matters (Phase 3.8 incident).**  tailwind-merge's default
 * config only recognises the built-in Tailwind font-size names (`xs`,
 * `sm`, `base`, `lg`, `xl`, `2xl`, …).  Our REQ-071 role-based names are
 * unknown to it, so when a component class string contained BOTH a
 * size token (e.g. `text-body`) and a colour token (e.g. `text-fg-inverse`)
 * the merger fell back to bucketing both into "text-color" and the later
 * one in the string won.  Result: every primary Button silently lost
 * `text-fg-inverse` because cva concatenated `variant.primary` BEFORE
 * `size.md`, so `text-body` overrode `text-fg-inverse` and the rendered
 * colour became `rgb(250, 250, 250)` (inherited `text-foreground`).
 *
 * Registering the custom names under the `font-size` group restores the
 * correct classification: `text-body` is a font-size, `text-fg-inverse` is
 * a text-color, the two never conflict, and both survive the merge.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'display',
            'heading',
            'title',
            'headline',
            'body',
            'body-sm',
            'callout',
            'caption',
            'label',
            'micro'
          ]
        }
      ]
    }
  }
})

/** Merge Tailwind class names. Required by shadcn/ui components. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
