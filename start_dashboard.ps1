$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8765

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    exit 0
}

Start-Process `
    -FilePath "python" `
    -ArgumentList ".\web_dashboard.py" `
    -WorkingDirectory $root `
    -WindowStyle Hidden
