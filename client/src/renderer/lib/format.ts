/** Byte size formatting (shared by monitor/SFTP panels) */
export function fmtSize(n: number): string {
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + 'G'
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'M'
  if (n >= 1024) return (n / 1024).toFixed(1) + 'K'
  return n + 'B'
}
