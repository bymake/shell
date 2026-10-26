/**
 * IPC whitelist channel registration (security boundary)
 * - The renderer can only invoke channels explicitly registered here
 * - All SSH/storage/monitor/SFTP operations run in the main process
 * - Terminal data is pushed back to the renderer via terminal:data:{connId} events
 */
import { ipcMain, dialog, clipboard, BrowserWindow, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import type { ClientChannel } from 'ssh2'
import { createConnection, closeConnection, openShell, type ConnId } from '../ssh/index'
import { listDir, uploadFile, downloadFile, readTextFile, writeTextFile, closeSftp } from '../sftp/index'
import { collectSnapshot } from '../monitor/index'
import { insertSession, listSessions, deleteSession, updateSession, type NewSession } from '../storage/index'
import { createLogger } from '../logger/index'

const log = createLogger('ipc')

function err(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e)
  throw new Error(JSON.stringify({ code: 'ERR', message: msg }))
}

/** Wrap a handler body: any throw becomes the ERR envelope */
function handle<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(fn())
  } catch (e) {
    return err(e)
  }
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
  // ---------- Connections & sessions ----------
  ipcMain.handle('conn:create', (_e, opts) =>
    handle(async () => {
      const protocol = (opts?.protocol as string | undefined) ?? 'ssh'
      if (protocol === 'serial') {
        return err(new Error('串口连接需本机原生串口驱动，当前绿色版暂不支持'))
      }
      const conn = await createConnection(opts)
      return { connId: conn.id }
    }),
  )

  ipcMain.handle('conn:close', (_e, connId: ConnId) =>
    handle(() => {
      const t = terminals.get(connId)
      if (t?.sshStream) t.sshStream.destroy()
      terminals.delete(connId)
      closeSftp(connId)
      closeConnection(connId)
      return { ok: true }
    }),
  )

  // ---------- Session storage ----------
  ipcMain.handle('session:create', (_e, s: NewSession) => handle(() => ({ id: insertSession(s) })))
  ipcMain.handle('session:list', (_e, opts?: { search?: string }) =>
    handle(() => ({ sessions: listSessions(opts ?? {}) })),
  )
  ipcMain.handle('session:update', (_e, id: number, fields: Partial<NewSession>) =>
    handle(() => {
      updateSession(id, fields)
      return { ok: true }
    }),
  )
  ipcMain.handle('session:delete', (_e, id: number) =>
    handle(() => {
      deleteSession(id)
      return { ok: true }
    }),
  )

  // ---------- File dialogs ----------
  ipcMain.handle('dialog:openFile', () =>
    handle(async () => {
      const r = await dialog.showOpenDialog({ title: '选择要上传的文件', properties: ['openFile'] })
      if (r.canceled || r.filePaths.length === 0) return { path: null }
      return { path: r.filePaths[0] }
    }),
  )

  ipcMain.handle('dialog:saveFile', (_e, defaultName?: string) =>
    handle(async () => {
      const r = await dialog.showSaveDialog({
        title: '保存到本地',
        defaultPath: defaultName ? `C:\\Users\\${process.env.USERNAME}\\Downloads\\${defaultName}` : undefined,
      })
      if (r.canceled || !r.filePath) return { path: null }
      return { path: r.filePath }
    }),
  )

  // ---------- Monitor (T4) ----------
  // Re-entry guard: skip if the previous collect for this connection is still running,
  // preventing exec channel pile-up
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
  ipcMain.handle('sftp:list', (_e, connId: ConnId, path: string) => handle(() => listDir(connId, path)))
  ipcMain.handle('sftp:upload', (_e, connId: ConnId, localPath: string, remotePath: string) =>
    handle(async () => {
      await uploadFile(connId, localPath, remotePath)
      return { ok: true }
    }),
  )
  ipcMain.handle('sftp:download', (_e, connId: ConnId, remotePath: string, localPath: string) =>
    handle(async () => {
      await downloadFile(connId, remotePath, localPath)
      return { ok: true }
    }),
  )
  ipcMain.handle('sftp:readText', (_e, connId: ConnId, remotePath: string) =>
    handle(async () => ({ content: await readTextFile(connId, remotePath) })),
  )
  ipcMain.handle('sftp:writeText', (_e, connId: ConnId, remotePath: string, content: string) =>
    handle(async () => {
      await writeTextFile(connId, remotePath, content)
      return { ok: true }
    }),
  )

  // ---------- Clipboard ----------
  // readText can throw "object could not be cloned" in some environments; fall back
  // through readBuffer(text/plain) -> readText() -> read('text/plain'), each failing on to the next
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
      // fall through to next channel
    }
    if (!text) {
      try {
        const t = c.readText()
        if (typeof t === 'string') text = t
      } catch {
        // ignore
      }
    }
    if (!text) {
      try {
        const t = c.read?.('text/plain')
        if (typeof t === 'string') text = t
      } catch {
        // ignore
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

  // ---------- Terminal (remote SSH shell) ----------
  ipcMain.handle('terminal:open', (_e, connId: ConnId) =>
    handle(async () => {
      const wc = getWebContents()
      const stream = await openShell(connId)

      terminals.set(connId, { connId, sshStream: stream })
      stream.on('data', (data: Buffer) => send(wc, `terminal:data:${connId}`, data.toString('utf-8')))
      stream.on('close', () => send(wc, `terminal:exit:${connId}`, { code: 0 }))
      return { connId }
    }),
  )

  ipcMain.handle('terminal:input', (_e, connId: ConnId, data: string) =>
    handle(() => {
      const t = terminals.get(connId)
      if (!t) return err(new Error('终端未打开'))
      t.sshStream?.write(data)
      return { ok: true }
    }),
  )

  ipcMain.handle('terminal:resize', (_e, connId: ConnId, cols: number, rows: number) =>
    handle(() => {
      const t = terminals.get(connId)
      if (!t) return err(new Error('终端未打开'))
      t.sshStream?.setWindow?.(rows, cols, cols, rows)
      return { ok: true }
    }),
  )

  ipcMain.handle('terminal:close', (_e, connId: ConnId) =>
    handle(() => {
      const t = terminals.get(connId)
      if (t?.sshStream) t.sshStream.destroy()
      terminals.delete(connId)
      return { ok: true }
    }),
  )

  // ---------- Window controls (custom title bar) ----------
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
