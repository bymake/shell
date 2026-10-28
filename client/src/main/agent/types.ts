/**
 * Agent gateway shared types
 * - An external agent (Doubao / any MCP-capable agent) drives ShellPro through the
 *   local HTTP+WebSocket gateway; every action is broadcast to the UI as an AgentEvent
 *   so the user can watch what the agent is doing in real time.
 */

export interface AgentTarget {
  host: string
  port: number
  username?: string
  protocol: 'ssh' | 'ssh2' | 'telnet'
}

export type AgentEventKind =
  | 'connect' // agent opened a connection
  | 'disconnect' // agent closed a connection
  | 'exec' // agent ran a command
  | 'exec_result' // command finished
  | 'shell_open' // interactive shell opened
  | 'shell_data' // interactive shell output
  | 'shell_exit' // shell ended
  | 'sftp' // sftp op
  | 'error' // error message

export interface AgentEvent {
  ts: string
  kind: AgentEventKind
  connId: string
  target?: AgentTarget
  command?: string
  code?: number
  stdout?: string
  stderr?: string
  data?: string
  op?: string
  path?: string
  message?: string
}

/** A connection held by the agent gateway */
export interface AgentConn {
  id: string
  type: 'ssh' | 'ssh2' | 'telnet'
  target: AgentTarget
  name?: string
  /** true when this is a session the user opened in the UI that the agent may
   *  reuse (send input / read output) but must NOT close or disconnect. */
  isUISession?: boolean
}

/** Outbound WebSocket message to the agent client */
export interface WsOut {
  type: string
  [k: string]: unknown
}
