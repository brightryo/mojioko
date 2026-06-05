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
        // REQ-071 Phase 1: role-based scale (single source of truth).
        // Values per RES-20260601-071-design §1.2 (option B).  Migration of
        // arbitrary `text-[Npx]` call-sites happens in Phase 2 (body), Phase 3
        // (caption / label / micro), Phase 5 (legacy cleanup).
        //   micro       — timeline-only constrained surfaces (ruler ticks,
        //                 block in-time, track labels, StyleCell mini-labels)
        //   label       — uppercase tracking-wider section labels
        //   caption     — hints, tooltips, kbd, badges, table headers
        //   body-sm     — compact rows, time-cell values (REQ-068 value)
        //   body        — default body text (REQ-071 lift 14 → 15)
        //   subheading  — card section titles (currently not used; available)
        //   heading     — screen H1 (REQ-071 lift 18 → 20, matches spec)
        //   display     — About / Splash headline (spec value)
        micro:        ['10px', { lineHeight: '14px' }],
        label:        ['12px', { lineHeight: '16px' }],
        caption:      ['12px', { lineHeight: '16px' }],
        'body-sm':    ['13px', { lineHeight: '18px' }],
        body:         ['15px', { lineHeight: '22px' }],
        subheading:   ['16px', { lineHeight: '24px' }],
        heading:      ['20px', { lineHeight: '28px' }],
        display:      ['24px', { lineHeight: '32px' }],

        // Legacy — retained during the REQ-071 migration so call-sites that
        // still use `text-2xs` (none today, but reserved in case a future
        // shadcn import lands one) keep compiling.  Slated for removal at
        // the end of Phase 5 once the full sweep is done.
        '2xs': ['11px', { lineHeight: '16px' }]
      }
    }
  },
  plugins: [tailwindAnimate]
}

export default config
