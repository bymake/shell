/**
 * Renderer global state (zustand)
 * - Session list comes from the main-process SQLite
 * - Connection lifecycle: conn:create -> terminal:open -> terminal:input/close
 */
import { create } from 'zustand'
import { zhError } from '../lib/errors'
import type { AgentEvent } from '../../main/agent/types'

export interface Session {
  id: number
  name: string
  host: string
  port: number
  protocol: string
  username: string | null
  remark: string | null
  password?: string | null
}

export interface ActiveConn {
  connId: string
  name: string
  host: string
  port: number
  username: string | null
  protocol: 'ssh' | 'ssh2' | 'telnet' | 'serial'
  /** kept in memory only, so a broken session can be reconnected without re-entering it */
  password?: string | null
}

export interface AgentConnInfo {
  connId: string
  host: string
  port: number
  username: string | null
  protocol: string
  /** true when this is a session the user opened in the UI that the agent can reuse */
  isUISession?: boolean
}

interface ShellProState {
  sessions: Session[]
  activeConns: ActiveConn[]
  activeId: string | null
  error: string | null
  /** connIds whose remote session has dropped (shown as "已断开" on the tab) */
  disconnectedIds: string[]
  loadSessions: () => Promise<void>
  connect: (opts: {
    name: string
    host: string
    port: number
    username: string
    password?: string
    protocol: 'ssh' | 'ssh2' | 'telnet' | 'serial'
  }) => Promise<string | null>
  disconnect: (connId: string) => Promise<void>
  reconnect: (connId: string) => Promise<boolean>
  setDisconnected: (connId: string, down: boolean) => void
  setActive: (connId: string | null) => void
  clearError: () => void
  setError: (msg: string | null) => void
  sftpPath: string
  sftpNavigate: (path: string) => void

  // Agent gateway (external agent drives ShellPro; user watches the operations)
  agentRunning: boolean
  agentPort: number | null
  agentToken: string
  agentUrl: string
  agentWsUrl: string
  agentConns: AgentConnInfo[]
  agentActiveId: string | null
  agentLog: AgentEvent[]
  loadAgentStatus: () => Promise<void>
  resetAgentToken: () => Promise<string | null>
  setAgentActive: (connId: string | null) => void
  pushAgentEvent: (e: AgentEvent) => void
}

export const useShell = create<ShellProState>((set, get) => ({
  sessions: [],
  activeConns: [],
  activeId: null,
  error: null,
  disconnectedIds: [],
  sftpPath: '.',

  loadSessions: async () => {
    try {
      const res = await window.shellpro.session.list()
      const sessions = (res.sessions ?? []).map((s: Record<string, unknown>) => ({
        id: s.id as number,
        name: s.name as string,
        host: s.host as string,
        port: s.port as number,
        protocol: s.protocol as string,
        username: (s.username as string) ?? null,
        remark: (s.remark as string) ?? null,
        password: (s.password as string) ?? null,
      }))
      set({ sessions })
    } catch (e) {
      set({ error: `加载会话失败：${zhError(e)}` })
    }
  },

  connect: async (opts) => {
    try {
      // 1. Establish the SSH connection
      const res = await window.shellpro.conn.create({
        host: opts.host,
        port: opts.port,
        username: opts.username,
        password: opts.password ?? undefined,
        protocol: opts.protocol ?? 'ssh',
      })
      const connId = res.connId as string
      // 2. Open the terminal (ssh shell)
      await window.shellpro.terminal.open(connId)
      const active: ActiveConn = {
        connId,
        name: opts.name || `${opts.username}@${opts.host}`,
        host: opts.host,
        port: opts.port,
        username: opts.username,
        protocol: opts.protocol ?? 'ssh',
        password: opts.password ?? null,
      }
      set((st) => ({ activeConns: [...st.activeConns, active], activeId: connId, error: null, sftpPath: '.' }))
      return connId
    } catch (e) {
      set({ error: `连接失败：${zhError(e)}` })
      return null
    }
  },

  disconnect: async (connId) => {
    try {
      await window.shellpro.terminal.close(connId)
      await window.shellpro.conn.close(connId)
    } catch (e) {
      set({ error: `断开失败：${zhError(e)}` })
    }
    set((st) => ({
      activeConns: st.activeConns.filter((c) => c.connId !== connId),
      activeId: st.activeId === connId ? null : st.activeId,
      disconnectedIds: st.disconnectedIds.filter((x) => x !== connId),
    }))
  },

  reconnect: async (connId) => {
    const old = get().activeConns.find((c) => c.connId === connId)
    if (!old) return false
    try {
      const res = await window.shellpro.conn.create({
        host: old.host,
        port: old.port,
        username: old.username ?? '',
        password: old.password ?? undefined,
        protocol: old.protocol,
      })
      const newId = res.connId as string
      await window.shellpro.terminal.open(newId)
      set((st) => ({
        activeConns: st.activeConns.map((c) =>
          c.connId === connId ? { ...old, connId: newId } : c,
        ),
        activeId: newId,
        error: null,
        sftpPath: '.',
        disconnectedIds: st.disconnectedIds.filter((x) => x !== connId),
      }))
      return true
    } catch (e) {
      set({ error: `重新连接失败：${zhError(e)}` })
      return false
    }
  },

  setDisconnected: (connId, down) =>
    set((st) => {
      const has = st.disconnectedIds.includes(connId)
      if (down === has) return {}
      return {
        disconnectedIds: down
          ? [...st.disconnectedIds, connId]
          : st.disconnectedIds.filter((x) => x !== connId),
      }
    }),

  setActive: (connId) => set({ activeId: connId, sftpPath: '.' }),
  clearError: () => set({ error: null }),
  setError: (msg) => set({ error: msg }),

  // SFTP path navigation (shared by SSH cd sync and panel directory jumps)
  sftpNavigate: (path) => set({ sftpPath: path }),

  // Agent gateway state
  agentRunning: false,
  agentPort: null,
  agentToken: '',
  agentUrl: '',
  agentWsUrl: '',
  agentConns: [],
  agentActiveId: null,
  agentLog: [],

  loadAgentStatus: async () => {
    try {
      const s = (await window.shellpro.agent.status()) as {
        running?: boolean
        port?: number | null
        token?: string
        url?: string
        wsUrl?: string
        connections?: Array<{
          id?: string
          type?: string
          isUISession?: boolean
          target?: { host?: string; port?: number; username?: string | null; protocol?: string }
        }>
      }
      const conns: AgentConnInfo[] = (s.connections ?? []).map((c) => ({
        connId: c.id ?? '',
        host: c.target?.host ?? '',
        port: c.target?.port ?? 0,
        username: c.target?.username ?? null,
        protocol: c.target?.protocol ?? c.type ?? '',
        isUISession: !!c.isUISession,
      }))
      set({
        agentRunning: !!s.running,
        agentPort: s.port ?? null,
        agentToken: s.token ?? '',
        agentUrl: s.url ?? '',
        agentWsUrl: s.wsUrl ?? '',
        agentConns: conns,
      })
    } catch {
      // ignore; gateway status is best-effort
    }
  },

  resetAgentToken: async () => {
    try {
      const r = (await window.shellpro.agent.resetToken()) as { token?: string }
      const token = r.token ?? ''
      set({ agentToken: token })
      return token
    } catch {
      return null
    }
  },

  setAgentActive: (connId) => set({ agentActiveId: connId }),

  pushAgentEvent: (e) =>
    set((st) => {
      let agentConns = st.agentConns
      if (e.kind === 'connect') {
        const t = e.target
        if (t && !agentConns.some((c) => c.connId === e.connId)) {
          agentConns = [
            ...agentConns,
            { connId: e.connId, host: t.host, port: t.port, username: t.username ?? null, protocol: t.protocol },
          ]
        }
      } else if (e.kind === 'disconnect') {
        agentConns = agentConns.filter((c) => c.connId !== e.connId)
      }
      const agentLog = [...st.agentLog, e]
      if (agentLog.length > 1500) agentLog.splice(0, agentLog.length - 1500)
      return {
        agentConns,
        agentLog,
        agentActiveId:
          e.kind === 'disconnect' && st.agentActiveId === e.connId ? null : st.agentActiveId,
      }
    }),
}))
