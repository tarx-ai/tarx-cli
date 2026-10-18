# TARX Windows client. Inference is the supercomputer door, not a local port.
# TARX_FRONT_DOOR=1
$ErrorActionPreference = "Stop"
$Auth = if ($env:TARX_AUTH_ORIGIN) { $env:TARX_AUTH_ORIGIN.TrimEnd("/") } else { "https://tarx.com" }
$Door = "https://compute.tarx.com/v1/chat/completions"
$Root = Join-Path $env:USERPROFILE ".tarx"
$CredentialPath = Join-Path $Root "credential"

foreach ($arg in $args) {
  if ("$arg" -match "tarx_cli_") { throw "Refusing a credential on the command line." }
}

function Protect-TarxFile([string]$Path) {
  $account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls $Path /inheritance:r /grant:r "${account}:(R,W)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not protect $Path" }
}

function Read-TarxLine {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { return "" }
  return $line
}

function Get-TarxCredential {
  if (-not (Test-Path -LiteralPath $CredentialPath)) { return $null }
  $value = (Get-Content -LiteralPath $CredentialPath -Raw).Trim()
  if ($value -notmatch "^tarx_cli_[0-9a-f]{64}$") { return $null }
  return $value
}

function Save-TarxCredential([string]$Value) {
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  $temp = Join-Path $Root ("credential." + [guid]::NewGuid().ToString("n"))
  Set-Content -LiteralPath $temp -Value $Value -NoNewline -Encoding ascii
  Protect-TarxFile $temp
  Move-Item -LiteralPath $temp -Destination $CredentialPath -Force
  Protect-TarxFile $CredentialPath
}

function Invoke-TarxJson([string]$Method, [string]$Url, $Body, $Headers) {
  $params = @{ Method = $Method; Uri = $Url; Headers = $Headers; TimeoutSec = 25 }
  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Compress)
  }
  return Invoke-RestMethod @params
}

function Start-TarxSignIn {
  $created = Invoke-TarxJson "POST" "$Auth/api/auth/device" @{} @{}
  $device = [string]$created.device_code
  $url = [string]$created.verification_uri
  if (-not $device -or ($url -notlike "$Auth/auth/device?*" -and $url -notlike "$Auth/agent?cli=*")) {
    Write-Output "Sign-in is unavailable. Try again in a moment."
    return
  }
  Write-Output "Finish signing in in your browser. I'll pick up here when you're done."
  Write-Output $url
  while ($true) {
    $typed = Read-TarxLine
    if ($typed.Trim().ToLowerInvariant() -in @("cancel", "quit", "exit")) {
      Invoke-TarxJson "POST" "$Auth/api/auth/device/cancel" @{ device_code = $device } @{} | Out-Null
      Write-Output "Sign-in cancelled."
      return
    }
    $polled = Invoke-TarxJson "POST" "$Auth/api/auth/device/poll" @{ device_code = $device } @{}
    if ($polled.status -eq "complete" -and $polled.credential) {
      Save-TarxCredential ([string]$polled.credential)
      Write-Output "This computer is connected."
      return
    }
    if ($polled.status -in @("denied", "expired", "canceled")) {
      Write-Output "That sign-in $($polled.status). Run tarx to try again."
      return
    }
  }
}

function Send-TarxTurn([string]$Text) {
  $credential = Get-TarxCredential
  if (-not $credential) {
    Write-Output "Say /signin to connect this computer."
    return
  }
  $headers = @{ Authorization = "Bearer $credential" }
  $reply = Invoke-TarxJson "POST" $Door @{
    model = "tarx/t-supercomputer"
    messages = @(@{ role = "user"; content = $Text })
    max_tokens = 420
  } $headers
  $content = $reply.choices[0].message.content
  if ($content) { Write-Output $content } else { Write-Output "TARX is temporarily unavailable. Try again in a moment." }
}

Write-Output "Welcome to TARX."
Write-Output "You can look around before connecting an account."
Write-Output "/signin     connect this computer"
while ($true) {
  $entered = Read-TarxLine
  if ($null -eq $entered -or $entered -eq "") { continue }
  $low = $entered.Trim().ToLowerInvariant()
  if ($low -in @("/signin", "signin")) { Start-TarxSignIn; continue }
  if ($low -in @("/quit", "quit", "exit")) { break }
  Send-TarxTurn $entered.Trim()
}
