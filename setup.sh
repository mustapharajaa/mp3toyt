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

# Install or Update yt-dlp
echo "Installing/Updating yt-dlp..."
sudo python3 -m pip install -U yt-dlp

# Verify installations
echo "-----------------------------------"
echo "Verifying installations:"
ffmpeg -version | head -n 1
yt-dlp --version
python3 --version
echo "-----------------------------------"

echo "Setup complete! You can now run the application."
