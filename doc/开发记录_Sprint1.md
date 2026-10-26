# ShellPro 开发记录 · Sprint 1 启动（2026-10-25）

> 本文记录脚手架搭建、已交付模块、关键决策、运行前置条件与下一步计划。
> 依据 `ShellPro_开发文档.md`（v2 执行版）执行。

## 1. 本次完成内容

### 客户端（`client/`，Electron + Vite + React + TS）
- **脚手架**：Electron 45 / Vite 8 / React 19 / TS 6，`vite-plugin-electron/simple` 打通主进程/预加载/渲染三端构建与热更新；`electron-builder` 三平台打包配置（`electron-builder.yml`）。
- **主进程模块**（`src/main/`）：
  - `logger`：统一日志 + 敏感信息脱敏（口令/私钥/token 一律 `***REDACTED***`）。
  - `storage`：better-sqlite3 建表，严格对齐文档第 6 节 DDL；会话 CRUD。
  - `ssh`：ssh2 引擎，密码/密钥登录、交互 shell、exec、跳板机隧道、并发连接限制（免费版默认 3）。
  - `sftp`：SFTP 目录浏览、流式上传/下载。
  - `pty`：node-pty（Windows 走 ConPTY）本地终端。
  - `ipc`：白名单通道注册，终端数据经 `terminal:data:{connId}` 事件回推。
- **预加载**（`src/preload/`）：`contextBridge` 只暴露 `window.shellpro` 白名单 API，渲染进程不直连 ssh/DB。
- **渲染层**（`src/renderer/`）：会话侧栏（快速连接 + 已保存会话列表）、xterm.js 终端组件（T2-1，FitAddon 自适应、深浅配色）、zustand 状态。

### 云同步后端（`cloud/`，Go + Gin）
- **auth**：注册/登录（bcrypt + JWT v5），`Authorization: Bearer` 中间件。
- **license**：自研 HMAC 签名授权校验，按 license 返回 tier（free/cloud/advanced/pro）。
- **sync**：增量拉取/推送/元信息，change 结构对齐文档第 7 节。
- 内存存储实现，接口化预留 MySQL/Redis 生产替换（`docker-compose.yml` 已含 API+MySQL+Redis 栈）。

## 2. 关键决策（相对文档的落地取舍）
| 文档建议 | 实际落地 | 理由 |
|---------|---------|------|
| `xterm` | `@xterm/xterm` v6 + `@xterm/addon-fit` | `xterm@5` 已官方弃用；v6 为当前维护版，符合"最新"意图 |
| React 18 / TS 5 | React 19 / TS 6（当前最新稳定） | 模板默认最新稳定版，符合文档"最新" |
| MySQL/Redis 后端 | 先内存实现，接口预留 DB | 便于脚手架直接运行与测试；T5-5/T5-7 落库任务再接入 |

## 3. 运行前置条件（⚠ 必须处理）
- **本机缺少 Visual Studio Build Tools**：better-sqlite3 **无 Electron 预编译包**，跑 Electron 必须源码编译 → 需要安装 VS Build Tools 2022（含"C++ 桌面开发"工作负载）。
- node-pty 有 win32-x64 预编译，但同样为 Node ABI；启动 Electron 后也会被 `electron-builder install-app-deps` 重编。
- **装好 Build Tools 后**，在 `client/` 执行 `npm run rebuild`（= `electron-builder install-app-deps`）即可。
- 开发运行：`cd client && npm run dev`。
- 云后端运行：`cd cloud && go run ./cmd/api`（默认 `:8080`，可用 `SHELLPRO_API_ADDR` 覆盖）。

## 4. 已验证
- `client/`：`npm run build`（tsc + vite）通过，三端产物生成（`dist-electron/index.js`、`dist-electron/index.mjs`、`dist/`）。
- `cloud/`：`go build ./...` 通过；API 冒烟测试通过：注册/登录发 JWT、同步推送 `accepted=1`、增量拉取正确、无效授权返回 403。

## 5. 下一步（建议顺序）
1. 安装 VS Build Tools → `npm run rebuild` → 启动 `npm run dev`，连通真实服务器验证 SSH 终端与 SFTP。
2. Sprint 1 余项：会话树/分组/搜索（T1-7）、快捷命令面板（T6-1）、复制粘贴选择（T2-6）。
3. Sprint 2：会话模板/导入导出、跳板/端口转发/复用/自动重连、主题、密钥管理。

## 6. 待用户确认
- **项目正式命名**（当前工作名 ShellPro）——唯一需要用户拍板的决策（文档 14.1），不影响技术执行。

## 7. 绿色版改造（免安装、免编译、直接可运行）
为满足"绿色版 + 不要安装包 + 直接编译"，做了两处关键架构调整：

1. **存储层换 `node:sqlite`**（Node 24 内置，Electron 45 实测可用）：彻底移除 better-sqlite3，不再需要 VS Build Tools 编译原生模块。
2. **node-pty 惰性加载降级**：仅在请求本地终端时动态加载，加载失败时降级报错；远程 SSH 终端走纯 JS 的 ssh2，不受影响。

### 修复：打包后启动崩溃 `__dirname is not defined in ES module scope`
- **现象**：打包后绿色版启动即崩，报 `ReferenceError: __dirname is not defined in ES module scope`。
- **根因**：打包器把 ssh2（纯 JS 但内部用 CJS 的 `__dirname` 定位 `pagent.exe`）内联进了 ESM 主进程 bundle，而 ESM 作用域里 `__dirname` 未定义。
- **修复**：在 `vite.config.ts` 的主进程 `vite.build.rolldownOptions.external` 中外部化 node_modules 依赖（Vite 8 用 `rolldownOptions`，不是 `rollupOptions`），让 ssh2/node-pty 等以 CJS `require` 在运行时加载（CJS 中 `__dirname` 合法）。主进程 bundle 从 440KB 降到约 18KB。
- **⚠️ 外部化范围陷阱**：外部化函数不能无差别外部化所有非 `.`/`/` 前缀模块——rolldown 会把相对导入解析成绝对路径（如 `D:/.../src/main/storage/index.ts`），不以 `.` 开头而被误外部化，导致产物 `index.js` 残留 `import "./storage/index.ts"` 源码引用，便携版运行时抛 `ERR_MODULE_NOT_FOUND`。**正确做法**：只外部化"裸包名 + 解析进 node_modules 的路径"，项目内相对/绝对源码路径必须照常打包。
- **验证**：便携版与免安装目录版均启动 8~10 秒无崩溃、窗口正常。

### 修复：连接报错 `TypeError: Cannot read properties of undefined (reading 'conn')`
- **现象**：能进界面、能点连接，但一连接就报 `Cannot read properties of undefined (reading 'conn')`。
- **根因**：preload 被 vite-plugin-electron 输出成 ESM（`.mjs`），但内容却是 CJS 写法 `require("electron")`。ESM 作用域里 `require` 未定义，preload 一加载就抛错 → `window.shellpro` 从未暴露 → `window.shellpro.conn` 是 undefined。
- **修复**：preload 强制以 CJS 输出（`output.format:'cjs'` + `entryFileNames:'[name].cjs'`），主进程 preload 路径改引 `./index.cjs`。`require("electron")` 在 CJS 中合法，`window.shellpro` 正常暴露。
- **验证**：临时 Electron 主进程加载同一 preload，渲染层 `executeJavaScript` 实测 `window.shellpro.conn.create` 为 function。

### 中文化（所有菜单、报错、提示均为中文）
- 主进程新增中文应用菜单：文件（新建连接/退出）、编辑（撤销/重做/剪切/复制/粘贴/全选）、视图（重新加载/开发者工具/放大/缩小/全屏）、帮助（关于）。
- 渲染层新增 `lib/errors.ts` 中文错误映射：将底层英文错误（超时/拒绝/认证失败/主机不可达等）翻译为中文；store 各 catch 全部改走该映射。
- 终端提示改为中文（`[会话已断开]`、`[正在连接...]`）；菜单「新建连接」→ 聚焦主机输入框。

### 绿色版产物
- 单文件便携版：`client/release/ShellPro 0.1.0.exe`
- 免安装目录：`client/release/win-unpacked/ShellPro.exe`（整个文件夹拷走即用）
- `electron-builder.yml`：`npmRebuild: false`（跳过原生重编译）、win target 为 `portable` + `dir`（无 nsis 安装包）。

## 8. 连接管理器 / 分栏 / 进程top（2026-10-25 第二批次）
按 FinalShell 交互改造，四项全部落地：

1. **侧栏精简**：移除"会话"列表块与"当前连接"块；顶部加「连接管理器」按钮；快速连接 + 监控面板保留。
2. **连接管理器弹窗**（`ConnManager.tsx`，菜单「文件→新建连接」打开）：
   - 左侧：会话列表（搜索 / 显示已删除 / 连接后关闭窗口），双击行连接，底部「新建连接」。
   - 右侧：协议选择（SSH/SFTP/Telnet/串口）+ 常规/认证/高级 三个 tab。
   - 常规：名称/主机/端口/备注；认证：方法(密码/私钥)/用户名/密码/私钥(浏览)；高级：智能加速/启用Exec Channel/关闭后无法监控。
   - 底部：确定（保存并关闭）/ 应用（保存）/ 连接 / 取消。密码以 base64 混淆存入 `password_enc`。
3. **进程top弹窗**（`TopModal.tsx`）：点击监控面板「进程」块弹出完整进程表（PID/用户/CPU%/内存%/命令，可按列排序 + 过滤，2 秒刷新）。
4. **主区 SSH/SFTP 上下分栏**：SSH 终端在上、SFTP 文件面板在下，可拖拽分隔条调整占比；SFTP 支持目录浏览/上级/双击进入/上传/下载。

**存储层扩展**：`sessions` 表经 ALTER 迁移新增 `remark/deleted/private_key_path/smart_accel/exec_channel/monitor_disabled` 列；新增 `getSession/updateSession/softDeleteSession/restoreSession`，`listSessions` 支持搜索与 `includeDeleted`。新增 IPC：`session:get/update/softDelete/restore`、`dialog:openKeyFile/openFile/saveFile`。

## 9. 侧栏纯监控 + 交互增强（2026-10-25 第三批次）
1. **侧栏纯监控**（对齐 FinalShell 图1）：彻底移除"会话"标题与快速连接表单；连上后侧栏即监控面板（同步状态/IP+复制、系统信息 运行/负载、CPU/内存/交换 进度条、进程、网络↑↓、磁盘 可用/大小）；未连接时显示"打开连接管理器"入口。
2. **SSH 右键复制/粘贴**：选中文本右键「复制」（剪贴板经主进程读写）；任意位置右键「粘贴」直接输入终端。
3. **SSH `cd` → SFTP 联动**：在 SSH 终端输入 `cd` 命令按回车后，SFTP 面板自动切换同路径（支持 `cd ..`、绝对路径、相对路径）。
4. **SFTP 增强**：
   - 去掉"SFTP"标题文字；
   - 列表分类排序：目录在前、文件在后，各自按名称；
   - 文本文件右键「在线编辑」→ 弹出编辑器，保存直接写回远程文件（新增 `sftp:readText/writeText`）；
   - 工具栏改为：刷新 / 上级路径 / 上传 / 下载。
5. **新增剪贴板 IPC**：`clipboard:readText/writeText`（主进程 Electron clipboard）。


## 第六批（终版）：连接交互 + 清理
- 连接管理器列表行**双击 = 连接**（`onDoubleClick` → `connectSession`，用解密密码直连，串口拦截提示）
- 密码输入框**恒显 8 个 * **（透明输入 `.pw-real` 捕获按键 + 遮罩 `.pw-mask` 显示 ********，空时显示"加密保存"）
- 侧栏进程网格块**整块任意位置可点**弹出 TopModal（只显示前 5，弹窗按 CPU 高→低排序）
- 终端**右键粘贴修复**：右键菜单由 `.terminal-wrap` 内固定定位改为 **portal 渲染到 body**（高 z-index 不受祖先 transform/overflow 限制），并 stopPropagation
- 源码清理：移除已停用的 **telnet 引擎**（net/randomUUID/telnetConns/stripIac/各终端分支）与 **conn:pwd** IPC + preload；execCommand 保留（conn:exec、monitor 仍在用）；tmp 清理过时中间文件；主进程 bundle 28kB→26.7kB

## 源码审计清理（2026-10-25）
逐目录/逐文件审计 `D:\github\shell`，删除与项目无关/残留项：
- `client/public/icons.svg`（Bluesky 社交平台图标，与本项目无关）
- `client/src/renderer/assets/`（hero.png、react.svg、vite.svg，Vite 模板遗留，全项目零引用）
- `client/src/main/auth/`、`client/src/main/sync/`（空目录残留）
- `client/README.md` 由 Vite 模板说明改写为 ShellPro 项目 README
保留：client/（Electron）、cloud/（Go 后端）、doc/、tmp/、.gitignore、各配置文件。删除后 `npm run build` 通过。

## 第七批：生产级逐文件逐行审计清理（2026-10-25）
按用户要求"全量逐个文件夹/逐个文件/逐行代码、生产级审计式清理删除"，在上一批目录级清理基础上再次逐行审计 `client/src` 全部源码，共 12 个文件重写/精简 + 1 个模块目录删除 + 2 个配置文件清理，删除全部死代码后重新编译打包：

### 主进程（src/main/）
| 文件 | 删除内容 |
|-----|---------|
| `ipc/index.ts` | 死通道 `conn:list/exec/limit`、`session:softDelete/restore`、`dialog:openKeyFile`、`group:*/quickcmd:*/setting:*` 全套、`win:toggleDevTools`；`TerminalEntry.kind/pty` 字段与全部 pty 分支（open 去 mode 参数、input/resize/close 去 pty 分支）；注释/空行清理；`session:list` 签名去 `includeDeleted`；关于文案去"Telnet"字样 |
| `preload/index.ts` | 未用的 `SessionApi` 导出；`conn.list/exec/limit`、`session.softDelete/restore`、`dialog.openKeyFile`、`group/quickcmd/setting` 整段、`window.toggleDevTools`；`terminal.open` 去 `mode` 参数 |
| `ssh/index.ts` | **整体重写精简**：删跳板机（forwardOut+sock 隧道）、并发限制（`setConcurrencyLimit/getConcurrencyLimit/listConnections/activeCount/shellCount`）、旧 ConnectConfig 落地；保留纯密码/密钥连接 + openShell/execCommand |
| `sftp/index.ts` | 删 `TransferProgress` 接口与 upload/download 的 `onProgress` 回调参数（渲染层无调用方） |
| `monitor/index.ts` | 删 `closeMonitor`（无调用方）；`ps \| head -n 12` 改全量进程采集（TopModal 需显示全部） |
| `storage/index.ts` | `Protocol` 收窄为 `'ssh'\|'serial'`；删 `softDeleteSession/restoreSession`、`listGroups/createGroup`、`listQuickCommands/createQuickCommand/deleteQuickCommand`、`getSetting/setSetting`；`getDb` 去 export |
| `logger/index.ts` | 删无人引用的 `export const logger` |
| `main/index.ts` | 原生应用菜单删 `{ role: 'toggleDevTools', label: '开发者工具' }` |
| `pty/` 目录 | **整体删除**（ipc 已无引用、本地终端功能未上线） |

### 渲染层（src/renderer/）
| 文件 | 删除内容 |
|-----|---------|
| `App.tsx` | 删 `activeProto` 变量、`activeProto === 'telnet'` 死分支、`TerminalView` 的 `mode="ssh"` 参数 |
| `components/Terminal.tsx` | 删 `Props.mode`、"本地 PTY"注释、冗余"断开"按钮（右上 ✕ 与 tab ✕ 重复）及组件内 `disconnect` store 引用 |
| `state/sessionStore.ts` | **整体重写精简**：`Session` 接口收窄（去 auth_type/private_key_path/smart_accel/exec_channel/monitor_disabled/deleted/password_enc，保留 password?）；`ActiveConn.protocol` 收窄 `'ssh'\|'serial'`；删 `addSession/deleteSession/connectById`、connect 的 `save` 分支、telnet 协议分支 |
| `components/ConnManager.tsx` | 头注释更新；`Protocol` 去 telnet；select 的 telnet 兼容分支收窄；串口报错文案去"请先用 SSH 或 Telnet"；save 去重条件去 `!s.deleted`；connect 调用去 `save: false`；行 class 去 `deleted` |
| `components/SftpPanel.tsx` | 删恒 false 表达式 `onKeyDown={e => e.key === 'Enter' && sftpPath !== sftpPath && undefined}`、无用 `listRef` ref 绑定 |
| `components/TopModal.tsx` | 删 `slice(0, 200)` 进程截断（显示全部进程，CPU 高→低） |
| `App.css` | 删 `.session-empty`、`.terminal-close(.hover)`、`.cm-row.deleted`、`.telnet-only` 残留样式 |

### 配置与依赖
- `package.json`：**dependencies 移除 node-pty**（源码已无引用），仅剩 ssh2；渲染层依赖全部在 devDependencies（体积优化措施，保持不变）
- `electron-builder.yml`：asarUnpack 删 `node_modules/node-pty/**`，仅留 `**/*.node`；注释同步
- `npm install` 更新 package-lock（removed 2 packages）

### 编译/体积/冒烟验证
- `npm run build`（tsc + vite）通过，主进程 bundle 28kB→**20.85kB**
- `npm run build:win` 打包成功；产物体积：**portable 单文件 98.4MB**（上一版 99.8MB）、**win-unpacked 238.2MB**（上一版 ~321MB）、app.asar **1.9MB**
- 冒烟：win-unpacked 启动 12 秒+稳定存活（4 进程、~316MB 内存），无崩溃
- cloud/ Go 后端本轮全量审计无死代码（GBK 编码源文件未改动）


## 第八批：终端 pwd 联动修复 + 原生菜单清理（2026-10-25）
### 1. SSH 输入后不再显示 pwd
- 现象：`cd /` 后终端自动出现 `pwd` 回显与输出（截图），用户不接受。
- 根因：pwd 回显数据经主进程数据流到达，解析逻辑却放在 `term.onData`（用户输入路径），既收不到回显导致 **SFTP 路径从未同步**（第 5 批修复未真正生效），也无法过滤显示。
- 修复（`Terminal.tsx` 重写数据接收路径）：
  - 捕获解析移到 `terminal.onData(connId, ...)` 主进程数据流：cd/sudo/su 回车后注入 `pwd\r`，数据流侧按行状态机（echo→path→pass）解析。
  - **回显过滤**：`pwd` 回显行与路径输出行在写入 xterm 前丢弃，用户终端看不到 pwd；提示符等普通行照常显示。
  - 命中路径行（以 `/` 开头且不含 `@`）→ `sftpNavigate(path)` 真正触发 SFTP 面板同步加载。
  - 2 秒超时兜底：捕获失败时剩余内容照常显示，不阻塞终端。

### 2. 原生应用菜单清理（`main/index.ts`）
- 窗口为 `frame: false` 无边框，原生菜单栏不可见；新建连接/重新加载/帮助/关于/退出已全部由自定义标题栏 `tb-menu` 覆盖，`buildMenu()` 属死代码。
- 删除 `buildMenu()` 函数、`dialog`/`MenuItemConstructorOptions` 引用，改为 `Menu.setApplicationMenu(null)`（杜绝 Alt 弹出默认菜单）。
- 主进程 bundle 20.85kB→19.32kB。

### 验证
- `npm run build` 通过；重新打包成功；win-unpacked 冒烟 13 秒+稳定存活（4 进程 ~318MB）。
## 第九批：SFTP 通道耗竭修复 + 右键粘贴终极修复（2026-10-26）
1. **Channel open failure 根因修复**：SFTP 每次操作（列目录/上级/切路径）都新建子系统通道且从不关闭 → 服务器通道数爆满 → 后续所有新通道（monitor:collect、sftp.list、切路径）被服务器拒绝。修复：`sftp/index.ts` 新增 `sftpSessions` Map，每连接复用单条 SFTP 通道，`end/close` 事件自清理；导出 `closeSftp(connId)`，`conn:close` 时显式关闭；`monitor:collect` 加防重入（进行中返回 `{skipped:true}`），MonitorPanel 同步忽略。
2. **右键粘贴终极修复（用户验收通过）**：定位到 Ctrl+V 有效实为 xterm 内置原生粘贴（浏览器 paste 事件通道），与主进程 clipboard 无关——主进程 clipboard 在该环境始终读空（readText/readBuffer/read 三级全空，IPC 兜底均失效）。重写 `doPaste`：通道1 `navigator.clipboard.readText()`（与原生粘贴同源，可靠）；通道2 主进程 IPC 兜底。Ctrl+V 分支不再调 doPaste，直接 `return false` 交给 xterm 原生处理（消除误报）。右键菜单按钮改 `div[data-act]` + 菜单容器 mousedown/pointerdown/click 三通道代理分发（300ms 防抖），彻底不依赖按钮自身事件。
3. 验证：build 通过；portable 98.4MB；win-unpacked 冒烟 9 秒 4 进程存活。
## 第十批：portable 图标统一 + 列表视图 16px 修复（2026-10-26）
1. **目标**：ShellPro 0.1.0.exe（portable）与 shellpro.exe（win-unpacked）图标完全一致（Electron 默认原子图标），且 shellpro.exe 图标不动。
2. **失败路径（已弃用）**：
   - 单条目（仅 256 PNG）icon.ico：打包成功、中/大图标正常，但资源管理器**列表视图（16x16）显示走样**（系统从 256 缩放，无原生 16px）。
   - 混合条目（16/32/48 BMP + 256 PNG）：electron-builder resedit 解析失败 RangeError: Invalid typed array length: 18963。
3. **最终方案（已交付）**：从 
ode_modules/electron/dist/electron.exe 提取 256 PNG 原子图标，用 System.Drawing 缩放生成 **16/32/48/256 全 BMP 条目**（BITMAPINFOHEADER 40B + XOR BGRA 行自下而上 + AND mask 全 0），组装 client/build/icon.ico（285,478 B）。resedit 本地验证通过（4 条目：16/32/48/256）。
4. **踩坑**：PowerShell -shl 对 byte 操作数结果仍为 byte、1<<8 溢出截断为 0（必须 [int] 强转）；**函数返回 yte[] 会被管道枚举成 Object[]**，BinaryWriter.Write(byte[]) 实际只写 1 字节（hexdump 见  1-01-01-01）→ 用 eturn , .ToArray() 逗号包装防枚举。
5. **验证**：重打包成功；portable 内嵌 RT_GROUP_ICON 含 16x16/32x32/48x48/256x256 四尺寸（resedit 读 exe 资源确认）；win-unpacked 冒烟 9 秒 4 进程存活。shellpro.exe 图标未改动。