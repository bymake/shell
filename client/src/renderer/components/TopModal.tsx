/**
 * Process top modal (T4-2)
 * - Opened by clicking the "Process" block of the monitor panel; shows a fuller top list
 * - Collects every 2 seconds; sortable by CPU/memory/command and filterable
 */
import { useMemo, useState } from 'react'
import { useMonitorPoll } from '../lib/useMonitorPoll'

interface Proc {
  pid: number
  user: string
  cpu: number
  mem: number
  command: string
}

interface Snap {
  ts: number
  cpu: { usage: number; load1: number; load5: number; load15: number }
  mem: { total: number; used: number; usage: number }
  procs: Proc[]
}

type SortKey = 'cpu' | 'mem' | 'pid' | 'command'

interface Props {
  connId: string
  onClose: () => void
}

export function TopModal({ connId, onClose }: Props) {
  const [snap, setSnap] = useState<Snap | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('cpu')
  const [asc, setAsc] = useState(false)
  const [filter, setFilter] = useState('')

  const { error } = useMonitorPoll<Snap>(connId, setSnap)

  const rows = useMemo(() => {
    if (!snap) return []
    let list = [...snap.procs]
    if (filter) {
      const f = filter.toLowerCase()
      list = list.filter((p) => p.command.toLowerCase().includes(f) || String(p.pid).includes(f))
    }
    list.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (typeof av === 'string' || typeof bv === 'string') return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
      return asc ? (av as number) - (bv as number) : (bv as number) - (av as number)
    })
    return list
  }, [snap, sortKey, asc, filter])

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setAsc(!asc)
    else {
      setSortKey(k)
      setAsc(k === 'pid' ? true : false)
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal top-modal">
        <div className="modal-head">
          <h3>进程监视（top）</h3>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="top-status">
          {snap && (
            <span>
              负载 {snap.cpu.load1.toFixed(2)} / {snap.cpu.load5.toFixed(2)} / {snap.cpu.load15.toFixed(2)} · CPU{' '}
              {snap.cpu.usage.toFixed(0)}% · 内存 {snap.mem.usage.toFixed(0)}% · 进程 {snap.procs.length}
            </span>
          )}
          <input className="top-filter" placeholder="过滤（命令 / PID）" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>

        <div className="top-table">
          <div className="top-row head">
            <span className="pid" onClick={() => toggleSort('pid')}>
              PID
            </span>
            <span className="user">用户</span>
            <span className="cpu" onClick={() => toggleSort('cpu')}>
              CPU%
            </span>
            <span className="mem" onClick={() => toggleSort('mem')}>
              内存%
            </span>
            <span className="cmd" onClick={() => toggleSort('command')}>
              命令
            </span>
          </div>
          {rows.map((p, i) => (
            <div className="top-row" key={i}>
              <span className="pid">{p.pid}</span>
              <span className="user">{p.user}</span>
              <span className="cpu">{p.cpu.toFixed(1)}</span>
              <span className="mem">{p.mem.toFixed(1)}</span>
              <span className="cmd" title={p.command}>
                {p.command}
              </span>
            </div>
          ))}
          {rows.length === 0 && <div className="top-empty">暂无进程数据</div>}
        </div>

        {error && <div className="cm-msg">{error}</div>}
      </div>
    </div>
  )
}
