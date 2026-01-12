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

# Detect Paths
$ffmpegPath = (Get-Command ffmpeg.exe).Source
$ytDlpPath = (Get-Command yt-dlp.exe).Source

Write-Host "Detected FFmpeg at: $ffmpegPath" -ForegroundColor Green
Write-Host "Detected yt-dlp at: $ytDlpPath" -ForegroundColor Green

# Update .env file
$envFile = ".env"
if (-not (Test-Path $envFile)) {
    Write-Host "Creating new .env file..." -ForegroundColor Yellow
    New-Item -ItemType File -Path $envFile -Force
}

function Update-EnvVar($name, $value) {
    $content = Get-Content $envFile
    $escapedValue = $value -replace '\\', '\\'
    if ($content -match "^$name=") {
        $content = $content -replace "^$name=.*", "$name=$escapedValue"
    } else {
        $content += "$name=$escapedValue"
    }
    $content | Set-Content $envFile
}

Write-Host "Updating .env file with Windows paths..." -ForegroundColor Yellow
Update-EnvVar "FFMPEG_PATH" $ffmpegPath
Update-EnvVar "YT_DLP_PATH" $ytDlpPath

Write-Host "-----------------------------------" -ForegroundColor Cyan
Write-Host "Verifying installations:"
ffmpeg -version | Select-String "version"
yt-dlp --version
Write-Host "-----------------------------------" -ForegroundColor Cyan

Write-Host "Setup complete! Your .env file has been updated." -ForegroundColor Green
Write-Host "You can now run 'npm install' and 'npm start'." -ForegroundColor White
