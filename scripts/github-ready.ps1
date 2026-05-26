param(
  [switch]$UiChanged,
  [switch]$SkipWorker,
  [switch]$SkipPublish,
  [switch]$NoPush,
  [switch]$AllowEmptyCommit,
  [string]$CommitMessage = ""
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
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $output = Invoke-Expression $Command 2>&1
      $exitCode = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
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

function Resolve-GitCommand {
  $command = Get-Command git -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $candidatePatterns = @(
    "C:\Program Files\Git\cmd\git.exe",
    "C:\Program Files\Git\bin\git.exe",
    (Join-Path $env:LOCALAPPDATA "GitHubDesktop\app-*\resources\app\git\cmd\git.exe"),
    (Join-Path $env:LOCALAPPDATA "GitHubDesktop\app-*\resources\app\git\mingw64\bin\git.exe")
  )

  foreach ($pattern in $candidatePatterns) {
    $match = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($match) {
      return $match.FullName
    }
  }

  throw "Git executable was not found. Install Git or GitHub Desktop, then rerun the ready script."
}

function Invoke-GitOutput {
  param([string[]]$Arguments)

  Push-Location $Root
  try {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $output = & $script:GitCommand @Arguments 2>&1
      $exitCode = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
      throw (($output | ForEach-Object { $_.ToString() }) -join "`n")
    }
    return @($output | ForEach-Object { $_.ToString() })
  }
  finally {
    Pop-Location
    $global:LASTEXITCODE = 0
  }
}

function Invoke-GitLogged {
  param(
    [string]$Name,
    [string[]]$Arguments
  )

  $safe = ($Name.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
  $log = Join-Path $Logs "$safe.log"
  Push-Location $Root
  try {
    "PS> $script:GitCommand $($Arguments -join ' ')" | Set-Content -LiteralPath $log -Encoding UTF8
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $output = & $script:GitCommand @Arguments 2>&1
      $exitCode = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    $output | Add-Content -LiteralPath $log -Encoding UTF8
    if ($exitCode -ne 0) {
      Add-Check $Name "failed" $log
      Add-Issue $Name "Git exited with $exitCode." $log
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

function Get-DefaultCommitMessage {
  param([string[]]$Files)

  if ($Files.Count -eq 1 -and $Files[0] -eq "scripts/github-ready.ps1") {
    return "Automate ready publish"
  }
  if ($Files | Where-Object { $_ -like "functions-resumes/*" }) {
    return "Update ResumeDoc functions"
  }
  if ($Files | Where-Object { $_ -in @("index.html", "styles.css", "app.js", "config.js") }) {
    return "Update ResumeDoc app"
  }
  return "Publish ResumeDoc updates"
}

function Publish-GithubReadyChanges {
  if ($SkipPublish) {
    Add-Check "git publish" "skipped" "" "Pass without -SkipPublish to commit and push after checks pass."
    return
  }

  try {
    $script:GitCommand = Resolve-GitCommand
    Add-Check "git executable" "passed" "" $script:GitCommand
  }
  catch {
    Add-Check "git executable" "failed"
    Add-Issue "git executable" $_.Exception.Message
    return
  }

  try {
    $insideRepo = (Invoke-GitOutput @("rev-parse", "--is-inside-work-tree") | Select-Object -First 1).Trim()
    if ($insideRepo -ne "true") {
      throw "Current folder is not inside a Git work tree."
    }
  }
  catch {
    Add-Check "git repository" "failed"
    Add-Issue "git repository" $_.Exception.Message
    return
  }
  Add-Check "git repository" "passed"

  $statusLines = Invoke-GitOutput @("status", "--porcelain", "--untracked-files=normal")
  if ($statusLines.Count -eq 0 -and -not $AllowEmptyCommit) {
    Add-Check "git commit" "skipped" "" "No non-ignored changes to commit."
    if ($NoPush) {
      Add-Check "git push" "skipped" "" "No changes to commit and -NoPush was passed."
      return
    }
    Publish-GitBranch
    return
  }

  if (-not (Invoke-GitLogged "git stage" @("add", "-A", "--", "."))) {
    return
  }

  $changedFiles = Invoke-GitOutput @("diff", "--cached", "--name-only")
  if ($changedFiles.Count -eq 0 -and -not $AllowEmptyCommit) {
    Add-Check "git commit" "skipped" "" "No staged changes after git add."
    if (-not $NoPush) {
      Publish-GitBranch
    }
    return
  }

  $subject = $CommitMessage.Trim()
  if (-not $subject) {
    $subject = Get-DefaultCommitMessage $changedFiles
  }
  $bodyLines = @(
    "Validated with scripts/github-ready.ps1 before publishing.",
    "",
    "Changed files:"
  ) + ($changedFiles | ForEach-Object { "- $_" })
  $commitArgs = @("commit", "-m", $subject, "-m", ($bodyLines -join "`n"))
  if ($AllowEmptyCommit -and $changedFiles.Count -eq 0) {
    $commitArgs = @("commit", "--allow-empty", "-m", $subject, "-m", "Validated with scripts/github-ready.ps1 before publishing.")
  }
  if (-not (Invoke-GitLogged "git commit" $commitArgs)) {
    return
  }

  if ($NoPush) {
    Add-Check "git push" "skipped" "" "Commit created locally; -NoPush was passed."
    return
  }

  Publish-GitBranch
}

function Publish-GitBranch {
  try {
    $branch = (Invoke-GitOutput @("branch", "--show-current") | Select-Object -First 1).Trim()
    if (-not $branch) {
      throw "Cannot push from a detached HEAD."
    }
    try {
      Invoke-GitOutput @("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}") | Out-Null
      $pushArgs = @("push")
    }
    catch {
      $pushArgs = @("push", "-u", "origin", $branch)
    }
    Invoke-GitLogged "git push" $pushArgs | Out-Null
  }
  catch {
    Add-Check "git push" "failed"
    Add-Issue "git push" $_.Exception.Message
  }
}

function Write-ReadyReport {
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
Invoke-Logged "docx smoke tests" "node scripts\resumedoc-docx-smoke.mjs --mode=local" $Root | Out-Null

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

if ($issues.Count -eq 0) {
  Publish-GithubReadyChanges
}

Write-ReadyReport
if ($issues.Count -gt 0) {
  throw "GitHub ready checks finished with $($issues.Count) issue(s)."
}
