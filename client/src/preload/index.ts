/**
 * 预加载脚本（contextBridge）
 * - 只暴露白名单 API 到 window.shellpro
 * - 渲染进程无法直接触达 Node / ssh / DB
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'


const api = {
  menu: {
    onNewConnect: (cb: () => void): (() => void) => {
      const listener = () => cb()
      ipcRenderer.on('menu:new-connect', listener)
      return () => ipcRenderer.removeListener('menu:new-connect', listener)
    },
  },
  conn: {
    create: (opts: Record<string, unknown>) => ipcRenderer.invoke('conn:create', opts),
    close: (connId: string) => ipcRenderer.invoke('conn:close', connId),
  },
  session: {
    create: (s: Record<string, unknown>) => ipcRenderer.invoke('session:create', s),
    list: (opts?: Record<string, unknown>) => ipcRenderer.invoke('session:list', opts),
    get: (id: number) => ipcRenderer.invoke('session:get', id),
    update: (id: number, fields: Record<string, unknown>) => ipcRenderer.invoke('session:update', id, fields),
    delete: (id: number) => ipcRenderer.invoke('session:delete', id),
  },
  dialog: {
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
    saveFile: (defaultName?: string) => ipcRenderer.invoke('dialog:saveFile', defaultName),
  },
  monitor: {
    collect: (connId: string) => ipcRenderer.invoke('monitor:collect', connId),
  },
  sftp: {
    list: (connId: string, path: string) => ipcRenderer.invoke('sftp:list', connId, path),
    upload: (connId: string, localPath: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:upload', connId, localPath, remotePath),
    download: (connId: string, remotePath: string, localPath: string) =>
      ipcRenderer.invoke('sftp:download', connId, remotePath, localPath),
    readText: (connId: string, remotePath: string) => ipcRenderer.invoke('sftp:readText', connId, remotePath),
    writeText: (connId: string, remotePath: string, content: string) =>
      ipcRenderer.invoke('sftp:writeText', connId, remotePath, content),
  },
  clipboard: {
    readText: () => ipcRenderer.invoke('clipboard:readText'),
    writeText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
  },
  window: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    reload: () => ipcRenderer.invoke('win:reload'),
    about: () => ipcRenderer.invoke('win:about'),
    help: () => ipcRenderer.invoke('win:help'),
  },
  serial: {
    listPorts: () => ipcRenderer.invoke('serial:listPorts'),
  },
  terminal: {
    open: (connId: string) => ipcRenderer.invoke('terminal:open', connId),
    input: (connId: string, data: string) => ipcRenderer.invoke('terminal:input', connId, data),
    resize: (connId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:resize', connId, cols, rows),
    close: (connId: string) => ipcRenderer.invoke('terminal:close', connId),
    onData: (connId: string, cb: (data: string) => void): (() => void) => {
      const channel = `terminal:data:${connId}`
      const listener = (_e: IpcRendererEvent, data: string) => cb(data)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (connId: string, cb: (info: { code: number }) => void): (() => void) => {
      const channel = `terminal:exit:${connId}`
      const listener = (_e: IpcRendererEvent, info: { code: number }) => cb(info)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
  },
}

export type ShellProApi = typeof api

contextBridge.exposeInMainWorld('shellpro', api)
