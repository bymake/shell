/**
 * Connection manager
 * - Left: connection list (search / double-click to connect / per-row delete)
 * - Right: single-page form (protocol dropdown SSH/serial + name/host/port/username/password/remark), no tabs
 * - Password: encrypted with safeStorage on disk (no plaintext); input always shows 8 asterisks
 * - Dedupe: same host+port+username is not created twice (updates instead)
 */
import { useCallback, useEffect, useState } from 'react'
import { useShell, type Session } from '../state/sessionStore'
import { zhError } from '../lib/errors'

interface Props {
  open: boolean
  onClose: () => void
}

type Protocol = 'ssh' | 'serial'

const PROTOCOL_OPTIONS: Array<{ key: Protocol; label: string }> = [
  { key: 'ssh', label: 'SSH' },
  { key: 'serial', label: '串口' },
]

const emptyForm = {
  id: null as number | null,
  name: '',
  host: '',
  port: 22,
  protocol: 'ssh' as Protocol,
  remark: '',
  username: 'root',
  password: '',
}

export function ConnManager({ open, onClose }: Props) {
  const connect = useShell((s) => s.connect)
  const [sessions, setSessions] = useState<Session[]>([])
  const [search, setSearch] = useState('')
  const [closeAfterConnect, setCloseAfterConnect] = useState(true)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [comPorts, setComPorts] = useState<string[]>([])
  const [pwFocus, setPwFocus] = useState(false)
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await window.shellpro.session.list({ search: search || undefined })
      setSessions(r.sessions as Session[])
      if (selectedId) {
        const still = (r.sessions as Session[]).some((s) => s.id === selectedId)
        if (!still) setSelectedId(null)
      }
    } catch (e) {
      setMsg({ text: zhError(e), err: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  useEffect(() => {
    if (!open) return
    setMsg(null)
  }, [open])

  useEffect(() => {
    if (form.protocol !== 'serial') return
    void window.shellpro.serial.listPorts().then((r) => setComPorts((r.ports as string[]) ?? [])).catch(() => setComPorts([]))
  }, [form.protocol])

  if (!open) return null

  const select = (s: Session) => {
    setSelectedId(s.id)
    setForm({
      id: s.id,
      name: s.name ?? '',
      host: s.host ?? '',
      port: s.port ?? 22,
      protocol: (s.protocol === 'serial' ? 'serial' : 'ssh') as Protocol,
      remark: s.remark ?? '',
      username: s.username ?? 'root',
      password: s.password ?? '',
    })
  }

  const newConn = () => {
    setSelectedId(null)
    setForm(emptyForm)
  }

  const setF = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const del = async (s: Session) => {
    try {
      await window.shellpro.session.delete(s.id)
      if (selectedId === s.id) newConn()
      await load()
    } catch (e) {
      setMsg({ text: `删除失败：${zhError(e)}`, err: true })
    }
  }

  // Save: password is not stored in plaintext; same host+port+username is not created twice
  const save = async (): Promise<boolean> => {
    if (!form.name.trim() || !form.host.trim()) {
      setMsg({ text: '请填写名称与主机地址', err: true })
      return false
    }
    const fields = {
      name: form.name,
      host: form.host,
      port: Number(form.port) || 22,
      protocol: form.protocol,
      remark: form.remark,
      username: form.username,
      auth_type: 'password' as const,
      // Plaintext password is memory-only; the main process encrypts it with safeStorage on disk
      password: form.password || null,
    }
    try {
      if (form.id != null) {
        // Edit: update the current connection
        await window.shellpro.session.update(form.id, fields)
        setMsg({ text: '已保存', err: false })
        await load()
        return true
      }
      // New: dedupe by same host+port+username
      const dup = sessions.find(
        (s) => s.host === form.host && s.port === Number(form.port) && s.username === form.username,
      )
      if (dup) {
        await window.shellpro.session.update(dup.id, fields)
        setSelectedId(dup.id)
        setForm((f) => ({ ...f, id: dup.id }))
        setMsg({ text: `该连接已存在，已更新为「${dup.name}」`, err: false })
        await load()
        return true
      }
      const r = await window.shellpro.session.create(fields)
      setForm((f) => ({ ...f, id: r.id as number }))
      setSelectedId(r.id as number)
      setMsg({ text: '已保存', err: false })
      await load()
      return true
    } catch (e) {
      setMsg({ text: `保存失败：${zhError(e)}`, err: true })
      return false
    }
  }

  // Connect: use the in-memory form password directly, not the saved one
  const connectCurrent = async () => {
    if (!form.host.trim()) {
      setMsg({ text: '请先填写主机地址', err: true })
      return
    }
    if (form.protocol === 'serial') {
      setMsg({ text: '串口连接需本机原生串口驱动，当前绿色版暂不支持', err: true })
      return
    }
    setMsg(null)
    const connId = await connect({
      name: form.name || `${form.username}@${form.host}`,
      host: form.host,
      port: Number(form.port) || 22,
      username: form.username || 'root',
      password: form.password || undefined,
      protocol: form.protocol,
    })
    if (connId && closeAfterConnect) onClose()
  }

  // Double-click a row to connect: uses the saved (decrypted) password
  const connectSession = async (s: Session) => {
    if (s.protocol === 'serial') {
      setMsg({ text: '串口连接需本机原生串口驱动，当前绿色版暂不支持', err: true })
      return
    }
    setMsg(null)
    const connId = await connect({
      name: s.name || `${s.username}@${s.host}`,
      host: s.host,
      port: Number(s.port) || 22,
      username: s.username || 'root',
      password: s.password || undefined,
      protocol: s.protocol === 'serial' ? 'serial' : 'ssh',
    })
    if (connId && closeAfterConnect) onClose()
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal cm">
        <div className="modal-head">
          <h3>连接管理器</h3>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="cm-body">
          {/* Left: connection list */}
          <div className="cm-left">
            <div className="cm-toolbar">

              <input
                className="cm-search"
                placeholder="搜索名称/地址/用户名"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="cm-list">
              <div className="cm-list-head">
                <span>名称</span>
                <span>地址</span>
                <span>端口</span>
                <span>用户名</span>
                <span className="cm-op">操作</span>
              </div>
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className={`cm-row ${s.id === selectedId ? 'active' : ''}`}
                  onClick={() => select(s)}
                  onDoubleClick={() => void connectSession(s)}
                  title="双击连接"
                >
                  <span className="cm-name" title={s.name}>
                    {s.name}
                  </span>
                  <span className="cm-host">{s.host}</span>
                  <span className="cm-port">{s.port}</span>
                  <span className="cm-user">{s.username}</span>
                  <span className="cm-op">
                    <button
                      className="btn tiny cm-del"
                      title="删除"
                      onClick={(e) => {
                        e.stopPropagation()
                        void del(s)
                      }}
                    >
                      删除
                    </button>
                  </span>
                </div>
              ))}
              {sessions.length === 0 && <div className="cm-empty">暂无连接</div>}
            </div>
            <div className="cm-list-foot">
              <label className="cm-check">
                <input
                  type="checkbox"
                  checked={closeAfterConnect}
                  onChange={(e) => setCloseAfterConnect(e.target.checked)}
                />
                连接后关闭窗口
              </label>
            </div>
          </div>

          {/* Right: single-page form */}
          <div className="cm-right">
            <div className="cm-single">
              <div className="cm-frow">
                <span className="cm-frow-label">协议</span>
                <select className="cm-proto-sel" value={form.protocol} onChange={(e) => setF({ protocol: e.target.value as Protocol })}>
                  {PROTOCOL_OPTIONS.map((p) => (
                    <option key={p.key} value={p.key}>{p.label}</option>
                  ))}
                </select>
              </div>
              <label className="cm-frow">
                <span className="cm-frow-label">名称</span>
                <input value={form.name} onChange={(e) => setF({ name: e.target.value })} placeholder="连接名称" />
              </label>
              <label className="cm-frow">
                <span className="cm-frow-label">主机地址</span>
                <input value={form.host} onChange={(e) => setF({ host: e.target.value })} placeholder="IP 或域名" />
              </label>
              <label className="cm-frow">
                <span className="cm-frow-label">端口</span>
                {form.protocol === 'serial' ? (
                  <select className="cm-proto-sel" value={String(form.port)} onChange={(e) => setF({ port: e.target.value as unknown as number })}>
                    {comPorts.length > 0 ? comPorts.map((cp) => <option key={cp} value={cp}>{cp}</option>) : <option value="">未检测到串口</option>}
                  </select>
                ) : (
                  <input type="number" value={form.port as number} onChange={(e) => setF({ port: Number(e.target.value) || 22 })} />
                )}
              </label>
              <label className="cm-frow">
                <span className="cm-frow-label">用户名</span>
                <input value={form.username} onChange={(e) => setF({ username: e.target.value })} />
              </label>
              <label className="cm-frow">
                <span className="cm-frow-label">密码</span>
                <div className="pw-box">
                  <input
                    type="text"
                    className="pw-real"
                    value={form.password}
                    onChange={(e) => setF({ password: e.target.value })}
                    onFocus={() => setPwFocus(true)}
                    onBlur={() => setPwFocus(false)}
                    autoComplete="off"
                  />
                  <span className={`pw-mask ${form.password ? '' : 'empty'}`}>
                    {form.password ? '********' : '加密保存'}
                  </span>
                  {pwFocus && <span className="pw-caret" />}
                </div>
              </label>
              <label className="cm-frow">
                <span className="cm-frow-label">备注</span>
                <input value={form.remark} onChange={(e) => setF({ remark: e.target.value })} placeholder="可选" />
              </label>
            </div>

            {msg && <div className={`cm-msg ${msg.err ? 'err' : ''}`}>{msg.text}</div>}

            <div className="cm-foot">
              <button className="btn primary" title="用当前内容连接" onClick={() => void connectCurrent()}>
                连接
              </button>
              <button className="btn" title="保存当前内容" onClick={() => void save()}>
                保存
              </button>
              <button className="btn" title="清空表单" onClick={newConn}>
                清除
              </button>
              <button className="btn" onClick={onClose}>
                取消
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
