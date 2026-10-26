/**
 * Monitor collection engine (M-04 / T4-1 etc.)
 * - Runs collection commands over the SSH channel and parses /proc/stat, /proc/net/dev,
 *   free, df, ps into a structured JSON snapshot
 * - Output feeds the echarts real-time curves directly
 * - CPU usage is computed by differencing adjacent samples; the rest are instant samples
 */
import { execCommand } from '../ssh/index'

export interface CpuSample {
  usage: number
  perCore: number[]
  load1: number
  load5: number
  load15: number
}

export interface MemSample {
  total: number
  used: number
  free: number
  buff: number
  cached: number
  swapTotal: number
  swapUsed: number
  usage: number
}

export interface DiskEntry {
  mount: string
  total: number
  used: number
  avail: number
  usage: number
}

export interface NetIfSample {
  iface: string
  rxBytes: number
  txBytes: number
}

export interface ProcSample {
  pid: number
  user: string
  cpu: number
  mem: number
  command: string
}

export interface MonitorSnapshot {
  ts: number
  cpu: CpuSample
  mem: MemSample
  disks: DiskEntry[]
  nets: NetIfSample[]
  procs: ProcSample[]
  uptime: string
}

const COLLECT_SCRIPT = `
{
  echo '--cpu--';
  grep '^cpu' /proc/stat;
  echo '--loadavg--';
  cat /proc/loadavg;
  echo '--mem--';
  free -b | grep -E '^(Mem|Swap):';
  echo '--disk--';
  df -B1 | grep -E '^/' | awk '{print $6" "$2" "$3" "$4}';
  echo '--net--';
  cat /proc/net/dev | tail -n +3 | awk '{gsub(":","",$1); print $1" "$2" "$10}';
  echo '--proc--';
  ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu;
  echo '--uptime--';
  uptime -p;
}
`

// Previous-frame raw counters (for CPU differencing); keys = 'total' or 'core:i'
let prevCounters = new Map<string, { total: number; idle: number }>()

function diffCpuUsage(key: string, total: number, idle: number): number {
  const prev = prevCounters.get(key)
  prevCounters.set(key, { total, idle })
  if (!prev) return 0
  const dTotal = total - prev.total
  const dIdle = idle - prev.idle
  if (dTotal <= 0) return 0
  return Math.min(100, ((dTotal - dIdle) / dTotal) * 100)
}

function parseSections(out: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {}
  let cur = ''
  for (const rawLine of out.split('\n')) {
    const line = rawLine.trim()
    const m = line.match(/^--(\w+)--$/)
    if (m) {
      cur = m[1]
      sections[cur] = sections[cur] ?? []
      continue
    }
    if (cur && line !== '') sections[cur].push(line)
  }
  return sections
}

function parseCpu(lines: string[], loadLine: string): CpuSample {
  const perCore: number[] = []
  const totalVals = lines[0]?.replace(/^cpu\s+/, '').trim().split(/\s+/).map(Number) ?? []
  const totalIdle = totalVals[3] ?? 0
  const totalSum = totalVals.reduce((a, b) => a + b, 0)
  const usage = diffCpuUsage('total', totalSum, totalIdle)

  for (let i = 1; i < lines.length; i++) {
    const v = lines[i].replace(/^cpu\d+\s+/, '').trim().split(/\s+/).map(Number)
    const idle = v[3] ?? 0
    const sum = v.reduce((a, b) => a + b, 0)
    perCore.push(diffCpuUsage(`core:${i}`, sum, idle))
  }
  const load = loadLine.trim().split(/\s+/).map(Number)
  return {
    usage,
    perCore,
    load1: load[0] ?? 0,
    load5: load[1] ?? 0,
    load15: load[2] ?? 0,
  }
}

function parseMem(lines: string[]): MemSample {
  // free -b Mem line columns: total used free shared buff/cache available
  const mem = (lines.find((l) => l.startsWith('Mem:')) ?? '').split(/\s+/).map(Number)
  const swap = (lines.find((l) => l.startsWith('Swap:')) ?? '').split(/\s+/).map(Number)
  const total = mem[1] ?? 0
  const used = mem[2] ?? 0
  const free = mem[3] ?? 0
  const shared = mem[4] ?? 0
  const buffCache = mem[5] ?? 0
  return {
    total,
    used,
    free,
    buff: shared, // kept for compatibility; see note below
    cached: buffCache,
    swapTotal: swap[1] ?? 0,
    swapUsed: swap[2] ?? 0,
    // usage follows free's "used" semantics (excluding buff/cache) to avoid exceeding 100%
    usage: total === 0 ? 0 : (used / total) * 100,
  }
}

function parseDisk(lines: string[]): DiskEntry[] {
  return lines
    .map((l) => {
      const p = l.trim().split(/\s+/)
      if (p.length < 4) return null
      const total = Number(p[1]) || 0
      const used = Number(p[2]) || 0
      const avail = Number(p[3]) || 0
      return {
        mount: p[0],
        total,
        used,
        avail,
        usage: total === 0 ? 0 : (used / total) * 100,
      }
    })
    .filter((x): x is DiskEntry => x !== null)
}

function parseNet(lines: string[]): NetIfSample[] {
  return lines
    .map((l) => {
      const p = l.trim().split(/\s+/)
      if (p.length < 3) return null
      return { iface: p[0], rxBytes: Number(p[1]) || 0, txBytes: Number(p[2]) || 0 }
    })
    .filter((x): x is NetIfSample => x !== null)
}

function parseProc(lines: string[]): ProcSample[] {
  return lines
    .map((l) => {
      const p = l.trim().split(/\s+/)
      if (p.length < 5) return null
      return {
        pid: Number(p[0]),
        user: p[1],
        cpu: Number(p[2]) || 0,
        mem: Number(p[3]) || 0,
        command: p.slice(4).join(' '),
      }
    })
    .filter((x): x is ProcSample => x !== null)
}

/** Collect a full monitor snapshot */
export async function collectSnapshot(connId: string): Promise<MonitorSnapshot> {
  const { stdout } = await execCommand(connId, COLLECT_SCRIPT)
  const sections = parseSections(stdout)
  const cpuLines = sections.cpu ?? []
  const cpu = parseCpu(cpuLines.filter((l) => l.startsWith('cpu')), sections.loadavg?.[0] ?? '0 0 0')
  return {
    ts: Date.now(),
    cpu,
    mem: parseMem(sections.mem ?? []),
    disks: parseDisk(sections.disk ?? []),
    nets: parseNet(sections.net ?? []),
    procs: parseProc(sections.proc ?? []),
    uptime: (sections.uptime ?? []).join(' '),
  }
}

