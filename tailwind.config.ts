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
          foreground: 'hsl(var(--primary-foreground))'
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
          foreground: 'hsl(var(--destructive-foreground))'
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))'
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
