import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { getTokenForChannel, getAuthenticatedChannelInfo } from './youtube-api.js';
import { LOGOS_DIR } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHANNELS_FILE = path.join(__dirname, '../channels.json');

// Helper function to read channels from the JSON file
async function readChannels() {
    try {
        const data = await fs.readFile(CHANNELS_FILE, 'utf8');
        const jsonData = JSON.parse(data);
        // Ensure the channels property exists and is an array
        return jsonData.channels || [];
    } catch (error) {
        if (error.code === 'ENOENT') {
            return []; // Return an empty array if the file doesn't exist
        }
        console.error('Error reading mp3toyt_channels.json file:', error);
        throw error;
    }
}

// Function to get all channels for a specific user
async function getChannelsForUser(username) {
    const channels = await readChannels();
    console.log(`[Channels] Total channels in file: ${channels.length}`);
    const userChannels = channels.filter(c => c.username === username);
    console.log(`[Channels] Found ${userChannels.length} channels for ${username}`);

    // Return the channel data directly from the file to avoid unnecessary API calls
    return userChannels.map(channel => ({
        channelId: channel.channelId,
        channelTitle: channel.channelTitle,
        thumbnail: channel.thumbnail,
        platform: channel.platform || 'youtube',
        socialAccountId: channel.socialAccountId,
        bundleInstanceId: channel.bundleInstanceId
    }));
}

async function saveChannel(channelData, username) {
    if (!username) {
        throw new Error('Username is required to save a channel.');
    }

    let allData;
    try {
        const fileContent = await fs.readFile(CHANNELS_FILE, 'utf8');
        allData = JSON.parse(fileContent);
        if (!Array.isArray(allData.channels)) {
            allData.channels = [];
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            allData = { channels: [] };
        } else {
            throw error;
        }
    }

    const existingIndex = allData.channels.findIndex(c => c.channelId === channelData.channelId);
    const now = new Date().toISOString();
    const channel = {
        ...channelData,
        username: username,
        updatedAt: now,
    };

    if (existingIndex >= 0) {
        channel.createdAt = allData.channels[existingIndex].createdAt || now;
        allData.channels[existingIndex] = channel;
    } else {
        channel.createdAt = now;
        allData.channels.push(channel);
    }

    await fs.writeFile(CHANNELS_FILE, JSON.stringify(allData, null, 2));
    return channel;
}

async function saveMp3toytChannel(newChannelData) {
    const channels = await readChannels();
    const existingIndex = channels.findIndex(c => c.channelId === newChannelData.channelId);

    if (existingIndex > -1) {
        // Update existing channel
        channels[existingIndex] = { ...channels[existingIndex], ...newChannelData };
    } else {
        // Add new channel
        channels.push(newChannelData);
    }

    // The file should contain an object with a 'channels' property
    await fs.writeFile(CHANNELS_FILE, JSON.stringify({ channels }, null, 2));
}

async function addChannel(newChannelData) {
    const channels = await readChannels();
    const existingIndex = channels.findIndex(c => c.channelId === newChannelData.channelId);

    if (existingIndex > -1) {
        // Update existing channel with new data
        channels[existingIndex] = { ...channels[existingIndex], ...newChannelData };
        console.log(`[CHANNELS] Updated channel: ${newChannelData.channelTitle}`);
    } else {
        // Add new channel
        channels.push(newChannelData);
        console.log(`[CHANNELS] Added new channel: ${newChannelData.channelTitle}`);
    }

    // The file should contain an object with a 'channels' property
    await fs.writeFile(CHANNELS_FILE, JSON.stringify({ channels }, null, 2));
}

async function deleteChannel(channelId) {
    const channels = await readChannels();
    const filteredChannels = channels.filter(c => c.channelId !== channelId);

    if (channels.length === filteredChannels.length) {
        console.warn(`[CHANNELS] Attempted to delete channel ${channelId}, but it was not found.`);
        return;
    }

    console.log(`[CHANNELS] Deleted channel with ID: ${channelId}`);

    // Delete the cached logo file
    const channelToDelete = channels.find(c => c.channelId === channelId);
    if (channelToDelete) {
        const platform = channelToDelete.platform || 'youtube';
        const logoName = `${platform}_${channelId}.jpg`;
        const logoPath = path.join(LOGOS_DIR, logoName);
        if (fs.existsSync(logoPath)) {
            fs.removeSync(logoPath);
            console.log(`[CHANNELS] Deleted cached logo: ${logoName}`);
        }
    }

    await fs.writeFile(CHANNELS_FILE, JSON.stringify({ channels: filteredChannels }, null, 2));
}

async function getAllChannelsRaw() {
    return await readChannels();
}

export { getChannelsForUser, saveChannel, saveMp3toytChannel, addChannel, deleteChannel, getAllChannelsRaw };
