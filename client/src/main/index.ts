/**
 * Electron 主进程入口
 * - 创建主窗口（无边框，交互全部走自定义标题栏）
 * - 初始化 SQLite、注册 IPC 白名单
 * - 退出时清理 SSH 连接与数据库
 */
import { app, BrowserWindow, Menu } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initStorage, closeStorage } from './storage/index'
import { registerIpc } from './ipc/index'
import { closeAll } from './ssh/index'
import { createLogger } from './logger/index'

const log = createLogger('main')
const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: 'ShellPro',
    frame: false,
    webPreferences: {
      preload: join(__dirname, './index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 开发模式加载 Vite dev server；生产加载打包后的 index.html
  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  initStorage()
  registerIpc(() => mainWindow?.webContents!)
  // 无边框窗口：关闭原生应用菜单，全部交互走自定义标题栏
  Menu.setApplicationMenu(null)
  createWindow()
  log.info('ShellPro app ready')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  closeAll()
  closeStorage()
})
