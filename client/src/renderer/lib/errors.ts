/**
 * Low-level error -> Chinese message mapping
 * - Errors from the main-process SSH engine are mostly English (TypeError / ETIMEDOUT etc.)
 * - The renderer translates them to Chinese so all messages are localized
 */
export function zhError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // Extract the inner message from the IPC error envelope first (like {"code":"ERR","message":"..."})
  const innerMatch = /"message"\s*:\s*"([^"]+)"/.exec(raw)
  const primary = innerMatch ? innerMatch[1] : raw
  const map: Array<[RegExp, string]> = [
    [/Cannot read properties of undefined \(reading 'conn'\)/i, '连接通道未就绪（预加载脚本未加载成功），请重启应用'],
    [/ERR_MODULE_NOT_FOUND/i, '模块未找到（打包文件缺失），请重新安装'],
    [/ENOTFOUND|getaddrinfo/i, '无法解析主机名 / 域名不存在'],
    [/ETIMEDOUT|timed out/i, '连接超时，请检查主机可达性与防火墙'],
    [/ECONNREFUSED/i, '连接被拒绝，目标端口未开放或服务未启动'],
    [/EHOSTUNREACH/i, '主机不可达，请检查网络与路由'],
    [/ENETUNREACH/i, '网络不可达'],
    [/EACCES/i, '权限不足'],
    [/no such file|ENOENT/i, '目录或文件不存在（可能无访问权限）'],
    [/authentication failed|all configured authentication methods failed/i, '认证失败：用户名或密码错误，或需改用密钥登录'],
    [/permission denied \(publickey|publickey/i, '密钥认证失败，请检查密钥，或改用密码登录'],
    [/no matching.*(cipher|key exchange)|unsupported cipher|algorithm negotiation/i, '加密/密钥交换算法协商失败，两端协议不兼容'],
    [/not connected/i, '已断开'],
    [/connection is closed by ssh server|closed by ssh server/i, '服务器关闭了连接：可能是协议/算法不兼容，请尝试选择 SSH2 协议'],
    [/no connection available|concurrency|连接数已达上限/i, '连接数已达上限，请稍后再试'],
    [/not an interactive shell|exec.*shell/i, '目标端不支持交互式 shell'],
    [/sftp.*(not supported|subsystem)|request for subsystem.*failed/i, '目标端未开启 SFTP 子系统'],
  ]
  for (const [re, zh] of map) {
    if (re.test(primary)) return zh
  }
  // No match: take the first line (strip stack noise) and prefix a Chinese label
  const firstLine = primary.split('\n')[0]?.trim() || primary
  return `操作失败：${firstLine}`
}
