import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { getTokenForChannel, getAuthenticatedChannelInfo } from './youtube-api.js';
import { LOGOS_DIR, CHANNELS_PATH, ADMIN_CHANNELS_PATH } from './config.js';

const ADMIN_USERNAME = 'erraja';

// Helper function to read channels from the JSON files
async function readChannels(username = null) {
    try {
        let channels = [];

        // Always try to read main channels
        if (await fs.pathExists(CHANNELS_PATH)) {
            const data = await fs.readFile(CHANNELS_PATH, 'utf8');
            const jsonData = JSON.parse(data);
            channels = jsonData.channels || [];
        }

        // Also try to read admin channels if file exists
        if (await fs.pathExists(ADMIN_CHANNELS_PATH)) {
            const adminData = await fs.readFile(ADMIN_CHANNELS_PATH, 'utf8');
            const adminJson = JSON.parse(adminData);
            const adminChannels = adminJson.channels || [];
            // Merge or filter? Usually we want all for lookup functions
            channels = [...channels, ...adminChannels];
        }

        if (username) {
            return channels.filter(c => c.username === username);
        }
        return channels;
    } catch (error) {
        console.error('Error reading channels files:', error);
        return [];
    }
}

// Function to get all channels for a specific user
async function getChannelsForUser(username) {
    const userChannels = await readChannels(username);
    console.log(`[Channels] Found ${userChannels.length} channels for ${username}`);

    return userChannels.map(channel => ({
        channelId: channel.channelId,
        channelTitle: channel.channelTitle,
        thumbnail: channel.thumbnail,
        platform: channel.platform || 'youtube',
        socialAccountId: channel.socialAccountId,
        bundleInstanceId: channel.bundleInstanceId,
        status: channel.status || 'connected',
        username: channel.username,
        authenticatedAt: channel.authenticatedAt || channel.createdAt
    }));
}

async function saveChannel(channelData, username) {
    if (!username) {
        throw new Error('Username is required to save a channel.');
    }

    const targetFile = (username === ADMIN_USERNAME) ? ADMIN_CHANNELS_PATH : CHANNELS_PATH;

    let allData = { channels: [] };
    try {
        if (await fs.pathExists(targetFile)) {
            const fileContent = await fs.readFile(targetFile, 'utf8');
            allData = JSON.parse(fileContent);
        }
    } catch (error) {
        console.error(`Error reading ${targetFile}:`, error);
    }

    if (!Array.isArray(allData.channels)) allData.channels = [];

    const existingIndex = allData.channels.findIndex(c => c.channelId === channelData.channelId);
    const now = new Date().toISOString();

    let channel;
    if (username === ADMIN_USERNAME) {
        // Use the style requested by the user
        channel = {
            channelId: channelData.channelId,
            channelTitle: channelData.channelTitle,
            username: username,
            thumbnail: channelData.thumbnail,
            authenticatedAt: channelData.authenticatedAt || channelData.createdAt || now,
            // Keep status for system logic
            status: channelData.status || 'connected'
        };
    } else {
        channel = {
            ...channelData,
            username: username,
            updatedAt: now,
            status: channelData.status || 'connected',
        };
        if (existingIndex >= 0) {
            channel.createdAt = allData.channels[existingIndex].createdAt || now;
        } else {
            channel.createdAt = now;
        }
    }

    if (existingIndex >= 0) {
        allData.channels[existingIndex] = channel;
    } else {
        allData.channels.push(channel);
    }

    await fs.writeFile(targetFile, JSON.stringify(allData, null, 2));
    return channel;
}


async function deleteChannel(channelId, username = null) {
    const isAdmin = username === ADMIN_USERNAME;
    const targetPath = isAdmin ? ADMIN_CHANNELS_PATH : CHANNELS_PATH;

    // Explicitly prevent admin ('erraja') from touching CHANNELS_PATH via fallback
    // and prevent regular users from touching ADMIN_CHANNELS_PATH
    if (!(await fs.pathExists(targetPath))) {
        console.warn(`[CHANNELS] Target file ${targetPath} does not exist.`);
        return;
    }

    const data = await fs.readJson(targetPath).catch(() => ({ channels: [] }));
    const initialCount = data.channels.length;
    data.channels = data.channels.filter(c => c.channelId !== channelId);

    if (data.channels.length < initialCount) {
        await fs.writeJson(targetPath, data, { spaces: 2 });
        console.log(`[CHANNELS] Removed ${channelId} from ${path.basename(targetPath)}.`);
    } else {
        console.warn(`[CHANNELS] Channel ${channelId} not found in ${path.basename(targetPath)}. No deletion performed.`);
    }

    // Always attempt logo cleanup
    const logoName = `youtube_${channelId}.jpg`;
    const logoPath = path.join(LOGOS_DIR, logoName);
    if (fs.existsSync(logoPath)) {
        fs.removeSync(logoPath);
        console.log(`[CHANNELS] Deleted cached logo: ${logoName}`);
    }
}

async function getAllChannelsRaw() {
    return await readChannels();
}

export { getChannelsForUser, saveChannel, deleteChannel, getAllChannelsRaw };
