/**
 * 会话侧栏（图1：纯监控面板）
 * - 连上服务器后：同步状态 / 系统信息 / CPU内存交换 / 进程 / 磁盘 监控
 * - 未连接：显示「连接管理器」入口
 * - 已去掉"会话"标题与快速连接表单
 */
import { useShell } from '../state/sessionStore'
import { MonitorPanel } from './MonitorPanel'

interface Props {
  onOpenManager: () => void
}

export function SessionSidebar({ onOpenManager }: Props) {
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
          <p className="sidebar-idle-hint">或按 Ctrl+N 新建连接</p>
        </div>
      )}
    </aside>
  )
}
