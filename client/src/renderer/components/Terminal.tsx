/**
 * xterm.js terminal component
 * - Binds to the SSH shell data stream of the main process
 * - FitAddon adapts to the window size
 * - Context menu: copy / paste (clipboard via the main process)
 * - cd command syncs SFTP: pure front-end path resolution (nothing is injected into the
 *   shell, WYSIWYG), directly updates store.sftpPath
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { createPortal } from 'react-dom'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useShell } from '../state/sessionStore'
import { norm, parentPath } from '../lib/path'

interface Props {
  connId: string
}

/** Resolve the target path of a cd command; returns null (no sync) when it cannot be determined (~, no arg, sudo, etc.) */
function resolveCd(cmd: string, cur: string): string | null {
  const rest = cmd.slice(2).trim()
  if (!rest) return null
  const target = rest.split(/\s+/)[0].replace(/^['"]|['"]$/g, '')
  if (target === '~') return null
  if (target.startsWith('/')) return norm(target)
  if (target === '..') return parentPath(cur)
  return norm(cur === '/' ? '/' + target : cur + '/' + target)
}

export function TerminalView({ connId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const cmdBuf = useRef('')
  const [ctx, setCtx] = useState<{ x: number; y: number; sel: boolean } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      fontFamily:
        '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
      scrollback: 5000,
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: '#1f6feb66',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()
    termRef.current = term

    // Main process -> terminal: display as-is
    const offData = window.shellpro.terminal.onData(connId, (data) => term.write(data))
    const offExit = window.shellpro.terminal.onExit(connId, () => {
      term.write('\r\n\x1b[31m[会话已断开]\x1b[0m\r\n')
    })

    // Terminal -> main process: pass through as-is; cd commands are parsed on the front end to sync SFTP
    const inputSub = term.onData((data) => {
      void window.shellpro.terminal.input(connId, data)
      if (data === '\r' || data === '\n') {
        const cmd = cmdBuf.current.trim()
        cmdBuf.current = ''
        if (/^cd(?:\s|$)/.test(cmd)) {
          const np = resolveCd(cmd, useShell.getState().sftpPath)
          if (np) useShell.getState().sftpNavigate(np)
        }
      } else if (data === '\x7f' || data === '\b') {
        cmdBuf.current = cmdBuf.current.slice(0, -1)
      } else if (data.length === 1 && data >= ' ') {
        cmdBuf.current += data
      }
    })

    // Ctrl+C: copy the selection to the clipboard (no SIGINT); Ctrl+V: paste from the clipboard
    term.attachCustomKeyEventHandler((e) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'c' && termRef.current?.getSelection()) {
        void doCopy()
        return false
      }
      if (mod && e.key.toLowerCase() === 'v') {
        // Leave it to xterm's native paste (browser paste event channel, same source as the
        // system clipboard); do not go through IPC
        return false
      }
      return true
    })

    // Size adaptation
    const onResize = () => {
      fit.fit()
      void window.shellpro.terminal.resize(connId, term.cols, term.rows)
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(el)
    onResize()

    term.write('\x1b[2J\x1b[H\x1b[90m[ShellPro] 正在连接...\x1b[0m\r\n')

    return () => {
      offData()
      offExit()
      inputSub.dispose()
      ro.disconnect()
      term.dispose()
      termRef.current = null
    }
  }, [connId])

  // Context menu: copy / paste
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const t = termRef.current
    if (!t) return
    const sel = !!t.getSelection()
    const box = containerRef.current?.getBoundingClientRect()
    setCtx({
      x: Math.min(e.clientX, (box?.right ?? window.innerWidth) - 150),
      y: Math.min(e.clientY, (box?.bottom ?? window.innerHeight) - 70),
      sel,
    })
  }

  const doCopy = async () => {
    const t = termRef.current
    setCtx(null)
    if (!t) return
    const sel = t.getSelection()
    if (sel) {
      await window.shellpro.clipboard.writeText(sel)
      t.focus()
    }
  }

  const doPaste = async () => {
    // Close the menu, then read the clipboard and write it into the remote terminal
    setCtx(null)
    let text = ''
    // Channel 1: browser standard clipboard API (same source as native Ctrl+V paste, most reliable)
    try {
      text = await navigator.clipboard.readText()
    } catch {
      // no permission or unavailable; fall through
    }
    // Channel 2: main-process IPC multi-channel read as a fallback
    if (!text) {
      try {
        const res = (await window.shellpro.clipboard.readText()) as { text?: unknown } | undefined
        text = res && typeof res.text === 'string' ? res.text : ''
      } catch {
        // ignore
      }
    }
    if (!text) {
      useShell.getState().setError('剪贴板为空，无可粘贴内容')
      return
    }
    await window.shellpro.terminal.input(connId, text)
    termRef.current?.focus()
  }

  const lastAct = useRef(0)
  const actOnce = (fn: () => void) => {
    const now = Date.now()
    if (now - lastAct.current < 300) return
    lastAct.current = now
    fn()
  }

  // Menu actions are dispatched by the container proxy (mousedown/pointerdown/click),
  // independent of button events - any of these events can hit the data-act target
  const menuAct = (e: React.MouseEvent | React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null
    if (!el) return
    const act = el.dataset.act
    if (act === 'copy') actOnce(() => void doCopy())
    else if (act === 'paste') actOnce(() => void doPaste())
  }

  return (
    <div className="terminal-wrap" onContextMenu={onContextMenu}>
      <div ref={containerRef} className="terminal-root" />
      {ctx &&
        createPortal(
          <>
            <div
              className="ctx-mask"
              onClick={() => setCtx(null)}
              onContextMenu={(e) => {
                e.preventDefault()
                setCtx(null)
              }}
            />
            <div
              className="ctx-menu"
              style={{ left: ctx.x, top: ctx.y }}
              onMouseDown={menuAct}
              onPointerDown={menuAct}
              onClick={menuAct}
              onContextMenu={(e) => e.stopPropagation()}
            >
              <div className={`ctx-item${ctx.sel ? '' : ' ctx-dis'}`} data-act="copy">
                复制
              </div>
              <div className="ctx-item" data-act="paste">
                粘贴
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  )
}
