import type { Config } from 'tailwindcss'
import tailwindAnimate from 'tailwindcss-animate'

const config: Config = {
  darkMode: 'class',
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))'
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          hover:  'hsl(var(--primary-hover))',
          active: 'hsl(var(--primary-active))',
          soft:   'hsl(var(--primary-soft))',
          faint:  'hsl(var(--primary-faint))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
          hover: 'hsl(var(--destructive-hover))',
          soft:  'hsl(var(--destructive-soft))'
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
          soft:       'hsl(var(--warning-soft))',
          faint:      'hsl(var(--warning-faint))',
          'very-faint': 'hsl(var(--warning-very-faint))'
        },
        info: 'hsl(var(--info))',
        'accent-soft': 'hsl(var(--accent-soft))',
        'row-selected': 'hsl(var(--row-selected))',
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        // REQ-20260615-002 MOJIOKO depth / text / state tokens.
        // Mirror Tailwind zinc-* values exactly so direct-class call
        // sites can switch with no visual change.  Keys are deliberately
        // short to avoid Tailwind's utility-prefix doubling (eg.
        // `bg-surface-1`, `text-fg-primary`, `border-line-strong`).
        surface: {
          0: 'hsl(var(--surface-0))',
          1: 'hsl(var(--surface-1))',
          2: 'hsl(var(--surface-2))',
          3: 'hsl(var(--surface-3))',
          4: 'hsl(var(--surface-4))',
          'inverse-0': 'hsl(var(--surface-inverse-0))',
          'inverse-1': 'hsl(var(--surface-inverse-1))',
          'inverse-2': 'hsl(var(--surface-inverse-2))'
        },
        fg: {
          primary:   'hsl(var(--text-primary))',
          secondary: 'hsl(var(--text-secondary))',
          tertiary:  'hsl(var(--text-tertiary))',
          muted:     'hsl(var(--text-muted))',
          disabled:  'hsl(var(--text-disabled))',
          faint:     'hsl(var(--text-faint))',
          inverse:   'hsl(var(--text-inverse))'
        },
        line: {
          DEFAULT: 'hsl(var(--border-default))',
          strong:  'hsl(var(--border-strong))',
          subtle:  'hsl(var(--border-subtle))'
        },
        row: {
          edited:  'hsl(var(--row-edited))',
          error:   'hsl(var(--row-error))',
          playing: 'hsl(var(--row-playing))'
        },
        playhead:       'hsl(var(--playhead))',
        'trim-overlay': 'hsl(var(--trim-overlay))',
        'cursor-active': 'hsl(var(--cursor-active))'
      },
      borderRadius: {
        sm: '4px',
        DEFAULT: '4px',
        md: '6px',
        lg: '8px',
        xl: '10px',
        '2xl': '12px'
      },
      fontFamily: {
        sans: ['Inter', 'Noto Sans JP', 'system-ui', 'sans-serif'],
        mono: ['SF Mono', 'Monaco', 'Consolas', 'monospace']
      },
      transitionDuration: {
        DEFAULT: '150ms'
      },
      fontSize: {
        // REQ-072 role-based type scale (Material Design 3 + Apple HIG
        // adaptation for desktop).  10 styles across 5 role groups.
        // Hierarchy comes from size AND weight AND color — Apple-style
        // "same size, different weight" pairs (headline/body, callout/body-sm)
        // let us add hierarchy without inflating the size scale.
        //
        // ┌─────────────┬──────┬────────┬──────────────────────────────────┐
        // │ Token       │ Size │ Weight │ Role                             │
        // ├─────────────┼──────┼────────┼──────────────────────────────────┤
        // │ display     │ 24   │ 600    │ About / Splash hero              │
        // │ heading     │ 20   │ 600    │ Screen H1                        │
        // │ title       │ 16   │ 600    │ Dialog title                     │
        // │ headline    │ 15   │ 600    │ Card / accordion section title   │
        // │ body        │ 15   │ 400    │ Default body                     │
        // │ callout     │ 13   │ 600    │ Item name in narrow / dense      │
        // │ body-sm     │ 13   │ 400    │ Compact body, values, hints,     │
        // │             │      │        │ descriptions, advisories         │
        // │ label       │ 12   │ 500    │ Uppercase chrome category label  │
        // │             │      │        │ (INPUT VIDEO, SUMMARY, etc.)     │
        // │ caption     │ 12   │ 400    │ Tooltip, kbd, badge, footnote    │
        // │ micro       │ 10   │ 400    │ Timeline only (ruler / in-block  │
        // │             │      │        │ timecode / track gutter /        │
        // │             │      │        │ StyleCell 80px-column labels)    │
        // └─────────────┴──────┴────────┴──────────────────────────────────┘
        //
        // Weight is set at call-site via font-{normal,medium,semibold}
        // because Tailwind's fontSize tuple does not carry weight.  The
        // table above is the canonical pairing — DESIGN_SYSTEM.md §1.3
        // is the prose authority.
        micro:        ['10px', { lineHeight: '14px' }],
        label:        ['12px', { lineHeight: '16px' }],
        caption:      ['12px', { lineHeight: '16px' }],
        'body-sm':    ['13px', { lineHeight: '18px' }],
        callout:      ['13px', { lineHeight: '18px' }],
        body:         ['15px', { lineHeight: '22px' }],
        headline:     ['15px', { lineHeight: '22px' }],
        title:        ['16px', { lineHeight: '24px' }],
        heading:      ['20px', { lineHeight: '28px' }],
        display:      ['24px', { lineHeight: '32px' }]
      }
    }
  },
  plugins: [tailwindAnimate]
}

export default config
