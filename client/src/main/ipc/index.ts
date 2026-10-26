/**
 * IPC 白名单通道注册（安全边界）
 * - 渲染进程只能调用这里显式注册的通道
 * - 所有 SSH/存储/监控/SFTP 操作在主进程完成
 * - 终端数据经 terminal:data:{connId} 事件回推渲染层
 */
import { ipcMain, dialog, clipboard, BrowserWindow, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import type { ClientChannel } from 'ssh2'
import { createConnection, closeConnection, openShell, type ConnId } from '../ssh/index'
import { listDir, uploadFile, downloadFile, readTextFile, writeTextFile, closeSftp } from '../sftp/index'
import { collectSnapshot } from '../monitor/index'
import { insertSession, listSessions, deleteSession, getSession, updateSession, type NewSession } from '../storage/index'
import { createLogger } from '../logger/index'

const log = createLogger('ipc')

function err(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e)
  throw new Error(JSON.stringify({ code: 'ERR', message: msg }))
}

interface TerminalEntry {
  connId: string
  sshStream?: ClientChannel
}

const terminals = new Map<string, TerminalEntry>()

function send(wc: WebContents, channel: string, payload: unknown): void {
  if (!wc.isDestroyed()) wc.send(channel, payload)
}

export function registerIpc(getWebContents: () => WebContents): void {
  // ---------- 连接与会话 ----------
  ipcMain.handle('conn:create', async (_e, opts) => {
    try {
      const protocol = (opts?.protocol as string | undefined) ?? 'ssh'
      if (protocol === 'serial') {
        return err(new Error('串口连接需本机原生串口驱动，当前绿色版暂不支持'))
      }
      const conn = await createConnection(opts)
      return { connId: conn.id }
    } catch (e) {
      return err(e)
    }
  })

  ipcMain.handle('conn:close', (_e, connId: ConnId) => {
    try {
      const t = terminals.get(connId)
      if (t?.sshStream) t.sshStream.destroy()
      terminals.delete(connId)
      closeSftp(connId)
      closeConnection(connId)
      return { ok: true }
    } catch (e) {
      return err(e)
    }
  })


  // ---------- 会话存储 ----------
  ipcMain.handle('session:create', (_e, s: NewSession) => {
    try {
      return { id: insertSession(s) }
    } catch (e) {
      return err(e)
    }
  })
  ipcMain.handle('session:list', (_e, opts?: { search?: string }) => {
    try {
      return { sessions: listSessions(opts ?? {}) }
    } catch (e) {
      return err(e)
    }
  })
  ipcMain.handle('session:get', (_e, id: number) => {
    try {
      const s = getSession(id)
      if (!s) return err(new Error('会话不存在'))
      return { session: s }
    } catch (e) {
      return err(e)
    }
  })
  ipcMain.handle('session:update', (_e, id: number, fields: Partial<NewSession>) => {
    try {
      updateSession(id, fields)
      return { ok: true }
    } catch (e) {
      return err(e)
    }
  })
  ipcMain.handle('session:delete', (_e, id: number) => {
    try {
      deleteSession(id)
      return { ok: true }
    } catch (e) {
      return err(e)
    }
  })

  // ---------- 文件选择对话框 ----------
  ipcMain.handle('dialog:openFile', async () => {
    try {
      const r = await dialog.showOpenDialog({ title: '选择要上传的文件', properties: ['openFile'] })
      if (r.canceled || r.filePaths.length === 0) return { path: null }
      return { path: r.filePaths[0] }
    } catch (e) {
      return err(e)
    }
  })

  ipcMain.handle('dialog:saveFile', async (_e, defaultName?: string) => {
    try {
      const r = await dialog.showSaveDialog({
        title: '保存到本地',
        defaultPath: defaultName ? `C:\\Users\\${process.env.USERNAME}\\Downloads\\${defaultName}` : undefined,
      })
      if (r.canceled || !r.filePath) return { path: null }
      return { path: r.filePath }
    } catch (e) {
      return err(e)
    }
  })

  // ---------- 监控（T4） ----------
  // 防重入：同一连接上一轮采集未完成时跳过，避免并发 exec 通道堆积
  const collecting = new Set<ConnId>()
  ipcMain.handle('monitor:collect', async (_e, connId: ConnId) => {
    if (collecting.has(connId)) return { skipped: true }
    collecting.add(connId)
    try {
      return await collectSnapshot(connId)
    } catch (e) {
      return err(e)
    } finally {
      collecting.delete(connId)
    }
  })

  // ---------- SFTP ----------
  ipcMain.handle('sftp:list', async (_e, connId: ConnId, path: string) => {
    try {
      return await listDir(connId, path)
    } catch (e) {
      return err(e)
    }
  })
  ipcMain.handle('sftp:upload', async (_e, connId: ConnId, localPath: string, remotePath: string) => {
    try {
      await uploadFile(connId, localPath, remotePath)
      return { ok: true }
    } catch (e) {
      return err(e)
    }
  })
  ipcMain.handle('sftp:download', async (_e, connId: ConnId, remotePath: string, localPath: string) => {
    try {
      await downloadFile(connId, remotePath, localPath)
      return { ok: true }
    } catch (e) {
      return err(e)
    }
  })

  ipcMain.handle('sftp:readText', async (_e, connId: ConnId, remotePath: string) => {
    try {
      const content = await readTextFile(connId, remotePath)
      return { content }
    } catch (e) {
      return err(e)
    }
  })

  ipcMain.handle('sftp:writeText', async (_e, connId: ConnId, remotePath: string, content: string) => {
    try {
      await writeTextFile(connId, remotePath, content)
      return { ok: true }
    } catch (e) {
      return err(e)
    }
  })

  // ---------- 剪贴板 ----------
  // readText 在个别环境会内部抛"对象无法克隆"，改用多通道读取兜底：
  // readBuffer(text/plain) → readText() → read('text/plain')，任一失败自动回落
  ipcMain.handle('clipboard:readText', () => {
    const c = clipboard as unknown as {
      readBuffer?: (fmt: string) => Buffer
      readText: () => string
      read?: (fmt: string) => string
    }
    let text = ''
    try {
      const buf = c.readBuffer?.('text/plain')
      if (buf && buf.length > 0) text = buf.toString('utf8')
    } catch {
      /* 忽略，走下一通道 */
    }
    if (!text) {
      try {
        const t = c.readText()
        if (typeof t === 'string') text = t
      } catch {
        /* 忽略 */
      }
    }
    if (!text) {
      try {
        const t = c.read?.('text/plain')
        if (typeof t === 'string') text = t
      } catch {
        /* 忽略 */
      }
    }
    return { text }
  })

  ipcMain.handle('clipboard:writeText', (_e, text: string) => {
    try {
      clipboard.writeText(typeof text === 'string' ? text : '')
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  // ---------- 终端（远程 SSH shell） ----------
  ipcMain.handle('terminal:open', async (_e, connId: ConnId) => {
    try {
      const wc = getWebContents()
      const stream = await openShell(connId)

      terminals.set(connId, { connId, sshStream: stream })
      stream.on('data', (data: Buffer) => send(wc, `terminal:data:${connId}`, data.toString('utf-8')))
      stream.on('close', () => send(wc, `terminal:exit:${connId}`, { code: 0 }))
      return { connId }
    } catch (e) {
      return err(e)
    }
  })

  ipcMain.handle('terminal:input', (_e, connId: ConnId, data: string) => {
    try {
      const t = terminals.get(connId)
      if (!t) return err(new Error('终端未打开'))
      t.sshStream?.write(data)
      return { ok: true }
    } catch (e) {
      return err(e)
    }
  })

  ipcMain.handle('terminal:resize', (_e, connId: ConnId, cols: number, rows: number) => {
    try {
      const t = terminals.get(connId)
      if (!t) return err(new Error('终端未打开'))
      t.sshStream?.setWindow?.(rows, cols, cols, rows)
      return { ok: true }
    } catch (e) {
      return err(e)
    }
  })

  ipcMain.handle('terminal:close', (_e, connId: ConnId) => {
    try {
      const t = terminals.get(connId)
      if (t?.sshStream) t.sshStream.destroy()
      terminals.delete(connId)
      return { ok: true }
    } catch (e) {
      return err(e)
    }
  })

  // ---------- 窗口控制（自定义标题栏） ----------
  ipcMain.handle('win:minimize', () => BrowserWindow.fromWebContents(getWebContents())?.minimize())
  ipcMain.handle('win:maximize', () => {
    const w = BrowserWindow.fromWebContents(getWebContents())
    if (w) (w.isMaximized() ? w.unmaximize() : w.maximize())
  })
  ipcMain.handle('win:close', () => BrowserWindow.fromWebContents(getWebContents())?.close())
  ipcMain.handle('win:reload', () => BrowserWindow.fromWebContents(getWebContents())?.webContents.reload())
  ipcMain.handle('serial:listPorts', async () => {
    try {
      const out = await new Promise<string>((res, rej) => {
        execFile('reg', ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM'], (err, stdout) => {
          if (err) return rej(err)
          res(stdout)
        })
      })
      const ports = (out.match(/COM\d+/gi) ?? [])
        .map((p) => p.toUpperCase())
        .filter((v, i, a) => a.indexOf(v) === i)
      return { ports }
    } catch {
      return { ports: [] }
    }
  })
  ipcMain.handle('win:about', async () => {
    const w = BrowserWindow.fromWebContents(getWebContents())
    if (!w) return { ok: true }
    await dialog.showMessageBox(w, {
      type: 'info',
      title: '关于 ShellPro',
      message: 'ShellPro 1.9.1',
      detail: '作者QQ :133205 欢迎反馈! · 个人使用，请勿商用。',
    })
    return { ok: true }
  })
  ipcMain.handle('win:help', async () => {
    const w = BrowserWindow.fromWebContents(getWebContents())
    if (!w) return { ok: true }
    await dialog.showMessageBox(w, {
      type: 'info',
      title: '帮助',
      message: 'ShellPro 使用帮助',
      detail:
        '1. 工具栏「工具 → 新建连接」或标签栏「＋」打开连接管理器\n2. 新建/选择连接，填写主机、端口、用户名、密码后保存并连接\n3. SSH 终端里 cd 后，下方 SFTP 自动同步路径\n4. 选中文字 Ctrl+C 复制、Ctrl+V 粘贴，或右键操作\n5. 侧栏监控面板显示服务器实时负载',
    })
    return { ok: true }
  })

  log.info('ipc whitelist channels registered')
}
