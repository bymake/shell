/**
 * 渲染进程全局类型声明
 * window.shellpro 由 preload 注入
 */
import type { ShellProApi } from '../preload/index'

declare global {
  interface Window {
    shellpro: ShellProApi
  }
}

export {}
