# Restart the exploration driver with a fresh copy of the project (keeps the isolated profile fresh too).
param([string]$Project = (Join-Path $env:USERPROFILE "Desktop\SR\tiki"), [int]$W = 1920, [int]$H = 1080)
$ui = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $ui
New-Item -ItemType File -Force tests\ui-audit\out\cmd\quit | Out-Null
Start-Sleep 5
Remove-Item -Recurse -Force tests\ui-audit\out\cmd -ErrorAction SilentlyContinue
$tmp = Join-Path $env:LOCALAPPDATA "Temp\xleth-ui-audit"
node tests\ui-audit\copy-project.mjs $Project $tmp
$copy = Join-Path $tmp (Split-Path $Project -Leaf)
Start-Process -FilePath node -ArgumentList 'tests\ui-audit\serve.mjs', $copy, $W, $H -WindowStyle Hidden -RedirectStandardOutput "$tmp\serve.log" -RedirectStandardError "$tmp\serve.err"
"restarted"
