# mp3toyt

A project to convert MP3 files to YouTube videos.

## Setup

### 1. Prerequisite (RDP/Server)

#### For Windows RDP:
Open **PowerShell as Administrator** and run:
```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
./setup.ps1
```

#### For Linux Server:
Run the setup script to install `ffmpeg` and `yt-dlp`:
```bash
chmod +x setup.sh
./setup.sh
```

### 2. Run the Application
Once the setup script finishes, it will have installed Node.js, FFmpeg, yt-dlp, and all project dependencies. You can then run:
```bash
npm start
```

### 3. Final Configuration
1. Add your `credentials.json` from Google Cloud Console.
2. The setup script will have created a `.env` file; you may add additional variables if needed.

### 4. Open Port for Online Access (Optional)
To access the application via your IP address, you must open port **8000**.

#### Windows RDP (Standard CMD or PowerShell as Admin):
```cmd
netsh advfirewall firewall add rule name="Allow mp3toyt (Port 8000)" dir=in action=allow protocol=TCP localport=8000
```
*Alternatively, in PowerShell:*
```powershell
New-NetFirewallRule -DisplayName "Allow mp3toyt (Port 8000)" -Direction Inbound -LocalPort 8000 -Protocol TCP -Action Allow
```

#### Linux Server (Terminal):
```bash
sudo ufw allow 8000/tcp
```
> [!NOTE]
> If you are using a cloud provider (AWS, Azure, etc.), you must also allow port 8000 in their web console's security rules.
