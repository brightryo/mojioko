import { cpSync, existsSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * ★ REQ-0547 (RES-0543 H1) — publish only the assets the renderer actually
 * fetches.
 *
 * `publicDir` points at `resources/`, and Vite copies a publicDir WHOLESALE
 * into the build output. `resources/` holds the ffmpeg binaries and the Whisper
 * sidecar (440 MB), so every build duplicated them into `out/renderer/`, and
 * electron-builder then packed that into `app.asar` — while shipping
 * `resources/` again as extraResources. The same 440 MB went into each
 * installer twice: measured 537 MB of app.asar, of which 490 MB was
 * `out/renderer/`.
 *
 * `publicDir` STAYS as it is, because the dev server serves it lazily (nothing
 * is copied, and `/fonts/...` must resolve during `npm run dev`). What changes
 * is `build.copyPublicDir: false` plus this plugin, which copies the two
 * directories the renderer really asks for:
 *
 *   - `fonts/`  — `styles/fonts.css` `@font-face` and `font-metrics.ts` fetch
 *                 `/fonts/Noto_Sans_JP/...`. **Genuinely needed** (~50 MB).
 *   - `splash/` — `routes/splash.tsx` loads `./splash/splash.png`.
 *
 * `bin/` is referenced from the renderer nowhere (`grep "'/bin/"` → 0 hits);
 * main resolves it from `resourcesPath`, which extraResources supplies. `icons/`
 * likewise — index.html declares no favicon.
 *
 * Adding a directory here is a deliberate act, which is the point: the previous
 * arrangement published whatever happened to be in `resources/`, so a new
 * bundled tool would silently double the installer again.
 */
const RENDERER_PUBLIC_DIRS = ['fonts', 'splash'] as const

function publishRendererAssets(): Plugin {
  return {
    name: 'mojioko:publish-renderer-assets',
    apply: 'build',
    closeBundle() {
      const from = resolve('resources')
      const to = resolve('out/renderer')
      for (const dir of RENDERER_PUBLIC_DIRS) {
        const src = resolve(from, dir)
        if (!existsSync(src)) continue
        cpSync(src, resolve(to, dir), { recursive: true })
      }
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // REQ-0455 — a second main entry: the pure-Node MCP clean-stdout proxy
        // (out/main/mcp-proxy.js), launched via ELECTRON_RUN_AS_NODE.
        input: {
          index: resolve('src/main/index.ts'),
          'mcp-proxy': resolve('src/main/mcp-proxy.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    // Kept so the DEV server can serve `/fonts/...` and `./splash/...`; it
    // serves lazily and copies nothing.
    publicDir: resolve('resources'),
    build: {
      // REQ-0547 — do not copy the whole publicDir into the build output.
      // `publishRendererAssets` copies the two directories that are actually
      // fetched; see the plugin for the 490 MB this avoids.
      copyPublicDir: false
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer')
      }
    },
    plugins: [react(), publishRendererAssets()]
  }
})
