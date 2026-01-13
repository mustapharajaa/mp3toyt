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
 * Uploads video to Facebook (simplistic version, for resumable see Meta docs)
 */
export async function uploadVideoToFacebook(accountId, accessToken, videoPath, metadata, onProgress) {
    const fileSize = fs.statSync(videoPath).size;
    const form = new FormData();
    form.append('access_token', accessToken);
    form.append('source', fs.createReadStream(videoPath));
    form.append('title', metadata.title);
    form.append('description', metadata.description);

    const response = await axios.post(`${FB_GRAPH_VIDEO_URL}/${accountId}/videos`, form, {
        headers: {
            ...form.getHeaders()
        },
        onUploadProgress: (progressEvent) => {
            if (onProgress) {
                const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                onProgress(percentCompleted);
            }
        }
    });

    return { success: true, data: response.data };
}
