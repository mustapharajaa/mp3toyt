// Correct import based on package inspection
import { Bundlesocial } from 'bundlesocial';
import fs from 'fs/promises';
import path from 'path';

// Fix for "does not provide an export named 'BundleSocial'" if it happens again:
// It might be a default export in some versions.
const apiKey = process.env.BUNDLE_API_KEY;
if (!apiKey) console.warn('[Bundle] BUNDLE_API_KEY is missing in .env');

const bundle = new Bundlesocial(apiKey);

// Cache team ID
let cachedTeamId = null;

async function getTeamId() {
    if (cachedTeamId) return cachedTeamId;
    try {
        // Correct property from debug: "items"
        const response = await bundle.team.teamGetList();
        if (response && response.items && response.items.length > 0) {
            cachedTeamId = response.items[0].id;
            console.log('[Bundle] Using Team ID:', cachedTeamId);
            return cachedTeamId;
        }

        // If we found nothing, try to create one
        console.log('[Bundle] No teams found. Creating team...');
        const created = await bundle.team.teamCreateTeam({
            requestBody: { name: 'MP3toYT Team' }
        });
        if (created && created.id) {
            cachedTeamId = created.id;
            return cachedTeamId;
        }
        return null;
    } catch (error) {
        // Handle 403 Social sets limit reached - This usually means there IS a team but we couldn't list it 
        // OR the response structure is still tricky.
        if (error.status === 403 && error.body && error.body.message.includes('Limit is 1')) {
            console.warn('[Bundle] Team creation limit reached. Retrying to find the existing team via Organization...');
            try {
                const org = await bundle.organization.organizationGetOrganization();
                if (org && org.teams && org.teams.length > 0) {
                    cachedTeamId = org.teams[0].id;
                    return cachedTeamId;
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
 * Generates the URL for a user to connect their Facebook account.
 */
export async function getFacebookConnectUrl(redirectUrl) {
    try {
        const teamId = await getTeamId();
        if (!teamId) return null;

        const response = await bundle.socialAccount.socialAccountConnect({
            requestBody: {
                teamId: teamId,
                type: 'FACEBOOK',
                redirectUrl: redirectUrl
            }
        });

        if (response && response.url) {
            return response.url;
        }
        return null;
    } catch (error) {
        if (error.body && error.body.issues) console.error('[Bundle] Connect URL Error Issues:', JSON.stringify(error.body.issues, null, 2));
        console.error('[Bundle] Error generating connect URL:', error);
        return null;
    }
}

/**
 * Fetches connected Facebook accounts and their pages (Channels).
 */
export async function getFacebookChannels() {
    try {
        const teamId = await getTeamId();
        if (!teamId) return [];

        const teamRes = await bundle.team.teamGetTeam({ id: teamId });
        const socialAccounts = teamRes.socialAccounts || [];
        const fbAccounts = socialAccounts.filter(acc => acc.type === 'FACEBOOK');

        let allChannels = [];
        for (const account of fbAccounts) {
            if (account.channels && account.channels.length > 0) {
                const mapped = account.channels.map(ch => ({
                    channelId: ch.id,
                    channelTitle: ch.name || account.name,
                    thumbnail: ch.pictureUrl || account.pictureUrl || 'https://www.facebook.com/favicon.ico',
                    platform: 'facebook',
                    socialAccountId: account.id
                }));
                allChannels = allChannels.concat(mapped);
            } else {
                allChannels.push({
                    channelId: account.id,
                    channelTitle: account.name,
                    thumbnail: account.pictureUrl || 'https://www.facebook.com/favicon.ico',
                    platform: 'facebook',
                    socialAccountId: account.id
                });
            }
        }
        return allChannels;
    } catch (error) {
        if (error.body && error.body.issues) console.error('[Bundle] Channel List Error Issues:', JSON.stringify(error.body.issues, null, 2));
        console.error('[Bundle] Error listing channels:', error);
        return [];
    }
}

async function ensureActiveChannel(socialAccountId, channelId) {
    try {
        const teamId = await getTeamId();
        const requestBody = {
            teamId: teamId,
            type: 'FACEBOOK',
            channelId: channelId
        };
        console.log('[Bundle] Setting active channel:', JSON.stringify(requestBody));

        await bundle.socialAccount.socialAccountSetChannel({
            requestBody: requestBody
        });
    } catch (error) {
        if (error.body && error.body.issues) console.error('[Bundle] Set Channel Error Issues:', JSON.stringify(error.body.issues, null, 2));
        console.warn('[Bundle] Failed to set active channel, might already be set or invalid:', error.message);
    }
}


/**
 * Uploads a video file to Bundle.social
 */
export async function uploadVideo(filePath) {
    try {
        const teamId = await getTeamId();
        if (!teamId) throw new Error('No Team ID');

        const fileBuffer = await fs.readFile(filePath);
        const fileSizeMb = (fileBuffer.length / (1024 * 1024)).toFixed(2);
        const fileName = path.basename(filePath);
        const isImage = /\.(jpg|jpeg|png)$/i.test(fileName);
        const mimeType = isImage ? 'image/jpeg' : 'video/mp4';

        console.log(`[Bundle] Starting upload: ${fileName} (${fileSizeMb} MB)...`);
        const startTime = Date.now();

        const response = await bundle.upload.uploadCreate({
            formData: {
                teamId: teamId,
                file: new Blob([fileBuffer], { type: mimeType })
            }
        });

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Bundle] Upload finished in ${duration}s. Media ID: ${response.id}`);

        if (response && response.id) {
            return response.id;
        }

        return null;
    } catch (error) {
        if (error.body && error.body.issues) console.error('[Bundle] Upload Error Issues:', JSON.stringify(error.body.issues, null, 2));
        console.error('[Bundle] Error uploading video:', error);
        throw error;
    }
}

/**
 * Creates a post on Facebook
 */
export async function postToFacebook(channelId, mediaId, text, scheduledDate = null) {
    try {
        const teamId = await getTeamId();
        const teamRes = await bundle.team.teamGetTeam({ id: teamId });
        const socialAccounts = teamRes.socialAccounts || [];

        const account = socialAccounts.find(acc =>
            acc.type === 'FACEBOOK' &&
            (acc.id === channelId || (acc.channels && acc.channels.find(c => c.id === channelId)))
        );

        if (!account) throw new Error('Social account not found for this channel ID');

        // Set active channel if it's a sub-channel
        // We do this but ignore failures if the post itself works fine
        if (channelId !== account.id) {
            await ensureActiveChannel(account.id, channelId);
        }

        // Handle empty or whitespace text
        const safeText = text && text.trim() ? text : 'New video upload from MP3toYT';
        const safeTitle = safeText.substring(0, 50).trim() || 'New Video Post';

        // Use user-provided date or create a small buffer (10 seconds) for extra safety
        let postDate = scheduledDate;
        if (!postDate) {
            postDate = new Date(Date.now() + 10000).toISOString();
        }

        const response = await bundle.post.postCreate({
            requestBody: {
                teamId: teamId,
                title: safeTitle,
                socialAccountTypes: ['FACEBOOK'],
                postDate: postDate,
                status: 'SCHEDULED',
                data: {
                    FACEBOOK: {
                        text: safeText,
                        uploadIds: [mediaId],
                        privacy: 'PUBLIC'
                    }
                }
            }
        });

        // The live URL isn't immediately available for scheduled posts.
        // We link to the Bundle.social dashboard instead so UI link isn't broken.
        return {
            success: true,
            data: response,
            url: `https://bundle.social/teams/${teamId}/posts/${response.id}`
        };
    } catch (error) {
        if (error.body && error.body.issues) console.error('[Bundle] Post Validation Errors:', JSON.stringify(error.body.issues, null, 2));
        console.error('[Bundle] Error creating post:', error);
        return { success: false, error: error.message };
    }
}
