/**
 * Agent gateway module entry
 * - Owns the singleton agent server
 * - Provides the token reset that takes effect immediately (updates the running server)
 */
import { randomUUID } from 'node:crypto'
import { startAgentServer, type AgentServer } from './server'
import { setSetting } from '../storage/index'
import type { AgentEvent } from './types'

let server: AgentServer | null = null
let onEvent: ((e: AgentEvent) => void) | null = null

/** Start (or restart) the agent gateway. Call once after initStorage(). */
export async function initAgentServer(eventCb?: (e: AgentEvent) => void): Promise<AgentServer | null> {
  if (eventCb) onEvent = eventCb
  try {
    server = await startAgentServer({ onEvent: (e) => onEvent?.(e) })
    return server
  } catch (e) {
    console.error('agent gateway failed to start:', e)
    return null
  }
}

export function getAgentServer(): AgentServer | null {
  return server
}

/** Generate a new token and apply it to the running server immediately. */
export function resetAgentToken(): string {
  const t = randomUUID().replace(/-/g, '')
  setSetting('agent.token', t)
  if (server) server.setToken(t)
  return t
}

export function closeAgentServer(): void {
  try {
    server?.close()
  } catch {
    // ignore
  }
  server = null
}
