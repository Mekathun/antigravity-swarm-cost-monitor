$ErrorActionPreference = "Stop"

$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TargetDir = Join-Path $env:USERPROFILE ".gemini\config\plugins\swarm-cost-monitor"

Write-Host "Installing Swarm Cost Monitor to $TargetDir ..." -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $TargetDir "assets") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $TargetDir "skills\swarm-cost") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $TargetDir "sidecars\swarm_cost\public") | Out-Null

Copy-Item -Force (Join-Path $SourceDir "plugin.json") $TargetDir
Copy-Item -Force (Join-Path $SourceDir "README.md") $TargetDir
Copy-Item -Force (Join-Path $SourceDir "assets\logo.svg") (Join-Path $TargetDir "assets")
Copy-Item -Force (Join-Path $SourceDir "skills\swarm-cost\SKILL.md") (Join-Path $TargetDir "skills\swarm-cost")
Copy-Item -Force (Join-Path $SourceDir "sidecars\swarm_cost\sidecar.json") (Join-Path $TargetDir "sidecars\swarm_cost")
Copy-Item -Force (Join-Path $SourceDir "sidecars\swarm_cost\package.json") (Join-Path $TargetDir "sidecars\swarm_cost")
Copy-Item -Force (Join-Path $SourceDir "sidecars\swarm_cost\main.mjs") (Join-Path $TargetDir "sidecars\swarm_cost")
Copy-Item -Force (Join-Path $SourceDir "sidecars\swarm_cost\scanner.mjs") (Join-Path $TargetDir "sidecars\swarm_cost")
Copy-Item -Force (Join-Path $SourceDir "sidecars\swarm_cost\pricing.mjs") (Join-Path $TargetDir "sidecars\swarm_cost")
Copy-Item -Force (Join-Path $SourceDir "sidecars\swarm_cost\public\*") (Join-Path $TargetDir "sidecars\swarm_cost\public")

Write-Host "Installed! Enable or toggle 'Swarm Cost Monitor' in Antigravity Customizations." -ForegroundColor Green
