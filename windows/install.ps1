# Install the TARX Windows client. The POSIX installer is not this program.
# powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = "Stop"
$repo = if ($env:TARX_INSTALL_REPO) { $env:TARX_INSTALL_REPO } else { "tarx-ai/tarx-cli" }
$ref = if ($env:TARX_INSTALL_REF) { $env:TARX_INSTALL_REF } else { "tarx/windows-ps1" }
$raw = "https://raw.githubusercontent.com/$repo/$ref/windows"
$tempClient = Join-Path $env:TEMP ("tarx-" + [guid]::NewGuid().ToString("n") + ".ps1")
$tempHash = Join-Path $env:TEMP ("tarx-" + [guid]::NewGuid().ToString("n") + ".sha256")
Invoke-WebRequest -Uri "$raw/tarx.ps1" -OutFile $tempClient
Invoke-WebRequest -Uri "$raw/tarx.ps1.sha256" -OutFile $tempHash
$expected = ((Get-Content -LiteralPath $tempHash -Raw).Trim() -split "\s+")[0].ToLowerInvariant()
if ($expected -notmatch "^[0-9a-f]{64}$") { Remove-Item $tempClient, $tempHash -Force; throw "TARX hash file is not a SHA256." }
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $tempClient).Hash.ToLowerInvariant()
if ($actual -ne $expected) { Remove-Item $tempClient, $tempHash -Force; throw "TARX Windows download hash does not match." }
$destDir = Join-Path $env:USERPROFILE ".tarx\bin"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
$dest = Join-Path $destDir "tarx.ps1"
Move-Item -LiteralPath $tempClient -Destination $dest -Force
Remove-Item $tempHash -Force
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $dest /inheritance:r /grant:r "${account}:(R)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not protect the installed client." }
Write-Output "installed $dest"
Write-Output "TARX inference: https://compute.tarx.com"
Write-Output "Start with: powershell -NoProfile -File $dest"
