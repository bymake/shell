# ShellPro

开源的 SSH/SFTP 远程服务器管理终端（Electron 桌面客户端）。

## 功能

- SSH 终端：交互式 shell、右键复制/粘贴、标签页管理、多连接并行
- SFTP：目录树 + 文件列表、文本在线编辑保存、上传/下载、随 `cd` 命令联动路径
- 连接管理器：保存/编辑连接，SSH / 串口协议，双击连接，密码加密保存
- 系统监控：CPU / 内存 / 交换、进程、网络、磁盘与实时曲线
- 全中文界面，绿色便携（免安装，单文件约 98MB）

## 构建

```powershell
cd client
npm install
npm run build
npm run build:win
```

产物：`client/release/ShellPro 0.1.0.exe`（便携单文件）。

## 致谢与借鉴

[Electron](https://www.electronjs.org/) · [xterm.js](https://xtermjs.org/) · [ssh2](https://github.com/mscdex/ssh2) · [React](https://react.dev/) · [Vite](https://vite.dev/) · [echarts](https://echarts.apache.org/)

## 协议

[MIT](./LICENSE)
