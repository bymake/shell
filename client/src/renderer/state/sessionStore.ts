/**
 * Renderer global state (zustand)
 * - Session list comes from the main-process SQLite
 * - Connection lifecycle: conn:create -> terminal:open -> terminal:input/close
 */
import { create } from 'zustand'
import { zhError } from '../lib/errors'

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
}

interface ShellProState {
  sessions: Session[]
  activeConns: ActiveConn[]
  activeId: string | null
  error: string | null
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
  setActive: (connId: string | null) => void
  clearError: () => void
  setError: (msg: string | null) => void
  sftpPath: string
  sftpNavigate: (path: string) => void
}

export const useShell = create<ShellProState>((set) => ({
  sessions: [],
  activeConns: [],
  activeId: null,
  error: null,
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
    }))
  },

  setActive: (connId) => set({ activeId: connId, sftpPath: '.' }),
  clearError: () => set({ error: null }),
  setError: (msg) => set({ error: msg }),

  // SFTP path navigation (shared by SSH cd sync and panel directory jumps)
  sftpNavigate: (path) => set({ sftpPath: path }),
}))
