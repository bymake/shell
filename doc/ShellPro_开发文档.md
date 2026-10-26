# ShellPro 完整开发文档（v2 · 执行版）

> **用途**：本文档是**可直接执行**的开发规格书。专业开发 agent / 工程师读完应能按第 3 节功能树、第 10 节任务拆解直接开工，无需再向用户询问技术决策（唯一例外见 14.1）。
> **项目路径**：`D:\github\shell`　**文档**：`D:\github\shell\doc`　**临时脚本**：`D:\github\shell\tmp`
> **对标**：FinalShell（功能 1:1）+ SecureCRT（补充特性）　**日期**：2026-10-25

---

## 0. 文档目的与合规红线（强制，先读）

### 0.1 本版本升级说明（v1 → v2）
v1 为需求草案；v2 补齐三块执行必需内容：
1. **技术栈定稿**（第 2 节，含版本与选型理由，agent 无需再决策）。
2. **完整功能树**（第 3 节，从产品功能递归拆到可执行任务，每个叶子带任务 ID）。
3. **任务拆解**（第 10 节，按 Sprint 给出每个任务的标题、输入、验收标准、依赖）。

### 0.2 合规红线（违反即整体不可交付）
1. **仅功能对齐**，禁止复制 FinalShell / SecureCRT 的专有代码、图标/皮肤/字体素材、逆向产物、授权校验逻辑。
2. **禁止实现任何绕过第三方软件授权/付费校验的机制**；本项目授权体系为**自研原创**。
3. 协议交互基于公开标准（SSH/SFTP/PTY/X11）自行实现或使用**合规开源库**。
4. 所有生成内容 / 临时脚本 / 中间文件一律放 `D:\github\shell\tmp`。

---

## 1. 项目概述

- **定位**：国产跨平台 SSH/SFTP 远程服务器管理终端工具（终端 + 文件传输 + 监控 + 云同步一体）。
- **目标用户**：运维工程师、后端开发者、站长。
- **平台**：Windows 7+ / macOS 11+ / Linux（x86_64 / ARM64 / LoongArch）。
- **授权分层**：免费版 → 云端同步 → 高级版 → 专业版（自研授权）。

### 1.1 竞品对标
| 维度 | 本项目 | FinalShell | SecureCRT | Xshell |
|------|--------|------------|-----------|--------|
| 免费基础版 | ✅ | ✅ | ❌（收费） | ✅（商业版收费） |
| 图形化 SFTP | ✅ | ✅ | 一般 | ❌（需 Xftp） |
| 内嵌监控面板 | ✅ | ✅ | ❌ | ❌ |
| 云端同步 | ✅（付费） | ✅（付费） | ❌ | ❌ |
| 脚本自动化 | ✅ | 高级版 | ✅（VBScript） | ✅（自动化） |
| 多标签/分屏 | ✅ | ✅ | ✅ | ✅ |

---

## 2. 技术栈定稿（本版本最终决策）

> **结论**：桌面客户端选 **方案 A（Electron）**；云同步后端选 **Go**。Agent 按此执行，不再做选型。

### 2.1 桌面客户端
| 层 | 选型 | 版本 | 理由 |
|----|------|------|------|
| 桌面壳 | Electron | 最新稳定 | 跨平台、生态成熟 |
| UI 框架 | React + TypeScript | React 18 / TS 5 | 组件化，贴合现有技术栈 |
| 构建 | Vite | 最新稳定 | 快、HMR |
| 终端渲染 | xterm.js + xterm-addon-fit | 最新 | 终端渲染事实标准 |
| SSH/SFTP | ssh2（npm `ssh2`） | 最新 | 成熟、含 SFTP 流 |
| PTY | node-pty（Windows 走 ConPTY） | 最新 | 伪终端 |
| 本地存储 | better-sqlite3 | 最新 | 同步 API、可靠 |
| 状态管理 | zustand | 最新 | 轻量 |
| UI 组件 | 自研轻量组件 + CSS Modules | — | 避免重依赖 |
| 图表 | echarts | 最新 | 监控曲线 |
| 打包 | electron-builder | 最新 | Win/mac/Linux |
| 图标字体 | 开源（如 lucide） | 最新 | 合规素材 |

### 2.2 云同步后端
| 层 | 选型 | 理由 |
|----|------|------|
| 语言/框架 | Go + Gin | 高并发、与用户 Go 能力契合 |
| 数据库 | MySQL 8 / PostgreSQL | 稳定 |
| 缓存 | Redis | 会话 / JWT 黑名单 |
| 认证 | JWT + bcrypt | 标准 |
| 部署 | Docker + docker-compose | 独立于客户端 |

### 2.3 进程模型
```
主进程 (Electron main) ── 负责：窗口、SSH/PTY/SFTP 引擎、SQLite、原生能力
       │ IPC(contextBridge / ipcMain.handle)
渲染进程 (React renderer) ── 负责：UI、xterm.js、图表、交互
云同步客户端 ── 作为主进程内模块，走 Go 后端 REST API
```
> 所有 SSH/PTY/文件操作放主进程，渲染进程只通过 IPC 调用，保证安全与性能。

---

## 3. 完整功能树（递归到可执行任务）

> 规则：`M-xx`=模块，`x.y`=功能，叶子任务带 `T-` ID，对应第 10 节任务拆解。括号内标注所属授权档：**免**=免费、**云**=云端同步、**高**=高级版、**专**=专业版。

### M-01 连接与会话管理
```
1.1 连接协议
  ├─ SSH 密码登录 (免)                    → T1-1
  ├─ SSH 密钥登录 RSA/ECDSA/Ed25519 (免)  → T1-2
  ├─ SFTP 会话 (免)                       → T1-3
  ├─ FTP (免)                             → T1-4
  ├─ Telnet (免)                          → T1-5
  └─ 串口 COM 终端 (借鉴 SecureCRT)       → T1-6
1.2 会话管理
  ├─ 会话树/文件夹分组/搜索 (免)          → T1-7
  ├─ 会话模板 (免)                        → T1-8
  ├─ 会话导入/导出 (免)                   → T1-9
  └─ 快速连接栏 (免)                      → T1-10
1.3 连接特性
  ├─ 跳板机 / 代理 (免)                   → T1-11
  ├─ 端口转发 本地/远程/动态 (免)         → T1-12
  ├─ 连接复用 (免)                        → T1-13
  └─ 自动重连 (免)                        → T1-14
1.4 多连接
  ├─ 多标签 / 分屏 (免)                   → T1-15
  ├─ 批量连接多服务器 (高)                → T1-16
  └─ 并发连接数限制 免费限3/付费不限 (免/高) → T1-17
```

### M-02 终端
```
2.1 渲染
  ├─ xterm.js 集成 + 自适应 (免)          → T2-1
  ├─ 256色/UTF-8/Unicode/代理 (免)        → T2-2
  ├─ 字体/行高/光标样式 (免)              → T2-3
  ├─ 深/浅主题 + 自定义配色 (免)          → T2-4
  └─ 终端背景图 本机图片 (专)             → T2-5
2.2 交互
  ├─ 复制/粘贴/选择 (免)                  → T2-6
  ├─ 滚动缓冲/搜索终端 (免)               → T2-7
  └─ 右键菜单 (免)                        → T2-8
2.3 历史与输入增强
  ├─ 命令历史 无限制 (高)                 → T2-9
  ├─ 左右键字段级编辑 (专)                → T2-10
  ├─ 快速输入路径 目录/文件选择 (专)      → T2-11
  ├─ 快速输入命令名 联想 (专)             → T2-12
  └─ 路径历史 (高)                        → T2-13
```

### M-03 SFTP 文件传输
```
3.1 基础
  ├─ 目录浏览/拖拽上传下载 (免)           → T3-1
  ├─ 多文件并发传输 (免)                  → T3-2
  ├─ 断点续传 (免)                        → T3-3
  └─ 传输限速 (免)                        → T3-4
3.2 高级
  ├─ 打包传输 自动压缩/解压 (高)          → T3-5
  ├─ 批量多服务器传输 (高)                → T3-6
  ├─ 传输队列/任务面板 (免)               → T3-7
  └─ 本地/远程目录对比 (免)               → T3-8
```

### M-04 监控
```
4.1 基础监控
  └─ CPU/内存/磁盘/网络实时曲线 (免)      → T4-1
4.2 高级网络监控
  ├─ 多接口同时监控速度 (高·A1)           → T4-2
  └─ 按进程监听端口与网络 (高·A3)         → T4-3
4.3 高级进程管理
  └─ 进程详情/连接状态/结束 (高·A4)       → T4-4
4.4 系统信息
  └─ 系统/CPU/内存/磁盘详情 (专·P1)       → T4-5
```

### M-05 云端同步
```
5.1 客户端
  ├─ 登录/登出 (云)                       → T5-1
  ├─ 增量拉取/推送 (云)                   → T5-2
  ├─ 冲突合并 时间戳+字段级 (云)          → T5-3
  └─ 多设备自动同步 (云)                  → T5-4
5.2 后端（独立服务，见第7节API）
  ├─ 账号注册/登录 (云)                   → T5-5
  ├─ 授权校验 (云)                        → T5-6
  └─ 同步 API 增量/推送 (云)              → T5-7
```

### M-06 快捷命令与历史
```
6.1 快捷命令面板
  ├─ 分组/变量/参数 (免)                  → T6-1
  └─ 一键发送/批量发送 (免)               → T6-2
6.2 历史
  ├─ 命令历史 (免/高)                     → T6-3
  ├─ 命令参数历史 (云)                    → T6-4
  └─ 文件路径历史 (云)                    → T6-5
```

### M-07 脚本引擎（借鉴 SecureCRT 脚本）
```
7.1 脚本运行 JS 子集 (高)                  → T7-1
7.2 脚本编辑器 + 调试器 (高)               → T7-2
7.3 自动化 API（登录/执行/等待/断言/文件） → T7-3
```

### M-08 密钥管理
```
8.1 密钥生成/导入/导出 (免)               → T8-1
8.2 密钥加密存储 + 主密码 (免)            → T8-2
```

### M-09 授权体系（自研）
```
9.1 版本分层 免费/云/高/专 (免)            → T9-1
9.2 授权校验 离线签名+在线校验 (免)       → T9-2
9.3 功能门控（按版本启用/禁用）           → T9-3
```

### M-10 设置与主题
```
10.1 全局设置（默认连接参数/字体/快捷键）  → T10-1
10.2 主题管理（内置/自定义/导入）          → T10-2
```

### M-11 平台适配
```
11.1 PTY 适配 ConPTY(Win)/pty(Linux/mac)  → T11-1
11.2 平台差异（路径/换行/权限/系统信息采集）→ T11-2
```

### M-12 串口终端（SecureCRT 借鉴）
```
12.1 串口扫描/波特率/数据位 (免)          → T12-1
12.2 串口终端收发 + 日志 (免)             → T12-2
```

---

## 4. 系统架构（详细）

### 4.1 运行时进程与通信
```
┌─ 渲染进程(Renderer) ─────────────────────────┐
│ React UI · xterm.js · echarts · zustand      │
└───────────────┬──────────────────────────────┘
        contextBridge.invoke('ipc:...')  （安全 IPC，仅白名单通道）
┌───────────────▼──────────────────────────────┐
│ 主进程(Main)                                 │
│  SSH/SFTP 引擎(ssh2) · PTY(node-pty) ·       │
│  SQLite(better-sqlite3) · 云同步客户端 ·      │
│  授权校验 · 监控采集                          │
└───────────────┬──────────────────────────────┘
        HTTPS（REST /api/v1）
┌───────────────▼──────────────────────────────┐
│ 云同步后端 (Go + Gin)                        │
│  JWT认证 · 账号 · 同步 · 授权校验            │
│  MySQL + Redis + Docker                      │
└──────────────────────────────────────────────┘
```

### 4.2 模块依赖图（主进程内）
```
conn ──► ssh/sftp 引擎 ──► PTY
conn ──► storage(SQLite)
monitor ──► ssh 采集通道 ──► echarts(渲染)
cloud-sync ──► storage ──► Go 后端
auth ──► 功能门控 ──► 所有模块
script ──► ssh/sftp/terminal
```
依赖规则：**上层模块只允许依赖下层**；渲染进程不得直连 ssh/存储。

### 4.3 关键流程
- **连接流程**：UI 提交会话 → IPC → conn 建立 SSH（密码/密钥/跳板）→ 打开 PTY → xterm 绑定 → 监控启动采集。
- **文件传输**：UI 选择文件 → IPC → sftp 上传/下载流 → 进度回传 → 完成/断点续传。
- **云同步**：本地变更写库置 `sync_flag` → 定时/手动推送增量 → 拉取远端增量 → 冲突合并 → 落库。

---

## 5. 模块详细设计（实现级）

> 每个模块给出：职责、核心接口、关键实现点、依赖、验收标准（对应第 10 节）。

### 5.1 conn（连接与会话）— 任务 T1-*
**核心接口（主进程）**
```ts
// ipcMain.handle 注册
'conn:create'(opts: ConnOptions): Promise<ConnId>
'conn:list'(): Promise<Session[]>
'conn:delete'(id): Promise<void>
'conn:forward'(id, kind: 'local'|'remote'|'dynamic', cfg): Promise<void>
'conn:limit'(count): Promise<boolean>   // 免费限3并发
```
**关键实现**
- ssh2 `Client` + `exec`/`shell`；SFTP 用 `client.sftp()`。
- 密钥：RSA/ECDSA/Ed25519，`KeyPair` 支持。
- 跳板：ssh2 支持 `sock` 参数走隧道链。
- 连接复用：同一会话共享控制连接。
**验收**：能建密码/密钥会话；并发限制生效（免费=3）；端口转发三类可用。

### 5.2 terminal（终端）— 任务 T2-*
**关键实现**
- `Terminal.from(xterm)` 绑定 PTY 流；`xterm-addon-fit` 自适应。
- ConPTY（Windows）/ node-pty（Unix）。
- 命令历史存 `command_history` 表；输入增强（P3/P4/P5）在主进程做补全数据源，渲染层 UI。
**验收**：中文/UTF-8/256色正常；命令历史无限（高级版）；背景图可设（专业版）。

### 5.3 sftp（文件传输）— 任务 T3-*
**关键实现**
- 上传/下载用 `sftp.createReadStream/createWriteStream`，并发上限可配。
- 断点续传：记录已传偏移，`RESUME` 标志。
- 打包传输（高）：远端执行 `tar czf -` / `zip`，本地 `tar xzf` / `unzip`，通过 SFTP 流中转。
- 批量传输（高）：多会话并发调度。
**验收**：大目录打包传输成功且不卡 UI；断点续传断网后可继续。

### 5.4 monitor（监控）— 任务 T4-*
**关键实现**
- SSH 通道下发自研采集脚本（`cat /proc/stat`、`/proc/net/dev`、`ss -tlnp`、`ps` 等），解析为结构化 JSON。
- 轮询周期：基础 2s / 高级 1s；echarts 实时刷新。
- 多接口监控（A1）：解析 `/proc/net/dev` 逐接口。
- 进程端口（A3）：`ss -tlnp` / `netstat` + `/proc/<pid>` 映射。
- 系统信息（P1）：`/proc/cpuinfo`、`free`、`df`、`uname`。
**验收**：Windows/Linux 下曲线正确；多接口各自曲线；按进程查看端口。

### 5.5 cloud-sync（云端同步）— 任务 T5-*
**关键实现**
- 增量模型：每表 `sync_flag` + `updated_at`；`GET /sync/changes?since=`。
- 冲突合并：按表内主键 + updated_at，后写者胜；列表型字段字段级合并。
- 自动同步：启动/定时/手动触发。
**验收**：两台设备改动后同步一致；冲突不丢数据。

### 5.6 其余模块
- **quickcmd**（T6）：快捷命令面板，支持变量占位 `{host}`、分组、参数历史。
- **script**（T7）：JS 子集沙箱执行；API：`connect()/exec()/waitFor()/upload()/assert()`。
- **keys**（T8）：密钥生成（`ssh-keygen` 等价）、导入导出；私钥用主密码派生密钥 AES 加密存库。
- **auth**（T9）：本地存授权文件，内含签名（自研密钥对）；在线校验走后端；功能门控按版本。
- **settings/theme**（T10）：全局配置 JSON + SQLite settings 表。
- **platform**（T11）：PTY 与系统信息采集的平台差异封装。
- **serial**（T12）：串口用 `serialport` 库，扫描/波特率配置/收发/日志。

---

## 6. 数据模型（完整 DDL）

```sql
PRAGMA foreign_keys=ON;

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER,               -- 会话分组树
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER DEFAULT 22,
  protocol TEXT DEFAULT 'ssh',    -- ssh|sftp|ftp|telnet|serial
  username TEXT,
  auth_type TEXT DEFAULT 'password', -- password|key
  key_id INTEGER,
  proxy_id INTEGER,               -- 跳板/代理
  jump_host TEXT, password_enc TEXT,
  charset TEXT DEFAULT 'utf-8',
  background_pic TEXT,            -- 专业版终端背景
  sync_flag INTEGER DEFAULT 0,
  updated_at TEXT,
  FOREIGN KEY(group_id) REFERENCES session_groups(id)
);
CREATE TABLE session_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, parent_id INTEGER);
CREATE TABLE quick_commands (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, command TEXT, group_id INTEGER, params TEXT, sync_flag INTEGER DEFAULT 0);
CREATE TABLE command_history (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, command TEXT, count INTEGER DEFAULT 1, last_used TEXT, sync_flag INTEGER DEFAULT 0);
CREATE TABLE param_history (id INTEGER PRIMARY KEY AUTOINCREMENT, command_id INTEGER, params TEXT, count INTEGER DEFAULT 1, sync_flag INTEGER DEFAULT 0);
CREATE TABLE path_history (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, count INTEGER DEFAULT 1, sync_flag INTEGER DEFAULT 0);
CREATE TABLE ssh_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type TEXT, public_key TEXT, private_key_enc TEXT, passphrase_enc TEXT);
CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE sync_meta (id INTEGER PRIMARY KEY, device_id TEXT, last_pull_ts TEXT, last_push_ts TEXT);
```
> 云同步表（sessions/quick_commands/command_history/param_history/path_history）统一带 `sync_flag`（0=未同步/1=已同步/2=待删）与 `updated_at`。

---

## 7. 云同步后端 API（完整设计）

基础路径 `/api/v1`，认证 `Authorization: Bearer <JWT>`。

| 方法 | 路径 | 说明 | 请求/响应 |
|------|------|------|-----------|
| POST | /auth/register | 注册 | `{email,password}` → `{token,user}` |
| POST | /auth/login | 登录 | `{email,password}` → `{token,user}` |
| POST | /auth/license/verify | 授权校验 | `{deviceId,license}` → `{tier}` |
| GET  | /sync/changes?since=&device= | 增量拉取 | → `{changes:[{table,id,op,data,updated_at}],serverTime}` |
| POST | /sync/push | 批量推送 | `{changes:[...]}` → `{accepted,conflicts}` |
| GET  | /sync/meta | 同步元信息 | → `{deviceId,lastTs}` |

**同步 change 结构**
```json
{ "table":"sessions", "id":3, "op":"upsert|delete", "data":{...字段}, "updated_at":"2026-10-25T13:00:00Z" }
```
**冲突合并策略**：服务端与客户端均按 `updated_at` 后写者胜；客户端收到 `conflicts` 后按字段级合并回推。

---

## 8. 前端页面 / 组件清单

| 页面/组件 | 归属模块 | 说明 |
|-----------|----------|------|
| 会话树 Sidebar | M-01 | 分组、搜索、同步状态角标 |
| 连接表单 Modal | M-01 | 协议/主机/认证/跳板 |
| 终端 TabPane | M-02 | xterm + 分屏 |
| 命令补全/路径选择弹层 | M-02(专) | P3/P4/P5 |
| 文件传输面板 | M-03 | 双向树、队列、进度 |
| 监控面板 | M-04 | 多图表 Tab |
| 快捷命令面板 | M-06 | 分组/参数/批量发送 |
| 密钥管理页 | M-08 | 生成/导入/导出 |
| 设置页 | M-10 | 全局/主题/授权状态 |
| 登录/授权页 | M-05/M-09 | 账号与版本 |

---

## 9. 工程脚手架搭建（执行命令）

在 `D:\github\shell` 下执行（临时脚本放 `tmp\`）：
```bash
# 脚手架（Electron + Vite + React + TS）
npm create vite@latest client -- --template react-ts
cd client
npm i electron electron-builder -D
npm i xterm @xterm/addon-fit ssh2 node-pty better-sqlite3 zustand echarts
npm i -D @types/ssh2 @types/node-pty
# 主进程/预加载/渲染目录
mkdir -p src/main src/preload src/renderer
# 云同步后端（Go）
go mod init github.com/shell/cloud
mkdir -p cmd/api internal/{auth,sync,license}
```
> 目录结构最终形态见第 11 节。

---

## 10. 任务拆解（Sprint + 可执行任务）

> 每个任务：`编号 / 标题 / 输入 / 验收标准 / 依赖`。按依赖顺序执行，先做 M1 基础骨架。

### Sprint 1（骨架 + 连接 + 终端，约 4 周）
| 任务 | 标题 | 验收标准 | 依赖 |
|------|------|----------|------|
| T1-1 | SSH 密码登录 | 输入主机/账号/密码可进入远程 shell | — |
| T1-2 | SSH 密钥登录 | 加载 RSA/ECDSA/Ed25519 私钥可登录 | T1-1 |
| T1-3 | SFTP 会话 | 可打开 sftp 连接并列出远端目录 | T1-1 |
| T2-1 | xterm 集成 | 终端渲染正常、自适应窗口 | T1-1 |
| T2-6 | 复制/粘贴/选择 | 三平台快捷键可用 | T2-1 |
| T11-1 | PTY 适配 | Win(ConPTY)/Linux/mac 均出交互 shell | T2-1 |
| T1-7 | 会话树/分组/搜索 | 可新建/分组/搜索会话并保存 | T1-1,T6-1 |
| T6-1 | 快捷命令面板 | 分组/变量占位/一键发送 | T1-1 |

### Sprint 2（会话管理 + 存储 + 主题，约 3 周）
| 任务 | 验收标准 | 依赖 |
|------|----------|------|
| T1-8/9 | 会话模板、导入导出 | 模板可套用；导出 JSON/导入还原 | T1-7 |
| T1-11/12/13/14 | 跳板/端口转发/复用/自动重连 | 三类转发可用；断线自动重连 | T1-1,T1-2 |
| T2-2/3/4 | 256色/字体/主题 | 深浅色+自定义配色生效 | T2-1 |
| T8-1/2 | 密钥管理 + 加密存储 | 生成/导入/导出；私钥加密落库 | T1-2 |
| T10-1 | 全局设置页 | 默认参数/快捷键可配置 | T1-7 |

### Sprint 3（SFTP + 基础监控，约 3 周）
| 任务 | 验收标准 | 依赖 |
|------|----------|------|
| T3-1/2 | 拖拽传输 + 多文件并发 | 双向拖拽可用、并发不卡 UI | T1-3 |
| T3-3/4 | 断点续传 + 限速 | 断网续传不重传；限速生效 | T3-1 |
| T3-7 | 传输队列/任务面板 | 任务列表、进度、取消 | T3-1 |
| T4-1 | 基础监控曲线 | CPU/内存/磁盘/网络实时曲线 | T1-1 |
| T6-3 | 命令历史 | 记录并快速回填 | T2-1 |

### Sprint 4（高级版功能，约 4 周）
| 任务 | 验收标准 | 依赖 |
|------|----------|------|
| T3-5 | 打包传输 | 大量小文件压缩后传输、自动解压 | T3-1 |
| T3-6 | 批量多服务器传输 | 多会话并发推送 | T1-16 |
| T4-2/3 | 多接口监控 + 进程端口 | 多接口曲线；按进程查端口 | T4-1 |
| T4-4 | 高级进程管理 | 进程详情/连接/结束 | T4-1 |
| T2-9 | 无限命令历史 | 历史不截断 | T6-3 |

### Sprint 5（云端同步，约 3 周）
| 任务 | 验收标准 | 依赖 |
|------|----------|------|
| T5-5 | 后端账号注册/登录 | 注册登录发 JWT | — |
| T5-6 | 授权校验 | 按 license 返回 tier | T5-5 |
| T5-7 | 同步 API | 增量拉取/推送/冲突 | T5-5 |
| T5-1/2 | 客户端登录 + 增量同步 | 登录后可拉/推变更 | T5-7 |
| T5-3/4 | 冲突合并 + 多设备 | 双设备改动最终一致 | T5-2 |
| T6-4/5 | 参数历史/路径历史同步 | 各同步项落库+同步 | T5-2 |

### Sprint 6（专业版 + 脚本 + 串口，约 4 周）
| 任务 | 验收标准 | 依赖 |
|------|----------|------|
| T2-5 | 终端背景图 | 设本机图片为背景 | T2-4 |
| T2-10 | 左右键字段编辑 | 历史命令按字段编辑 | T2-9 |
| T2-11/12 | 快速路径/命令输入 | 窗口选目录文件；命令联想 | T2-1 |
| T4-5 | 系统信息页 | 显示系统/CPU/内存/磁盘详情 | T4-1 |
| T7-1/2/3 | 脚本引擎 | JS 脚本可跑；自动化 API 可用 | T1-1,T3-1 |
| T12-1/2 | 串口终端 | 扫描/波特率/收发/日志 | T2-1 |

### Sprint 7（授权 + 打包 + 收尾，约 3 周）
| 任务 | 验收标准 | 依赖 |
|------|----------|------|
| T9-1/2/3 | 授权分层 + 门控 | 四版本功能正确启停 | T5-6 |
| P 系列 | 专业版门控核对 | 专版专属功能仅专版可用 | T9-3 |
| 打包 | electron-builder 三平台 | Win/mac/Linux 安装包可装 | 全部 |
| 测试 | 三平台回归 | 见第 13 节 | 全部 |

---

## 11. 完整目录结构（目标形态）

```
shell/
├── doc/                    # 文档
├── tmp/                    # 临时脚本/中间文件（强制）
├── client/                 # Electron 客户端
│   ├── src/
│   │   ├── main/           # 主进程: ipc/ssh/sftp/pty/sync/auth/storage
│   │   ├── preload/        # contextBridge 白名单
│   │   └── renderer/       # React: pages/components/state
│   ├── package.json
│   └── electron-builder.yml
└── cloud/                  # 云同步后端
    ├── cmd/api/main.go
    └── internal/{auth,sync,license}
```

---

## 12. 开发规范（强制）

- **命名**：目录/文件 kebab-case；TS 类型 PascalCase；IPC 通道 `模块:动作`。
- **Git**：`main` 保护；功能分支 `feat/T-xx-描述`；提交信息 `T-xx: 标题`；禁止 `--no-verify`、禁止 `--amend` 已有共享提交。
- **IPC 安全**：只暴露白名单通道，校验入参；渲染进程不直连 ssh/DB。
- **错误处理**：主进程统一 `Error` 对象返回 `{code,message}`；不吞异常。
- **日志**：统一 logger，脱敏（不记明文口令/私钥）。
- **安全**：密码/私钥 AES 加密存储；依赖锁定版本；不做命令注入/路径穿越（SFTP 路径校验）。

---

## 13. 测试与质量

| 类型 | 覆盖 |
|------|------|
| 单元 | ssh/sftp/sync/storage/auth 核心逻辑 |
| 集成 | 连真实服务器、传输、监控采集 |
| 跨平台 | Win/macOS/Linux 三平台矩阵（必测） |
| 安全 | 加密存储、IPC 白名单、授权门控、路径校验 |
| 性能 | 高并发连接、大文件打包传输、内存占用 |
| UI | 关键交互（会话树/终端/传输面板） |

---

## 14. 风险与待确认

### 14.1 唯一需要用户确认的决策
1. **项目正式命名**（当前工作名 ShellPro）——不影响技术执行，但影响产品包装，开工前确认一次即可。

### 14.2 风险与对策
| 风险 | 对策 |
|------|------|
| 三平台 PTY/系统信息差异大 | 第 11 节平台适配封装，提前搭 CI 矩阵 |
| SSH 高并发资源占用 | 连接池 + 复用控制通道，性能测试前置 |
| 云同步冲突丢数据 | 时间戳 + 字段级合并，加冲突预览 UI |
| 打包体积大 | 评估 Tauri(方案B) 作为后续优化 |

---

## 15. 里程碑汇总

| 阶段 | 内容 | 周期 |
|------|------|------|
| S1 | 骨架+连接+终端 | 4 周 |
| S2 | 会话+存储+主题 | 3 周 |
| S3 | SFTP+基础监控 | 3 周 |
| S4 | 高级版功能 | 4 周 |
| S5 | 云端同步 | 3 周 |
| S6 | 专业版+脚本+串口 | 4 周 |
| S7 | 授权+打包+测试 | 3 周 |
| **合计** | | **24 周** |

---

*v2 执行版定稿。所有生成内容统一存放 `D:\github\shell\tmp`。*
