/**
 * xterm.js 终端组件
 * - 绑定主进程 SSH shell 数据流
 * - FitAddon 自适应窗口尺寸
 * - 右键菜单：复制 / 粘贴（剪贴板经主进程读写）
 * - cd 命令联动 SFTP：纯前端解析目标路径（不向 shell 注入任何命令，
 *   终端所见即用户所输），直接同步 store.sftpPath
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { createPortal } from 'react-dom'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useShell } from '../state/sessionStore'

interface Props {
  connId: string
}

// 路径规范化：/a/../b → /b；去 . 与重复斜杠
function norm(p: string): string {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

function parentPath(p: string): string {
  if (p === '/') return '/'
  const n = norm(p)
  const i = n.lastIndexOf('/')
  return i <= 0 ? '/' : n.slice(0, i)
}

/** 解析 cd 命令的目标路径；无法确定（~、无参、sudo 等）返回 null 不联动 */
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

    // 主进程 -> 终端：原样显示
    const offData = window.shellpro.terminal.onData(connId, (data) => term.write(data))
    const offExit = window.shellpro.terminal.onExit(connId, () => {
      term.write('\r\n\x1b[31m[会话已断开]\x1b[0m\r\n')
    })

    // 终端 -> 主进程：原样透传；cd 命令前端解析联动 SFTP
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

    // Ctrl+C：有选中文字则复制到剪贴板（不发送 SIGINT）；Ctrl+V：粘贴剪贴板
    term.attachCustomKeyEventHandler((e) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'c' && termRef.current?.getSelection()) {
        void doCopy()
        return false
      }
      if (mod && e.key.toLowerCase() === 'v') {
        // 交给 xterm 原生粘贴（浏览器 paste 事件通道，与系统剪贴板同源），不走 IPC
        return false
      }
      return true
    })

    // 尺寸自适应
    const onResize = () => {
      fit.fit()
      void window.shellpro.terminal.resize(connId, term.cols, term.rows)
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(el)
    onResize()

    // 初始写提示
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

  // 右键菜单：复制 / 粘贴
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
    // 关闭菜单后读取剪贴板并写入远程终端
    setCtx(null)
    let text = ''
    // 通道1：浏览器标准剪贴板 API（与快捷键原生粘贴同源，最可靠）
    try {
      text = await navigator.clipboard.readText()
    } catch {
      /* 无权或不可用，走下一通道 */
    }
    // 通道2：主进程 IPC 多通道读取兜底
    if (!text) {
      try {
        const res = (await window.shellpro.clipboard.readText()) as { text?: unknown } | undefined
        text = res && typeof res.text === 'string' ? res.text : ''
      } catch {
        /* 忽略 */
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

  // 菜单动作统一由容器代理分发（mousedown/pointerdown/click 三通道），
  // 不依赖按钮自身事件——任何一路事件到达都能命中 data-act 并执行
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
