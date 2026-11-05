<#
.SYNOPSIS
  Installs pos-api as a Windows service (NSSM) on the counter PC: auto-start on
  boot, restart on crash, data folder readable only by the service account.

.EXAMPLE
  # From an elevated PowerShell in the repository root, after `npm ci; npm run build`:
  .\deploy\windows\install-service.ps1 -DataDir C:\DhabaPOS\data -LanIp 192.168.1.20 -WebDir C:\DhabaPOS\web

.NOTES
  Needs nssm.exe on PATH (https://nssm.cc) and Node 20. Re-running updates the service.
#>
param(
  [string]$ServiceName = "DhabaPOS",
  [string]$AppDir = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [Parameter(Mandatory = $true)][string]$DataDir,
  # The counter PC's LAN address (reserve it in the router's DHCP). Empty = the server picks the first private address.
  [string]$LanIp = "",
  [int]$Port = 80,
  [string]$WebDir = "",
  [string]$SheetPassword = "",
  [string]$TlsCertFile = "",
  [string]$TlsKeyFile = "",
  [string]$OffsiteBackupDir = ""
)
$ErrorActionPreference = "Stop"

$node = (Get-Command node.exe).Source
$nssm = (Get-Command nssm.exe).Source
$main = Join-Path $AppDir "apps\pos-api\dist\main.js"
if (-not (Test-Path $main)) { throw "Build first: npm ci; npm run build ($main missing)" }
if (-not $SheetPassword) { $SheetPassword = [Guid]::NewGuid().ToString("N") }

# 1. Data folder: only the service account (LocalService) and Administrators.
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$account = "NT AUTHORITY\LocalService"
icacls $DataDir /inheritance:r /grant:r "${account}:(OI)(CI)M" /grant:r "BUILTIN\Administrators:(OI)(CI)F" /T | Out-Null
Write-Host "Data folder $DataDir is readable only by $account and Administrators."

# 2. Service: auto-start on boot, restart after a crash, logs next to the data folder.
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $existing) { & $nssm install $ServiceName $node $main | Out-Null }
& $nssm set $ServiceName Application $node | Out-Null
& $nssm set $ServiceName AppParameters "`"$main`"" | Out-Null
& $nssm set $ServiceName AppDirectory $AppDir | Out-Null
& $nssm set $ServiceName ObjectName $account | Out-Null
& $nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $nssm set $ServiceName AppExit Default Restart | Out-Null
& $nssm set $ServiceName AppRestartDelay 3000 | Out-Null
$logDir = Join-Path (Split-Path $DataDir -Parent) "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
icacls $logDir /grant "${account}:(OI)(CI)M" | Out-Null
& $nssm set $ServiceName AppStdout (Join-Path $logDir "pos-api.log") | Out-Null
& $nssm set $ServiceName AppStderr (Join-Path $logDir "pos-api.log") | Out-Null
& $nssm set $ServiceName AppRotateFiles 1 | Out-Null
& $nssm set $ServiceName AppRotateBytes 10485760 | Out-Null

$envLines = @(
  "DEPLOY_PROFILE=lan",
  "PORT=$Port",
  "DATA_DIR=$DataDir",
  "WORKBOOK_SHEET_PASSWORD=$SheetPassword"
)
if ($LanIp) { $envLines += "HOST=$LanIp" }
if ($WebDir) { $envLines += "WEB_DIR=$WebDir" }
if ($TlsCertFile) { $envLines += @("TLS_CERT_FILE=$TlsCertFile", "TLS_KEY_FILE=$TlsKeyFile", "HTTP_REDIRECT_PORT=80") }
if ($OffsiteBackupDir) { $envLines += "OFFSITE_BACKUP_DIR=$OffsiteBackupDir" }
& $nssm set $ServiceName AppEnvironmentExtra $envLines | Out-Null

# 3. Firewall: allow the port only from the private (LAN) network profile.
$rule = "Dhaba POS ($Port)"
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $Port -Profile Private -RemoteAddress LocalSubnet -Action Allow | Out-Null

# 4. Start and wait for /health.
& $nssm restart $ServiceName | Out-Null
$hostForCheck = if ($LanIp) { $LanIp } else { "127.0.0.1" }
$scheme = if ($TlsCertFile) { "https" } else { "http" }
for ($i = 0; $i -lt 30; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing "${scheme}://${hostForCheck}:$Port/api/v1/health" -TimeoutSec 2
    Write-Host "pos-api is up: $($r.Content)"; break
  } catch { Start-Sleep -Seconds 2 }
}
Write-Host "Installed service $ServiceName (auto-start on boot)."
Write-Host "Recommended: disable write caching on the data disk (Device Manager > Disks > Policies) and use a small UPS."
Write-Host "Workbook sheet password: $SheetPassword (keep it with the owner)."
