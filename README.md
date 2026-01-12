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

### 2. Install Project Dependencies
```bash
npm install
```

2. Add your `credentials.json` from Google Cloud Console.
3. Create a `.env` file with necessary environment variables.
4. Run the application:
   ```bash
   npm start
   ```
