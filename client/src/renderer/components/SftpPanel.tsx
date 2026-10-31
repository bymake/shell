/**
 * SFTP file panel (bottom of the main area)
 * - Left: narrow directory tree (like a file manager; lazy-loaded, expands along sftpPath)
 * - Right: file list (directories first, then files, each sorted by name)
 * - Right-click "Edit" on text files -> online edit and write back to the remote
 * - Toolbar: refresh / parent path / upload / download
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShell } from '../state/sessionStore'
import { zhError } from '../lib/errors'
import { fmtSize } from '../lib/format'
import { parentPath, join } from '../lib/path'
import { EditorModal } from './EditorModal'

interface Entry {
  filename: string
  longname: string
  attrs: { mode: number; size: number; isDirectory: boolean; mtime: number }
}

interface Props {
  connId: string
}

// Tree node: children === undefined means not yet loaded
interface TreeNode {
  name: string
  path: string
  expanded: boolean
  children?: TreeNode[]
}

// Extensions treated as text (right-click for online editing)
const TEXT_EXT = new Set([
  'txt', 'log', 'conf', 'cfg', 'ini', 'sh', 'bash', 'zsh', 'py', 'js', 'ts', 'json',
  'yml', 'yaml', 'md', 'html', 'htm', 'css', 'xml', 'properties', 'env', 'toml',
  'c', 'h', 'cpp', 'go', 'java', 'rb', 'php', 'sql', 'gitignore', 'dockerfile',
])

function isTextFile(name: string): boolean {
  const n = name.toLowerCase()
  if (TEXT_EXT.has(n)) return true
  const ext = n.includes('.') ? n.split('.').pop() : ''
  return !!ext && TEXT_EXT.has(ext)
}

export function SftpPanel({ connId }: Props) {
  const sftpPath = useShell((s) => s.sftpPath)
  const sftpNavigate = useShell((s) => s.sftpNavigate)
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [ctx, setCtx] = useState<{ x: number; y: number; entry: Entry } | null>(null)
  const [edit, setEdit] = useState<Entry | null>(null)
  const [tree, setTree] = useState<TreeNode | null>(null)
  const treeRef = useRef<TreeNode | null>(null)

  const load = useCallback(
    async (p: string) => {
      setLoading(true)
      setError(null)
      try {
        const r = await window.shellpro.sftp.list(connId, p)
        setEntries(r.entries as Entry[])
      } catch (e) {
        setError(zhError(e))
      } finally {
        setLoading(false)
      }
    },
    [connId],
  )

  useEffect(() => {
    void load(sftpPath)
  }, [sftpPath, load])

  // ---------- Directory tree ----------
  // Only list remote dirs for nodes that are not loaded yet; reuse children when present
  const loadNode = useCallback(
    async (node: TreeNode) => {
      if (node.children !== undefined) return
      try {
        const r = await window.shellpro.sftp.list(connId, node.path)
        node.children = (r.entries as Entry[])
          .filter((e) => e.attrs.isDirectory)
          .map((e) => ({ name: e.filename, path: join(node.path, e.filename), expanded: false, children: undefined }))
          .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      } catch {
        node.children = []
      }
    },
    [connId],
  )

  // Ensure nodes exist and expand along sftpPath (syncs with SSH cd / tree clicks)
  const ensurePath = useCallback(
    async (targetPath: string) => {
      if (!treeRef.current) {
        treeRef.current = { name: '/', path: '/', expanded: true, children: undefined }
      }
      const root = treeRef.current
      await loadNode(root)
      const segs = targetPath.split('/').filter(Boolean)
      let cur = root
      for (const seg of segs) {
        await loadNode(cur)
        const child = cur.children?.find((c) => c.name === seg)
        if (!child) break
        child.expanded = true
        await loadNode(child)
        cur = child
      }
      setTree({ ...root })
    },
    [loadNode],
  )

  useEffect(() => {
    void ensurePath(sftpPath === '.' ? '/' : sftpPath)
  }, [sftpPath, ensurePath])

  const lastToggle = useRef(0)
  const toggleNode = async (node: TreeNode) => {
    const now = Date.now()
    if (now - lastToggle.current < 300) return
    lastToggle.current = now
    node.expanded = !node.expanded
    if (node.expanded) await loadNode(node)
    // Must pass a new reference, otherwise React's state comparison skips re-render
    if (treeRef.current) setTree({ ...treeRef.current })
  }

  const goNode = async (node: TreeNode) => {
    // Unexpanded directory: expand first, then enter (ensurePath syncs along the path)
    if (!node.expanded) {
      node.expanded = true
      await loadNode(node)
      if (treeRef.current) setTree({ ...treeRef.current })
    }
    if (node.path !== sftpPath) sftpNavigate(node.path)
  }

  const renderTree = (node: TreeNode, depth: number): React.ReactNode => {
    const pad = depth * 12 + 6
    return (
      <div key={node.path}>
        <div
          className={`tree-row${node.path === sftpPath ? ' active' : ''}`}
          style={{ paddingLeft: pad }}
          onClick={() => void goNode(node)}
          title={node.path}
        >
          <span
            className="tree-arrow"
            onPointerDown={(e) => {
              e.stopPropagation()
              void toggleNode(node)
            }}
            onMouseDown={(e) => {
              e.stopPropagation()
              void toggleNode(node)
            }}
            onClick={(e) => {
              // Block click bubbling: otherwise a click after collapsing lands on the row
              // and triggers goNode, which re-expands the node
              e.stopPropagation()
            }}
          >
            {node.expanded ? '▾' : '▸'}
          </span>
          <span className="tree-name">{node.name}</span>
        </div>
        {node.expanded &&
          node.children?.map((c) => renderTree(c, depth + 1))}
      </div>
    )
  }

  // ---------- Right: file list ----------
  const rows = useMemo(() => {
    const dirs = entries.filter((e) => e.attrs.isDirectory).sort((a, b) => a.filename.localeCompare(b.filename, 'zh'))
    const files = entries.filter((e) => !e.attrs.isDirectory).sort((a, b) => a.filename.localeCompare(b.filename, 'zh'))
    return [...dirs, ...files]
  }, [entries])

  const up = () => {
    const p = parentPath(sftpPath)
    if (p !== sftpPath) sftpNavigate(p)
  }

  const enter = (name: string) => sftpNavigate(join(sftpPath, name))

  const upload = async () => {
    const r = await window.shellpro.dialog.openFile()
    if (!r.path) return
    const name = r.path.replace(/\\/g, '/').split('/').pop()
    const dest = join(sftpPath, name)
    setMsg(`正在上传 ${name} …`)
    try {
      await window.shellpro.sftp.upload(connId, r.path, dest)
      setMsg(`已上传 ${name}`)
      await load(sftpPath)
    } catch (e) {
      setMsg(`上传失败：${zhError(e)}`)
    }
  }

  const downloadSelected = async () => {
    if (!sel) {
      setMsg('请先选择要下载的文件')
      return
    }
    const e = rows.find((x) => x.filename === sel && !x.attrs.isDirectory)
    if (!e) return
    const r = await window.shellpro.dialog.saveFile(e.filename)
    if (!r.path) return
    const src = join(sftpPath, e.filename)
    setMsg(`正在下载 ${e.filename} …`)
    try {
      await window.shellpro.sftp.download(connId, src, r.path)
      setMsg(`已下载 ${e.filename}`)
    } catch (err) {
      setMsg(`下载失败：${zhError(err)}`)
    }
  }

  const onRowContext = (e: React.MouseEvent, entry: Entry) => {
    if (entry.attrs.isDirectory) return
    setSel(entry.filename)
    setCtx({ x: e.clientX, y: e.clientY, entry })
  }

  // Remove a node from the (already loaded) tree after a successful delete, so the
  // left tree stays in sync with the right list without a full reload
  const removeFromTree = (targetPath: string) => {
    const root = treeRef.current
    if (!root) return
    const walk = (nodes: TreeNode[]): boolean => {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]
        if (n.path === targetPath) {
          nodes.splice(i, 1)
          return true
        }
        if (n.children && walk(n.children)) return true
      }
      return false
    }
    if (walk(root.children ?? [])) setTree({ ...root })
  }

  const del = async (name: string) => {
    if (!window.confirm(`确认删除 ${name} ？此操作不可恢复`)) return
    const src = join(sftpPath, name)
    setMsg(`正在删除 ${name} …`)
    try {
      await window.shellpro.sftp.delete(connId, src)
      setMsg(`已删除 ${name}`)
      await load(sftpPath)
      removeFromTree(src)
    } catch (e) {
      setMsg(`删除失败：${zhError(e)}`)
    }
  }

  // Rebuild the left tree from scratch (external changes / manual refresh)
  const refreshTree = () => {
    treeRef.current = null
    setTree(null)
    void ensurePath(sftpPath === '.' ? '/' : sftpPath)
  }

  return (
    <div className="sftp-panel">
      <div className="sftp-tree">
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '4px 8px', borderBottom: '1px solid #21262d', fontSize: 12, color: '#8b949e',
          }}
        >
          <span>目录</span>
          <button className="btn tiny" onClick={refreshTree} title="重新加载目录树">
            ⟳ 刷新
          </button>
        </div>
        {tree ? (
          renderTree(tree, 0)
        ) : (
          <div className="sftp-empty">加载中…</div>
        )}
      </div>

      <div className="sftp-body">
        <div className="sftp-toolbar">
          <input
            className="sftp-path"
            value={sftpPath}
            onChange={(e) => sftpNavigate(e.target.value)}
            onBlur={() => void load(sftpPath)}
          />
          <button className="btn small" onClick={() => void load(sftpPath)}>
            刷新
          </button>
          <button className="btn small" onClick={up}>
            上级路径
          </button>
          <button className="btn small" onClick={() => void upload()}>
            上传
          </button>
          <button className="btn primary small" onClick={() => void downloadSelected()}>
            下载
          </button>
        </div>

        <div className="sftp-list">
          <div className="sftp-row head">
            <span className="fn">名称</span>
            <span className="sz">大小</span>
            <span className="mt">修改时间</span>
            <span className="op">操作</span>
          </div>
          <div className="sftp-row" onClick={up}>
            <span className="fn dir">..</span>
          </div>
          {rows.map((e) => (
            <div
              key={e.filename}
              className={`sftp-row ${e.filename === sel ? 'selected' : ''}`}
              onClick={() => {
                setSel(e.filename)
              }}
              onDoubleClick={() => e.attrs.isDirectory && enter(e.filename)}
              onContextMenu={(ev) => onRowContext(ev, e)}
            >
              <span className={`fn ${e.attrs.isDirectory ? 'dir' : ''}`} title={e.filename}>
                {e.attrs.isDirectory ? '📁 ' : '📄 '}
                {e.filename}
              </span>
              <span className="sz">{e.attrs.isDirectory ? '—' : fmtSize(e.attrs.size)}</span>
              <span className="mt">
                {e.attrs.mtime ? new Date(e.attrs.mtime * 1000).toLocaleString('zh-CN') : '—'}
              </span>
              <span className="op">
                {e.attrs.isDirectory ? (
                  <button className="btn tiny" onClick={() => void del(e.filename)}>
                    删除
                  </button>
                ) : (
                  <>
                    <button className="btn tiny" onClick={() => setEdit(e)}>
                      编辑
                    </button>
                    <button
                      className="btn tiny"
                      onClick={() => {
                        setSel(e.filename)
                        void downloadSelected()
                      }}
                    >
                      下载
                    </button>
                    <button className="btn tiny" onClick={() => void del(e.filename)}>
                      删除
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
          {loading && <div className="sftp-empty">加载中…</div>}
          {!loading && rows.length === 0 && <div className="sftp-empty">空目录</div>}
        </div>
      </div>

      {error && <div className="sftp-err">{error}</div>}
      {msg && <div className="sftp-msg">{msg}</div>}

      {ctx && isTextFile(ctx.entry.filename) && (
        <>
          <div className="ctx-mask" onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null) }} />
          <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }}>
            <button
              type="button"
              className="ctx-item"
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setEdit(ctx.entry)
                setCtx(null)
              }}
            >
              在线编辑
            </button>
          </div>
        </>
      )}

      {edit && (
        <EditorModal
          connId={connId}
          remotePath={join(sftpPath, edit.filename)}
          onClose={() => setEdit(null)}
          onSaved={() => void load(sftpPath)}
        />
      )}
    </div>
  )
}
