/**
 * ShellPro app shell
 * - Left: monitor sidebar (sync status / system / processes / network)
 * - Right: SSH terminal (top) + SFTP file panel (bottom), draggable divider
 * - Tool menu (custom title bar) opens the connection manager modal
 */
import { useEffect, useRef, useState } from 'react'
import { MonitorSidebar } from './components/MonitorSidebar'
import { TerminalView } from './components/Terminal'
import { SftpPanel } from './components/SftpPanel'
import { ConnManager } from './components/ConnManager'
import { useShell } from './state/sessionStore'
import './App.css'

function App() {
  const loadSessions = useShell((s) => s.loadSessions)
  const activeConns = useShell((s) => s.activeConns)
  const activeId = useShell((s) => s.activeId)
  const setActive = useShell((s) => s.setActive)
  const disconnect = useShell((s) => s.disconnect)
  const error = useShell((s) => s.error)
  const clearError = useShell((s) => s.clearError)

  const [managerOpen, setManagerOpen] = useState(false)
  const [toolOpen, setToolOpen] = useState(false)
  const [ratio, setRatio] = useState(62) // SSH area percentage
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  const activeConn = activeConns.find((c) => c.connId === activeId)
  const isShell = activeConn?.protocol === 'ssh' || activeConn?.protocol === 'ssh2'

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
          {activeConns.length === 0 ? (
            <div className="welcome">
              <h2>ShellPro</h2>
              <p>打开「工具 → 新建连接」或连接管理器新建连接。</p>
            </div>
          ) : (
            <div className="split-vert">
              <div className="split-top" style={{ height: isShell ? `${ratio}%` : '100%' }}>
                <div className="tab-strip">
                  {activeConns.map((c) => (
                    <div
                      key={c.connId}
                      className={`tab ${c.connId === activeId ? 'active' : ''}`}
                      onClick={() => setActive(c.connId)}
                    >
                      <span className="tab-name">{c.name}</span>
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
                  ))}
                  <button className="tab-add" title="新建连接" onClick={() => setManagerOpen(true)}>
                    ＋
                  </button>
                </div>
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
          )}
        </main>
      </div>

      {error && (
        <div className="error-toast">
          <span>{error}</span>
          <button onClick={clearError}>×</button>
        </div>
      )}

      {managerOpen && <ConnManager open={managerOpen} onClose={() => setManagerOpen(false)} />}
    </div>
  )
}

export default App
