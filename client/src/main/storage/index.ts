/**
 * Local storage layer (node:sqlite - Node built-in, no compilation needed)
 * - Uses the node:sqlite module (Node 24+) from Electron's bundled Node, so the
 *   portable build runs without any native module compilation
 * - Table schema follows section 6 DDL of the development doc
 * - Session CRUD used by the conn module
 */
import { DatabaseSync } from 'node:sqlite'
import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { createLogger } from '../logger/index'

const log = createLogger('storage')

type AuthType = 'password' | 'key'
type Protocol = 'ssh' | 'ssh2' | 'telnet' | 'serial'

export interface SessionRow {
  id: number
  group_id: number | null
  name: string
  host: string
  port: number
  protocol: Protocol
  username: string | null
  auth_type: AuthType
  key_id: number | null
  proxy_id: number | null
  jump_host: string | null
  charset: string
  remark: string | null
  password_enc: string | null
  password?: string | null
  private_key_path: string | null
  smart_accel: number
  exec_channel: number
  monitor_disabled: number
  deleted: number
  sync_flag: number
  updated_at: string | null
}

export interface NewSession {
  name: string
  host: string
  port?: number
  protocol?: Protocol
  username?: string
  auth_type?: AuthType
  group_id?: number | null
  jump_host?: string | null
  password_enc?: string | null
  /** Plaintext password (memory only; encrypted with safeStorage on write, never stored in clear) */
  password?: string | null
  remark?: string | null
  private_key_path?: string | null
}

// --- Password security: encrypted with safeStorage (DPAPI on Windows); only ciphertext on disk ---
function encryptPw(plain: string): string | null {
  try {
    if (!plain) return null
    if (!safeStorage.isEncryptionAvailable()) {
      // Fall back to base64 obfuscation (still not plaintext), and log it
      log.warn('safeStorage 不可用，使用 base64 存储')
      return Buffer.from(plain, 'utf8').toString('base64')
    }
    return safeStorage.encryptString(plain).toString('base64')
  } catch (e) {
    log.warn(`password encrypt failed: ${String(e)}`)
    return null
  }
}

function decryptPw(cipher: string | null): string | null {
  if (!cipher) return null
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    }
    return Buffer.from(cipher, 'base64').toString('utf8')
  } catch {
    return null
  }
}

const SCHEMA = `
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER DEFAULT 22,
  protocol TEXT DEFAULT 'ssh',
  username TEXT,
  auth_type TEXT DEFAULT 'password',
  key_id INTEGER,
  proxy_id INTEGER,
  jump_host TEXT,
  password_enc TEXT,
  charset TEXT DEFAULT 'utf-8',
  sync_flag INTEGER DEFAULT 0,
  updated_at TEXT
);
`

let db: DatabaseSync | null = null

export function initStorage(): DatabaseSync {
  if (db) return db
  const dir = app.getPath('userData')
  const file = join(dir, 'shellpro.db')
  db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  migrate()
  log.info(`storage initialized at ${file}`)
  return db
}

/** Column-level migration: add missing columns to old DBs (ALTER ADD COLUMN throws if the column exists; ignore) */
function migrate(): void {
  const db0 = db!
  const cols: Array<[string, string]> = [
    ['remark', 'TEXT'],
    ['deleted', 'INTEGER DEFAULT 0'],
    ['private_key_path', 'TEXT'],
    ['smart_accel', 'INTEGER DEFAULT 0'],
    ['exec_channel', 'INTEGER DEFAULT 0'],
    ['monitor_disabled', 'INTEGER DEFAULT 0'],
  ]
  for (const [name, def] of cols) {
    try {
      db0.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${def}`)
    } catch {
      // column already exists; ignore
    }
  }
}

function getDb(): DatabaseSync {
  if (!db) return initStorage()
  return db
}

/** Insert a session; returns the new session id */
export function insertSession(s: NewSession): number {
  const stmt = getDb().prepare(
    `INSERT INTO sessions
       (group_id, name, host, port, protocol, username, auth_type, jump_host, password_enc,
        remark, private_key_path, smart_accel, exec_channel, monitor_disabled, sync_flag, updated_at)
     VALUES (@group_id, @name, @host, @port, @protocol, @username, @auth_type, @jump_host, @password_enc,
        @remark, @private_key_path, @smart_accel, @exec_channel, @monitor_disabled, 0, datetime('now'))`,
  )
  const r = stmt.run({
    group_id: s.group_id ?? null,
    name: s.name,
    host: s.host,
    port: s.port ?? 22,
    protocol: s.protocol ?? 'ssh',
    username: s.username ?? null,
    auth_type: s.auth_type ?? 'password',
    jump_host: s.jump_host ?? null,
    password_enc: s.password != null ? encryptPw(s.password) : (s.password_enc ?? null),
    remark: s.remark ?? null,
    private_key_path: s.private_key_path ?? null,
    smart_accel: 0,
    exec_channel: 0,
    monitor_disabled: 0,
  })
  return Number(r.lastInsertRowid)
}

/** List sessions (excludes deleted by default; includeDeleted and search optional) */
export function listSessions(opts: { includeDeleted?: boolean; search?: string } = {}): SessionRow[] {
  const { includeDeleted = false, search = '' } = opts
  const clauses: string[] = []
  const args: Array<string | number | null> = []
  if (!includeDeleted) clauses.push('deleted = 0')
  if (search) {
    clauses.push('(name LIKE ? OR host LIKE ? OR username LIKE ? OR remark LIKE ?)')
    const like = `%${search}%`
    args.push(like, like, like, like)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const sql = `SELECT * FROM sessions ${where} ORDER BY name`
  const rows = getDb().prepare(sql).all(...args) as unknown as SessionRow[]
  return rows.map((r) => ({ ...r, password: decryptPw(r.password_enc), password_enc: null }))
}

/** Update a session (only the passed fields are updated) */
export function updateSession(id: number, fields: Partial<NewSession>): void {
  const allow = [
    'name', 'host', 'port', 'protocol', 'username', 'auth_type', 'group_id', 'jump_host',
    'remark', 'private_key_path',
  ]
  const set: string[] = []
  const args: Array<string | number | null> = []
  // Password: only updated when a non-empty plaintext is passed (stored encrypted); otherwise keep the old one
  if (fields.password != null && fields.password !== '') {
    set.push('password_enc = ?')
    args.push(encryptPw(fields.password))
  }
  for (const k of allow) {
    if (k in fields) {
      set.push(`${k} = ?`)
      const v = (fields as Record<string, unknown>)[k]
      args.push((v ?? null) as string | number | null)
    }
  }
  if (set.length === 0) return
  args.push(id)
  getDb()
    .prepare(`UPDATE sessions SET ${set.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...args)
}


/** Delete a session */
export function deleteSession(id: number): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

export function closeStorage(): void {
  if (db) {
    db.close()
    db = null
  }
}


