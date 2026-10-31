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
  // Network throughput history: cumulative rx/tx bytes (diffed into B/s for the chart)
  // Kept to the last 60s window so the time axis scrolls instead of growing forever.
  const history = useRef<{ t: number; rx: number; tx: number }[]>([])
  // Latest real-time up/down speed (B/s), shown under the chart
  const [speed, setSpeed] = useState<{ rx: number; tx: number }>({ rx: 0, tx: 0 })

  // Discrete y-axis tiers (MB/s): start at 1M and double up to a 10G ceiling. The axis
  // only steps up when the recent peak exceeds half the current max; it steps down (with
  // hysteresis + debounce) only after the peak stays below a quarter for 3 samples.
  const Y_TIERS_MBPS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 10240]
  // Current tier index (0 => 1M) and a debounce counter for stepping down
  const tierIdxRef = useRef(0)
  const downCountRef = useRef(0)

  // Sum rx/tx over all non-loopback interfaces (total up/down throughput)
  function netTotals(nets: Snapshot['nets']): { rx: number; tx: number } {
    let rx = 0
    let tx = 0
    for (const n of nets) {
      if (n.iface === 'lo') continue
      rx += n.rxBytes || 0
      tx += n.txBytes || 0
    }
    return { rx, tx }
  }

  function fmtRate(bps: number): string {
    if (!Number.isFinite(bps)) return '0 B/s'
    const abs = Math.abs(bps)
    if (abs >= 1048576) return (bps / 1048576).toFixed(2) + ' MB/s'
    if (abs >= 1024) return (bps / 1024).toFixed(1) + ' KB/s'
    return bps.toFixed(0) + ' B/s'
  }

  // Integer formatting for the y-axis tick labels (no decimals)
  function fmtRateInt(bps: number): string {
    if (!Number.isFinite(bps)) return '0 B/s'
    if (bps >= 1048576) return Math.round(bps / 1048576) + ' MB/s'
    if (bps >= 1024) return Math.round(bps / 1024) + ' KB/s'
    return Math.round(bps) + ' B/s'
  }

  function drawChart() {
    const el = chartRef.current
    if (!el || history.current.length < 2) return
    const chart = echarts.getInstanceByDom(el) ?? echarts.init(el)
    const h = history.current
    // Diff cumulative counters into B/s, aligned with each sample's timestamp
    const rateSeries = (key: 'rx' | 'tx'): Array<[number, number]> =>
      h.map((p, i) => {
        if (i === 0) return [p.t, 0]
        const dt = (p.t - h[i - 1].t) / 1000
        if (dt <= 0) return [p.t, 0]
        return [p.t, Math.max(0, (p[key] - h[i - 1][key]) / dt)]
      })
    const dl = rateSeries('rx')
    const ul = rateSeries('tx')
    // Peak over the 60s window drives the tier up/down (hysteresis + debounce)
    let peak = 0
    for (const [, v] of [...dl, ...ul]) if (v > peak) peak = v
    const lastTierIdx = Y_TIERS_MBPS.length - 1
    const curMaxBps = Y_TIERS_MBPS[tierIdxRef.current] * 1048576
    if (tierIdxRef.current < lastTierIdx && peak > curMaxBps / 2) {
      // rate exceeded half the current max → step up immediately (don't clip the curve)
      tierIdxRef.current++
      downCountRef.current = 0
    } else if (tierIdxRef.current > 0 && peak < curMaxBps / 4) {
      // peak stayed below a quarter of the current max for 3 samples → step down (debounced)
      downCountRef.current++
      if (downCountRef.current >= 3) {
        tierIdxRef.current--
        downCountRef.current = 0
      }
    } else {
      downCountRef.current = 0
    }
    const tierMaxBps = Y_TIERS_MBPS[tierIdxRef.current] * 1048576
    const now = Date.now()
    chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 44, right: 8, top: 10, bottom: 6 },
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => fmtRate(v) },
      // Time axis: rolling 60s window, no tick labels at the bottom
      xAxis: {
        type: 'time',
        min: now - 60000,
        max: now,
        axisLabel: { show: false },
        axisLine: { lineStyle: { color: '#30363d' } },
        splitLine: { show: false },
      },
      // Tiered y-axis: 0 at the bottom + 3 even ticks above (⅓, ⅔, max), integers only
      yAxis: {
        type: 'value',
        min: 0,
        max: tierMaxBps,
        splitNumber: 3,
        axisLabel: { color: '#8b949e', fontSize: 9, formatter: (v: number) => fmtRateInt(v) },
        splitLine: { lineStyle: { color: '#21262d' } },
      },
      series: [
        {
          name: '下载',
          type: 'line',
          data: dl,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#58a6ff', width: 1.5 },
          itemStyle: { color: '#58a6ff' },
          areaStyle: { color: 'rgba(88,166,255,0.15)' },
        },
        {
          name: '上传',
          type: 'line',
          data: ul,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#f0883e', width: 1.5 },
          itemStyle: { color: '#f0883e' },
          areaStyle: { color: 'rgba(240,136,62,0.15)' },
        },
      ],
    })
  }

  const { error } = useMonitorPoll<Snapshot>(connId, (s) => {
    setSnap(s)
    const { rx, tx } = netTotals(s.nets)
    const t = s.ts
    history.current.push({ t, rx, tx })
    // keep only the last 60s
    while (history.current.length > 0 && t - history.current[0].t > 60000) history.current.shift()
    // latest real-time speed = last diff
    const n = history.current.length
    if (n >= 2) {
      const last = history.current[n - 1]
      const prev = history.current[n - 2]
      const dt = (last.t - prev.t) / 1000
      if (dt > 0) setSpeed({ rx: Math.max(0, (last.rx - prev.rx) / dt), tx: Math.max(0, (last.tx - prev.tx) / dt) })
    }
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
          <div
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              fontSize: 10, color: '#8b949e', padding: '0 8px', lineHeight: '16px',
            }}
          >
            <span style={{ color: '#58a6ff' }}>⬇ 接收 {fmtRate(speed.rx)}</span>
            <span style={{ color: '#f0883e' }}>⬆ 发送 {fmtRate(speed.tx)}</span>
          </div>

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
