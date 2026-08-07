import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

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
    publicDir: resolve('resources'),
    resolve: {
      alias: {
        '@': resolve('src/renderer')
      }
    },
    plugins: [react()]
  }
})
