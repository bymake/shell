/**
 * Electron main process entry
 * - Create the main frameless window (interactions go through the custom title bar)
 * - Initialize SQLite and register the IPC whitelist
 * - Clean up SSH connections and storage on quit
 */
import { app, BrowserWindow, Menu } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initStorage, closeStorage } from './storage/index'
import { registerIpc } from './ipc/index'
import { initAgentServer, closeAgentServer } from './agent/index'
import { closeAll } from './ssh/index'
import { closeAllTelnet } from './telnet/index'
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

  // Load the Vite dev server in dev mode; load the bundled index.html in production
  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  initStorage()
  registerIpc(() => mainWindow?.webContents!)
  // Start the agent gateway; every agent action is broadcast to the renderer as 'agent:event'
  void initAgentServer((event) => {
    const wc = mainWindow?.webContents
    if (wc && !wc.isDestroyed()) wc.send('agent:event', event)
  })
  // Frameless window: disable the native app menu; all interactions use the custom title bar
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
  closeAgentServer()
  closeAll()
  closeAllTelnet()
  closeStorage()
})
