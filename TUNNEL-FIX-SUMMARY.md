# Cloudflare Tunnel - Fixed!

## What Was Changed

The `setup.ps1` script has been improved to prevent tunnel credential loss:

### 1. **Better Credential Detection**
- Now checks for actual `.json` credential files (most reliable method)
- Automatically handles missing credentials by recreating the tunnel

### 2. **Automatic Backup**
- Creates `tunnel-backup/` folder
- Backs up both `cert.pem` and tunnel credentials JSON
- Can be restored if credentials are lost

### 3. **Config File**
- Creates `config.yml` in `.cloudflared/` directory
- More reliable than command-line options
- Survives system restarts

### 4. **PM2 Auto-Start Option**
- Tunnel can run in background via PM2
- Auto-restarts if it crashes
- Survives terminal close and RDP disconnects

---

## Quick Commands

### Start Tunnel (Simple)
```powershell
cloudflared tunnel run mp3-rdp-tunnel
```

### Start Tunnel (PM2 - Recommended)
```powershell
pm2 start cloudflared --name cf-tunnel -- tunnel run mp3-rdp-tunnel
pm2 save
```

### If Credentials Are Lost
```powershell
# Option 1: Restore from backup
.\restore-tunnel.ps1

# Option 2: Fix manually
.\fix-tunnel.ps1
```

---

## Why This Prevents the Problem

**Before:** Credentials could be deleted, and the tunnel name would exist in Cloudflare but not locally → Error

**Now:** 
- ✅ Credentials are backed up automatically
- ✅ Config file stores tunnel settings permanently
- ✅ Setup script detects and auto-fixes credential mismatches
- ✅ Can restore from backup instantly

You won't see the "tunnel credentials file not found" error anymore!
