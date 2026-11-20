param(
  [string]$AppRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [int]$Port = 8810
)

$ErrorActionPreference = 'Stop'
$envFile = Join-Path $AppRoot '.env'
$repoRoot = (Resolve-Path (Join-Path $AppRoot '..\..')).Path
$workspaceRoot = Split-Path $repoRoot -Parent
$logRoot = Join-Path $workspaceRoot 'service-logs'
$outLog = Join-Path $logRoot 'data-agent.out.log'
$errLog = Join-Path $logRoot 'data-agent.err.log'

function Read-DotEnv([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "Missing private configuration: $Path" }
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') { continue }
    $value = $matches[2].Trim()
    if (($value.StartsWith("'") -and $value.EndsWith("'")) -or ($value.StartsWith('"') -and $value.EndsWith('"'))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$matches[1]] = $value
  }
  return $values
}

function Resolve-AppPath([string]$Value) {
  if ([IO.Path]::IsPathRooted($Value)) { return $Value }
  return [IO.Path]::GetFullPath((Join-Path $AppRoot $Value))
}

function Resolve-Node {
  $bundled = Get-ChildItem -LiteralPath (Join-Path $workspaceRoot '.tools') -Directory -Filter 'node-v*-win-x64' -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'node.exe' } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
  if ($bundled) { return $bundled }
  $command = Get-Command node -ErrorAction SilentlyContinue
  if (-not $command) { throw 'Node.js was not found' }
  return $command.Source
}

function Assert-Model([hashtable]$Values) {
  foreach ($name in @('DATA_AGENT_TIDB_URL','DATA_AGENT_PYTHON','DATA_AGENT_MODEL_CONFIG','DATA_AGENT_MODEL_KEY')) {
    if ([string]::IsNullOrWhiteSpace($Values[$name])) { throw "Missing $name in $envFile" }
  }
  $configPath = Resolve-AppPath $Values['DATA_AGENT_MODEL_CONFIG']
  if (-not (Test-Path -LiteralPath $configPath)) { throw "Model configuration not found: $configPath" }
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  $modelKey = $Values['DATA_AGENT_MODEL_KEY']
  $model = $config.models.$modelKey
  if (-not $model) { throw "Model key is not configured: $modelKey" }
  $provider = $config.providers.($model.providerKey)
  if (-not $provider) { throw "Provider is not configured: $($model.providerKey)" }
  $apiKeyName = $provider.apiKeyEnv
  $apiKey = $Values[$apiKeyName]
  if ([string]::IsNullOrWhiteSpace($apiKey)) { $apiKey = [Environment]::GetEnvironmentVariable($apiKeyName) }
  if ([string]::IsNullOrWhiteSpace($apiKey)) { throw "Missing provider credential: $apiKeyName" }
  if ($provider.protocol -ne 'chat-completions') { return }
  $uri = $provider.baseUrl.TrimEnd('/') + '/chat/completions'
  $body = @{ model = $model.providerModel; messages = @(@{ role = 'user'; content = '只回复OK' }); max_tokens = 32; stream = $false } | ConvertTo-Json -Depth 5
  $response = Invoke-RestMethod -Uri $uri -Method Post -Headers @{ Authorization = "Bearer $apiKey" } -ContentType 'application/json' -Body $body -TimeoutSec 30
  $content = $response.choices[0].message.content
  if ([string]::IsNullOrWhiteSpace($content)) {
    throw "Model preflight returned no visible content. Check the exact provider model id: $($model.providerModel)"
  }
}

function Assert-TiDb([hashtable]$Values) {
  $uri = [Uri]$Values['DATA_AGENT_TIDB_URL']
  $portValue = if ($uri.Port -gt 0) { $uri.Port } else { 4000 }
  $probe = Test-NetConnection $uri.Host -Port $portValue -WarningAction SilentlyContinue
  if (-not $probe.TcpTestSucceeded) { throw "TiDB is unreachable: $($uri.Host):$portValue" }
}

function Get-ListeningProcess([int]$ListenPort) {
  $listener = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
}

function Test-DataAgentProcess([object]$Process, [hashtable]$Values, [int]$ListenPort) {
  if (-not $Process) { return [pscustomobject]@{ Matches = $false; Reason = 'listener process metadata is unavailable' } }
  if ($Process.Name -notmatch '^node(?:\.exe)?$') {
    return [pscustomobject]@{ Matches = $false; Reason = "executable is $($Process.Name), not Node.js" }
  }
  $expectedEntry = ([IO.Path]::GetFullPath((Join-Path $AppRoot 'src\main.ts'))).Replace('\','/')
  $commandLine = ([string]$Process.CommandLine).Replace('\','/')
  $entryMatches = $commandLine.IndexOf($expectedEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $commandLine -match '(?i)(?:^|[\s"''])src/main\.ts(?:[\s"'']|$)'
  if (-not $entryMatches) {
    return [pscustomobject]@{ Matches = $false; Reason = 'command line is not the Data Agent entrypoint' }
  }
  try {
    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $page = Invoke-WebRequest -Uri "http://127.0.0.1:$ListenPort/" -WebSession $session -UseBasicParsing -TimeoutSec 3
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$ListenPort/api/settings/status" -WebSession $session -TimeoutSec 3
    $config = Invoke-RestMethod -Uri "http://127.0.0.1:$ListenPort/api/config" -WebSession $session -TimeoutSec 3
    $healthy = $page.StatusCode -eq 200 -and $status.service -eq 'AgentLoop Data Agent' -and $status.skill.name -eq 'data-analysis' -and $status.url -eq "http://127.0.0.1:$ListenPort" -and $config.models.key -contains $Values['DATA_AGENT_MODEL_KEY']
    if (-not $healthy) { return [pscustomobject]@{ Matches = $false; Reason = 'health identity does not match the configured Data Agent' } }
  } catch {
    return [pscustomobject]@{ Matches = $false; Reason = 'Data Agent identity endpoints are unavailable' }
  }
  return [pscustomobject]@{ Matches = $true; Reason = 'command line and health identity match' }
}

if ($MyInvocation.InvocationName -eq '.') { return }

$values = Read-DotEnv $envFile
$node = Resolve-Node
$nodeVersion = ((& $node --version) | Select-Object -First 1).Trim().TrimStart('v')
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 26) { throw "Data Agent requires Node 26 or newer; found Node $major" }

$listenerProcess = Get-ListeningProcess $Port
if ($listenerProcess) {
  $identity = Test-DataAgentProcess $listenerProcess $values $Port
  if (-not $identity.Matches) {
    throw "Port $Port is occupied by PID $($listenerProcess.ProcessId) ($($listenerProcess.Name)), but it is not the current Data Agent: $($identity.Reason). Refusing to stop it."
  }
}

Assert-TiDb $values
Assert-Model $values

if ($listenerProcess) {
  Stop-Process -Id $listenerProcess.ProcessId -ErrorAction Stop
  $deadline = (Get-Date).AddSeconds(15)
  do { Start-Sleep -Milliseconds 250 } while ((Get-Process -Id $listenerProcess.ProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline)
  if (Get-Process -Id $listenerProcess.ProcessId -ErrorAction SilentlyContinue) { throw "Old process did not exit: $($listenerProcess.ProcessId)" }
}

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$process = $null
$ready = $false
$historyCount = $null
$takeoverDeadline = (Get-Date).AddSeconds(105)
do {
  $process = Start-Process -FilePath $node -ArgumentList @('--env-file-if-exists=.env',(Join-Path $AppRoot 'src\main.ts')) -WorkingDirectory $AppRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $attemptDeadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) { break }
    try {
      $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
      $page = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -WebSession $session -UseBasicParsing -TimeoutSec 3
      $configResponse = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/config" -WebSession $session -TimeoutSec 3
      $conversations = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/conversations" -WebSession $session -TimeoutSec 3
      $historyCount = @($conversations.conversations).Count
      $ready = $page.StatusCode -eq 200 -and $configResponse.models.key -contains $values['DATA_AGENT_MODEL_KEY']
    } catch { }
  } while (-not $ready -and (Get-Date) -lt $attemptDeadline)
  if ($ready) { break }
  $leaseConflict = (Test-Path -LiteralPath $errLog) -and ((Get-Content -LiteralPath $errLog -Tail 8) -join "`n") -match 'TiDB Runtime.*活动宿主'
  if (-not $leaseConflict -or (Get-Date) -ge $takeoverDeadline) { break }
  Start-Sleep -Seconds 5
} while ((Get-Date) -lt $takeoverDeadline)

if (-not $ready) {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  $tail = if (Test-Path -LiteralPath $errLog) { (Get-Content -LiteralPath $errLog -Tail 20) -join [Environment]::NewLine } else { '' }
  throw "Data Agent did not become ready. PID=$($process.Id)`n$tail"
}

[pscustomobject]@{
  ready = $true
  pid = $process.Id
  url = "http://127.0.0.1:$Port/"
  modelKey = $values['DATA_AGENT_MODEL_KEY']
  providerModel = ((Get-Content -LiteralPath (Resolve-AppPath $values['DATA_AGENT_MODEL_CONFIG']) -Raw | ConvertFrom-Json).models.($values['DATA_AGENT_MODEL_KEY']).providerModel)
  historyCount = $historyCount
  outputLog = $outLog
  errorLog = $errLog
} | ConvertTo-Json -Compress
