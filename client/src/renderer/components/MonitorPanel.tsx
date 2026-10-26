/**
 * Monitor panel (M-04 / T4-1)
 * - Renders the structured snapshot returned by monitor:collect
 * - CPU/memory/swap usage + progress bars; process list; disk mounts
 * - echarts real-time curves (CPU/memory trends)
 */
import { useRef, useState } from 'react'
import * as echarts from 'echarts'
import { TopModal } from './TopModal'
import { NetModal } from './NetModal'
import { useShell } from '../state/sessionStore'
import { fmtSize } from '../lib/format'
import { useMonitorPoll } from '../lib/useMonitorPoll'

interface Snapshot {
  ts: number
  cpu: { usage: number; perCore: number[]; load1: number; load5: number; load15: number }
  mem: { total: number; used: number; usage: number; swapUsed: number; swapTotal: number }
  disks: Array<{ mount: string; total: number; used: number; avail: number; usage: number }>
  nets: Array<{ iface: string; rxBytes: number; txBytes: number }>
  procs: Array<{ pid: number; user: string; cpu: number; mem: number; command: string }>
  uptime: string
}

const fmt = fmtSize
export function MonitorPanel({ connId }: { connId: string }) {
  const activeConns = useShell((s) => s.activeConns)
  const host = activeConns.find((c) => c.connId === connId)?.host ?? ''
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [topOpen, setTopOpen] = useState(false)
  const [netOpen, setNetOpen] = useState(false)
  const chartRef = useRef<HTMLDivElement>(null)
  const history = useRef<{ t: number; cpu: number; mem: number }[]>([])

  function drawChart() {
    const el = chartRef.current
    if (!el || history.current.length < 2) return
    const chart = echarts.getInstanceByDom(el) ?? echarts.init(el)
    const h = history.current
    chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 30, right: 8, top: 10, bottom: 22 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: h.map((p) => new Date(p.t).toLocaleTimeString('zh-CN', { hour12: false })),
        axisLabel: { color: '#8b949e', fontSize: 9 },
        axisLine: { lineStyle: { color: '#30363d' } },
      },
      yAxis: {
        type: 'value',
        max: 100,
        axisLabel: { color: '#8b949e', fontSize: 9 },
        splitLine: { lineStyle: { color: '#21262d' } },
      },
      series: [
        {
          name: 'CPU',
          type: 'line',
          data: h.map((p) => Number(p.cpu.toFixed(1))),
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#58a6ff', width: 1.5 },
          itemStyle: { color: '#58a6ff' },
          areaStyle: { color: 'rgba(88,166,255,0.15)' },
        },
        {
          name: '内存',
          type: 'line',
          data: h.map((p) => Number(p.mem.toFixed(1))),
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#3fb950', width: 1.5 },
          itemStyle: { color: '#3fb950' },
          areaStyle: { color: 'rgba(63,185,80,0.15)' },
        },
      ],
    })
  }

  const { error } = useMonitorPoll<Snapshot>(connId, (s) => {
    setSnap(s)
    history.current.push({ t: s.ts, cpu: s.cpu.usage, mem: s.mem.usage })
    if (history.current.length > 60) history.current.shift()
    drawChart()
  })

  return (
    <div className="monitor">
      <div className="mon-head">
        <h3>同步状态</h3>
        {error ? (
          <span className="sync-off">● 离线</span>
        ) : snap ? (
          <span className="sync-on">● 在线</span>
        ) : (
          <span className="sync-pend">● 采集中</span>
        )}
      </div>
      <div className="sync-ip">
        <span className="sync-ip-label">IP</span>
        <span className="sync-ip-val">{host || '—'}</span>
        <button
          className="btn tiny"
          onClick={() => host && void window.shellpro.clipboard.writeText(host)}
        >
          复制
        </button>
      </div>

      {error && <div className="mon-err">{error}</div>}

      {snap && (
        <>
          <div className="m-sub">系统信息</div>
          <div className="sys-line">
            <span>运行</span>
            <span className="sys-val">{snap.uptime || '—'}</span>
          </div>
          <div className="sys-line">
            <span>负载</span>
            <span className="sys-val">
              {snap.cpu.load1.toFixed(2)}, {snap.cpu.load5.toFixed(2)}, {snap.cpu.load15.toFixed(2)}
            </span>
          </div>

          <div className="m-res">
            <div className="m-res-row">
              <span className="label">CPU</span>
              <span className="pct">{snap.cpu.usage.toFixed(0)}%</span>
              <span className="val">负载 {snap.cpu.load1.toFixed(2)}</span>
              <div className="m-bar">
                <i className="b-cpu" style={{ width: `${Math.min(100, snap.cpu.usage)}%` }} />
              </div>
            </div>
            <div className="m-res-row">
              <span className="label">内存</span>
              <span className="pct">{snap.mem.usage.toFixed(0)}%</span>
              <span className="val">
                {fmt(snap.mem.used)}/{fmt(snap.mem.total)}
              </span>
              <div className="m-bar">
                <i className="b-mem" style={{ width: `${Math.min(100, snap.mem.usage)}%` }} />
              </div>
            </div>
            <div className="m-res-row">
              <span className="label">交换</span>
              <span className="pct">
                {snap.mem.swapTotal ? Math.round((snap.mem.swapUsed / snap.mem.swapTotal) * 100) : 0}%
              </span>
              <span className="val">
                {fmt(snap.mem.swapUsed)}/{fmt(snap.mem.swapTotal)}
              </span>
              <div className="m-bar">
                <i className="b-swap" style={{ width: `${Math.min(100, snap.mem.swapTotal ? (snap.mem.swapUsed / snap.mem.swapTotal) * 100 : 0)}%` }} />
              </div>
            </div>
          </div>

          <div ref={chartRef} className="mon-chart" />

          <div className="m-proc-grid" onClick={() => setTopOpen(true)}>
            <div className="m-sub proc-block">
              进程<span className="proc-more">展开›</span>
            </div>
            <div className="m-proc-head"><span>CPU%</span><span>内存</span><span>命令</span></div>
            {snap.procs.slice(0, 5).map((p, i) => (
              <div className="m-proc-row" key={i}>
                <span className="c">{p.cpu.toFixed(1)}</span>
                <span className="m">{p.mem.toFixed(1)}%</span>
                <span className="cmd">{p.command}</span>
              </div>
            ))}
          </div>

          <div className="m-proc-grid" onClick={() => setNetOpen(true)}>
            <div className="m-sub proc-block">
              网络<span className="proc-more">展开›</span>
            </div>
            <div className="net-list">
              {snap.nets.slice(0, 10).map((n, i) => (
                <div className="net-row" key={i}>
                  <span className="net-if">{n.iface}</span>
                  <span className="net-io">↑{fmt(n.txBytes)} ↓{fmt(n.rxBytes)}</span>
                </div>
              ))}
              {snap.nets.length === 0 && <span className="net-empty">—</span>}
            </div>
          </div>

          <div className="m-sub">磁盘</div>
          <div className="m-disk-head"><span>路径</span><span>可用/大小</span></div>
          {snap.disks.map((d, i) => (
            <div className="m-disk-row" key={i}>
              <span>{d.mount}</span>
              <span className="sz">{fmt(d.avail)}/{fmt(d.total)}</span>
            </div>
          ))}
        </>
      )}
      {topOpen && <TopModal connId={connId} onClose={() => setTopOpen(false)} />}
      {netOpen && <NetModal connId={connId} onClose={() => setNetOpen(false)} />}
    </div>
  )
}
