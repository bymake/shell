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
        // 主进程入口：ShellPro 的 SSH/PTY/SFTP/存储/同步/授权全在此
        entry: 'src/main/index.ts',
        vite: {
          build: {
            // Vite 8 使用 rolldownOptions（不是 rollupOptions）
            rolldownOptions: {
              // 外部化只针对 node_modules 依赖（ssh2/node-pty 等 CJS 依赖内含 __dirname，
              // 内联进 ESM bundle 会导致 ESM 作用域 __dirname 未定义而启动崩溃）。
              // 项目内相对模块必须照常打包（不能外部化，否则产物残留 .ts 源码引用）。
              external: (id) => {
                // 虚拟模块 / 内部占位：不外部化
                if (id.startsWith('\0')) return false
                // 裸包名 / 内置模块（ssh2、node:sqlite、electron 等）：外部化
                if (!id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\\') && !/^[a-zA-Z]:[\\/]/.test(id)) {
                  return true
                }
                // 解析到 node_modules 的绝对路径：外部化
                if (id.includes('node_modules')) return true
                // 其余（项目相对/绝对源码路径）：打包
                return false
              },
            },
          },
        },
      },
      preload: {
        // 预加载脚本：contextBridge 白名单通道
        input: resolve(__dirname, 'src/preload/index.ts'),
        vite: {
          build: {
            rolldownOptions: {
              // 预加载必须以 CJS 输出：Electron preload 用 require("electron")，
              // ESM 作用域里 require 未定义会导致 window.shellpro 暴露失败。
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
