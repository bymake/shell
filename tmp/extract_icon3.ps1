# 从 electron.exe 提取 256 PNG，缩放生成 16/32/48/256 全 BMP 条目，组装 icon.ico
# （resedit 对混合 PNG/BMP 条目解析不稳，全 BMP 最稳）
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IconRes7 {
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

function Get-U32([byte[]]$b, [int]$o) { return ([int]$b[$o] -shl 24) -bor ([int]$b[$o+1] -shl 16) -bor ([int]$b[$o+2] -shl 8) -bor ([int]$b[$o+3]) }

$pngBytes = $null
$hmod = [IconRes7]::LoadLibraryEx('D:\github\shell\client\node_modules\electron\dist\electron.exe', [IntPtr]::Zero, 0x2)
try {
  $found = New-Object System.Collections.ArrayList
  $cb = [IconRes7+EnumResProc]{ param($a,$b,$c,$d) [void]$found.Add($c); return $true }
  [IconRes7]::EnumResourceNames($hmod, [IntPtr]3, $cb, [IntPtr]::Zero) | Out-Null
  foreach ($n in $found) {
    $res = [IconRes7]::FindResource($hmod, $n, [IntPtr]3)
    if ($res -eq [IntPtr]::Zero) { continue }
    $dd = [IconRes7]::LoadResource($hmod, $res); $pp = [IconRes7]::LockResource($dd)
    $sz = [IconRes7]::SizeofResource($hmod, $res)
    $b = New-Object byte[] $sz
    [Runtime.InteropServices.Marshal]::Copy($pp, $b, 0, $sz)
    if ($sz -ge 24 -and $b[0] -eq 0x89 -and $b[1] -eq 0x50 -and $b[2] -eq 0x4E -and $b[3] -eq 0x47) {
      if ((Get-U32 $b 16) -eq 256) { $pngBytes = $b }
    }
  }
  if (-not $pngBytes) { throw '256 png not found' }
}
finally { [IconRes7]::FreeLibrary($hmod) | Out-Null }

function Make-BmpEntry([int]$size, [byte[]]$png) {
  $src = New-Object System.IO.MemoryStream(, $png)
  $bmp = [System.Drawing.Bitmap]::FromStream($src)
  $dst = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($bmp, 0, 0, $size, $size)
  $g.Dispose(); $bmp.Dispose(); $src.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([UInt32]40); $bw.Write([Int32]$size); $bw.Write([Int32]($size * 2))
  $bw.Write([UInt16]1); $bw.Write([UInt16]32); $bw.Write([UInt32]0)
  $bw.Write([UInt32]($size * $size * 4)); $bw.Write([Int32]0); $bw.Write([Int32]0)
  $bw.Write([UInt32]0); $bw.Write([UInt32]0)
  # XOR：行自下而上（GetPixel 逐像素，尺寸小足够快）
  for ($y = $size - 1; $y -ge 0; $y--) {
    for ($x = 0; $x -lt $size; $x++) {
      $c = $dst.GetPixel($x, $y)
      $bw.Write([Byte]$c.B); $bw.Write([Byte]$c.G); $bw.Write([Byte]$c.R); $bw.Write([Byte]$c.A)
    }
  }
  # AND mask（全 0）
  $maskRow = [int]([Math]::Ceiling($size / 32.0)) * 4
  $zeros = [byte[]]::new($maskRow * $size)
  $bw.Write($zeros)
  $bw.Flush()
  return $ms.ToArray()
}

$entries = New-Object System.Collections.ArrayList
foreach ($s in @(16, 32, 48, 256)) {
  $d = Make-BmpEntry $s $pngBytes
  [void]$entries.Add(@{ data = $d; w = $s; h = $s })
  Write-Output ('BMP ' + $s + ' len=' + $d.Length)
}

$ms2 = New-Object System.IO.MemoryStream
$bw2 = New-Object System.IO.BinaryWriter($ms2)
$bw2.Write([UInt16]0); $bw2.Write([UInt16]1); $bw2.Write([UInt16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($m in $entries) {
  $d0 = if ($m.w -ge 256) { 0 } else { $m.w }
  $d1 = if ($m.h -ge 256) { 0 } else { $m.h }
  $bw2.Write([Byte]$d0); $bw2.Write([Byte]$d1)
  $bw2.Write([Byte]0); $bw2.Write([Byte]0)
  $bw2.Write([UInt16]1); $bw2.Write([UInt16]32)
  $bw2.Write([UInt32]$m.data.Length)
  $bw2.Write([UInt32]$offset)
  $offset += $m.data.Length
}
foreach ($m in $entries) { $bw2.Write($m.data) }
$bw2.Flush()
$out = 'D:\github\shell\client\build\icon.ico'
[IO.File]::WriteAllBytes($out, $ms2.ToArray())
Write-Output ('ICO_SAVED=' + $out + ' entries=' + $entries.Count + ' size=' + $ms2.Length)
