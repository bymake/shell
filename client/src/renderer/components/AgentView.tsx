/**
 * AgentView - visualizes what an external agent is doing on a connection
 * - A read-only xterm: agent commands are highlighted (green), output streamed, errors red
 * - A structured operation log sidebar (connect / exec / sftp / disconnect) for reviewing
 * - Data comes from the store's agentLog (each event carries its connId)
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useShell } from '../state/sessionStore'
import type { AgentEvent } from '../../main/agent/types'

interface Props {
  connId: string
}

function ts(hhmm: string): string {
  return hhmm.slice(11, 19) // ISO -> HH:MM:SS
}

function renderEvent(term: Terminal, e: AgentEvent): void {
  switch (e.kind) {
    case 'connect':
      term.write(
        `\r\n\x1b[36m▌ agent 连接 ${e.target?.username ? e.target.username + '@' : ''}${e.target?.host}:${e.target?.port} (${e.target?.protocol})\x1b[0m\r\n`,
      )
      break
    case 'shell_open':
      term.write('\x1b[90m▌ 交互终端已打开\x1b[0m\r\n')
      break
    case 'exec':
      term.write(`\r\n\x1b[32m$ ${e.command}\x1b[0m\r\n`)
      break
    case 'exec_result':
      if (e.stdout) term.write(e.stdout.replace(/\n/g, '\r\n'))
      if (e.stderr) term.write(`\x1b[31m${e.stderr.replace(/\n/g, '\r\n')}\x1b[0m\r\n`)
      if (typeof e.code === 'number' && e.code !== 0)
        term.write(`\x1b[33m[退出码 ${e.code}]\x1b[0m\r\n`)
      break
    case 'shell_data':
      if (e.data) term.write(e.data)
      break
    case 'sftp':
      term.write(`\x1b[90m▌ [sftp] ${e.op ?? ''} ${e.path ?? ''}\x1b[0m\r\n`)
      break
    case 'error':
      term.write(`\x1b[31m▌ ${e.message ?? ''}\x1b[0m\r\n`)
      break
    case 'disconnect':
    case 'shell_exit':
      term.write('\x1b[31m\r\n▌ agent 会话已断开\x1b[0m\r\n')
      break
  }
}

function summarize(e: AgentEvent): string {
  switch (e.kind) {
    case 'connect':
      return `连接 ${e.target?.username ? e.target.username + '@' : ''}${e.target?.host}:${e.target?.port}`
    case 'disconnect':
      return '断开连接'
    case 'exec':
      return `执行: ${e.command}`
    case 'exec_result':
      return `结果: 退出码 ${e.code ?? '-'}${e.stderr ? '（有 stderr）' : ''}`
    case 'shell_open':
      return '打开交互终端'
    case 'shell_data':
      return '终端输出…'
    case 'shell_exit':
      return '终端已关闭'
    case 'sftp':
      return `[sftp] ${e.op ?? ''} ${e.path ?? ''}`
    case 'error':
      return `错误: ${e.message ?? ''}`
    default:
      return e.kind
  }
}

const KIND_COLOR: Record<string, string> = {
  connect: 'ag-conn',
  disconnect: 'ag-disc',
  exec: 'ag-exec',
  exec_result: 'ag-res',
  shell_open: 'ag-res',
  shell_data: 'ag-data',
  shell_exit: 'ag-disc',
  sftp: 'ag-sftp',
  error: 'ag-err',
}

export function AgentView({ connId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const writeCursor = useRef(0)
  const agentLog = useShell((s) => s.agentLog)
  const [input, setInput] = useState('')

  // Events belonging to this connection, in arrival order
  const myLog = useMemo(() => agentLog.filter((e) => e.connId === connId), [agentLog, connId])
  // Reverse for the sidebar (newest on top)
  const revLog = useMemo(() => [...myLog].reverse(), [myLog])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const term = new Terminal({
      cursorBlink: false,
      fontSize: 13,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
      scrollback: 5000,
      theme: {
        background: '#0b1220',
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
    term.write('\x1b[2J\x1b[H\x1b[90m[Agent 会话] 等待外部 agent 操作…\x1b[0m\r\n')
    writeCursor.current = 0

    const onResize = () => fit.fit()
    const ro = new ResizeObserver(onResize)
    ro.observe(el)
    onResize()

    return () => {
      ro.disconnect()
      term.dispose()
      termRef.current = null
    }
  }, [connId])

  // Incrementally render new events into the xterm
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    while (writeCursor.current < myLog.length) {
      renderEvent(term, myLog[writeCursor.current])
      writeCursor.current++
    }
  }, [myLog])

  return (
    <div className="agent-view">
      <div ref={containerRef} className="agent-term" />
      <div className="agent-log">
        <div className="agent-log-head">
          <span>操作记录</span>
          <span className="agent-log-count">{myLog.length} 条</span>
        </div>
        <div className="agent-log-list">
          {revLog.length === 0 && <div className="agent-log-empty">暂无操作</div>}
          {revLog.map((e, i) => (
            <div key={`${e.ts}-${i}`} className={`agent-log-item ${KIND_COLOR[e.kind] ?? ''}`}>
              <span className="agent-log-ts">{ts(e.ts)}</span>
              <span className="agent-log-sum">{summarize(e)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="agent-inputbar">
        <span className="agent-input-tag">输入</span>
        <input
          className="agent-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            const v = input
            if (!v) return
            void window.shellpro.agent.sendInput(connId, v + '\r')
            setInput('')
          }}
          placeholder="手动输入（账号 / 密码 / 命令），回车发送"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  )
}
