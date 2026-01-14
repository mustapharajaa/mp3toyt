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
            month: currentMonth,
            channels: {} // Track specific channel activity
        };
    }
    if (!usageData[key].channels) usageData[key].channels = {};
    return usageData[key];
}

/**
 * Updates the last active timestamp for a channel to prevent auto-disconnection.
 */
export async function updateActivity(instanceId, channelId, platform) {
    await ensureUsageLoaded();
    const inst = getInstanceById(instanceId);
    if (!inst) return;

    const usage = getUsageForKey(inst.key);
    if (!usage.channels[channelId]) {
        usage.channels[channelId] = {
            platform: platform.toLowerCase(),
            lastActive: new Date().toISOString()
        };
    } else {
        usage.channels[channelId].lastActive = new Date().toISOString();
        if (platform) usage.channels[channelId].platform = platform.toLowerCase();
    }
    await saveUsage();
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
    return getConnectUrlWithRotation('FACEBOOK', redirectUrl);
}

export async function getYoutubeConnectUrl(redirectUrl) {
    return getConnectUrlWithRotation('YOUTUBE', redirectUrl);
}

async function getConnectUrlWithRotation(type, redirectUrl) {
    await ensureUsageLoaded();
    const platformField = type.toLowerCase() === 'facebook' ? 'facebookConnected' : 'youtubeConnected';

    // Try to find a slot that we THINK is free
    const availableIndices = instances
        .map((_, i) => i)
        .filter(i => {
            const usage = getUsageForKey(instances[i].key);
            return usage.uploads < 100 && !usage[platformField];
        });

    let finalIndices = availableIndices;

    if (finalIndices.length === 0) {
        console.warn(`[Bundle] All slots for ${type} are full. Identifying least active channel for displacement...`);
        let oldestTime = Infinity;
        let oldestIdx = -1;

        for (let i = 0; i < instances.length; i++) {
            const usage = getUsageForKey(instances[i].key);
            if (usage.uploads >= 100) continue; // Skip keys with no quota

            // Find the most recent activity for this platform on this key
            let lastPlatformActive = 0;
            if (usage.channels) {
                Object.values(usage.channels).forEach(ch => {
                    if (ch.platform === type.toLowerCase()) {
                        const time = new Date(ch.lastActive).getTime();
                        if (time > lastPlatformActive) lastPlatformActive = time;
                    }
                });
            }

            // If no activity found, it means it was likely just connected but Sync hasn't run yet.
            // Treat as "Just Active" (now) to protect it from premature displacement.
            if (lastPlatformActive === 0) lastPlatformActive = Date.now();

            if (lastPlatformActive < oldestTime) {
                oldestTime = lastPlatformActive;
                oldestIdx = i;
            }
        }

        if (oldestIdx !== -1) {
            const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
            if (oldestTime > fiveMinutesAgo) {
                throw new Error(`All slots for ${type} are busy with active users (less than 5 mins idle). Please try again shortly.`);
            }

            console.log(`[Bundle] Displacing least active ${type} connection on Key ${oldestIdx} (Last active: ${new Date(oldestTime).toISOString()})`);
            await disconnectPlatform(oldestIdx, type);
            finalIndices = [oldestIdx];
        } else {
            throw new Error(`No available Bundle.social slots for ${type} and no active channels to displace.`);
        }
    }

    for (const idx of finalIndices) {
        const inst = instances[idx];
        try {
            // Append inst=idx to the redirectUrl so the callback knows which one we used
            const separator = redirectUrl.includes('?') ? '&' : '?';
            const targetedRedirectUrl = `${redirectUrl}${separator}inst=${idx}`;

            const url = await getConnectUrl(inst, targetedRedirectUrl, type);
            if (url) return url;
        } catch (error) {
            // Check if it's the "Already Connected" error (Status 400)
            if (error.status === 400 && error.body && error.body.message.includes('already has a')) {
                console.warn(`[Bundle] Key ${idx} reports ${type} already connected. Updating local state and rotating...`);
                const usage = getUsageForKey(inst.key);
                usage[platformField] = true; // Sync local state
                await saveUsage();
                continue; // Try next instance
            }
            console.error(`[Bundle] Error on Key ${idx}:`, error.message);
        }
    }

    throw new Error(`All available slots for ${type} returned errors or are actually full.`);
}

async function getConnectUrl(instance, redirectUrl, type) {
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
        return response.url;
    }
    return null;
}

export async function getConnectedChannels(targetInstanceId = null) {
    // This is tricky: we need to check ALL keys to see which ones now have accounts
    // and update our usage tracking.
    await ensureUsageLoaded();
    let allChannels = [];

    const scanInstances = targetInstanceId !== null
        ? instances.filter(i => i.id === parseInt(targetInstanceId))
        : instances;

    const seenAccountIds = {}; // Tracks { accountId: instanceId } to find duplicates

    for (const inst of scanInstances) {
        try {
            const teamId = await getTeamId(inst);
            if (!teamId) continue;

            const teamRes = await inst.bundle.team.teamGetTeam({ id: teamId });
            const socialAccounts = teamRes.socialAccounts || [];
            const usage = getUsageForKey(inst.key);

            // Update connected status
            usage.facebookConnected = socialAccounts.some(acc => acc.type === 'FACEBOOK');
            usage.youtubeConnected = socialAccounts.some(acc => acc.type === 'YOUTUBE');

            // DETECT & RESOLVE DUPLICATES: Immediately free up space if this channel exists elsewhere
            await resolveSlotConflicts(inst.id, socialAccounts, seenAccountIds);

            for (const account of socialAccounts) {
                if (account.type !== 'FACEBOOK' && account.type !== 'YOUTUBE') continue;
                const platform = account.type.toLowerCase();
                const mapped = (account.channels || [{ id: account.id, name: account.name }]).map(ch => ({
                    channelId: ch.id,
                    channelTitle: ch.name || account.name,
                    thumbnail: ch.pictureUrl || account.pictureUrl || (platform === 'facebook' ? 'https://www.facebook.com/favicon.ico' : 'https://www.youtube.com/favicon.ico'),
                    platform: platform,
                    socialAccountId: account.id,
                    bundleInstanceId: inst.id
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

        // Track activity
        if (!usage.channels[channelId]) usage.channels[channelId] = {};
        usage.channels[channelId].lastActive = new Date().toISOString();

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

/**
 * Background task to sync local usage with reality on Bundle.social
 */
export async function syncWithBundle() {
    await ensureUsageLoaded();
    console.log('[Bundle Sync] Starting global synchronization...');

    const seenAccountIds = {}; // Tracks { accountId: instanceId } to find duplicates

    for (const inst of instances) {
        try {
            const teamId = await getTeamId(inst);
            if (!teamId) continue;

            const teamRes = await inst.bundle.team.teamGetTeam({ id: teamId });
            const socialAccounts = teamRes.socialAccounts || [];
            const usage = getUsageForKey(inst.key);

            // Update connected status
            const fbAcc = socialAccounts.find(acc => acc.type === 'FACEBOOK');
            const ytAcc = socialAccounts.find(acc => acc.type === 'YOUTUBE');

            usage.facebookConnected = !!fbAcc;
            usage.youtubeConnected = !!ytAcc;

            // DETECT & RESOLVE DUPLICATES
            await resolveSlotConflicts(inst.id, socialAccounts, seenAccountIds);

            // Track IDs found in reality to seed activity for new ones
            if (fbAcc) {
                if (!usage.channels[fbAcc.id]) {
                    usage.channels[fbAcc.id] = { platform: 'facebook', lastActive: new Date().toISOString() };
                } else {
                    usage.channels[fbAcc.id].platform = 'facebook';
                }
            }
            if (ytAcc) {
                const ids = [ytAcc.id, ...(ytAcc.channels || []).map(c => c.id)];
                ids.forEach(id => {
                    if (!usage.channels[id]) {
                        usage.channels[id] = { platform: 'youtube', lastActive: new Date().toISOString() };
                    } else {
                        usage.channels[id].platform = 'youtube';
                    }
                });
            }

        } catch (err) {
            console.error(`[Bundle Sync] Error syncing key ${inst.id}:`, err.message);
        }
    }
    await saveUsage();
    console.log('[Bundle Sync] Synchronization complete.');
}

/**
 * Disconnects channels that have been idle for more than 10 minutes.
 */
export async function cleanupIdleChannels() {
    await ensureUsageLoaded();
    const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
    let disconnectsCount = 0;

    for (const inst of instances) {
        const usage = getUsageForKey(inst.key);
        const channelEntries = Object.entries(usage.channels);

        // Check YouTube idle status
        if (usage.youtubeConnected) {
            const ytChannels = channelEntries.filter(([_, data]) => data.platform === 'youtube');
            // SAFETY: Only disconnect if we HAVE channel data and all are idle.
            // If ytChannels.length === 0, it means sync hasn't found them yet, so DON'T disconnect.
            const allYtIdle = ytChannels.length > 0 && ytChannels.every(([_, data]) =>
                new Date(data.lastActive).getTime() < tenMinutesAgo
            );

            if (allYtIdle) {
                console.log(`[Auto-Cleanup] Disconnecting idle YouTube on Key ${inst.id}`);
                await disconnectPlatform(inst.id, 'YOUTUBE');
                disconnectsCount++;
            }
        }

        // Check Facebook idle status
        if (usage.facebookConnected) {
            const fbChannels = channelEntries.filter(([_, data]) => data.platform === 'facebook');
            // SAFETY: Only disconnect if we HAVE channel data and all are idle.
            const allFbIdle = fbChannels.length > 0 && fbChannels.every(([_, data]) =>
                new Date(data.lastActive).getTime() < tenMinutesAgo
            );

            if (allFbIdle) {
                console.log(`[Auto-Cleanup] Disconnecting idle Facebook on Key ${inst.id}`);
                await disconnectPlatform(inst.id, 'FACEBOOK');
                disconnectsCount++;
            }
        }
    }

    if (disconnectsCount > 0) {
        console.log(`[Auto-Cleanup] Cleaned up ${disconnectsCount} idle social accounts.`);
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

        // Update usage and clear associated channels
        const usage = getUsageForKey(inst.key);
        const typeUpper = type.toUpperCase();

        if (typeUpper === 'FACEBOOK') {
            usage.facebookConnected = false;
            // Remove FB channel IDs
            Object.entries(usage.channels).forEach(([id, data]) => {
                if (data.platform === 'facebook') delete usage.channels[id];
            });
        }
        if (typeUpper === 'YOUTUBE') {
            usage.youtubeConnected = false;
            // Remove YT channel IDs
            Object.entries(usage.channels).forEach(([id, data]) => {
                if (data.platform === 'youtube') delete usage.channels[id];
            });
        }
        await saveUsage();

        return { success: true };
    } catch (error) {
        console.error(`[Bundle] Error disconnecting ${type}:`, error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Shared helper to detect and prune redundant channel connections across multiple API keys.
 */
async function resolveSlotConflicts(currentIdx, socialAccounts, seenAccountIds) {
    for (const acc of socialAccounts) {
        if (seenAccountIds[acc.id] !== undefined) {
            const oldIdx = seenAccountIds[acc.id];
            console.log(`[Bundle Sync] Redundant account ${acc.id} (${acc.type}) found on Key ${currentIdx}. Disconnecting from Key ${oldIdx} to free slot...`);
            // Disconnect from the OLD instance
            await disconnectPlatform(oldIdx, acc.type);
        }
        seenAccountIds[acc.id] = currentIdx;
    }
}
