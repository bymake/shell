/**
 * ShellPro MCP server (stdio)
 * - Exposes the ShellPro agent gateway as standard MCP tools, so any MCP-capable
 *   agent (Doubao, Claude, etc.) can drive ShellPro and the user watches in the UI
 * - This is a thin adapter: every tool call forwards to the ShellPro local gateway
 *   (HTTP + WebSocket). Configure with:
 *     SHELLPRO_AGENT_URL   (default http://127.0.0.1:17890)
 *     SHELLPRO_AGENT_TOKEN (the token shown in ShellPro → 工具 → Agent 接口)
 * - Run: npx tsx src/agent-mcp/server.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE = process.env.SHELLPRO_AGENT_URL || 'http://127.0.0.1:17890'
const TOKEN = process.env.SHELLPRO_AGENT_TOKEN || ''

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean }
  if (!res.ok || j.ok === false) {
    throw new Error((j.error as string) || `HTTP ${res.status}`)
  }
  return j as T
}

const server = new McpServer({ name: 'shellpro', version: '0.1.0' })

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], isError }
}

async function run(fn: () => Promise<string>) {
  try {
    return text(await fn())
  } catch (e) {
    return text(`错误: ${e instanceof Error ? e.message : String(e)}`, true)
  }
}

// health / discovery
server.tool(
  'shellpro_health',
  'Check whether the ShellPro agent gateway is reachable and return its URL',
  {},
  async () => run(async () => JSON.stringify(await api<Record<string, unknown>>('/health'))),
)

server.tool(
  'shellpro_list_connections',
  'List the connections currently held by the agent in ShellPro',
  {},
  async () =>
    run(async () => {
      const r = await api<{ connections: unknown[] }>('/sessions')
      return JSON.stringify(r.connections)
    }),
)

// connection lifecycle
server.tool(
  'shellpro_connect',
  'Open an SSH/Telnet connection in ShellPro. Returns a connId used by later tools.',
  {
    host: z.string().describe('Remote host / IP'),
    port: z.number().optional().describe('Port (SSH default 22, Telnet 23)'),
    username: z.string().optional(),
    password: z.string().optional(),
    protocol: z.enum(['ssh', 'ssh2', 'telnet']).optional().describe('Defaults to ssh'),
    name: z.string().optional(),
  },
  async (a) =>
    run(async () => {
      const r = await api<{ connId: string; target: unknown }>('/session', 'POST', a)
      return `connected: ${JSON.stringify(r.target)} connId=${r.connId}`
    }),
)

server.tool(
  'shellpro_disconnect',
  'Close a connection previously opened by the agent',
  { connId: z.string() },
  async (a) => run(async () => JSON.stringify(await api(`/session/${a.connId}`, 'DELETE'))),
)

// exec (one-shot, returns full output)
server.tool(
  'shellpro_exec',
  'Run a single command over an SSH connection and return { code, stdout, stderr }.',
  { connId: z.string(), command: z.string() },
  async (a) =>
    run(async () => {
      const r = await api<{ code: number; stdout: string; stderr: string }>(
        `/session/${a.connId}/exec`,
        'POST',
        { command: a.command },
      )
      return JSON.stringify({ code: r.code, stdout: r.stdout, stderr: r.stderr })
    }),
)

// interactive shell
server.tool(
  'shellpro_shell_open',
  'Open an interactive shell on an SSH/Telnet connection (output streams to the ShellPro UI).',
  { connId: z.string() },
  async (a) => run(async () => JSON.stringify(await api(`/session/${a.connId}/shell/open`, 'POST'))),
)

server.tool(
  'shellpro_shell_input',
  'Write input to the interactive shell of a connection',
  { connId: z.string(), data: z.string() },
  async (a) => run(async () => JSON.stringify(await api(`/session/${a.connId}/shell/input`, 'POST', { data: a.data }))),
)

server.tool(
  'shellpro_shell_close',
  'Close the interactive shell of a connection',
  { connId: z.string() },
  async (a) => run(async () => JSON.stringify(await api(`/session/${a.connId}/shell/close`, 'POST'))),
)

// SFTP
server.tool(
  'shellpro_sftp_list',
  'List a remote directory over SFTP',
  { connId: z.string(), path: z.string().default('.') },
  async (a) =>
    run(async () => {
      const r = await api<{ entries: unknown[] }>(`/session/${a.connId}/sftp/list`, 'POST', { path: a.path })
      return JSON.stringify(r.entries)
    }),
)

server.tool(
  'shellpro_sftp_read',
  'Read a remote text file over SFTP',
  { connId: z.string(), path: z.string() },
  async (a) =>
    run(async () => {
      const r = await api<{ content: string }>(`/session/${a.connId}/sftp/readText`, 'POST', { path: a.path })
      return r.content
    }),
)

server.tool(
  'shellpro_sftp_write',
  'Write a remote text file over SFTP',
  { connId: z.string(), path: z.string(), content: z.string() },
  async (a) => run(async () => JSON.stringify(await api(`/session/${a.connId}/sftp/writeText`, 'POST', a))),
)

server.tool(
  'shellpro_sftp_upload',
  'Upload a local file to the remote host over SFTP',
  { connId: z.string(), localPath: z.string(), remotePath: z.string() },
  async (a) => run(async () => JSON.stringify(await api(`/session/${a.connId}/sftp/upload`, 'POST', a))),
)

server.tool(
  'shellpro_sftp_download',
  'Download a remote file to the local machine over SFTP',
  { connId: z.string(), remotePath: z.string(), localPath: z.string() },
  async (a) => run(async () => JSON.stringify(await api(`/session/${a.connId}/sftp/download`, 'POST', a))),
)

// start
const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`[shellpro-mcp] gateway=${BASE} token=${TOKEN ? '***' : '(未设置!)'}`)
