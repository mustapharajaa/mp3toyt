import { Bundlesocial } from 'bundlesocial';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const USAGE_FILE = path.join(__dirname, '../bundle_usage.json');

// Handle multiple keys
const apiKeysStr = process.env.BUNDLE_API_KEYS || process.env.BUNDLE_API_KEY || '';
const API_KEYS = apiKeysStr.split(',').map(k => k.trim()).filter(k => k);

if (API_KEYS.length === 0) {
    console.warn('[Bundle] No API keys found in BUNDLE_API_KEYS or BUNDLE_API_KEY');
}

// Initialize instances
const instances = API_KEYS.map((key, index) => ({
    id: index,
    key,
    bundle: new Bundlesocial(key),
    cachedTeamId: null
}));

// Usage tracking
let usageData = {};

async function loadUsage() {
    try {
        const data = await fs.readFile(USAGE_FILE, 'utf8');
        usageData = JSON.parse(data);
    } catch (e) {
        usageData = {};
    }
}

async function saveUsage() {
    try {
        await fs.writeFile(USAGE_FILE, JSON.stringify(usageData, null, 2));
    } catch (e) {
        console.error('[Bundle] Failed to save usage info:', e.message);
    }
}

function getUsageForKey(key) {
    const currentMonth = new Date().toISOString().substring(0, 7); // YYYY-MM
    if (!usageData[key] || usageData[key].month !== currentMonth) {
        usageData[key] = {
            uploads: 0,
            facebookConnected: false,
            youtubeConnected: false,
            month: currentMonth
        };
    }
    return usageData[key];
}

// Ensure usage is loaded once
let usageLoaded = false;
async function ensureUsageLoaded() {
    if (!usageLoaded) {
        await loadUsage();
        usageLoaded = true;
    }
}

async function getTeamId(instance) {
    if (instance.cachedTeamId) return instance.cachedTeamId;
    try {
        const response = await instance.bundle.team.teamGetList();
        if (response && response.items && response.items.length > 0) {
            instance.cachedTeamId = response.items[0].id;
            return instance.cachedTeamId;
        }

        const created = await instance.bundle.team.teamCreateTeam({
            requestBody: { name: 'MP3toYT Team' }
        });
        if (created && created.id) {
            instance.cachedTeamId = created.id;
            return instance.cachedTeamId;
        }
        return null;
    } catch (error) {
        if (error.status === 403 && error.body && error.body.message.includes('Limit is 1')) {
            try {
                const org = await instance.bundle.organization.organizationGetOrganization();
                if (org && org.teams && org.teams.length > 0) {
                    instance.cachedTeamId = org.teams[0].id;
                    return instance.cachedTeamId;
                }
            } catch (orgErr) {
                console.error('[Bundle] Failed to fetch organization as fallback:', orgErr);
            }
        }
        console.error('[Bundle] Error fetching/creating team:', error);
        return null;
    }
}

/**
 * Finds an available API key instance for a specific platform.
 */
export async function getAvailableInstance(platform) {
    await ensureUsageLoaded();
    const platformField = platform.toLowerCase() === 'facebook' ? 'facebookConnected' : 'youtubeConnected';

    for (const inst of instances) {
        const usage = getUsageForKey(inst.key);
        // User rule: < 100 uploads and slot must be free
        if (usage.uploads < 100 && !usage[platformField]) {
            return inst;
        }
    }
    return null; // All slots full or limit reached
}

export function getInstanceById(id) {
    const idx = parseInt(id);
    if (isNaN(idx) || idx < 0 || idx >= instances.length) return null;
    return instances[idx];
}

export async function getFacebookConnectUrl(redirectUrl) {
    const inst = await getAvailableInstance('FACEBOOK');
    if (!inst) throw new Error('No available Bundle.social slots for Facebook');
    return getConnectUrl(inst, redirectUrl, 'FACEBOOK');
}

export async function getYoutubeConnectUrl(redirectUrl) {
    const inst = await getAvailableInstance('YOUTUBE');
    if (!inst) throw new Error('No available Bundle.social slots for YouTube');
    return getConnectUrl(inst, redirectUrl, 'YOUTUBE');
}

async function getConnectUrl(instance, redirectUrl, type) {
    try {
        const teamId = await getTeamId(instance);
        if (!teamId) return null;

        const response = await instance.bundle.socialAccount.socialAccountConnect({
            requestBody: {
                teamId: teamId,
                type: type,
                redirectUrl: redirectUrl
            }
        });

        if (response && response.url) {
            // Include instance ID in redirect URL if needed? 
            // Or just resolve it during claim based on which key currently has that account.
            return response.url;
        }
        return null;
    } catch (error) {
        console.error(`[Bundle] Error generating ${type} connect URL:`, error);
        return null;
    }
}

export async function getConnectedChannels() {
    // This is tricky: we need to check ALL keys to see which ones now have accounts
    // and update our usage tracking.
    await ensureUsageLoaded();
    let allChannels = [];

    for (const inst of instances) {
        try {
            const teamId = await getTeamId(inst);
            if (!teamId) continue;

            const teamRes = await inst.bundle.team.teamGetTeam({ id: teamId });
            const socialAccounts = teamRes.socialAccounts || [];

            const usage = getUsageForKey(inst.key);
            usage.facebookConnected = socialAccounts.some(acc => acc.type === 'FACEBOOK');
            usage.youtubeConnected = socialAccounts.some(acc => acc.type === 'YOUTUBE');

            for (const account of socialAccounts) {
                if (account.type !== 'FACEBOOK' && account.type !== 'YOUTUBE') continue;
                const platform = account.type.toLowerCase();
                const mapped = (account.channels || [{ id: account.id, name: account.name }]).map(ch => ({
                    channelId: ch.id,
                    channelTitle: ch.name || account.name,
                    thumbnail: ch.pictureUrl || account.pictureUrl || (platform === 'facebook' ? 'https://www.facebook.com/favicon.ico' : 'https://www.youtube.com/favicon.ico'),
                    platform: platform,
                    socialAccountId: account.id,
                    bundleInstanceId: inst.id // Store which key this belongs to
                }));
                allChannels = allChannels.concat(mapped);
            }
        } catch (err) {
            console.error(`[Bundle] Error checking Key ${inst.id}:`, err.message);
        }
    }
    await saveUsage();
    return allChannels;
}

export async function uploadVideo(instanceId, filePath) {
    const inst = getInstanceById(instanceId);
    if (!inst) throw new Error('Invalid Bundle instance ID');

    try {
        const teamId = await getTeamId(inst);
        if (!teamId) throw new Error('No Team ID');

        const fileBuffer = await fs.readFile(filePath);
        const fileName = path.basename(filePath);
        const isImage = /\.(jpg|jpeg|png)$/i.test(fileName);
        const mimeType = isImage ? 'image/jpeg' : 'video/mp4';

        const response = await inst.bundle.upload.uploadCreate({
            formData: {
                teamId: teamId,
                file: new Blob([fileBuffer], { type: mimeType })
            }
        });

        if (response && response.id) return response.id;
        return null;
    } catch (error) {
        console.error('[Bundle] Error uploading video:', error);
        throw error;
    }
}

export async function postToFacebook(instanceId, channelId, mediaId, text, scheduledDate = null) {
    return postToPlatform(instanceId, 'FACEBOOK', channelId, mediaId, text, scheduledDate);
}

export async function postToYoutube(instanceId, channelId, mediaId, text, scheduledDate = null) {
    return postToPlatform(instanceId, 'YOUTUBE', channelId, mediaId, text, scheduledDate);
}

async function postToPlatform(instanceId, type, channelId, mediaId, text, scheduledDate = null) {
    const inst = getInstanceById(instanceId);
    if (!inst) throw new Error('Invalid Bundle instance ID');

    try {
        const teamId = await getTeamId(inst);
        const teamRes = await inst.bundle.team.teamGetTeam({ id: teamId });
        const socialAccounts = teamRes.socialAccounts || [];

        const account = socialAccounts.find(acc =>
            acc.type === type &&
            (acc.id === channelId || (acc.channels && acc.channels.find(c => c.id === channelId)))
        );

        if (!account) throw new Error(`${type} social account not found for this channel ID`);

        // Check if we actually need to change the channel on this account
        // If type is YOUTUBE, the account might have multiple channels, our selected channelId needs to be 'set' as active.
        let needsSetChannel = false;
        if (type === 'YOUTUBE' && channelId !== account.id) {
            // Check if it's already the primary channel
            if (!account.primaryChannel || account.primaryChannel.id !== channelId) {
                needsSetChannel = true;
            }
        }

        if (needsSetChannel) {
            try {
                await inst.bundle.socialAccount.socialAccountSetChannel({
                    requestBody: { teamId, type, channelId }
                });
            } catch (setErr) {
                console.warn(`[Bundle] Warning setting channel (might be already set):`, setErr.message);
                // Continue anyway as the primary check might have missed a state or it's harmless
            }
        }

        const [rawTitle, ...descParts] = (text || '').split('\n\n');
        const rawDescription = descParts.join('\n\n');
        const safeTitle = (rawTitle || 'new nusic video').substring(0, 100);
        const safeText = rawDescription || '';

        const postDate = scheduledDate || new Date(Date.now() + 10000).toISOString();

        let platformData = {};
        if (type === 'FACEBOOK') {
            platformData.FACEBOOK = { text, uploadIds: [mediaId], privacy: 'PUBLIC' };
        } else {
            platformData.YOUTUBE = { type: 'VIDEO', text: safeTitle, description: safeText, uploadIds: [mediaId], privacy: 'PUBLIC' };
        }

        const response = await inst.bundle.post.postCreate({
            requestBody: {
                teamId: teamId,
                title: safeTitle,
                socialAccountTypes: [type],
                postDate: postDate,
                status: 'SCHEDULED',
                data: platformData
            }
        });

        // Update usage
        const usage = getUsageForKey(inst.key);
        usage.uploads++;
        await saveUsage();

        return {
            success: true,
            data: response,
            url: `https://bundle.social/teams/${teamId}/posts/${response.id}`
        };
    } catch (error) {
        console.error(`[Bundle] Error creating ${type} post:`, error);
        return { success: false, error: error.message };
    }
}

export async function disconnectPlatform(instanceId, type) {
    const inst = getInstanceById(instanceId);
    if (!inst) return { success: false, error: 'Invalid Instance' };

    try {
        const teamId = await getTeamId(inst);
        if (!teamId) return { success: false, error: 'No Team ID' };

        await inst.bundle.socialAccount.socialAccountDisconnect({
            requestBody: { teamId, type: type.toUpperCase() }
        });

        // Update usage
        const usage = getUsageForKey(inst.key);
        if (type.toUpperCase() === 'FACEBOOK') usage.facebookConnected = false;
        if (type.toUpperCase() === 'YOUTUBE') usage.youtubeConnected = false;
        await saveUsage();

        return { success: true };
    } catch (error) {
        console.error(`[Bundle] Error disconnecting ${type}:`, error.message);
        return { success: false, error: error.message };
    }
}
