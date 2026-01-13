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
} else {
    Write-Host "Node.js is already installed." -ForegroundColor Green
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
Write-Host "Running npm install..." -ForegroundColor Cyan
npm install

Write-Host "`nYou can now run 'npm start' to launch the application!" -ForegroundColor White
