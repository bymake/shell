/**
 * Monitor sidebar (left)
 * - When connected: sync status / system info / CPU-memory-swap / processes / disks
 * - When idle: shows the connection manager entry
 */
import { useShell } from '../state/sessionStore'
import { MonitorPanel } from './MonitorPanel'

interface Props {
  onOpenManager: () => void
}

export function MonitorSidebar({ onOpenManager }: Props) {
  const activeId = useShell((s) => s.activeId)

  return (
    <aside className="sidebar">
      {activeId ? (
        <MonitorPanel connId={activeId} />
      ) : (
        <div className="sidebar-idle">
          <div className="sidebar-idle-title">ShellPro</div>
          <p>未连接服务器</p>
          <button className="btn primary" onClick={onOpenManager}>
            打开连接管理器
          </button>
        </div>
      )}
    </aside>
  )
}
