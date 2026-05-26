param(
  [switch]$UiChanged,
  [switch]$SkipWorker
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Artifacts = Join-Path $Root "artifacts\frontend-validation"
$Logs = Join-Path $Artifacts "logs"
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

$checks = New-Object System.Collections.Generic.List[object]
$issues = New-Object System.Collections.Generic.List[object]

function Add-Check {
  param(
    [string]$Name,
    [string]$Status,
    [string]$LogPath = "",
    [string]$Detail = ""
  )
  $checks.Add([ordered]@{
    name = $Name
    status = $Status
    logPath = $LogPath
    detail = $Detail
  }) | Out-Null
}

function Add-Issue {
  param(
    [string]$Name,
    [string]$Reason,
    [string]$LogPath = ""
  )
  $issues.Add([ordered]@{
    name = $Name
    reason = $Reason
    logPath = $LogPath
  }) | Out-Null
}

function Invoke-Logged {
  param(
    [string]$Name,
    [string]$Command,
    [string]$WorkingDirectory
  )
  $safe = ($Name.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
  $log = Join-Path $Logs "$safe.log"
  Push-Location $WorkingDirectory
  try {
    "PS> $Command" | Set-Content -LiteralPath $log -Encoding UTF8
    $output = Invoke-Expression $Command 2>&1
    $exitCode = $LASTEXITCODE
    $output | Add-Content -LiteralPath $log -Encoding UTF8
    if ($exitCode -ne 0 -and $null -ne $exitCode) {
      Add-Check $Name "failed" $log
      Add-Issue $Name "Command exited with $exitCode." $log
      return $false
    }
    Add-Check $Name "passed" $log
    return $true
  }
  catch {
    $_ | Out-String | Add-Content -LiteralPath $log -Encoding UTF8
    Add-Check $Name "failed" $log
    Add-Issue $Name $_.Exception.Message $log
    return $false
  }
  finally {
    Pop-Location
    $global:LASTEXITCODE = 0
  }
}

function Test-RequiredFile {
  param([string]$Path)
  $full = Join-Path $Root $Path
  if (Test-Path -LiteralPath $full) {
    Add-Check "required file $Path" "passed"
  }
  else {
    Add-Check "required file $Path" "failed"
    Add-Issue "required file $Path" "Missing required file."
  }
}

@(
  "index.html",
  "styles.css",
  "app.js",
  "config.js",
  "firebase.json",
  "functions-resumes\index.js",
  "functions-resumes\assets\interview-packet-template.docx"
) | ForEach-Object { Test-RequiredFile $_ }

Invoke-Logged "frontend syntax" "node --check app.js" $Root | Out-Null
Invoke-Logged "functions syntax" "npm run typecheck" (Join-Path $Root "functions-resumes") | Out-Null
Invoke-Logged "functions tests" "npm test" (Join-Path $Root "functions-resumes") | Out-Null

if (-not $SkipWorker) {
  $WorkerRoot = "C:\Codex\stripe-worker-api"
  if (Test-Path -LiteralPath $WorkerRoot) {
    Invoke-Logged "stripe worker typecheck" "npm run typecheck" $WorkerRoot | Out-Null
  }
  else {
    Add-Check "stripe worker typecheck" "skipped" "" "C:\Codex\stripe-worker-api was not found."
  }
}

if ($UiChanged) {
  Add-Check "five server smoke" "manual" "" "Open this repo with Five Server and verify sign-in/detail layout at http://localhost:5500 or the assigned Five Server port."
}
else {
  Add-Check "five server smoke" "skipped" "" "Pass -UiChanged when rendered UI changed."
}

$report = [ordered]@{
  generatedAt = (Get-Date).ToString("o")
  repo = $Root
  uiChanged = $UiChanged.IsPresent
  checks = $checks.ToArray()
  issuesRemaining = $issues.ToArray()
}

$jsonPath = Join-Path $Artifacts "report.json"
$txtPath = Join-Path $Artifacts "report.txt"
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("ResumeDoc GitHub Ready Report") | Out-Null
$lines.Add("Generated: $($report.generatedAt)") | Out-Null
$lines.Add("Repo: $Root") | Out-Null
$lines.Add("") | Out-Null
$lines.Add("Checks:") | Out-Null
foreach ($check in $checks) {
  $detail = if ($check.detail) { " - $($check.detail)" } else { "" }
  $lines.Add("- [$($check.status)] $($check.name)$detail") | Out-Null
}
$lines.Add("") | Out-Null
$lines.Add("Issues remaining:") | Out-Null
if ($issues.Count -eq 0) {
  $lines.Add("- None") | Out-Null
}
else {
  foreach ($issue in $issues) {
    $lines.Add("- $($issue.name): $($issue.reason)") | Out-Null
  }
}
$lines | Set-Content -LiteralPath $txtPath -Encoding UTF8

Write-Host "Report: $txtPath"
Write-Host "JSON: $jsonPath"
if ($issues.Count -gt 0) {
  throw "GitHub ready checks finished with $($issues.Count) issue(s)."
}
