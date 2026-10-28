/**
 * SSH connection engine (ssh2)
 * - Password / private key (RSA/ECDSA/Ed25519) authentication
 * - Interactive shell (for the terminal) and exec (for monitor collection)
 */
import { Client, type ClientChannel, type Algorithms } from 'ssh2'
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
  /** 'ssh2' = legacy-compatible algorithms (H3C / old network gear); default = standard */
  protocol?: 'ssh' | 'ssh2'
}

export interface ConnHandle {
  id: ConnId
  client: Client
  opts: ConnOptions
}

const connections = new Map<ConnId, ConnHandle>()

// Legacy-network compatibility: prepend old-school algorithms to ssh2's default
// list (which is already filtered to what the runtime supports), so devices like
// H3C Comware / old Cisco that only speak SHA-1 group KEX + CBC ciphers negotiate
// successfully. We never replace the whole list — replacing it can trigger
// "Unsupported algorithm" for entries the runtime OpenSSL/BoringSSL lacks
// (e.g. chacha20-poly1305@openssh.com under Electron).
// Partial keys are legal at runtime (ssh2 merges them into the default list);
// the type cast exists only because @types/ssh2 declares all three keys required.
const COMPAT_ALGORITHMS = {
  kex: {
    prepend: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1', 'diffie-hellman-group-exchange-sha1'],
  },
  cipher: {
    prepend: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc'],
  },
  serverHostKey: {
    prepend: ['ssh-rsa'],
  },
  hmac: {
    prepend: ['hmac-sha1'],
  },
} as unknown as Algorithms

function connectOne(opts: ConnOptions): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client()
    // Keep a permanent error listener: an SSH server may drop the connection at
    // any time (DISCONNECT / handshake failure). Without a listener the error
    // becomes an uncaught exception and Electron shows a native error dialog.
    // `reject` is a no-op once the promise has resolved, so this is safe to keep.
    c.on('error', (err) => {
      log.error(`ssh client error: ${err instanceof Error ? err.message : String(err)}`)
      reject(err)
    })
    c.once('ready', () => resolve(c))
    c.connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      readyTimeout: 20000,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3,
      // Compatibility algorithms only for the explicit "ssh2" protocol
      ...(opts.protocol === 'ssh2' ? { algorithms: COMPAT_ALGORITHMS } : {}),
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

/** List all live connections (id + target), so an agent can reuse a session the
 *  user already opened in the UI instead of creating its own connection. */
export function listConnections(): Array<{ id: ConnId; host: string; port: number; username?: string; protocol?: 'ssh' | 'ssh2' }> {
  return [...connections.values()].map((h) => ({
    id: h.id,
    host: h.opts.host,
    port: h.opts.port,
    username: h.opts.username || undefined,
    protocol: h.opts.protocol,
  }))
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
