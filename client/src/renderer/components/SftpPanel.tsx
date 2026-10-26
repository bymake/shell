/**
 * SFTP 文件面板（主区下方）
 * - 左侧窄目录树（仿 Linux 文件管理器，懒加载、随 sftpPath 联动展开）
 * - 右侧文件列表：目录在前、文件在后，各自按名称排序
 * - 文本文件右键「编辑」→ 在线编辑并写回远程
 * - 工具栏：刷新 / 上级路径 / 上传 / 下载
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShell } from '../state/sessionStore'
import { zhError } from '../lib/errors'
import { EditorModal } from './EditorModal'

interface Entry {
  filename: string
  longname: string
  attrs: { mode: number; size: number; isDirectory: boolean; mtime: number }
}

interface Props {
  connId: string
}

// 目录树节点：children === undefined 表示尚未加载
interface TreeNode {
  name: string
  path: string
  expanded: boolean
  children?: TreeNode[]
}

// 视为文本的扩展名（可右键在线编辑）
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

function fmtSize(n: number): string {
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + 'G'
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'M'
  if (n >= 1024) return (n / 1024).toFixed(1) + 'K'
  return n + 'B'
}

function parentPath(p: string): string {
  if (p === '/' || p === '.') return p
  const parts = p.split('/').filter(Boolean)
  parts.pop()
  return parts.length ? '/' + parts.join('/') : '/'
}

function join(p: string, name: string): string {
  if (p === '/' || p === '.') return '/' + name
  return p.replace(/\/+$/, '') + '/' + name
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

  // ---------- 目录树 ----------
  // 只对未加载节点执行远程 list；children 已存在则直接复用
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

  // 沿 sftpPath 逐级确保节点存在并展开（与 SSH cd / 树点击联动）
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
    // 必须传新引用，否则 React 状态比较跳过重渲染
    if (treeRef.current) setTree({ ...treeRef.current })
  }

  const goNode = async (node: TreeNode) => {
    // 未展开的目录：先展开再进入（进入时 ensurePath 会沿路径联动）
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
              // 阻断 click 冒泡：否则闭合后 click 会落到行上触发 goNode 重新展开
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

  // ---------- 右侧文件列表 ----------
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

  return (
    <div className="sftp-panel">
      <div className="sftp-tree">
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
                {!e.attrs.isDirectory && (
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
