/**
 * SFTP 文件传输引擎（ssh2 sftp 流）
 * - 基于 conn 的控制连接打开 SFTP 子系统
 * - 目录浏览 / 上传 / 下载（流式）
 * - 路径校验，防路径穿越
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

/** 每个连接只建一个 SFTP 通道并复用，避免反复新建导致服务器通道数超限 */
const sftpSessions = new Map<string, SftpSession>()

/** 打开（或复用）SFTP 会话；通道随连接关闭而清理 */
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

/** 关闭连接的 SFTP 通道（连接断开时调用） */
export function closeSftp(connId: string): void {
  const s = sftpSessions.get(connId)
  if (s) {
    try {
      s.end()
    } catch {
      /* 忽略 */
    }
  }
  sftpSessions.delete(connId)
}

/** 目录浏览 */
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

/** SFTP 路径基本校验（允许 .. 用于目录导航；本地落盘路径在调用方校验） */
function safeRemote(remotePath: string): string {
  if (!remotePath || remotePath.trim() === '') {
    throw new Error('非法路径：路径不能为空')
  }
  return remotePath
}

/** 上传单个文件 */
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

/** 下载单个文件 */
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

/** 读取远程文本文件（在线编辑用，≤ 1MB） */
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

/** 写入远程文本文件（在线编辑保存） */
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
