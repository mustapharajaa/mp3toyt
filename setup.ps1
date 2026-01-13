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
Write-Host "Installing yt-dlp..." -ForegroundColor Yellow
choco install yt-dlp -y

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
$tokensFile = Join-Path $PSScriptRoot "tokens.json"
if (-not (Test-Path $tokensFile)) { "[]" | Out-File -FilePath $tokensFile -Encoding utf8 }

$channelsFile = Join-Path $PSScriptRoot "channels.json"
if (-not (Test-Path $channelsFile)) { '{"channels": []}' | Out-File -FilePath $channelsFile -Encoding utf8 }

$facebookTokensFile = Join-Path $PSScriptRoot "facebook_tokens.json"
if (-not (Test-Path $facebookTokensFile)) { "[]" | Out-File -FilePath $facebookTokensFile -Encoding utf8 }

$facebookCredentialsFile = Join-Path $PSScriptRoot "facebook_credentials.json"
if (-not (Test-Path $facebookCredentialsFile)) { "{}" | Set-Content $facebookCredentialsFile }

$credentialsFile = Join-Path $PSScriptRoot "credentials.json"
if (-not (Test-Path $credentialsFile)) { "{}" | Set-Content $credentialsFile }

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
Write-Host '2. LOGIN REQUIRED: A unique URL will appear below.'
Write-Host 'COPY and OPEN this URL in your local browser to link your domain.'
Write-Host '-----------------------------------' -ForegroundColor Cyan

cloudflared tunnel login

Write-Host '--- Cloudflare Tunnel Setup ---' -ForegroundColor Cyan
# Check if tunnel already exists
$tunnels = cloudflared tunnel list
if ($tunnels -notmatch 'mp3-tunnel') {
    Write-Host 'Creating Cloudflare Tunnel: mp3-tunnel...' -ForegroundColor Yellow
    cloudflared tunnel create mp3-tunnel
}

# Extract domain for DNS routing (remove https://)
$domainOnly = $currentBaseUrl -replace 'https?://', '' -replace '/.*', ''
Write-Host "Routing domain $domainOnly to tunnel..." -ForegroundColor Yellow
cloudflared tunnel route dns -f mp3-tunnel $domainOnly

# Start Tunnel with PM2
Write-Host 'Starting Cloudflare Tunnel background process...' -ForegroundColor Cyan
pm2 delete cf-tunnel 2>$null | Out-Null
pm2 start "cloudflared tunnel --url http://localhost:8000 run mp3-tunnel" --name cf-tunnel
pm2 save

Write-Host '-----------------------------------' -ForegroundColor Cyan
Write-Host 'PRODUCTION READY!' -ForegroundColor Green
Write-Host '1. Your app is running in the background via PM2.'
Write-Host "2. Your domain $domainOnly is now linked to this server!"
Write-Host '-----------------------------------' -ForegroundColor Cyan

# Force open the dashboard in the RDP browser
Start-Process 'https://one.dash.cloudflare.com/'

Write-Host 'Setup complete!' -ForegroundColor White
