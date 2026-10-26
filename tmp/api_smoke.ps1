$base = "http://127.0.0.1:18080/api/v1"
$lines = @()
$lines += "=== register ==="
$reg = Invoke-RestMethod -Method Post -Uri "$base/auth/register" -ContentType "application/json" -Body '{"email":"t3@t.com","password":"secret123"}'
$lines += "register user=" + $reg.user.email + " tokenLen=" + $reg.token.Length
$lines += "=== login ==="
$login = Invoke-RestMethod -Method Post -Uri "$base/auth/login" -ContentType "application/json" -Body '{"email":"t3@t.com","password":"secret123"}'
$tok = $login.token
$lines += "login ok tokenLen=" + $tok.Length
$h = @{ Authorization = "Bearer $tok" }
$lines += "=== sync push ==="
$body = '{"changes":[{"table":"sessions","id":1,"op":"upsert","data":{"name":"prod"},"updated_at":"2026-10-25T06:00:00Z"}]}'
$push = Invoke-RestMethod -Method Post -Uri "$base/sync/push" -Headers $h -ContentType "application/json" -Body $body
$lines += "push accepted=" + $push.accepted
$lines += "=== sync changes ==="
$ch = Invoke-RestMethod -Method Get -Uri "$base/sync/changes" -Headers $h
$lines += "changes count=" + @($ch.changes).Count + " serverTime=" + $ch.serverTime
$lines += "=== license verify (bad) ==="
$bad = "abc.def"
try {
  Invoke-RestMethod -Method Post -Uri "$base/auth/license/verify" -ContentType "application/json" -Body (@{deviceId="d1";license=$bad} | ConvertTo-Json) -ErrorAction Stop | Out-Null
  $lines += "bad license ACCEPTED (unexpected)"
} catch {
  $lines += "bad license rejected: " + $_.Exception.Response.StatusCode.value__
}
$lines | Set-Content -LiteralPath "D:\github\shell\tmp\api_test.txt" -Encoding utf8
