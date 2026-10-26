$lines = @()
Set-Location -LiteralPath "D:\github\shell\client"
$mainFile = Get-ChildItem -LiteralPath "dist-electron" -File | Where-Object { $_.Name -like 'index.js' } | Select-Object -First 1
$lines += "main file: " + $mainFile.Name + " size=" + $mainFile.Length
$c = Get-Content -Raw $mainFile.FullName
if ($c.Contains('pagent')) { $lines += 'STILL bundled ssh2 pagent (bad)' } else { $lines += 'no pagent -> ssh2 externalized (good)' }
$lines += "index.js size now: " + $mainFile.Length
# 主入口是否还能正常引用 node:sqlite / electron
$lines += 'node:sqlite ref: ' + $c.Contains('node:sqlite')
$lines += 'electron ref: ' + $c.Contains('electron')
$lines | Set-Content -LiteralPath "D:\github\shell\tmp\ext_check.txt" -Encoding utf8
