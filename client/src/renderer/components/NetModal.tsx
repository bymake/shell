/**
 * 网络接口弹窗
 * - 点击监控面板「网络」块弹出，展示全部网络接口
 * - 每 2 秒采集一次，可按 接口名/接收/发送 排序，可过滤接口名
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { zhError } from '../lib/errors'

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

const fmt = (b: number): string => {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + 'G'
  if (b >= 1048576) return (b / 1048576).toFixed(1) + 'M'
  if (b >= 1024) return (b / 1024).toFixed(0) + 'K'
  return b + 'B'
}

export function NetModal({ connId, onClose }: Props) {
  const [nets, setNets] = useState<NetIf[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('rx')
  const [asc, setAsc] = useState(false)
  const [filter, setFilter] = useState('')
  const stopRef = useRef(false)

  useEffect(() => {
    stopRef.current = false
    let t: ReturnType<typeof setInterval> | null = null
    const tick = async () => {
      if (stopRef.current) return
      try {
        const s = (await window.shellpro.monitor.collect(connId)) as { nets: NetIf[] }
        if (!stopRef.current) {
          setNets(s.nets ?? [])
          setError(null)
        }
      } catch (e) {
        if (stopRef.current) return
        if (/not connected/i.test(String(e))) {
          setError('已断开')
          stopRef.current = true
          if (t) clearInterval(t)
        } else {
          setError(`采集失败：${zhError(e)}`)
        }
      }
    }
    void tick()
    t = setInterval(tick, 2000)
    return () => {
      stopRef.current = true
      if (t) clearInterval(t)
    }
  }, [connId])

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
