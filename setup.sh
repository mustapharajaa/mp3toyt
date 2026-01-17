#!/bin/bash

# Exit on error
set -e

echo "Starting setup for mp3toyt dependencies..."

# Update package list
echo "Updating packages..."
sudo apt-get update -y

# Install FFmpeg
echo "Installing FFmpeg..."
sudo apt-get install -y ffmpeg

# Install Python and Pip
echo "Installing Python3 and Pip..."
sudo apt-get install -y python3 python3-pip

# Install Node.js
if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "Node.js is already installed."
fi

# Install PM2
if ! command -v pm2 &> /dev/null; then
    echo "Installing PM2..."
    sudo npm install pm2 -g
fi

# Install Cloudflare Tunnel
if ! command -v cloudflared &> /dev/null; then
    echo "Installing Cloudflare Tunnel..."
    curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
    sudo dpkg -i cloudflared.deb
    rm cloudflared.deb
fi

# Install or Update yt-dlp
echo "Installing/Updating yt-dlp..."
sudo python3 -m pip install -U yt-dlp --break-system-packages

# Detect Paths
FFMPEG_LOC=$(which ffmpeg)
FFPROBE_LOC=$(which ffprobe)
YT_DLP_LOC=$(which yt-dlp)

echo "Detected FFmpeg at: $FFMPEG_LOC"
echo "Detected FFprobe at: $FFPROBE_LOC"
echo "Detected yt-dlp at: $YT_DLP_LOC"

# Update .env file
echo "Updating .env file with Linux paths..."
ENV_FILE=".env"

if [ ! -f "$ENV_FILE" ]; then
    echo "Creating new .env file..."
    touch "$ENV_FILE"
fi

update_env_var() {
    local var_name=$1
    local var_value=$2
    if grep -q "^${var_name}=" "$ENV_FILE"; then
        # Replace existing value
        sed -i "s|^${var_name}=.*|${var_name}=${var_value}|" "$ENV_FILE"
    else
        # Append new value
        echo "${var_name}=${var_value}" >> "$ENV_FILE"
    fi
}

update_env_var "FFMPEG_PATH" "$FFMPEG_LOC"
update_env_var "FFPROBE_PATH" "$FFPROBE_LOC"
update_env_var "YT_DLP_PATH" "$YT_DLP_LOC"

# Domain Setup
echo ""
echo "--- Domain Setup (liveenity.com) ---"
read -p "Enter your production domain (default: https://liveenity.com): " USER_DOMAIN
USER_DOMAIN=${USER_DOMAIN:-https://liveenity.com}
update_env_var "BASE_URL" "$USER_DOMAIN"
echo "BASE_URL updated to: $USER_DOMAIN"

echo "Creating placeholder JSON files if missing..."
[ -f tokens.json ] || echo "[]" > tokens.json
[ -f channels.json ] || echo '{"channels": []}' > channels.json
[ -f facebook_tokens.json ] || echo "[]" > facebook_tokens.json
[ -f facebook_credentials.json ] || echo "{}" > facebook_credentials.json
[ -f credentials.json ] || echo "{}" > credentials.json
[ -f bundle_usage.json ] || echo "{}" > bundle_usage.json
[ -f users.json ] || echo "[]" > users.json

# Verify installations
echo "-----------------------------------"
echo "Verifying installations:"
ffmpeg -version | head -n 1
ffprobe -version | head -n 1
yt-dlp --version
python3 --version
echo "-----------------------------------"

echo "Setup complete! Your .env file has been updated."
# Run npm install
echo "Running npm install..."
npm install

# Start Application with PM2
echo "Starting application with PM2..."
pm2 delete mp3toyt 2>/dev/null || true
pm2 start backend/server.js --name mp3toyt
pm2 save

echo "-----------------------------------"
echo "🚀 PRODUCTION READY!"
echo "1. Your app is running in the background via PM2."
echo "2. LOGIN REQUIRED: A unique URL will appear below."
echo "👉 COPY and OPEN this URL in your local browser to link your domain."
echo "-----------------------------------"

cloudflared tunnel login

echo "--- Cloudflare Tunnel Setup ---"
TUNNEL_NAME="mp3-rdp-tunnel"

# More robust check: Does the specific tunnel name exist on this machine with local keys?
# cloudflared tunnel list shows tunnels that are authorized on this machine
TUNNEL_LIST=$(cloudflared tunnel list)

if echo "$TUNNEL_LIST" | grep -q "[[:space:]]$TUNNEL_NAME[[:space:]]"; then
    HAS_KEYS=true
else
    HAS_KEYS=false
fi

if [ "$HAS_KEYS" = false ]; then
    # Look for ANY existing tunnels on this machine
    EXISTING=$(echo "$TUNNEL_LIST" | grep "[0-9a-f]\{8\}-" || true)
    if [ -n "$EXISTING" ]; then
        echo "Found existing authorized tunnels on this machine:"
        echo "$EXISTING" | sed 's/^/  - /'
        read -p "Enter the tunnel name you want to use (or press Enter for mp3-rdp-tunnel): " USER_TUNNEL
        TUNNEL_NAME=${USER_TUNNEL:-mp3-rdp-tunnel}
    else
        echo "No tunnels or keys found for '$TUNNEL_NAME' on this machine."
        read -p "Enter a name for your tunnel on this machine (default: mp3-rdp-tunnel): " USER_TUNNEL
        TUNNEL_NAME=${USER_TUNNEL:-mp3-rdp-tunnel}
        
        # Check if they picked a name that exists on Cloudflare but not locally
        if echo "$TUNNEL_LIST" | grep -q "[[:space:]]$TUNNEL_NAME[[:space:]]"; then
             echo "Note: Tunnel '$TUNNEL_NAME' exists on Cloudflare. If you don't have the keys, this command might fail."
        fi
        
        echo "Creating Cloudflare Tunnel: $TUNNEL_NAME..."
        cloudflared tunnel create "$TUNNEL_NAME"
    fi
else
    echo "Tunnel '$TUNNEL_NAME' is authorized and ready on this machine."
fi

# Extract domain for DNS routing (remove https://)
DOMAIN_ONLY=$(echo "$USER_DOMAIN" | sed -E 's|https?://||' | sed -E 's|/.*||')
echo "Routing domain $DOMAIN_ONLY to tunnel $TUNNEL_NAME..."
cloudflared tunnel route dns -f "$TUNNEL_NAME" "$DOMAIN_ONLY"

# Start Tunnel with PM2
echo "Starting Cloudflare Tunnel background process..."
pm2 delete cf-tunnel 2>/dev/null || true
pm2 start cloudflared --name cf-tunnel -- tunnel run "$TUNNEL_NAME"
pm2 save

echo "-----------------------------------"
echo "🚀 PRODUCTION READY!"
echo "1. Your app is running in the background via PM2."
echo "2. Your domain $DOMAIN_ONLY is now linked to this server!"
echo ""
echo "If you need to run it manually or verify, use these commands:"
echo "   cloudflared tunnel route dns -f $TUNNEL_NAME $DOMAIN_ONLY"
echo "   cloudflared tunnel run --url http://localhost:8000 $TUNNEL_NAME"
echo "-----------------------------------"

# Best effort to open browser on Linux
if command -v xdg-open &> /dev/null; then
    xdg-open "https://one.dash.cloudflare.com/" &
fi

echo "Setup complete!"
