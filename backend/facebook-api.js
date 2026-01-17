import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import { FACEBOOK_TOKENS_PATH, FACEBOOK_CREDENTIALS_PATH } from './config.js';

const FB_GRAPH_URL = 'https://graph.facebook.com/v20.0';
const FB_GRAPH_VIDEO_URL = 'https://graph-video.facebook.com/v20.0';

/**
 * Loads Facebook Credentials (appId, appSecret)
 */
async function loadFacebookCredentials() {
    try {
        if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
            return { appId: process.env.FACEBOOK_APP_ID, appSecret: process.env.FACEBOOK_APP_SECRET };
        }
        if (await fs.pathExists(FACEBOOK_CREDENTIALS_PATH)) {
            const creds = await fs.readJson(FACEBOOK_CREDENTIALS_PATH);
            if (creds && creds.appId && creds.appSecret) return creds;
        }
    } catch (e) {
        console.warn('[Facebook] Failed to load credentials:', e.message);
    }
    return null;
}

/**
 * Generates the Facebook OAuth URL
 */
export async function getFacebookAuthUrl(redirectUri) {
    const creds = await loadFacebookCredentials();
    if (!creds || !creds.appId) return null; // Return null instead of throwing

    const scopes = [
        'pages_show_list',
        'pages_read_engagement',
        'pages_manage_posts',
        'publish_video',
        'public_profile'
    ].join(',');

    return `https://www.facebook.com/v20.0/dialog/oauth?client_id=${creds.appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&response_type=code`;
}

/**
 * Exchanges OAuth code for an access token
 */
export async function getFacebookTokenFromCode(code, redirectUri) {
    const creds = await loadFacebookCredentials();
    if (!creds || !creds.appId || !creds.appSecret) throw new Error('Facebook App credentials not configured.');

    const response = await axios.get(`${FB_GRAPH_URL}/oauth/access_token`, {
        params: {
            client_id: creds.appId,
            client_secret: creds.appSecret,
            redirect_uri: redirectUri,
            code: code
        }
    });

    return response.data; // { access_token, token_type, expires_in }
}

/**
 * Gets user and their pages info
 */
export async function getFacebookUserInfo(accessToken) {
    // Get User Info
    const userRes = await axios.get(`${FB_GRAPH_URL}/me`, {
        params: {
            fields: 'id,name,picture',
            access_token: accessToken
        }
    });

    // Get User's Pages
    const pagesRes = await axios.get(`${FB_GRAPH_URL}/me/accounts`, {
        params: {
            access_token: accessToken
        }
    });

    return {
        user: userRes.data,
        pages: pagesRes.data.data // Array of pages with their own access_tokens
    };
}

/**
 * Saves Facebook tokens to JSON
 */
export async function saveFacebookToken(accountId, accountTitle, tokenData, type = 'user') {
    let tokens = [];
    if (await fs.pathExists(FACEBOOK_TOKENS_PATH)) {
        tokens = await fs.readJson(FACEBOOK_TOKENS_PATH);
    }

    const index = tokens.findIndex(t => t.accountId === accountId);
    if (index > -1) {
        tokens[index] = { accountId, accountTitle, ...tokenData, type, updatedAt: new Date().toISOString() };
    } else {
        tokens.push({ accountId, accountTitle, ...tokenData, type, updatedAt: new Date().toISOString() });
    }

    await fs.writeJson(FACEBOOK_TOKENS_PATH, tokens, { spaces: 2 });
}

/**
 * Uploads video to Facebook directly using Graph API
 */
export async function uploadVideoToFacebook(targetId, accessToken, videoPath, metadata, onProgress) {
    try {
        let finalTargetId = targetId;

        // If target is 'me', let's resolve the actual ID first (more robust)
        if (targetId === 'me') {
            try {
                const meRes = await axios.get(`${FB_GRAPH_URL}/me?fields=id&access_token=${accessToken}`);
                if (meRes.data && meRes.data.id) {
                    finalTargetId = meRes.data.id;
                    console.log(`[Facebook] Resolved 'me' to User ID: ${finalTargetId}`);
                }
            } catch (e) {
                console.warn('[Facebook] Failed to resolve User ID, falling back to "me"', e.message);
            }
        }

        const stats = await fs.stat(videoPath);
        const fileSize = stats.size;
        const videoBuffer = await fs.readFile(videoPath);
        const videoBlob = new Blob([videoBuffer], { type: 'video/mp4' });

        const form = new FormData();
        form.append('access_token', accessToken);
        form.append('source', videoBlob, path.basename(videoPath));
        form.append('description', metadata.description || metadata.title || '');

        if (metadata.title) {
            form.append('title', metadata.title);
        }

        console.log(`[Facebook] Initiating direct upload to ${finalTargetId} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

        const response = await axios.post(`${FB_GRAPH_VIDEO_URL}/${finalTargetId}/videos`, form, {
            headers: {
                'Content-Type': 'multipart/form-data'
            },
            onUploadProgress: (progressEvent) => {
                if (onProgress && progressEvent.total) {
                    const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                    onProgress(percentCompleted);
                }
            }
        });

        console.log(`[Facebook] Upload successful. ID: ${response.data.id}`);
        return { success: true, data: response.data };
    } catch (error) {
        console.error('[Facebook] Direct upload failed:', error.response?.data || error.message);
        const fbError = error.response?.data?.error;
        let errorMessage = error.message;

        if (fbError) {
            errorMessage = `(#${fbError.code}) ${fbError.message}`;
            if (fbError.code === 100 && targetId === 'me') {
                errorMessage += " - Note: Posting to personal profiles is restricted by Facebook. Try using a Page instead.";
            }
        }

        return {
            success: false,
            error: errorMessage
        };
    }
}
