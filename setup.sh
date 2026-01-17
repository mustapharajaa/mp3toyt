#!/bin/bash

# Exit on error
set -e

echo "Starting setup for mp3toyt dependencies (VPS Optimized)..."

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
update_env_var "PORT" "80"

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
pm2 startup

echo "-----------------------------------"
echo "🚀 PRODUCTION READY!"
echo "1. Your app is running in the background via PM2 on PORT 80."
echo "2. Make sure your domain points to this server's IP via an A-Record."
echo "-----------------------------------"
