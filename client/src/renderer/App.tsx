/**
 * ShellPro app shell
 * - Left: monitor sidebar (sync status / system / processes / network)
 * - Right: SSH terminal (top) + SFTP file panel (bottom), draggable divider
 * - Tool menu (custom title bar) opens the connection manager modal
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MonitorSidebar } from './components/MonitorSidebar'
import { TerminalView } from './components/Terminal'
import { SftpPanel } from './components/SftpPanel'
import { ConnManager } from './components/ConnManager'
import { AgentView } from './components/AgentView'
import { AgentPanel } from './components/AgentPanel'
import { useShell } from './state/sessionStore'
import type { AgentEvent } from '../main/agent/types'
import './App.css'

function App() {
  const loadSessions = useShell((s) => s.loadSessions)
  const activeConns = useShell((s) => s.activeConns)
  const activeId = useShell((s) => s.activeId)
  const setActive = useShell((s) => s.setActive)
  const disconnect = useShell((s) => s.disconnect)
  const reconnect = useShell((s) => s.reconnect)
  const disconnectedIds = useShell((s) => s.disconnectedIds)
  const error = useShell((s) => s.error)
  const clearError = useShell((s) => s.clearError)
  const agentConns = useShell((s) => s.agentConns)
  const agentActiveId = useShell((s) => s.agentActiveId)
  const setAgentActive = useShell((s) => s.setAgentActive)

  const [managerOpen, setManagerOpen] = useState(false)
  const [agentPanelOpen, setAgentPanelOpen] = useState(false)
  const [toolOpen, setToolOpen] = useState(false)
  const [tabMenu, setTabMenu] = useState<{ connId: string; x: number; y: number } | null>(null)
  const [ratio, setRatio] = useState(62) // SSH area percentage
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  // Listen for agent gateway events: keep the operation log + agent tabs up to date
  useEffect(() => {
    const off = window.shellpro.agent.onEvent((e) => useShell.getState().pushAgentEvent(e as unknown as AgentEvent))
    void useShell.getState().loadAgentStatus()
    return off
  }, [])

  const activeConn = activeConns.find((c) => c.connId === activeId)
  const isShell = activeConn?.protocol === 'ssh' || activeConn?.protocol === 'ssh2'
  // "New tab" is the default welcome page. Once a connection / agent session
  // exists, it takes over the current tab — no extra empty tab is kept.
  const hasAny = activeConns.length > 0 || agentConns.length > 0

  // Auto-close the error toast after 5 seconds
  useEffect(() => {
    if (!error) return
    const t = setTimeout(clearError, 5000)
    return () => clearTimeout(t)
  }, [error, clearError])

  // Draggable split divider
  const onDividerDown = (e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const move = (ev: MouseEvent) => {
      const box = containerRef.current?.getBoundingClientRect()
      if (!box) return
      const r = ((ev.clientY - box.top) / box.height) * 100
      setRatio(Math.min(88, Math.max(18, r)))
    }
    const up = () => {
      dragging.current = false
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className="app-shell">
      {/* Custom title bar: icon + tools menu + drag area + window controls */}
      <div className="titlebar">
        <div className="tb-icon">˃_</div>
        <div className="tb-menu">
          <button className="tb-menu-btn" onClick={() => setToolOpen((v) => !v)}>
            工具 <span className="tb-caret">▾</span>
          </button>
          {toolOpen && (
            <div className="tb-dropdown" onMouseLeave={() => setToolOpen(false)}>
              <button
                onClick={() => {
                  setManagerOpen(true)
                  setToolOpen(false)
                }}
              >
                新建连接
              </button>
              <button
                onClick={() => {
                  setAgentPanelOpen(true)
                  setToolOpen(false)
                }}
              >
                Agent 接口
              </button>
              <button
                onClick={() => {
                  void window.shellpro.window.reload()
                  setToolOpen(false)
                }}
              >
                重新加载
              </button>
              <button
                onClick={() => {
                  void window.shellpro.window.help()
                  setToolOpen(false)
                }}
              >
                帮助
              </button>
              <button
                onClick={() => {
                  void window.shellpro.window.about()
                  setToolOpen(false)
                }}
              >
                关于
              </button>
              <button
                onClick={() => {
                  void window.shellpro.window.close()
                  setToolOpen(false)
                }}
              >
                退出
              </button>
            </div>
          )}
        </div>
        <div className="tb-drag" />
        <div className="tb-controls">
          <button className="tb-cbtn" title="最小化" onClick={() => void window.shellpro.window.minimize()}>
            ─
          </button>
          <button className="tb-cbtn" title="最大化" onClick={() => void window.shellpro.window.maximize()}>
            □
          </button>
          <button className="tb-cbtn tb-close" title="关闭" onClick={() => void window.shellpro.window.close()}>
            ✕
          </button>
        </div>
      </div>

      <div className="app-body">
        <MonitorSidebar onOpenManager={() => setManagerOpen(true)} />

        <main className="main-area" ref={containerRef}>
          {/* Tab strip always visible, like a browser: a fixed "new tab" + live connection/agent tabs */}
          <div className="tab-strip">
            {!hasAny && (
              <div
                className="tab active"
                onClick={() => {
                  setActive(null)
                  setAgentActive(null)
                }}
                title="新标签页"
              >
                <span className="tab-name">新标签页</span>
              </div>
            )}
            {activeConns.map((c) => {
              const down = disconnectedIds.includes(c.connId)
              return (
                <div
                  key={c.connId}
                  className={`tab ${c.connId === activeId ? 'active' : ''}${down ? ' tab-down' : ''}`}
                  onClick={() => {
                    setActive(c.connId)
                    setAgentActive(null)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setTabMenu({ connId: c.connId, x: e.clientX, y: e.clientY })
                  }}
                >
                  <span className="tab-name">
                    {c.name}
                    {down && <em className="tab-down-tag">已断开</em>}
                  </span>
                  <button
                    className="tab-x"
                    title="关闭"
                    onClick={(e) => {
                      e.stopPropagation()
                      void disconnect(c.connId)
                    }}
                  >
                    ✕
                  </button>
                </div>
              )
            })}
            {agentConns.map((c) => (
              <div
                key={`ag-${c.connId}`}
                className={`tab tab-agent ${c.connId === agentActiveId ? 'active' : ''}`}
                onClick={() => {
                  setAgentActive(c.connId)
                  setActive(null)
                }}
                title={`agent 会话 ${c.username ? c.username + '@' : ''}${c.host}:${c.port}`}
              >
                <span className="tab-badge">AI</span>
                <span className="tab-name">
                  {c.username ? c.username + '@' : ''}
                  {c.host}:{c.port}
                </span>
              </div>
            ))}
            <button className="tab-add" title="新建连接" onClick={() => setManagerOpen(true)}>
              ＋
            </button>
          </div>

          {tabMenu &&
            createPortal(
              <>
                <div
                  className="ctx-mask"
                  onClick={() => setTabMenu(null)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setTabMenu(null)
                  }}
                />
                <div
                  className="ctx-menu"
                  style={{ left: Math.min(tabMenu.x, window.innerWidth - 140), top: tabMenu.y }}
                  onClick={(e) => e.stopPropagation()}
                  onContextMenu={(e) => e.stopPropagation()}
                >
                  <div
                    className={`ctx-item${disconnectedIds.includes(tabMenu.connId) ? '' : ' ctx-dis'}`}
                    onClick={() => {
                      const id = tabMenu.connId
                      setTabMenu(null)
                      void reconnect(id)
                    }}
                  >
                    重新连接
                  </div>
                  <div
                    className="ctx-item"
                    onClick={() => {
                      const id = tabMenu.connId
                      setTabMenu(null)
                      void disconnect(id)
                    }}
                  >
                    关闭会话
                  </div>
                </div>
              </>,
              document.body,
            )}

          <div className="tab-content">
            {!activeId && !agentActiveId ? (
              <div className="welcome">
                <h2>ShellPro</h2>
                <p>打开「工具 → 新建连接」或连接管理器新建连接。</p>
              </div>
            ) : agentActiveId ? (
              <AgentView connId={agentActiveId!} />
            ) : activeId ? (
              <div className="split-vert">
                <div className="split-top" style={{ height: isShell ? `${ratio}%` : '100%' }}>
                  {activeId && <TerminalView key={`ssh-${activeId}`} connId={activeId} />}
                </div>
                {isShell && (
                  <>
                    <div className="split-divider" onMouseDown={onDividerDown} />
                    <div className="split-bottom">
                      {activeId && <SftpPanel key={`sftp-${activeId}`} connId={activeId} />}
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </main>
      </div>

      {error && (
        <div className="error-toast">
          <span>{error}</span>
          <button onClick={clearError}>×</button>
        </div>
      )}

      {managerOpen && <ConnManager open={managerOpen} onClose={() => setManagerOpen(false)} />}
      <AgentPanel open={agentPanelOpen} onClose={() => setAgentPanelOpen(false)} />
    </div>
  )
}

export default App
