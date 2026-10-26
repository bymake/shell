/**
 * 远程文本在线编辑（SFTP 右键「编辑」）
 * - 读取远程文本 → textarea 编辑 → 保存直接写回远程文件
 */
import { useEffect, useState } from 'react'
import { zhError } from '../lib/errors'

interface Props {
  connId: string
  remotePath: string
  onClose: () => void
  onSaved: () => void
}

export function EditorModal({ connId, remotePath, onClose, onSaved }: Props) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await window.shellpro.sftp.readText(connId, remotePath)
        if (alive) {
          setContent(r.content as string)
          setError(null)
        }
      } catch (e) {
        if (alive) setError(`读取失败：${zhError(e)}`)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [connId, remotePath])

  const save = async () => {
    setSaving(true)
    try {
      await window.shellpro.sftp.writeText(connId, remotePath, content)
      onSaved()
      onClose()
    } catch (e) {
      setError(`保存失败：${zhError(e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal editor-modal">
        <div className="modal-head">
          <h3>在线编辑 {remotePath}</h3>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </div>
        {error && <div className="cm-msg err">{error}</div>}
        {loading ? (
          <div className="editor-loading">加载中…</div>
        ) : (
          <textarea
            className="editor-area"
            spellCheck={false}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        )}
        <div className="cm-foot">
          <button className="btn primary" disabled={saving || loading} onClick={() => void save()}>
            {saving ? '保存中…' : '保存到远程'}
          </button>
          <button className="btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
