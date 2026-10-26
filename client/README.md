# ShellPro

国产 SSH/SFTP 终端工具（对齐 FinalShell/SecureCRT 交互），Electron 桌面客户端 + Go 云同步后端。

## 技术栈
- Electron 45（内置 Node 24 + node:sqlite）/ Vite 8 / React 19 / TypeScript 6
- 终端：@xterm/xterm；SSH/SFTP：ssh2；本地 PTY：node-pty（惰性加载）
- 存储：node:sqlite（会话加密落盘，safeStorage/DPAPI）
- 监控：SSH 采集 bash 脚本按 `--段--` 标记解析 + echarts 曲线

## 目录结构
```
client/   Electron 桌面客户端（绿色版，portable 单文件 ~100MB）
cloud/    Go+Gin 云同步后端（cmd/api + internal/{auth,license,sync}）
doc/      开发文档与开发记录
tmp/      临时脚本与构建日志（勿提交）
```

## 构建与打包
```powershell
cd client
npm install
npm run build        # tsc + vite（渲染层 dist/ + 主进程 dist-electron/）
npm run build:win    # electron-builder 打 portable 单文件 + win-unpacked
```
产物：`client/release/ShellPro 0.1.0.exe`（单文件便携版）与 `client/release/win-unpacked/`（免安装目录）。

## 功能
- SSH 密码/密钥登录、交互 shell；协议下拉：SSH / 串口
- SFTP 文件浏览：分类排序、文本在线编辑保存、cd 联动路径、上传/下载
- 监控侧栏：同步状态 / CPU / 内存 / 交换 / 进程（前 5，整块点击弹全部按 CPU 排序）/ 网络 / 磁盘
- 连接管理器：双击连接、密码恒显 8 星号、加密保存（磁盘无明文）、硬删除
- 终端：右键复制/粘贴、Ctrl+C/V、页头标签关闭、标签栏加号新建连接
