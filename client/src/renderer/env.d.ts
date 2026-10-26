/**
 * Renderer global type declarations
 * window.shellpro is injected by the preload script
 */
import type { ShellProApi } from '../preload/index'

declare global {
  interface Window {
    shellpro: ShellProApi
  }
}

export {}
