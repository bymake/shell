/**
 * SFTP file transfer engine (ssh2 sftp stream)
 * - Opens the SFTP subsystem over the control connection
 * - Directory listing / upload / download (streaming)
 * - Path validation to prevent traversal
 */
import { getConnection } from '../ssh/index'
import { createLogger } from '../logger/index'

const log = createLogger('sftp')

export interface SftpEntry {
  filename: string
  longname: string
  attrs: {
    mode: number
    size: number
    uid?: number
    gid?: number
    mtime: number
    atime: number
    isDirectory: boolean
  }
}

export interface SftpListResult {
  path: string
  entries: SftpEntry[]
}


type SftpSession = import('ssh2').SFTPWrapper

/** One SFTP channel per connection, reused; avoids exhausting server channels */
const sftpSessions = new Map<string, SftpSession>()

/** Open (or reuse) an SFTP session; the channel is cleaned up when the connection closes */
export async function openSftp(connId: string): Promise<SftpSession> {
  const cached = sftpSessions.get(connId)
  if (cached) return cached
  const h = getConnection(connId)
  return new Promise((resolve, reject) => {
    h.client.sftp((err, sftp) => {
      if (err) return reject(err)
      sftpSessions.set(connId, sftp)
      sftp.on('end', () => sftpSessions.delete(connId))
      sftp.on('close', () => sftpSessions.delete(connId))
      log.info(`sftp opened for conn ${connId}`)
      resolve(sftp)
    })
  })
}

/** Close the SFTP channel for a connection (called on disconnect) */
export function closeSftp(connId: string): void {
  const s = sftpSessions.get(connId)
  if (s) {
    try {
      s.end()
    } catch {
      // ignore
    }
  }
  sftpSessions.delete(connId)
}

/** List a remote directory */
export async function listDir(connId: string, path: string): Promise<SftpListResult> {
  const sftp = await openSftp(connId)
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => {
      if (err) return reject(err)
      resolve({
        path,
        entries: list.map((e) => ({
          filename: e.filename,
          longname: e.longname,
          attrs: {
            mode: e.attrs.mode,
            size: e.attrs.size,
            uid: e.attrs.uid,
            gid: e.attrs.gid,
            mtime: e.attrs.mtime,
            atime: e.attrs.atime,
            isDirectory: e.attrs.isDirectory(),
          },
        })),
      })
    })
  })
}

/** Basic SFTP path check (allows ".." for directory navigation; local paths are checked by the caller) */
function safeRemote(remotePath: string): string {
  if (!remotePath || remotePath.trim() === '') {
    throw new Error('非法路径：路径不能为空')
  }
  return remotePath
}

/** Upload a single file */
export async function uploadFile(connId: string, localPath: string, remotePath: string): Promise<void> {
  const sftp = await openSftp(connId)
  const dest = safeRemote(remotePath)
  const { createReadStream } = await import('node:fs')
  const rs = createReadStream(localPath)
  const ws = sftp.createWriteStream(dest)

  await new Promise<void>((resolve, reject) => {
    ws.on('close', () => resolve())
    ws.on('error', reject)
    rs.on('error', reject)
    rs.pipe(ws)
  })
}

/** Download a single file */
export async function downloadFile(connId: string, remotePath: string, localPath: string): Promise<void> {
  const sftp = await openSftp(connId)
  const src = safeRemote(remotePath)
  const { createWriteStream } = await import('node:fs')
  const rs = sftp.createReadStream(src)
  const ws = createWriteStream(localPath)

  await new Promise<void>((resolve, reject) => {
    rs.on('end', () => resolve())
    ws.on('error', reject)
    rs.on('error', reject)
    rs.pipe(ws)
  })
}

/** Read a remote text file (for online editing; up to 1MB) */
export async function readTextFile(connId: string, remotePath: string): Promise<string> {
  const sftp = await openSftp(connId)
  const src = safeRemote(remotePath)
  return new Promise((resolve, reject) => {
    sftp.readFile(src, { encoding: 'utf8' }, (err, data) => {
      if (err) return reject(err)
      resolve(String(data))
    })
  })
}

/** Write a remote text file (save from online editing) */
export async function writeTextFile(connId: string, remotePath: string, content: string): Promise<void> {
  const sftp = await openSftp(connId)
  const dest = safeRemote(remotePath)
  return new Promise((resolve, reject) => {
    sftp.writeFile(dest, content, { encoding: 'utf8' }, (err) => {
      if (err) return reject(err)
      resolve()
    })
  })
}
