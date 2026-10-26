import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import electron from 'vite-plugin-electron/simple'
import { resolve } from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        // Main process entry: all ShellPro SSH/PTY/SFTP/storage/sync/auth logic lives here
        entry: 'src/main/index.ts',
        vite: {
          build: {
            // Vite 8 uses rolldownOptions (not rollupOptions)
            rolldownOptions: {
              // Externalize only node_modules dependencies (CJS deps like ssh2 contain __dirname;
              // inlining them into the ESM bundle crashes at startup because __dirname is undefined
              // in ESM scope). Project-relative modules must be bundled normally (otherwise the
              // output keeps references to .ts sources).
              external: (id) => {
                // Virtual modules / internal placeholders: do not externalize
                if (id.startsWith('\0')) return false
                // Bare package names / built-in modules (ssh2, node:sqlite, electron, etc.): externalize
                if (!id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\\') && !/^[a-zA-Z]:[\\/]/.test(id)) {
                  return true
                }
                // Absolute paths resolving into node_modules: externalize
                if (id.includes('node_modules')) return true
                // Everything else (project-relative/absolute source paths): bundle
                return false
              },
            },
          },
        },
      },
      preload: {
        // Preload script: contextBridge whitelist channels
        input: resolve(__dirname, 'src/preload/index.ts'),
        vite: {
          build: {
            rolldownOptions: {
              // Preload must be CJS: Electron preload uses require("electron"); in ESM scope
              // require is undefined and window.shellpro would fail to be exposed.
              output: {
                format: 'cjs',
                entryFileNames: '[name].cjs',
              },
            },
          },
        },
      },
      renderer: {},
    }),
  ],
})
