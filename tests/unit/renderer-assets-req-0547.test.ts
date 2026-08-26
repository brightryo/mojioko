import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

/**
 * REQ-0547 (RES-0543 H1) — the renderer build must publish only what the
 * renderer fetches.
 *
 * ## What went wrong
 *
 * `publicDir` points at `resources/`, and Vite copies a publicDir WHOLESALE
 * into the build output. `resources/` holds ffmpeg and the Whisper sidecar
 * (440 MB), so every build duplicated them into `out/renderer/` and
 * electron-builder packed that into `app.asar` — while also shipping
 * `resources/` as extraResources. Measured: app.asar 537 MB, of which
 * `out/renderer/` was 490 MB, in BOTH the appx and the NSIS build.
 *
 * ## Why this is a unit test and not a packaging gate
 *
 * The obvious home would be `verify:package-fresh`, but that inspects a built
 * `.appx` / `.exe`, which needs `build:win` — and this REQ is explicitly not
 * allowed to run it. The regression to catch is a CONFIG change (someone drops
 * `copyPublicDir`, or adds a directory to the publish list), and the config is
 * readable without building anything. So the invariant is asserted on the
 * config unconditionally, and the build output is checked as well whenever it
 * happens to be present.
 */

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf-8')

/**
 * Strip comments before asserting on config CODE.
 *
 * Found by this REQ's own negative control: flipping `copyPublicDir` to `true`
 * left the assertion green, because the plugin's docstring above it contains
 * the literal `build.copyPublicDir: false`. A test that a comment can satisfy
 * is not a test.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const OUT_RENDERER = resolve(__dirname, '../../out/renderer')

function dirSizeMb(dir: string): number {
  let total = 0
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else total += st.size
    }
  }
  walk(dir)
  return total / 1048576
}

describe('REQ-0547 §3 — the config cannot quietly go back to publishing everything', () => {
  const config = stripComments(read('electron.vite.config.ts'))

  it('★ the build does not copy the whole publicDir', () => {
    // Dropping this line is the exact regression: it re-copies `resources/`,
    // and the installer silently doubles again with nothing failing.
    expect(config).toMatch(/copyPublicDir:\s*false/)
  })

  it('★ the publish list contains neither bin nor any new heavyweight', () => {
    const m = /RENDERER_PUBLIC_DIRS = \[([^\]]*)\]/.exec(config)
    expect(m, 'the publish list moved — re-point this test').not.toBeNull()
    const dirs = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    // Exactly the two the renderer fetches: `/fonts/...` from fonts.css and
    // font-metrics.ts, `./splash/...` from the splash route.
    expect(dirs).toEqual(['fonts', 'splash'])
  })

  it('the dev server still serves the assets (publicDir is untouched)', () => {
    // `npm run dev` resolves `/fonts/...` through publicDir, which serves
    // lazily and copies nothing. Removing it would break dev while "fixing"
    // the build.
    expect(config).toContain("publicDir: resolve('resources')")
  })

  it('the renderer really does fetch fonts and splash — the list is not arbitrary', () => {
    expect(read('src/renderer/styles/fonts.css')).toContain("url('/fonts/")
    expect(read('src/renderer/lib/font-metrics.ts')).toContain('./fonts/')
    expect(read('src/renderer/routes/splash.tsx')).toContain('./splash/')
  })

  it('★ and it fetches nothing from bin — the 440 MB had no reader', () => {
    for (const f of [
      'src/renderer/lib/font-metrics.ts',
      'src/renderer/routes/splash.tsx',
      'src/renderer/styles/fonts.css',
      'src/renderer/index.html',
    ]) {
      expect(read(f), `${f} must not reference /bin/`).not.toMatch(/['"`]\.?\/bin\//)
    }
  })
})

describe('REQ-0547 §2 — the build output', () => {
  it('has no bin/ (and is checked, or says why not)', () => {
    if (!existsSync(OUT_RENDERER)) {
      // Stated rather than silently passing: an unbuilt tree cannot answer this
      // question, and a green tick that means "not measured" is how a gate
      // stops being a gate (CLAUDE.md §18).
      console.log('NOTE  out/renderer is absent — run `npm run build` to include this check.')
      expect(true).toBe(true)
      return
    }
    expect(existsSync(join(OUT_RENDERER, 'bin')), 'out/renderer/bin is back').toBe(false)
    // A ceiling rather than an exact size: fonts legitimately weigh ~50 MB, and
    // the failure being guarded is a 440 MB one, so the two are far apart.
    const mb = dirSizeMb(OUT_RENDERER)
    expect(mb, `out/renderer is ${mb.toFixed(1)} MB — something large came back`).toBeLessThan(120)
  })
})
