/**
 * AgentPanel - view the local agent gateway status
 * - Shows whether the gateway is running, its address, the bearer token
 *   (copy it into your agent/MCP client to connect), and a reset button
 * - Also lists the connections currently held by the agent
 */
import { useEffect, useState } from 'react'
import { useShell } from '../state/sessionStore'

interface Props {
  open: boolean
  onClose: () => void
}

export function AgentPanel({ open, onClose }: Props) {
  const agentRunning = useShell((s) => s.agentRunning)
  const agentPort = useShell((s) => s.agentPort)
  const agentUrl = useShell((s) => s.agentUrl)
  const agentWsUrl = useShell((s) => s.agentWsUrl)
  const agentToken = useShell((s) => s.agentToken)
  const agentConns = useShell((s) => s.agentConns)
  const loadAgentStatus = useShell((s) => s.loadAgentStatus)
  const resetAgentToken = useShell((s) => s.resetAgentToken)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (open) void loadAgentStatus()
  }, [open, loadAgentStatus])

  if (!open) return null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(agentToken)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  const reset = async () => {
    if (!window.confirm('重置后，外部 agent 需使用新 token 重新接入。确定重置？')) return
    await resetAgentToken()
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal agent-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Agent 接口</h3>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="agent-panel-body">
          <div className="agp-row">
            <span className="agp-label">状态</span>
            <span className={agentRunning ? 'agp-ok' : 'agp-bad'}>
              {agentRunning ? '● 运行中' : '○ 未运行'}
            </span>
            <span className="agp-sub">端口 {agentPort ?? '—'}</span>
          </div>

          <div className="agp-row">
            <span className="agp-label">HTTP</span>
            <code className="agp-code">{agentUrl || '—'}</code>
          </div>
          <div className="agp-row">
            <span className="agp-label">WS</span>
            <code className="agp-code">{agentWsUrl || '—'}</code>
          </div>

          <div className="agp-row agp-token-row">
            <span className="agp-label">Token</span>
            <code className="agp-code agp-token">{agentToken || '—'}</code>
            <button className="agp-btn" onClick={() => void copy()}>
              {copied ? '已复制' : '复制'}
            </button>
            <button className="agp-btn agp-btn-warn" onClick={() => void reset()}>
              重置
            </button>
          </div>

          <div className="agp-hint">
            外部 agent 通过 <code>Authorization: Bearer {agentToken ? '<token>' : '…'}</code> 调用；WebSocket 用
            <code>?token=</code> 接入。所有操作会实时显示在「Agent」标签里。
          </div>

          <div className="agp-conns">
            <div className="agp-conns-head">当前 agent 连接（{agentConns.length}）</div>
            {agentConns.length === 0 && <div className="agp-empty">暂无连接</div>}
            {agentConns.map((c) => (
              <div key={c.connId} className="agp-conn">
                <span className="agp-conn-host">
                  {c.username ? c.username + '@' : ''}{c.host}:{c.port}
                </span>
                <span className="agp-conn-proto">{c.protocol}{c.isUISession ? ' · 已登录会话' : ''}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
