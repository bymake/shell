/**
 * Agent gateway server (local HTTP + WebSocket)
 * - Binds to 127.0.0.1 only; every request is authenticated with a bearer token
 *   (persisted in the settings table; viewable/resettable from the UI)
 * - Reuses the existing ssh / telnet / sftp engines in the main process
 * - Every agent action (connect / exec / shell / sftp / disconnect) is emitted as an
 *   AgentEvent so the UI can show the user, in real time, what the agent is doing
 * - REST is for one-shot question/answer (exec, sftp); WebSocket is for interactive
 *   shells and streaming output
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { ClientChannel } from 'ssh2'
import { createConnection, closeConnection, execCommand, openShell, listConnections as sshListConnections } from '../ssh/index'
import {
  createTelnetConnection,
  closeTelnetConnection,
  getTelnetConnection,
  telnetFilter,
  listConnections as telnetListConnections,
} from '../telnet/index'
import { listDir, uploadFile, downloadFile, readTextFile, writeTextFile, closeSftp } from '../sftp/index'
import { getSetting, setSetting } from '../storage/index'
import { createLogger } from '../logger/index'
import type { AgentConn, AgentEvent, AgentTarget, WsOut } from './types'

const log = createLogger('agent')
const DEFAULT_PORT = 17890
const BODY_LIMIT = 2 * 1024 * 1024 // 2MB

export interface AgentServer {
  port: number
  token: string
  running: boolean
  url: string
  wsUrl: string
  listConns: () => AgentConn[]
  setToken: (t: string) => void
  writeShellInput: (connId: string, data: string) => void
  close: () => void
}

interface ServerOptions {
  onEvent?: (e: AgentEvent) => void
}

const agentConns = new Map<string, AgentConn>()
const shells = new Map<string, ClientChannel>() // connId -> interactive ssh shell stream

/** All reachable connections: the agent's own + sessions the user opened in the UI
 *  (isUISession=true). UI sessions can be reused for input/output but never closed. */
function allConns(): AgentConn[] {
  const ids = new Set(agentConns.keys())
  const out = [...agentConns.values()]
  for (const s of sshListConnections()) {
    if (!ids.has(s.id)) {
      out.push({ id: s.id, type: s.protocol ?? 'ssh', target: { host: s.host, port: s.port, username: s.username, protocol: s.protocol ?? 'ssh' }, isUISession: true })
    }
  }
  for (const t of telnetListConnections()) {
    if (!ids.has(t.id)) {
      out.push({ id: t.id, type: 'telnet', target: { host: t.host, port: t.port, username: t.username, protocol: 'telnet' }, isUISession: true })
    }
  }
  return out
}

function resolveConn(connId: string): AgentConn | undefined {
  return allConns().find((c) => c.id === connId)
}

function nowIso(): string {
  return new Date().toISOString()
}

function makeTarget(opts: {
  host?: string
  port?: number
  username?: string
  protocol?: string
}): { target: AgentTarget; type: 'ssh' | 'ssh2' | 'telnet' } {
  const protocol = opts.protocol ?? 'ssh'
  if (protocol !== 'ssh' && protocol !== 'ssh2' && protocol !== 'telnet') {
    throw new Error(`不支持的协议: ${protocol}（仅支持 ssh / ssh2 / telnet）`)
  }
  return {
    type: protocol,
    target: {
      host: opts.host ?? '',
      port: opts.port ?? (protocol === 'telnet' ? 23 : 22),
      username: opts.username,
      protocol,
    },
  }
}

export function startAgentServer(opts: ServerOptions = {}): Promise<AgentServer> {
  const { onEvent } = opts
  let token = getSetting('agent.token') || (() => {
    const t = randomUUID().replace(/-/g, '')
    setSetting('agent.token', t)
    return t
  })()

  const server = createServer((req, res) => {
    void route(req, res)
  })

  const wss = new WebSocketServer({ server, path: '/ws' })

  /** Push an event to the UI (renderer) and to all connected agent WS clients */
  function emitEvent(e: AgentEvent): void {
    onEvent?.(e)
    broadcastWs({ type: 'event', event: e })
  }

  function broadcastWs(msg: WsOut): void {
    const s = JSON.stringify(msg)
    for (const c of wss.clients) {
      if (c.readyState === WebSocket.OPEN) c.send(s)
    }
  }

  function sendShell(connId: string, data: string): void {
    broadcastWs({ type: 'shell_data', connId, data })
    emitEvent({ ts: nowIso(), kind: 'shell_data', connId, data })
  }

  // ---------- Auth ----------
  function isAuthed(headers: IncomingMessage['headers']): boolean {
    const h = headers.authorization ?? ''
    return h === `Bearer ${token}` || h === `bearer ${token}`
  }

  function unauthorized(res: ServerResponse): void {
    sendJson(res, 401, { ok: false, error: '未授权：缺少或错误的 Bearer token' })
  }

  // ---------- HTTP helpers ----------
  function sendJson(res: ServerResponse, code: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(payload)
  }

  function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > BODY_LIMIT) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        try {
          resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>) : {})
        } catch {
          reject(new Error('请求体不是合法 JSON'))
        }
      })
      req.on('error', reject)
    })
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAuthed(req.headers)) return unauthorized(res)
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean) // e.g. ["session", ":id", "exec"]
    const method = req.method ?? 'GET'

    try {
      // GET /health
      if (parts[0] === 'health' && method === 'GET') {
        return sendJson(res, 200, { ok: true, service: 'shellpro-agent', running: true })
      }
      // GET /sessions - list agent connections
      if (parts[0] === 'sessions' && method === 'GET') {
        return sendJson(res, 200, { ok: true, connections: [...agentConns.values()] })
      }
      // POST /session - open a connection
      if (parts[0] === 'session' && parts.length === 1 && method === 'POST') {
        const body = await readBody(req)
        return handleConnect(body, res)
      }
      // /session/:id/...
      if (parts[0] === 'session' && parts.length >= 2) {
        const connId = parts[1]
        const action = parts[2] ?? ''
        return handleConnRoute(connId, action, parts.slice(3), method, req, res)
      }
      return sendJson(res, 404, { ok: false, error: '未找到路由' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error(`route error: ${msg}`)
      return sendJson(res, 500, { ok: false, error: msg })
    }
  }

  async function handleConnect(
    body: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<void> {
    const { target, type } = makeTarget({
      host: String(body.host ?? ''),
      port: Number(body.port ?? 0),
      username: body.username ? String(body.username) : undefined,
      protocol: body.protocol ? String(body.protocol) : 'ssh',
    })
    if (!target.host) {
      return sendJson(res, 400, { ok: false, error: '缺少 host' })
    }
    // Use the id the engine actually registers, so later exec/shell lookups by
    // connId resolve (the ssh/telnet engines key their own maps by their own id)
    let realId: string
    if (type === 'telnet') {
      const h = await createTelnetConnection({
        host: target.host,
        port: target.port,
        username: target.username,
        password: body.password ? String(body.password) : undefined,
      })
      realId = h.id
    } else {
      const h = await createConnection({
        host: target.host,
        port: target.port,
        username: target.username ?? '',
        password: body.password ? String(body.password) : undefined,
        privateKey: body.privateKey ? String(body.privateKey) : undefined,
        passphrase: body.passphrase ? String(body.passphrase) : undefined,
        protocol: type,
      })
      realId = h.id
    }
    agentConns.set(realId, { id: realId, type, target, name: body.name ? String(body.name) : undefined })
    emitEvent({
      ts: nowIso(),
      kind: 'connect',
      connId: realId,
      target,
      message: `agent 连接 ${target.username ? target.username + '@' : ''}${target.host}:${target.port} (${type})`,
    })
    log.info(`agent connect: ${target.username ?? ''}@${target.host}:${target.port} (${type})`)
    return sendJson(res, 200, { ok: true, connId: realId, target })
  }

  async function handleConnRoute(
    connId: string,
    action: string,
    rest: string[],
    method: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const conn = resolveConn(connId)
    if (!conn) return sendJson(res, 404, { ok: false, error: `连接不存在: ${connId}` })

    // DELETE /session/:id - close
    if (method === 'DELETE' && action === '') {
      closeAgentConn(connId)
      return sendJson(res, 200, { ok: true })
    }

    // POST /session/:id/exec
    if (action === 'exec' && method === 'POST') {
      const body = await readBody(req)
      const command = String(body.command ?? '')
      if (!command.trim()) return sendJson(res, 400, { ok: false, error: '命令为空' })
      if (conn.type === 'telnet') return sendJson(res, 400, { ok: false, error: 'Telnet 不支持 exec，请用 shell 交互' })
      emitEvent({ ts: nowIso(), kind: 'exec', connId, target: conn.target, command })
      const r = await execCommand(connId, command)
      emitEvent({
        ts: nowIso(),
        kind: 'exec_result',
        connId,
        target: conn.target,
        command,
        code: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
      })
      return sendJson(res, 200, { ok: true, code: r.code, stdout: r.stdout, stderr: r.stderr })
    }

    // POST /session/:id/shell/open
    if (action === 'shell' && rest[0] === 'open' && method === 'POST') {
      await openAgentShell(connId)
      return sendJson(res, 200, { ok: true, connId })
    }

    // POST /session/:id/shell/input {data}
    if (action === 'shell' && rest[0] === 'input' && method === 'POST') {
      const body = await readBody(req)
      const data = String(body.data ?? '')
      writeShell(connId, data)
      return sendJson(res, 200, { ok: true })
    }

    // POST /session/:id/shell/resize {cols, rows}
    if (action === 'shell' && rest[0] === 'resize' && method === 'POST') {
      const body = await readBody(req)
      resizeShell(connId, Number(body.cols ?? 80), Number(body.rows ?? 24))
      return sendJson(res, 200, { ok: true })
    }

    // POST /session/:id/shell/close
    if (action === 'shell' && rest[0] === 'close' && method === 'POST') {
      closeAgentShell(connId)
      return sendJson(res, 200, { ok: true })
    }

    // SFTP
    if (action === 'sftp' && method === 'POST') {
      if (conn.type === 'telnet') return sendJson(res, 400, { ok: false, error: 'Telnet 不支持 SFTP' })
      const body = await readBody(req)
      return handleSftp(connId, conn, rest[0], body, res)
    }

    return sendJson(res, 404, { ok: false, error: '未找到操作' })
  }

  async function handleSftp(
    connId: string,
    conn: AgentConn,
    op: string,
    body: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<void> {
    const path = String(body.path ?? '')
    const local = String(body.localPath ?? '')
    const remote = String(body.remotePath ?? '')
    const opLabel = op

    switch (op) {
      case 'list': {
        const r = await listDir(connId, path || '.')
        emitEvent({ ts: nowIso(), kind: 'sftp', connId, target: conn.target, op: opLabel, path })
        return sendJson(res, 200, { ok: true, entries: r.entries })
      }
      case 'readText': {
        const content = await readTextFile(connId, path)
        emitEvent({ ts: nowIso(), kind: 'sftp', connId, target: conn.target, op: opLabel, path })
        return sendJson(res, 200, { ok: true, content })
      }
      case 'writeText': {
        await writeTextFile(connId, path, String(body.content ?? ''))
        emitEvent({ ts: nowIso(), kind: 'sftp', connId, target: conn.target, op: opLabel, path })
        return sendJson(res, 200, { ok: true })
      }
      case 'upload': {
        await uploadFile(connId, local, remote)
        emitEvent({ ts: nowIso(), kind: 'sftp', connId, target: conn.target, op: opLabel, path: `${local} → ${remote}` })
        return sendJson(res, 200, { ok: true })
      }
      case 'download': {
        await downloadFile(connId, remote, local)
        emitEvent({ ts: nowIso(), kind: 'sftp', connId, target: conn.target, op: opLabel, path: `${remote} → ${local}` })
        return sendJson(res, 200, { ok: true })
      }
      default:
        return sendJson(res, 404, { ok: false, error: `未知 SFTP 操作: ${op}` })
    }
  }

  async function openAgentShell(connId: string): Promise<void> {
    const conn = resolveConn(connId)
    if (!conn) throw new Error(`连接不存在: ${connId}`)
    if (conn.type === 'telnet') {
      const h = getTelnetConnection(connId)
      // Forward cleaned telnet output to the UI/WS
      const fwd = (raw: Buffer) => {
        const clean = telnetFilter(h, raw)
        if (clean.length) sendShell(connId, clean.toString('utf-8'))
      }
      h.socket.on('data', fwd)
      h.socket.on('close', () => {
        broadcastWs({ type: 'shell_exit', connId })
        emitEvent({ ts: nowIso(), kind: 'shell_exit', connId, target: conn.target })
      })
      shells.set(connId, undefined as unknown as ClientChannel)
      emitEvent({ ts: nowIso(), kind: 'shell_open', connId, target: conn.target })
      return
    }
    const stream = await openShell(connId)
    shells.set(connId, stream)
    stream.on('data', (d: Buffer) => sendShell(connId, d.toString('utf-8')))
    stream.on('close', () => {
      shells.delete(connId)
      broadcastWs({ type: 'shell_exit', connId })
      emitEvent({ ts: nowIso(), kind: 'shell_exit', connId, target: conn.target })
    })
    emitEvent({ ts: nowIso(), kind: 'shell_open', connId, target: conn.target })
  }

  function writeShell(connId: string, data: string): void {
    const conn = resolveConn(connId)
    if (!conn) return
    if (conn.type === 'telnet') {
      getTelnetConnection(connId).socket.write(data)
      return
    }
    const s = shells.get(connId)
    if (s) s.write(data)
  }

  function resizeShell(connId: string, cols: number, rows: number): void {
    const conn = resolveConn(connId)
    if (!conn || conn.type === 'telnet') return
    const s = shells.get(connId)
    if (s) s.setWindow?.(rows, cols, cols, rows)
  }

  function closeAgentShell(connId: string): void {
    const conn = resolveConn(connId)
    const s = shells.get(connId)
    if (s && conn?.type !== 'telnet') s.destroy()
    shells.delete(connId)
  }

  function closeAgentConn(connId: string): void {
    const conn = resolveConn(connId)
    if (!conn) return
    // Destroy only the agent's own ssh channel / sftp handle
    closeAgentShell(connId)
    closeSftp(connId)
    if (conn.isUISession) {
      // A session the user opened in the UI: never disconnect it, only clear
      // the agent's attachment
      emitEvent({ ts: nowIso(), kind: 'disconnect', connId, target: conn.target, message: 'agent 已停止操作该已登录会话（会话保留）' })
      return
    }
    if (conn.type === 'telnet') {
      closeTelnetConnection(connId)
    } else {
      closeConnection(connId)
    }
    agentConns.delete(connId)
    emitEvent({ ts: nowIso(), kind: 'disconnect', connId, target: conn.target })
  }

  // ---------- WebSocket ----------
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.searchParams.get('token') !== token) {
      ws.close(4001, 'unauthorized')
      return
    }
    ws.on('message', (raw: RawData) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        return
      }
      void handleWsMessage(ws, msg)
    })
  })

  async function handleWsMessage(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? '')
    const reqId = msg.id as string | undefined
    const reply = (payload: Record<string, unknown>) => {
      if (reqId) ws.send(JSON.stringify({ type, id: reqId, ...payload }))
    }
    try {
      if (type === 'connect') {
        const body = msg as Record<string, unknown>
        const { target, type: connType } = makeTarget({
          host: String(body.host ?? ''),
          port: Number(body.port ?? 0),
          username: body.username ? String(body.username) : undefined,
          protocol: body.protocol ? String(body.protocol) : 'ssh',
        })
        let realId: string
        if (connType === 'telnet') {
          const h = await createTelnetConnection({ host: target.host, port: target.port, username: target.username, password: body.password ? String(body.password) : undefined })
          realId = h.id
        } else {
          const h = await createConnection({
            host: target.host,
            port: target.port,
            username: target.username ?? '',
            password: body.password ? String(body.password) : undefined,
            privateKey: body.privateKey ? String(body.privateKey) : undefined,
            passphrase: body.passphrase ? String(body.passphrase) : undefined,
            protocol: connType,
          })
          realId = h.id
        }
        agentConns.set(realId, { id: realId, type: connType, target })
        emitEvent({ ts: nowIso(), kind: 'connect', connId: realId, target })
        return reply({ ok: true, connId: realId, target })
      }
      if (type === 'exec') {
        const connId = String(msg.connId ?? '')
        const conn = resolveConn(connId)
        const command = String(msg.command ?? '')
        if (!conn) return reply({ ok: false, error: `连接不存在: ${connId}` })
        if (!command.trim()) return reply({ ok: false, error: '命令为空' })
        if (conn.type === 'telnet') return reply({ ok: false, error: 'Telnet 不支持 exec' })
        emitEvent({ ts: nowIso(), kind: 'exec', connId, target: conn.target, command })
        const r = await execCommand(connId, command)
        emitEvent({ ts: nowIso(), kind: 'exec_result', connId, target: conn.target, command, code: r.code, stdout: r.stdout, stderr: r.stderr })
        return reply({ ok: true, code: r.code, stdout: r.stdout, stderr: r.stderr })
      }
      if (type === 'shell_open') {
        const connId = String(msg.connId ?? '')
        if (!resolveConn(connId)) return reply({ ok: false, error: `连接不存在: ${connId}` })
        await openAgentShell(connId)
        return reply({ ok: true, connId })
      }
      if (type === 'shell_input') {
        const connId = String(msg.connId ?? '')
        writeShell(connId, String(msg.data ?? ''))
        return reply({ ok: true })
      }
      if (type === 'shell_resize') {
        const connId = String(msg.connId ?? '')
        resizeShell(connId, Number(msg.cols ?? 80), Number(msg.rows ?? 24))
        return reply({ ok: true })
      }
      if (type === 'shell_close') {
        const connId = String(msg.connId ?? '')
        closeAgentShell(connId)
        return reply({ ok: true })
      }
      if (type === 'disconnect') {
        const connId = String(msg.connId ?? '')
        closeAgentConn(connId)
        return reply({ ok: true })
      }
      if (type === 'sftp_list') {
        const connId = String(msg.connId ?? '')
        const conn = resolveConn(connId)
        if (!conn) return reply({ ok: false, error: `连接不存在: ${connId}` })
        const r = await listDir(connId, String(msg.path ?? '.'))
        emitEvent({ ts: nowIso(), kind: 'sftp', connId, target: conn.target, op: 'list', path: String(msg.path ?? '.') })
        return reply({ ok: true, entries: r.entries })
      }
      reply({ ok: false, error: `未知消息类型: ${type}` })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      reply({ ok: false, error: m })
    }
  }

  // ---------- Listen ----------
  server.on('error', (err: NodeJS.ErrnoException) => {
    log.error(`agent server error: ${err.message}`)
  })

  return new Promise<AgentServer>((resolve) => {
    const listen = (port: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port !== 0) {
          log.warn(`agent port ${port} 被占用，尝试随机端口`)
          listen(0)
          return
        }
        log.error(`agent server 启动失败: ${err.message}`)
        resolve({
          port,
          token,
          running: false,
          url: `http://127.0.0.1:${port}`,
          wsUrl: `ws://127.0.0.1:${port}/ws`,
          listConns: () => allConns(),
          writeShellInput: (connId: string, data: string) => writeShell(connId, data),
          setToken: (t: string) => {
            token = t
            setSetting('agent.token', t)
          },
          close: () => {},
        })
      })
      server.listen(port, '127.0.0.1', () => {
        const actual = (server.address() as { port: number }).port
        log.info(`agent gateway listening on ws://127.0.0.1:${actual}/ws (token=${token.slice(0, 6)}…)`)
        resolve({
          port: actual,
          token,
          running: true,
          url: `http://127.0.0.1:${actual}`,
          wsUrl: `ws://127.0.0.1:${actual}/ws`,
          listConns: () => allConns(),
          writeShellInput: (connId: string, data: string) => writeShell(connId, data),
          setToken: (t: string) => {
            token = t
            setSetting('agent.token', t)
          },
          close: () => {
            try {
              for (const id of [...agentConns.keys()]) closeAgentConn(id)
              wss.close()
              server.close()
            } catch {
              // ignore
            }
          },
        })
      })
    }
    listen(DEFAULT_PORT)
  })
}
