/**
 * 本地存储层（node:sqlite · Node 内置，免编译）
 * - 使用 Electron 内置 Node 的 node:sqlite（Node 24+），无需原生模块编译，绿色版可直接运行
 * - 建表严格遵循开发文档第 6 节 DDL
 * - 会话 CRUD 供 conn 模块调用
 */
import { DatabaseSync } from 'node:sqlite'
import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { createLogger } from '../logger/index'

const log = createLogger('storage')

export type AuthType = 'password' | 'key'
export type Protocol = 'ssh' | 'serial'

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
  /** 明文密码（仅内存传入，写入时用 safeStorage 加密，磁盘不留明文） */
  password?: string | null
  remark?: string | null
  private_key_path?: string | null
  smart_accel?: number
  exec_channel?: number
  monitor_disabled?: number
}

// —— 密码安全：safeStorage（Windows=DPAPI）加密，磁盘上只有密文 ——
function encryptPw(plain: string): string | null {
  try {
    if (!plain) return null
    if (!safeStorage.isEncryptionAvailable()) {
      // 不可用时退回 base64 混淆（仍不是明文），并打日志
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
  background_pic TEXT,
  sync_flag INTEGER DEFAULT 0,
  updated_at TEXT,
  FOREIGN KEY(group_id) REFERENCES session_groups(id)
);
CREATE TABLE IF NOT EXISTS session_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, parent_id INTEGER);
CREATE TABLE IF NOT EXISTS quick_commands (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, command TEXT, group_id INTEGER, params TEXT, sync_flag INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS command_history (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, command TEXT, count INTEGER DEFAULT 1, last_used TEXT, sync_flag INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS param_history (id INTEGER PRIMARY KEY AUTOINCREMENT, command_id INTEGER, params TEXT, count INTEGER DEFAULT 1, sync_flag INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS path_history (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, count INTEGER DEFAULT 1, sync_flag INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS ssh_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type TEXT, public_key TEXT, private_key_enc TEXT, passphrase_enc TEXT);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS sync_meta (id INTEGER PRIMARY KEY, device_id TEXT, last_pull_ts TEXT, last_push_ts TEXT);
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

/** 列级迁移：旧库补新列（ALTER ADD COLUMN 在列已存在时会抛错，需 try/catch 忽略） */
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
      // 列已存在，忽略
    }
  }
}

function getDb(): DatabaseSync {
  if (!db) return initStorage()
  return db
}

/** 新增会话，返回新会话 id */
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
    smart_accel: s.smart_accel ?? 0,
    exec_channel: s.exec_channel ?? 0,
    monitor_disabled: s.monitor_disabled ?? 0,
  })
  return Number(r.lastInsertRowid)
}

/** 会话列表（默认不含已删除；includeDeleted 与搜索可选） */
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

/** 按 id 取单条会话 */
export function getSession(id: number): SessionRow | null {
  const s = (getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined) ?? null
  if (!s) return null
  return { ...s, password: decryptPw(s.password_enc), password_enc: null }
}

/** 更新会话（仅更新传入的字段） */
export function updateSession(id: number, fields: Partial<NewSession>): void {
  const allow = [
    'name', 'host', 'port', 'protocol', 'username', 'auth_type', 'group_id', 'jump_host',
    'remark', 'private_key_path', 'smart_accel', 'exec_channel', 'monitor_disabled',
  ]
  const set: string[] = []
  const args: Array<string | number | null> = []
  // 密码：仅当传入非空明文时才更新（加密存储）；不传/为空则保持原密码
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


/** 删除会话 */
export function deleteSession(id: number): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

export function closeStorage(): void {
  if (db) {
    db.close()
    db = null
  }
}


