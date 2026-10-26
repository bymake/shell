/**
 * 统一日志模块（ShellPro）
 * - 统一 logger，控制台输出，带时间戳与级别
 * - 敏感信息脱敏：不明文记录口令、私钥、token
 */
import { inspect } from 'node:util'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

// 需要脱敏的关键字（大小写不敏感匹配）
const SENSITIVE_KEYS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'privatekey',
  'private_key',
  'passphrase',
  'token',
  'authorization',
  'license',
]

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return value
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s))) {
        out[k] = '***REDACTED***'
      } else {
        out[k] = redact(v, depth + 1)
      }
    }
    return out
  }
  return value
}

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      return inspect(redact(a), { depth: 5, colors: false })
    })
    .join(' ')
}

function write(level: LogLevel, scope: string, args: unknown[]): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] [${level.toUpperCase()}] [${scope}] ${format(args)}`
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line)
  else console.log(line)
}

export function createLogger(scope: string) {
  return {
    debug: (...args: unknown[]) => write('debug', scope, args),
    info: (...args: unknown[]) => write('info', scope, args),
    warn: (...args: unknown[]) => write('warn', scope, args),
    error: (...args: unknown[]) => write('error', scope, args),
  }
}

export const logger = createLogger('shellpro')
