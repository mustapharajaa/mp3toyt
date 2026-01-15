# Restore Tunnel Credentials from Backup
# Use this script if tunnel credentials are lost

Write-Host "=== Restore Tunnel Credentials ===" -ForegroundColor Cyan
Write-Host ""

$backupDir = Join-Path $PSScriptRoot "tunnel-backup"
$cloudflaredDir = Join-Path $HOME ".cloudflared"

# Check if backup exists
if (-not (Test-Path $backupDir)) {
    Write-Host "✗ Backup directory not found at: $backupDir" -ForegroundColor Red
    Write-Host ""
    Write-Host "If credentials are lost, you'll need to recreate the tunnel:" -ForegroundColor Yellow
    Write-Host "  .\fix-tunnel.ps1" -ForegroundColor Cyan
    exit 1
}

# Check for backup files
$backupCert = Join-Path $backupDir "cert.pem"
$backupJson = Get-ChildItem $backupDir -Filter "*.json" -ErrorAction SilentlyContinue

if (-not (Test-Path $backupCert)) {
    Write-Host "✗ No cert.pem found in backup!" -ForegroundColor Red
    exit 1
}

if ($backupJson.Count -eq 0) {
    Write-Host "✗ No tunnel credentials JSON found in backup!" -ForegroundColor Red
    exit 1
}

Write-Host "✓ Backup files found:" -ForegroundColor Green
Write-Host "  - cert.pem" -ForegroundColor Gray
foreach ($json in $backupJson) {
    Write-Host "  - $($json.Name)" -ForegroundColor Gray
}
Write-Host ""

# Create .cloudflared directory if it doesn't exist
if (-not (Test-Path $cloudflaredDir)) {
    New-Item -ItemType Directory -Path $cloudflaredDir -Force | Out-Null
    Write-Host "✓ Created .cloudflared directory" -ForegroundColor Green
}

# Restore files
Write-Host "Restoring credentials..." -ForegroundColor Yellow
Copy-Item $backupCert $cloudflaredDir -Force
Write-Host "✓ Restored cert.pem" -ForegroundColor Green

foreach ($json in $backupJson) {
    Copy-Item $json.FullName $cloudflaredDir -Force
    Write-Host "✓ Restored $($json.Name)" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Restore Complete! ===" -ForegroundColor Green
Write-Host ""
Write-Host "You can now start the tunnel:" -ForegroundColor White
Write-Host "  cloudflared tunnel run mp3-rdp-tunnel" -ForegroundColor Cyan
Write-Host ""
Write-Host "Or with PM2:" -ForegroundColor White
Write-Host "  pm2 start cloudflared --name cf-tunnel -- tunnel run mp3-rdp-tunnel" -ForegroundColor Cyan
Write-Host "  pm2 save" -ForegroundColor Cyan
