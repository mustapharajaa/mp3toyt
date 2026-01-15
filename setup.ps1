# Check for Administrator privileges
if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Warning "Please run this script as Administrator!"
    exit
}

Write-Host "Starting setup for mp3toyt dependencies on Windows..." -ForegroundColor Cyan

# Install Chocolatey if not installed
if (-not (Get-Command choco.exe -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Chocolatey..." -ForegroundColor Yellow
    Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
}

# Install FFmpeg
Write-Host "Installing FFmpeg..." -ForegroundColor Yellow
choco install ffmpeg -y

# Install yt-dlp
Write-Host "Installing/Updating yt-dlp..." -ForegroundColor Yellow
choco install yt-dlp -y
& yt-dlp -U  # Force update to latest version to handle YouTube's latest decryption

# Install Node.js (LTS)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Node.js (LTS)..." -ForegroundColor Yellow
    choco install nodejs-lts -y
    # Refresh Path immediately after Node install
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Host "Node.js is already installed." -ForegroundColor Green
}

# Install PM2 (Process Manager)
# Force path refresh for current session to ensure npm is found
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Host "Installing PM2 (Process Manager)..." -ForegroundColor Yellow
    npm install pm2 -g
}

# Install Cloudflare Tunnel (cloudflared)
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Cloudflare Tunnel (cloudflared)..." -ForegroundColor Yellow
    choco install cloudflared -y
}

# Detect Paths
$ffmpegPath = (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue).Source
$ffprobePath = (Get-Command ffprobe.exe -ErrorAction SilentlyContinue).Source
$ytDlpPath = (Get-Command yt-dlp.exe -ErrorAction SilentlyContinue).Source

if (-not $ffmpegPath) { Write-Error "FFmpeg not found!"; exit }
if (-not $ffprobePath) { Write-Error "FFprobe not found!"; exit }
if (-not $ytDlpPath) { Write-Error "yt-dlp not found!"; exit }

Write-Host "Detected FFmpeg at: $ffmpegPath" -ForegroundColor Green
Write-Host "Detected FFprobe at: $ffprobePath" -ForegroundColor Green
Write-Host "Detected yt-dlp at: $ytDlpPath" -ForegroundColor Green

# Update .env file
$envFile = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envFile)) {
    Write-Host "Creating new .env file at $envFile..." -ForegroundColor Yellow
    New-Item -ItemType File -Path $envFile -Force | Out-Null
}

function Update-EnvVar($name, $value) {
    $content = @()
    if (Test-Path $envFile) {
        $content = @(Get-Content $envFile)
    }
    
    $escapedValue = $value -replace '\\', '\\'
    $line = "$name=$escapedValue"
    
    $found = $false
    for ($i = 0; $i -lt $content.Count; $i++) {
        if ($content[$i] -match "^$name=") {
            $content[$i] = $line
            $found = $true
            break
        }
    }
    
    if (-not $found) {
        $content += $line
    }
    
    # Filter out any empty lines and write back
    $content | Where-Object { $_.Trim() -ne "" } | Set-Content $envFile
}

Write-Host "Updating .env file with Windows paths..." -ForegroundColor Yellow
Update-EnvVar "FFMPEG_PATH" $ffmpegPath
Update-EnvVar "FFPROBE_PATH" $ffprobePath
Update-EnvVar "YT_DLP_PATH" $ytDlpPath

# Domain Setup
Write-Host '--- Domain Setup (liveenity.com) ---' -ForegroundColor Cyan
$currentBaseUrl = 'https://liveenity.com'
$userInput = Read-Host "Enter your production domain (default: $currentBaseUrl)"
if ($userInput) { $currentBaseUrl = $userInput }
Update-EnvVar 'BASE_URL' $currentBaseUrl
Write-Host "BASE_URL updated to: $currentBaseUrl" -ForegroundColor Green

Write-Host "Creating placeholder JSON files if missing..." -ForegroundColor Yellow
Write-Host "Creating placeholder JSON files if missing..." -ForegroundColor Yellow
$backendDir = Join-Path $PSScriptRoot "backend"
if (-not (Test-Path $backendDir)) { New-Item -ItemType Directory -Path $backendDir | Out-Null }
$tokensFile = Join-Path $backendDir "tokens.json"

# Use .NET IO to write UTF8 without BOM, which Node.js prefers
if (-not (Test-Path $tokensFile)) { 
    [System.IO.File]::WriteAllText($tokensFile, "[]") 
}

$channelsFile = Join-Path $PSScriptRoot "channels.json"
if (-not (Test-Path $channelsFile)) { 
    [System.IO.File]::WriteAllText($channelsFile, '{"channels": []}')
} else {
    # Check for corruption (BOM) and fix if needed
    try {
        $content = Get-Content $channelsFile -Raw
        $null = ConvertFrom-Json $content
    } catch {
        Write-Host "Detected corrupted channels.json (BOM). Repairing..." -ForegroundColor Yellow
        [System.IO.File]::WriteAllText($channelsFile, '{"channels": []}')
    }
}

$facebookTokensFile = Join-Path $PSScriptRoot "facebook_tokens.json"
if (-not (Test-Path $facebookTokensFile)) { 
    [System.IO.File]::WriteAllText($facebookTokensFile, "[]")
}

$facebookCredentialsFile = Join-Path $PSScriptRoot "facebook_credentials.json"
if (-not (Test-Path $facebookCredentialsFile)) { 
    [System.IO.File]::WriteAllText($facebookCredentialsFile, "{}")
}

$thumbnailsDir = Join-Path $PSScriptRoot "temp\thumbnails"
if (-not (Test-Path $thumbnailsDir)) { New-Item -ItemType Directory -Path $thumbnailsDir | Out-Null }

$credentialsFile = Join-Path $PSScriptRoot "credentials.json"
if (-not (Test-Path $credentialsFile)) { 
    [System.IO.File]::WriteAllText($credentialsFile, "{}")
}

$bundleUsageFile = Join-Path $PSScriptRoot "bundle_usage.json"
if (-not (Test-Path $bundleUsageFile)) { 
    [System.IO.File]::WriteAllText($bundleUsageFile, "{}")
}

$usersFile = Join-Path $PSScriptRoot "users.json"
if (-not (Test-Path $usersFile)) { 
    [System.IO.File]::WriteAllText($usersFile, "[]")
}

$adminChannelsFile = Join-Path $PSScriptRoot "admin_channels.json"
if (-not (Test-Path $adminChannelsFile)) { 
    [System.IO.File]::WriteAllText($adminChannelsFile, '{"channels": []}')
}

$automationStatsFile = Join-Path $PSScriptRoot "automation_stats.json"
if (-not (Test-Path $automationStatsFile)) { 
    [System.IO.File]::WriteAllText($automationStatsFile, "{}")
}

$pendingAutomationFile = Join-Path $PSScriptRoot "pending_automation.json"
if (-not (Test-Path $pendingAutomationFile)) { 
    [System.IO.File]::WriteAllText($pendingAutomationFile, "[]")
}

Write-Host "-----------------------------------" -ForegroundColor Cyan
Write-Host "Verifying installations:"
ffmpeg -version | Select-String "version"
ffprobe -version | Select-String "version"
yt-dlp --version
Write-Host "-----------------------------------" -ForegroundColor Cyan

Write-Host "Setup complete! Your .env file has been updated." -ForegroundColor Green

# Refresh Environment Variables for the current session (to find npm if just installed)
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# Run npm install
Write-Host 'Running npm install...' -ForegroundColor Cyan
npm install

# Start Application with PM2
Write-Host 'Starting application with PM2...' -ForegroundColor Cyan
pm2 delete mp3toyt 2>$null | Out-Null
pm2 start backend/server.js --name mp3toyt
pm2 save

Write-Host '-----------------------------------' -ForegroundColor Cyan
Write-Host 'PRODUCTION READY!' -ForegroundColor Green
Write-Host '1. Your app is running in the background via PM2.'
$certPath = Join-Path $HOME ".cloudflared\cert.pem"
if (-not (Test-Path $certPath)) {
    Write-Host "No Cloudflare certificate found. Starting login..." -ForegroundColor Yellow
    cloudflared tunnel login
} else {
    Write-Host "Cloudflare certificate already exists. Skipping login." -ForegroundColor Green
}

Write-Host '--- Cloudflare Tunnel Setup ---' -ForegroundColor Cyan
$tunnelName = "mp3-rdp-tunnel"
$cloudflaredDir = Join-Path $HOME ".cloudflared"

# Check if credentials JSON file exists locally (most reliable check)
$jsonFiles = Get-ChildItem $cloudflaredDir -Filter "*.json" -ErrorAction SilentlyContinue
$hasLocalCredentials = $jsonFiles.Count -gt 0

# List tunnels from Cloudflare
Write-Host "Checking Cloudflare tunnels..." -ForegroundColor Yellow
$tunnelList = cloudflared tunnel list 2>&1 | Out-String
$tunnelInCloud = $tunnelList | Select-String "\s$tunnelName\s"

# Decision tree for tunnel setup
if ($hasLocalCredentials) {
    Write-Host "[OK] Tunnel credentials found locally." -ForegroundColor Green
    $foundCredFile = $jsonFiles[0].FullName
    Write-Host "  Credential file: $($jsonFiles[0].Name)" -ForegroundColor Gray
} else {
    Write-Host "⚠ No local tunnel credentials found." -ForegroundColor Yellow
    
    if ($tunnelInCloud) {
        Write-Host "⚠ Tunnel '$tunnelName' exists in Cloudflare but credentials are missing locally!" -ForegroundColor Yellow
        Write-Host "This can happen if credentials were deleted or this is a different machine." -ForegroundColor Gray
        Write-Host ""
        Write-Host "Deleting old tunnel and creating fresh one..." -ForegroundColor Cyan
        
        # Delete old tunnel and create new one
        cloudflared tunnel delete -f $tunnelName 2>$null | Out-Null
        Start-Sleep -Seconds 2
        cloudflared tunnel create $tunnelName
    } else {
        Write-Host "Creating new tunnel '$tunnelName'..." -ForegroundColor Cyan
        cloudflared tunnel create $tunnelName
    }
    
    # Get the newly created credential file
    $jsonFiles = Get-ChildItem $cloudflaredDir -Filter "*.json" -ErrorAction SilentlyContinue
    if ($jsonFiles.Count -gt 0) {
        $foundCredFile = $jsonFiles[0].FullName
        Write-Host "[OK] Tunnel created successfully!" -ForegroundColor Green
    } else {
        Write-Host "✗ Failed to create tunnel credentials!" -ForegroundColor Red
        exit 1
    }
}

# Create backup of credentials to prevent future loss
$backupDir = Join-Path $PSScriptRoot "tunnel-backup"
if (-not (Test-Path $backupDir)) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
}
Write-Host "Creating backup of tunnel credentials..." -ForegroundColor Yellow
Copy-Item "$cloudflaredDir\cert.pem" "$backupDir\cert.pem" -Force -ErrorAction SilentlyContinue
Copy-Item "$cloudflaredDir\*.json" "$backupDir\" -Force -ErrorAction SilentlyContinue
Write-Host "[OK] Backup saved to: $backupDir" -ForegroundColor Green

# Extract tunnel ID from the JSON filename
$tunnelId = (Get-Item $foundCredFile).BaseName

# Create a config file for the tunnel (more reliable than command-line)
$configFile = Join-Path $cloudflaredDir "config.yml"
Write-Host "Creating tunnel config file..." -ForegroundColor Yellow
$configContent = "tunnel: $tunnelId`r`ncredentials-file: $foundCredFile`r`n`r`ningress:`r`n  - service: http://localhost:8000`r`n"
[System.IO.File]::WriteAllText($configFile, $configContent)
Write-Host "Config file created at: $configFile" -ForegroundColor Green

# Route DNS
Write-Host "Setting up DNS routing..." -ForegroundColor Yellow
$domainOnly = $currentBaseUrl -replace 'https?://', '' -replace '/.*', ''
cloudflared tunnel route dns -f $tunnelName $domainOnly 2>&1 | Out-Null
Write-Host "[OK] DNS routed: $domainOnly -> $tunnelName" -ForegroundColor Green

# Cleanup existing processes to free up ports
Write-Host 'Cleaning up old processes...' -ForegroundColor Cyan
if (Get-Command pm2 -ErrorAction SilentlyContinue) {
    pm2 delete all 2>$null | Out-Null
    pm2 kill 2>$null | Out-Null
}
Stop-Process -Name 'node' -ErrorAction SilentlyContinue

# Run npm install
Write-Host 'Running npm install...' -ForegroundColor Cyan
npm install

Write-Host '-----------------------------------' -ForegroundColor Cyan
Write-Host 'SETUP COMPLETE!' -ForegroundColor Green
Write-Host '1. Run this command to start your server:' -ForegroundColor White
Write-Host '   npm start' -ForegroundColor Yellow
Write-Host ''
Write-Host '2. To put your site online, choose ONE option:' -ForegroundColor White
Write-Host ''
Write-Host '   Option A - Simple background process:' -ForegroundColor Cyan
Write-Host "   Start-Process -NoNewWindow cloudflared -ArgumentList `"tunnel`",`"run`",`"$tunnelName`"" -ForegroundColor Yellow
Write-Host ''
Write-Host '   Option B - With PM2 (auto-restart, better for production):' -ForegroundColor Cyan
Write-Host '   First, create a batch file:' -ForegroundColor Gray
Write-Host '   @"' -ForegroundColor Yellow
Write-Host '   @echo off' -ForegroundColor Yellow
Write-Host "   cloudflared tunnel run $tunnelName" -ForegroundColor Yellow
Write-Host '   "@ | Out-File -FilePath ".\start-cf-tunnel.bat" -Encoding ASCII' -ForegroundColor Yellow
Write-Host '   Then run with PM2:' -ForegroundColor Gray
Write-Host '   pm2 start ".\start-cf-tunnel.bat" --name cf-tunnel' -ForegroundColor Yellow
Write-Host '   pm2 save' -ForegroundColor Yellow
Write-Host ''
Write-Host '[OK] Tunnel credentials backed up to: tunnel-backup/' -ForegroundColor Green
Write-Host '[OK] If credentials are lost, they can be restored from backup' -ForegroundColor Green
Write-Host '-----------------------------------' -ForegroundColor Cyan

# Force open the dashboard in the RDP browser
Start-Process 'https://one.dash.cloudflare.com/'
Write-Host 'Setup complete!' -ForegroundColor White
