/**
 * Telnet engine (NVT over TCP)
 * - Direct byte-stream terminal, no encryption
 * - Minimal IAC negotiation so the device is happy (ECHO / SGA / DONT-WONT for the rest)
 * - Optional auto-login: watches for "Username:" / "Password:" prompts and replies
 *   from the saved credentials (the prompts are matched on the stripped stream)
 */
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../logger/index'

const log = createLogger('telnet')

export interface TelnetOptions {
  host: string
  port: number
  username?: string
  password?: string
}

export interface TelnetHandle {
  id: string
  socket: net.Socket
  opts: TelnetOptions
  authed: boolean
}

const connections = new Map<string, TelnetHandle>()

// Telnet command bytes
const IAC = 255
const DONT = 254
const DO = 253
const WONT = 252
const WILL = 251
const SB = 250
const SE = 240
// Options
const ECHO = 1
const SGA = 3

/** Parse a buffer: strip IAC sequences, reply to negotations, return the clean bytes */
export function telnetFilter(handle: TelnetHandle, buf: Buffer): Buffer {
  const out: Buffer[] = []
  let i = 0
  while (i < buf.length) {
    const b = buf[i]
    if (b !== IAC) {
      out.push(buf.subarray(i, i + 1))
      i++
      continue
    }
    if (i + 1 >= buf.length) break
    const cmd = buf[i + 1]
    if (cmd === IAC) {
      // Escaped 0xFF byte (literal data)
      out.push(buf.subarray(i, i + 1))
      i += 2
      continue
    }
    if (cmd === SB) {
      // Subnegotiation: skip until IAC SE
      let j = i + 2
      while (j + 1 < buf.length && !(buf[j] === IAC && buf[j + 1] === SE)) j++
      i = j + 2
      continue
    }
    if (cmd === WILL || cmd === WONT || cmd === DO || cmd === DONT) {
      if (i + 2 >= buf.length) break
      const opt = buf[i + 2]
      // Accept ECHO / SGA (devices expect them); refuse everything else
      const accept = opt === ECHO || opt === SGA
      if (cmd === WILL) handle.socket.write(Buffer.from([IAC, accept ? DO : DONT, opt]))
      else if (cmd === DO) handle.socket.write(Buffer.from([IAC, accept ? WILL : WONT, opt]))
      i += 3
      continue
    }
    // Other IAC commands (AYT / IP / DM / NOP / GA...): just drop
    i += 2
  }
  return Buffer.concat(out)
}

/** Connect a telnet session (TCP only; no auto-login here) */
export async function createTelnetConnection(opts: TelnetOptions): Promise<TelnetHandle> {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const socket = net.connect({ host: opts.host, port: opts.port })
    let settled = false
    socket.once('connect', () => {
      settled = true
      const h: TelnetHandle = { id, socket, opts, authed: false }
      connections.set(id, h)
      log.info(`telnet connected: ${opts.username ?? ''}@${opts.host}:${opts.port}`)
      resolve(h)
    })
    socket.once('error', (err) => {
      if (!settled) reject(err)
      else log.error(`telnet error: ${err.message}`)
    })
  })
}

export function getTelnetConnection(id: string): TelnetHandle {
  const h = connections.get(id)
  if (!h) throw new Error(`连接不存在: ${id}`)
  return h
}

export function closeTelnetConnection(id: string): void {
  const h = connections.get(id)
  if (h) {
    h.socket.destroy()
    connections.delete(id)
    log.info(`telnet closed: ${id}`)
  }
}

export function closeAllTelnet(): void {
  for (const id of [...connections.keys()]) closeTelnetConnection(id)
}
