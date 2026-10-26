/**
 * Network interface modal
 * - Opened by clicking the "Network" block of the monitor panel; shows all interfaces
 * - Collects every 2 seconds; sortable by interface/received/sent and filterable
 */
import { useMemo, useState } from 'react'
import { fmtSize } from '../lib/format'
import { useMonitorPoll } from '../lib/useMonitorPoll'

interface NetIf {
  iface: string
  rxBytes: number
  txBytes: number
}

type SortKey = 'iface' | 'rx' | 'tx'

interface Props {
  connId: string
  onClose: () => void
}

const fmt = fmtSize

export function NetModal({ connId, onClose }: Props) {
  const [nets, setNets] = useState<NetIf[]>([])
  const [sortKey, setSortKey] = useState<SortKey>('rx')
  const [asc, setAsc] = useState(false)
  const [filter, setFilter] = useState('')

  const { error } = useMonitorPoll<{ nets: NetIf[] }>(connId, (s) => setNets(s.nets ?? []))

  const rows = useMemo(() => {
    let list = [...nets]
    if (filter) {
      const f = filter.toLowerCase()
      list = list.filter((n) => n.iface.toLowerCase().includes(f))
    }
    list.sort((a, b) => {
      if (sortKey === 'iface') return asc ? a.iface.localeCompare(b.iface) : b.iface.localeCompare(a.iface)
      const av = sortKey === 'rx' ? a.rxBytes : a.txBytes
      const bv = sortKey === 'rx' ? b.rxBytes : b.txBytes
      return asc ? av - bv : bv - av
    })
    return list
  }, [nets, sortKey, asc, filter])

  const totalRx = nets.reduce((s, n) => s + n.rxBytes, 0)
  const totalTx = nets.reduce((s, n) => s + n.txBytes, 0)

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setAsc(!asc)
    else {
      setSortKey(k)
      setAsc(false)
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal top-modal">
        <div className="modal-head">
          <h3>网络接口</h3>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="top-status">
          <span>
            接口 {nets.length} 个 · 合计 ↓{fmt(totalRx)} ↑{fmt(totalTx)}
          </span>
          <input
            className="top-filter"
            placeholder="过滤（接口名）"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        <div className="top-table">
          <div className="top-row net-row head">
            <span className="ni" onClick={() => toggleSort('iface')}>
              接口名
            </span>
            <span className="rx" onClick={() => toggleSort('rx')}>
              接收
            </span>
            <span className="tx" onClick={() => toggleSort('tx')}>
              发送
            </span>
          </div>
          {rows.map((n, i) => (
            <div className="top-row net-row" key={i}>
              <span className="ni" title={n.iface}>
                {n.iface}
              </span>
              <span className="rx">↓{fmt(n.rxBytes)}</span>
              <span className="tx">↑{fmt(n.txBytes)}</span>
            </div>
          ))}
          {rows.length === 0 && <div className="top-empty">暂无网络数据</div>}
        </div>

        {error && <div className="cm-msg">{error}</div>}
      </div>
    </div>
  )
}
