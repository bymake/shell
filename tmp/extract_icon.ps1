# 从 electron.exe 提取原子图标资源，组装为 build/icon.ico
# 输出：D:\github\shell\build\icon.ico（16/32/48 BMP + 256 PNG）
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IconRes3 {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr LoadLibraryEx(string file, IntPtr h, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool FreeLibrary(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr FindResource(IntPtr h, IntPtr name, IntPtr type);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr LoadResource(IntPtr h, IntPtr res);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr LockResource(IntPtr res);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint SizeofResource(IntPtr h, IntPtr res);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool EnumResourceNames(IntPtr h, IntPtr type, EnumResProc callback, IntPtr lparam);
  public delegate bool EnumResProc(IntPtr h, IntPtr type, IntPtr name, IntPtr lparam);
}
"@

function ReadU16([byte[]]$b, [int]$o) { return ([int]$b[$o]) -bor ([int]$b[$o+1] -shl 8) }
function ReadU32([byte[]]$b, [int]$o) { return ([int]$b[$o] -shl 24) -bor ([int]$b[$o+1] -shl 16) -bor ([int]$b[$o+2] -shl 8) -bor ([int]$b[$o+3]) }

$exe = 'D:\github\shell\client\node_modules\electron\dist\electron.exe'
$h = [IconRes3]::LoadLibraryEx($exe, [IntPtr]::Zero, 0x2)
if ($h -eq [IntPtr]::Zero) { throw 'LoadLibraryEx failed' }
try {
  $found = New-Object System.Collections.ArrayList
  $cb = [IconRes3+EnumResProc]{
    param($h2, $type, $name, $lparam)
    [void]$found.Add($name)
    return $true
  }
  if (-not [IconRes3]::EnumResourceNames($h, [IntPtr]3, $cb, [IntPtr]::Zero)) { throw 'EnumResourceNames failed' }

  $icons = @()
  foreach ($n in $found) {
    $res = [IconRes3]::FindResource($h, $n, [IntPtr]3)
    if ($res -eq [IntPtr]::Zero) { continue }
    $data = [IconRes3]::LoadResource($h, $res)
    $ptr = [IconRes3]::LockResource($data)
    $size = [IconRes3]::SizeofResource($h, $res)
    $bytes = New-Object byte[] $size
    [Runtime.InteropServices.Marshal]::Copy($ptr, $bytes, 0, $size)
    $w = 0; $hgt = 0; $png = $false
    if ($bytes.Length -ge 24 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47) {
      $png = $true
      $w = ReadU32 $bytes 16; $hgt = ReadU32 $bytes 20
    } elseif ($bytes.Length -ge 40) {
      # RT_ICON BMP：从 BITMAPINFOHEADER 开始；height 字段 = 图高*2（含 AND mask）
      $w = ReadU32 $bytes 4
      $hgt = [Math]::Abs((ReadU32 $bytes 8)) / 2
    }
    if ($w -gt 0 -and $hgt -gt 0) {
      $icons += @{ data = $bytes; w = $w; h = $hgt; png = $png }
      Write-Output ("FOUND " + $w + "x" + $hgt + " png=" + $png + " len=" + $size)
    }
  }
  if ($icons.Count -eq 0) { throw 'no usable icon resource' }

  $sel = @()
  foreach ($t in @(256, 48, 32, 16)) {
    $m = $icons | Where-Object { $_.w -eq $t -and $_.png } | Select-Object -First 1
    if (-not $m) { $m = $icons | Where-Object { $_.w -eq $t } | Select-Object -First 1 }
    if ($m) { $sel += $m }
  }
  if ($sel.Count -eq 0) { throw 'no matching icon size' }

  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sel.Count)
  $offset = 6 + 16 * $sel.Count
  foreach ($m in $sel) {
    $s = $m.data.Length
    $d0 = if ($m.w -ge 256) { 0 } else { $m.w }
    $d1 = if ($m.h -ge 256) { 0 } else { $m.h }
    $bw.Write([Byte]$d0)
    $bw.Write([Byte]$d1)
    $bw.Write([Byte]0); $bw.Write([Byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$s)
    $bw.Write([UInt32]$offset)
    $offset += $s
  }
  foreach ($m in $sel) { $bw.Write($m.data) }
  $bw.Flush()
  $dir = 'D:\github\shell\client\build'
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  $out = Join-Path $dir 'icon.ico'
  [IO.File]::WriteAllBytes($out, $ms.ToArray())
  Write-Output ("ICO_SAVED=" + $out + " entries=" + $sel.Count)
}
finally {
  [IconRes3]::FreeLibrary($h) | Out-Null
}
