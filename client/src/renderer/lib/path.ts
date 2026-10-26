/** Remote path helpers (shared by the terminal and the SFTP panel) */

/** Normalize a path: /a/../b -> /b; drops "." and duplicate slashes */
export function norm(p: string): string {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

/** Parent of a path ('/' and '.' stay unchanged) */
export function parentPath(p: string): string {
  if (p === '/' || p === '.') return p
  const parts = p.split('/').filter(Boolean)
  parts.pop()
  return parts.length ? '/' + parts.join('/') : '/'
}

/** Join a directory path with a child name */
export function join(p: string, name: string): string {
  if (p === '/' || p === '.') return '/' + name
  return p.replace(/\/+$/, '') + '/' + name
}
