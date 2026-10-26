/**
 * SSH connection engine (ssh2)
 * - Password / private key (RSA/ECDSA/Ed25519) authentication
 * - Interactive shell (for the terminal) and exec (for monitor collection)
 */
import { Client, type ClientChannel } from 'ssh2'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../logger/index'

const log = createLogger('ssh')

export type ConnId = string

export interface ConnOptions {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface ConnHandle {
  id: ConnId
  client: Client
  opts: ConnOptions
}

const connections = new Map<ConnId, ConnHandle>()

function connectOne(opts: ConnOptions): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client()
    c.once('ready', () => resolve(c))
    c.once('error', reject)
    c.connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      readyTimeout: 20000,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3,
      ...(opts.password ? { password: opts.password } : {}),
      ...(opts.privateKey
        ? { privateKey: opts.privateKey, ...(opts.passphrase ? { passphrase: opts.passphrase } : {}) }
        : {}),
    })
  })
}

/** Establish an SSH connection */
export async function createConnection(opts: ConnOptions): Promise<ConnHandle> {
  const client = await connectOne(opts)
  const id = randomUUID()
  connections.set(id, { id, client, opts })
  log.info(`connection created: ${opts.username}@${opts.host}:${opts.port}`)
  return connections.get(id)!
}

export function getConnection(id: ConnId): ConnHandle {
  const h = connections.get(id)
  if (!h) throw new Error(`连接不存在: ${id}`)
  return h
}

export function closeConnection(id: ConnId): void {
  const h = connections.get(id)
  if (h) {
    h.client.end()
    connections.delete(id)
    log.info(`connection closed: ${id}`)
  }
}

/** Open an interactive shell (for xterm binding); returns a read/write stream */
export function openShell(id: ConnId): Promise<ClientChannel> {
  const h = getConnection(id)
  return new Promise((resolve, reject) => {
    h.client.shell({ term: 'xterm-256color', rows: 30, cols: 100 }, (err, stream) => {
      if (err) return reject(err)
      resolve(stream)
    })
  })
}

/** Run a single command; returns stdout/stderr (monitor collection, path probing) */
export function execCommand(id: ConnId, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const h = getConnection(id)
  return new Promise((resolve, reject) => {
    h.client.exec(command, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      stream.on('close', (code: number, signal?: string) =>
        resolve({ code: code ?? (signal ? -1 : 0), stdout, stderr }),
      )
      stream.on('data', (d: Buffer) => (stdout += d.toString('utf-8')))
      stream.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')))
    })
  })
}

export function closeAll(): void {
  for (const id of [...connections.keys()]) closeConnection(id)
}
