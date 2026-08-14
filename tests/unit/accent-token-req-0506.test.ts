import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * REQ-0506 §1-2 — pin the accent's LITERAL value.
 *
 * CLAUDE.md §5 states that `--primary` is `148 64% 54%` ≈ `#3FD585`, that it is
 * "**Not** green-500 `#22c55e`, and no longer the REQ-0177 muted `#46AA7B` — do
 * not revert to either", and that "the single source of truth is
 * `globals.css` (`tests/e2e/green-button-color.spec.ts` pins the live value)".
 *
 * That last clause was false. The e2e spec deliberately pins no colour — it
 * reads `--primary` from the live stylesheet and asserts foreground/background
 * differ, which is a contrast check, not a value check. Nothing in `tests/` or
 * `scripts/` contained the string `148 64% 54%`, so reverting the token to
 * either explicitly-forbidden colour passed the entire suite (RES-0505 §3, M5).
 *
 * Division of labour, now that both exist:
 *   - this file        — the literal value, statically, in `npm test`
 *   - green-button-color.spec.ts — that the theme actually LOADS and the
 *     rendered button is legible (a value pin cannot see a stylesheet that
 *     failed to apply)
 */

const ROOT = join(__dirname, '..', '..')
const GLOBALS_CSS = join(ROOT, 'src', 'renderer', 'styles', 'globals.css')
const TOKENS_TS = join(ROOT, 'src', 'renderer', 'lib', 'tokens.ts')

/** The accent, exactly as CLAUDE.md §5 and REQ-0418 v2 define it. */
const EXPECTED_HSL = '148 64% 54%'
const EXPECTED_HEX = '#3fd585'

/**
 * Values §5 explicitly forbids reverting to.
 *
 * Listed as HSL because that is the form `globals.css` stores; a reviewer
 * reading a diff sees the numbers, not a name.
 */
const FORBIDDEN = [
  { name: 'Tailwind green-500 (#22c55e)', hsl: '142 71% 45%' },
  { name: 'REQ-0177 muted green (#46AA7B)', hsl: '152 42% 47%' },
]

/** First `--primary:` declaration in the `:root` block. */
export function readPrimaryHsl(css: string): string | null {
  const m = /--primary:\s*([^;]+);/.exec(css)
  return m ? m[1].trim() : null
}

/** `H S% L%` → `#rrggbb`, so the two stored copies can be compared directly. */
export function hslToHex(hsl: string): string {
  const m = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/.exec(hsl.trim())
  if (!m) throw new Error(`not an HSL triple: ${hsl}`)
  const h = Number(m[1])
  const s = Number(m[2]) / 100
  const l = Number(m[3]) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const mm = l - c / 2
  const seg = Math.floor(h / 60) % 6
  const [r, g, b] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][seg]
  const to = (v: number): string => Math.round((v + mm) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

describe('REQ-0506 §1-2 — the accent value is pinned', () => {
  const css = readFileSync(GLOBALS_CSS, 'utf-8')

  it('globals.css --primary is the REQ-0418 v2 vivid green', () => {
    expect(readPrimaryHsl(css)).toBe(EXPECTED_HSL)
  })

  it.each(FORBIDDEN)('globals.css --primary is NOT $name', ({ hsl }) => {
    expect(readPrimaryHsl(css)).not.toBe(hsl)
  })

  it('the HSL resolves to the hex CLAUDE.md §5 quotes', () => {
    expect(hslToHex(EXPECTED_HSL)).toBe(EXPECTED_HEX)
  })

  it('tokens.ts carries the SAME accent (the two copies cannot drift apart)', () => {
    // `tokens.ts` mirrors the value as a hex literal for JS consumers. Two
    // stored copies of one colour is two chances to diverge, so tie them.
    const tokens = readFileSync(TOKENS_TS, 'utf-8')
    const m = /accent:\s*'(#[0-9a-fA-F]{6})'/.exec(tokens)
    expect(m, 'tokens.ts should declare `accent: <hex>`').not.toBeNull()
    expect(m![1].toLowerCase()).toBe(hslToHex(readPrimaryHsl(css)!))
  })
})

/**
 * ★ Negative controls. A value pin that cannot reject the specific colours the
 * design system forbids would be the same empty gesture the CLAUDE.md sentence
 * was — so both banned values are fed through the real reader.
 */
describe('REQ-0506 §1-2 — NEGATIVE CONTROL: the forbidden colours are rejected', () => {
  it.each(FORBIDDEN)('reverting to $name is caught', ({ hsl }) => {
    const reverted = `:root {\n  --primary: ${hsl};\n}\n`
    expect(readPrimaryHsl(reverted)).toBe(hsl)
    expect(readPrimaryHsl(reverted)).not.toBe(EXPECTED_HSL)
  })

  it('the reader returns null rather than silently passing when the token is gone', () => {
    // If a refactor renamed the variable, `null !== EXPECTED_HSL` fails loudly
    // instead of the suite quietly checking nothing.
    expect(readPrimaryHsl(':root { --brand: 148 64% 54%; }')).toBeNull()
  })

  it('hslToHex is a real conversion, not an identity', () => {
    expect(hslToHex('0 0% 100%')).toBe('#ffffff')
    expect(hslToHex('0 0% 0%')).toBe('#000000')
    expect(hslToHex('0 100% 50%')).toBe('#ff0000')
    // The accent itself round-trips exactly, which is what the pin relies on.
    expect(hslToHex(EXPECTED_HSL)).toBe(EXPECTED_HEX)
  })

  it('the forbidden HSL values are the rounded forms the CSS would actually carry', () => {
    // Worth stating: Tailwind's `142 71% 45%` is a ROUNDED HSL of #22c55e, so
    // converting it back gives #21c45d, not #22c55e. That is a property of the
    // rounding, not a bug in the converter — and it is why the FORBIDDEN list
    // stores HSL (the form a reverting diff would contain) rather than hex.
    expect(hslToHex('142 71% 45%')).toBe('#21c45d')
    expect(hslToHex('142 71% 45%')).not.toBe(EXPECTED_HEX)
  })
})
