import { useEffect, useRef, useState } from 'react'
import { zhError } from './errors'

/**
 * Poll monitor:collect every 2s for a connection.
 * - Stops automatically when the connection is lost and reports "已断开"
 * - The latest onSnapshot callback is kept in a ref to avoid stale closures
 */
export function useMonitorPoll<T>(
  connId: string,
  onSnapshot: (s: T) => void,
): { error: string | null } {
  const [error, setError] = useState<string | null>(null)
  const cbRef = useRef(onSnapshot)
  cbRef.current = onSnapshot

  useEffect(() => {
    let stop = false
    let busy = false
    let t: ReturnType<typeof setInterval> | null = null
    const tick = async () => {
      if (stop || busy) return
      busy = true
      try {
        const s = (await window.shellpro.monitor.collect(connId)) as T & { skipped?: boolean }
        if (stop || s?.skipped) return
        cbRef.current(s)
        setError(null)
      } catch (e) {
        if (stop) return
        if (/not connected/i.test(String(e))) {
          setError('已断开')
          stop = true
          if (t) clearInterval(t)
        } else {
          setError(`采集失败：${zhError(e)}`)
        }
      } finally {
        busy = false
      }
    }
    void tick()
    t = setInterval(tick, 2000)
    return () => {
      stop = true
      if (t) clearInterval(t)
    }
  }, [connId])

  return { error }
}
