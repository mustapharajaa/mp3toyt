// This file will handle YouTube API authentication and live event creation
import fs from 'fs-extra';
import { google } from 'googleapis';
// Track active FFmpeg processes (Stubbed here to prevent circular dependency with main.js)
const ffmpegActiveKeys = new Set();
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as wait } from 'timers/promises';

import { SCOPES, TOKEN_PATH, CREDENTIALS_PATH, ACTIVE_STREAMS_PATH } from './config.js';


// These are now loaded from environment variables to support production deployment
const DEFAULT_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI;
const MP3TOYT_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI_MP3TOYT;


function loadCredentials() {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        throw new Error('credentials.json file is missing.');
    }
    const content = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    const credentials = JSON.parse(content);

    if (!credentials || (!credentials.installed && !credentials.web)) {
        throw new Error('credentials.json is empty or invalid. Please download it from Google Cloud Console and replace the placeholder.');
    }

    return credentials;
}

// Import file system functions to read channel data
// getAllChannels import removed as it serves no purpose here and caused a dependency error

// --- Caching Layer ---
// Cache for idle streams, keyed by channelId
const channelStreamCaches = {};
// ffmpegActiveKeys is imported from stream_state.js

/**
 * Gets an idle stream from cache for the specified channel
 * @param {string} channelId - The YouTube channel ID
 * @returns {Object|null} The idle stream or null if none available
 */
function getIdleStreamFromCache(channelId, excludeStreamId = null) {
    const cache = channelStreamCaches[channelId];
    if (!cache || !cache.idle || cache.idle.length === 0) {
        return null;
    }

    let stream = null;
    let streamIndex = -1;

    // Find the index of a suitable stream
    if (excludeStreamId) {
        streamIndex = cache.idle.findIndex(s => s.id !== excludeStreamId);
        if (streamIndex !== -1) {
            console.log(`[YouTubeAPI_Cache] Found an idle stream, excluding the busy one (${excludeStreamId}).`);
        }
    } else {
        streamIndex = 0; // Just get the first one if no exclusion is needed
    }

    // If no suitable stream was found
    if (streamIndex === -1) {
        console.log(`[YouTubeAPI_Cache] No suitable idle streams available in cache for channel ${channelId}.`);
        return null;
    }

    // A suitable stream was found, move it from idle to active
    stream = cache.idle.splice(streamIndex, 1)[0];
    cache.active = cache.active || [];
    cache.active.push(stream);

    console.log(`[YouTubeAPI_Cache] Retrieved stream ${stream.id} from cache for channel ${channelId}`);
    return stream;
}

/**
 * Adds a stream to the cache
 * @param {Object} stream - The stream to add
 * @param {string} channelId - The YouTube channel ID
 */
function addStreamToCache(stream, channelId) {
    if (!stream || !stream.id) {
        console.error('[YouTubeAPI_Cache] Cannot add invalid stream to cache');
        return;
    }

    // Initialize cache for channel if it doesn't exist
    if (!channelStreamCaches[channelId]) {
        channelStreamCaches[channelId] = { idle: [], active: [] };
    }

    // Add to idle cache
    channelStreamCaches[channelId].idle.push(stream);

    console.log(`[YouTubeAPI_Cache] Added stream ${stream.id} to cache for channel ${channelId}`);
}


/**
 * Marks a stream as active in the cache
 * @param {Object} stream - The stream to mark as active
 * @param {string} channelId - The YouTube channel ID
 */
export function markStreamAsActive(stream, channelId) {
    if (!stream || !stream.id) {
        console.error('[YouTubeAPI_Cache] Cannot mark invalid stream as active');
        return;
    }

    if (!channelStreamCaches[channelId]) {
        channelStreamCaches[channelId] = { idle: [], active: [] };
    }

    // Remove from idle cache if it exists there
    if (channelStreamCaches[channelId].idle) {
        channelStreamCaches[channelId].idle = channelStreamCaches[channelId].idle.filter(s => s.id !== stream.id);
    }

    // Add to active cache if not already there
    if (!channelStreamCaches[channelId].active.some(s => s.id === stream.id)) {
        channelStreamCaches[channelId].active.push(stream);
        console.log(`[YouTubeAPI_Cache] Marked stream ${stream.id} as active for channel ${channelId}`);
    }
}

/**
 * Returns a stream to the idle cache
 * @param {Object} stream - The stream to return to the idle cache
 * @param {string} channelId - The YouTube channel ID
 */
export function returnStreamToCache(stream, channelId) {
    if (!stream || !stream.id) {
        console.error('[YouTubeAPI_Cache] Cannot return invalid stream to cache');
        return;
    }

    if (!channelStreamCaches[channelId]) {
        channelStreamCaches[channelId] = { idle: [], active: [] };
    }

    // Remove from active cache if it exists there
    if (channelStreamCaches[channelId].active) {
        channelStreamCaches[channelId].active = channelStreamCaches[channelId].active.filter(s => s.id !== stream.id);
    }

    // Add to idle cache if not already there
    if (!channelStreamCaches[channelId].idle.some(s => s.id === stream.id)) {
        channelStreamCaches[channelId].idle.push(stream);
        console.log(`[YouTubeAPI_Cache] Returned stream ${stream.id} to idle cache for channel ${channelId}`);
    }
}




/**
 * Get token data for a specific channel
 * @param {string} channelId - The channel ID to get token for
 * @returns {Object|null} Token data or null if not found
 */
export function getTokenForChannel(channelId) {
    try {


        if (!fs.existsSync(TOKEN_PATH)) {
            return null;
        }

        const fileContent = fs.readFileSync(TOKEN_PATH, 'utf8');
        const allAuthentications = JSON.parse(fileContent);

        if (!Array.isArray(allAuthentications)) {
            console.error('[YouTubeAPI] Token file does not contain an array of authentications');
            return null;
        }

        const auth = allAuthentications.find(auth => auth.channelId === channelId);

        if (!auth) {
            return null;
        }

        return auth;
    } catch (error) {
        console.error(`[YouTubeAPI] Error getting token for channel ${channelId}:`, error);
        return null;
    }
}

/**
 * Authorizes with YouTube API using OAuth2 tokens for a specific channel
 * @param {string} channelId - The channel ID to authorize
 * @returns {OAuth2Client} The authorized OAuth2 client
 * @throws {Error} If no matching authentication is found or if there are any issues with the token
 */
function isTokenExpiredOrExpiringSoon(token) {
    // If no expiry date, assume it's expired
    if (!token.expiry_date) return true;

    // If token is expired, consider it expired
    return token.expiry_date < Date.now();
}

export async function authorize(channelId) {
    if (!channelId) {
        const errorMsg = 'Channel ID is required for authorization';
        console.error(`[YouTubeAPI] ${errorMsg}`);
        throw new Error(errorMsg);
    }

    console.log(`[YouTubeAPI] Authorizing with channel ID: ${channelId}`);
    const credentials = loadCredentials();
    const config = credentials.installed || credentials.web;
    if (!config) throw new Error('Invalid credentials format: missing "installed" or "web" property.');
    const { client_secret, client_id } = config;

    // Use the redirect URI from environment variable
    let baseUrl = (process.env.BASE_URL || 'http://localhost:8000').replace(/\/$/, ''); // Remove trailing slash if present

    // Force HTTPS for production domain to prevent OAuth mismatch errors
    if (baseUrl.includes('test.liveenity.com') && baseUrl.startsWith('http://')) {
        console.log('[YouTubeAPI] Detected http protocol for production domain. Upgrading to https.');
        baseUrl = baseUrl.replace('http://', 'https://');
    }

    const redirectUri = `${baseUrl}/oauth2callback`;
    console.log(`[YouTubeAPI] Using redirect URI for authorization: ${redirectUri}`);

    if (!fs.existsSync(TOKEN_PATH)) {
        const errorMsg = 'No authentication tokens found. Please connect your YouTube channel first.';
        console.error(`[YouTubeAPI] ${errorMsg}`);
        throw new Error(errorMsg);
    }

    try {
        const fileContent = fs.readFileSync(TOKEN_PATH, 'utf8');
        const allAuthentications = JSON.parse(fileContent);

        if (!Array.isArray(allAuthentications) || allAuthentications.length === 0) {
            const errorMsg = 'No valid authentications found. Please connect your YouTube channel.';
            console.error(`[YouTubeAPI] ${errorMsg}`);
            throw new Error(errorMsg);
        }

        console.log(`[YouTubeAPI] Found ${allAuthentications.length} authentication entries in token file`);

        // Find the exact match for the specified channel ID
        const authIndex = allAuthentications.findIndex(auth => auth.channelId === channelId);

        if (authIndex === -1) {
            const errorMsg = `No authentication found for channel ID: ${channelId}. Please reconnect this channel.`;
            console.error(`[YouTubeAPI] ${errorMsg}`);
            throw new Error(errorMsg);
        }

        const authToUse = allAuthentications[authIndex];
        console.log(`[YouTubeAPI] Found authentication for channel: ${authToUse.channelTitle} (${authToUse.channelId})`);

        const token = authToUse.tokens;
        if (!token) {
            const errorMsg = `Authentication found for channel ${channelId} but no token data is available.`;
            console.error(`[YouTubeAPI] ${errorMsg}`);
            throw new Error(errorMsg);
        }

        // Check if refresh token exists
        if (!token.refresh_token) {
            console.warn(`[YouTubeAPI] No refresh token found for channel ${authToUse.channelTitle || authToUse.channelId}.`);
            console.warn('[YouTubeAPI] This authentication may expire and require reconnection.');
        }

        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

        // Set up the OAuth2 client with the token
        oAuth2Client.setCredentials(token);

        // The client is now configured. The Google Auth Library will handle the token.
        // API calls will fail if the token is invalid and cannot be refreshed.
        console.log(`[YouTubeAPI] OAuth2 client configured for channel: ${authToUse.channelTitle}.`);
        return oAuth2Client;
    } catch (err) {
        console.error('[YouTubeAPI] Error reading, parsing, or processing token file:', err.message);
        throw new Error('Invalid or corrupt OAuth token file. Please reconnect your YouTube channel.');
    }
}

// Helper to run OAuth2 flow (one-time setup)
export function getAuthUrl(redirectUri, state = null) {
    const credentials = loadCredentials();
    const config = credentials.installed || credentials.web;
    if (!config) throw new Error('Invalid credentials format: missing "installed" or "web" property.');
    const { client_secret, client_id } = config;

    // Force HTTPS for production domain to prevent OAuth mismatch errors
    if (redirectUri && redirectUri.includes('test.liveenity.com') && redirectUri.startsWith('http://')) {
        console.log('[YouTubeAPI] Detected http protocol in getAuthUrl. Upgrading to https.');
        redirectUri = redirectUri.replace('http://', 'https://');
    }

    const oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirectUri // The caller is responsible for providing the correct redirectUri
    );

    const authUrlOptions = {
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
        include_granted_scopes: true,
    };

    if (state) {
        authUrlOptions.state = state;
    }

    const authUrl = oAuth2Client.generateAuthUrl(authUrlOptions);

    console.log(`[YouTubeAPI] Generating auth URL with redirect_uri: ${redirectUri}, state: ${state}`);
    console.log(`[YouTubeAPI] Generated auth URL: ${authUrl}`);

    return authUrl;
}

// Function to save token to the token file
export async function saveToken(channelId, channelTitle, tokens) {
    try {
        // Read existing tokens
        let allTokens = [];
        if (fs.existsSync(TOKEN_PATH)) {
            const fileContent = fs.readFileSync(TOKEN_PATH, 'utf8');
            if (fileContent.trim()) {
                allTokens = JSON.parse(fileContent);
                if (!Array.isArray(allTokens)) {
                    allTokens = [];
                }
            }
        }

        // Check if token for this channel already exists
        const existingTokenIndex = allTokens.findIndex(t => t.channelId === channelId);
        const tokenData = {
            channelId,
            channelTitle,
            tokens,
            createdAt: new Date().toISOString()
        };

        if (existingTokenIndex >= 0) {
            // Update existing token
            allTokens[existingTokenIndex] = tokenData;
            console.log(`[YouTubeAPI] Updated token for channel: ${channelTitle} (${channelId})`);
        } else {
            // Add new token
            allTokens.push(tokenData);
            console.log(`[YouTubeAPI] Added new token for channel: ${channelTitle} (${channelId})`);
        }

        // Save back to file
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(allTokens, null, 2));
        console.log(`[YouTubeAPI] Token for channel ${channelTitle} saved successfully.`);
    } catch (error) {
        console.error('[YouTubeAPI] Error saving token:', error.message);
        throw new Error('Failed to save token');
    }
}

// Function to save the token obtained from the OAuth2 flow
export async function saveTokenFromCode(code, redirectUri, state = null) {
    console.log(`[YouTubeAPI] Exchanging code for token with redirect_uri: ${redirectUri}, state: ${state || 'none'}`);

    try {
        const credentials = loadCredentials();
        const config = credentials.installed || credentials.web;
        if (!config) throw new Error('Invalid credentials format in saveTokenFromCode.');
        const { client_secret, client_id } = config;

        console.log(`[YouTubeAPI] Using redirect_uri from caller: ${redirectUri}`);

        // Force HTTPS for production domain to prevent OAuth mismatch errors
        if (redirectUri && redirectUri.includes('test.liveenity.com') && redirectUri.startsWith('http://')) {
            console.log('[YouTubeAPI] Detected http protocol in saveTokenFromCode. Upgrading to https.');
            redirectUri = redirectUri.replace('http://', 'https://');
        }

        // Create OAuth2 client with the correct redirect URI provided by the caller
        const oAuth2Client = new google.auth.OAuth2(
            client_id,
            client_secret,
            redirectUri
        );

        // Exchange the code for tokens
        const { tokens } = await oAuth2Client.getToken({
            code,
            redirect_uri: redirectUri,
            client_id,
            client_secret
        });

        console.log('[YouTubeAPI] Successfully obtained tokens');
        oAuth2Client.setCredentials(tokens);

        // Get channel info
        const youtube = google.youtube({ version: 'v3', auth: oAuth2Client });
        const meResponse = await youtube.channels.list({
            part: 'snippet',
            mine: true,
            maxResults: 1
        });

        if (!meResponse.data.items || meResponse.data.items.length === 0) {
            throw new Error('No YouTube channel found for the authenticated user');
        }

        const channel = meResponse.data.items[0];
        const channelId = channel.id;
        const channelTitle = channel.snippet.title;
        const channelThumbnail = channel.snippet.thumbnails.default.url;

        // Save the token
        await saveToken(channelId, channelTitle, tokens);

        return { tokens, channelId, channelTitle, channelThumbnail };
    } catch (error) {
        console.error('[YouTubeAPI] Error in saveTokenFromCode:', error.response?.data?.error || error.message);
        console.error('Error details:', {
            error: error.response?.data?.error,
            error_description: error.response?.data?.error_description,
            error_uri: error.response?.data?.error_uri
        });

        if (error.response?.data?.error === 'redirect_uri_mismatch') {
            throw new Error('The redirect URI in the request does not match the authorized redirect URIs. Please check your Google Cloud Console settings.');
        }

        if (error.response) {
            console.error('Error details:', error.response.data);
        }
        throw error;
    }
}

// Helper function to check if the token is valid and contains a refresh token
export function checkTokenValidity() {
    if (!fs.existsSync(TOKEN_PATH)) {
        return { valid: false, reason: 'Token file does not exist' };
    }

    try {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
        if (!token.refresh_token) {
            return { valid: false, reason: 'No refresh token in file' };
        }
        return { valid: true };
    } catch (err) {
        return { valid: false, reason: 'Invalid token file: ' + err.message };
    }
}

// Function to clear the token file, forcing re-authentication
export function clearTokenFile() {
    if (fs.existsSync(TOKEN_PATH)) {
        try {
            fs.unlinkSync(TOKEN_PATH);
            console.log('[YouTubeAPI] Token file cleared.'); // Ensure log is here
            return true;
        } catch (err) {
            console.error('Error deleting token file:', err);
            return false;
        }
    }
    return true; // Already doesn't exist
}

// Function to clear the application's internal stream cache
export function clearAppStreamCache() {
    console.log('[YouTubeAPI_Cache] Clearing all internal channel stream caches.');
    for (const channelId in channelStreamCaches) {
        delete channelStreamCaches[channelId];
    }
    return { success: true, message: 'Application stream cache cleared for all channels.' };
}

// Function to delete broadcasts bound to a specific stream ID
export async function deleteBroadcastsBoundToStream(streamId, channelId) {
    console.log(`[YouTubeAPI] Attempting to delete broadcasts bound to stream: ${streamId}`);
    let successCount = 0;
    let totalAttempted = 0;
    const deletionDetails = [];

    try {
        const auth = await authorize(channelId);
        const youtube = google.youtube({ version: 'v3', auth });

        // List broadcasts bound to this stream
        const listResponse = await youtube.liveBroadcasts.list({
            part: 'id,snippet,status,contentDetails',
            boundStreamId: streamId,
            mine: true, // Added required filter
            maxResults: 50 // Get up to 50 broadcasts
        });

        const broadcasts = listResponse.data.items;
        totalAttempted = broadcasts ? broadcasts.length : 0;

        if (!broadcasts || broadcasts.length === 0) {
            console.log(`[YouTubeAPI] No broadcasts found bound to stream ${streamId}.`);
            return {
                success: true,
                message: `No broadcasts found bound to stream ${streamId}.`,
                successCount: 0,
                totalAttempted: 0,
                details: []
            };
        }

        console.log(`[YouTubeAPI] Found ${broadcasts.length} broadcast(s) bound to stream ${streamId}. Attempting deletion.`);

        for (const broadcast of broadcasts) {
            const broadcastId = broadcast.id;
            const broadcastTitle = broadcast.snippet.title;
            try {
                if (broadcast.status.lifeCycleStatus === 'active') {
                    console.warn(`[YouTubeAPI] Cannot delete active broadcast ${broadcastId} (${broadcastTitle}). Skipping.`);
                    deletionDetails.push({ broadcastId, title: broadcastTitle, status: 'skipped_active', message: 'Cannot delete active broadcast.' });
                    continue;
                }
                await youtube.liveBroadcasts.delete({ id: broadcastId });
                console.log(`[YouTubeAPI] Successfully deleted broadcast: ${broadcastId} (${broadcastTitle})`);
                successCount++;
                deletionDetails.push({ broadcastId, title: broadcastTitle, status: 'deleted', message: 'Successfully deleted.' });
            } catch (deleteError) {
                console.error(`[YouTubeAPI] Error deleting broadcast ${broadcastId} (${broadcastTitle}):`, deleteError.message);
                deletionDetails.push({ broadcastId, title: broadcastTitle, status: 'error', message: deleteError.message });
            }
        }

        return {
            success: successCount === totalAttempted, // True if all found broadcasts were successfully processed (deleted or intentionally skipped if logic changes)
            message: `Processed ${totalAttempted} broadcast(s) for stream ${streamId}. Deleted: ${successCount}. Failed/Skipped: ${totalAttempted - successCount}.`,
            successCount: successCount,
            totalAttempted: totalAttempted,
            details: deletionDetails
        };

    } catch (error) {
        console.error(`[YouTubeAPI] Error listing or processing broadcasts for stream ${streamId}:`, error.message);
        // If listing fails, totalAttempted might be 0, but it's an error state.
        return {
            success: false,
            message: `Failed to list or process broadcasts for stream ${streamId}: ${error.message}`,
            errorDetails: error,
            successCount: 0,
            totalAttempted: totalAttempted, // Could be 0 if list failed, or some number if list succeeded but loop failed
            details: deletionDetails
        };
    }
}

// Function to delete a stream key and its associated broadcasts
export async function deleteStreamKey(streamId, channelId) {
    console.log(`[YouTubeAPI] Attempting to delete stream with ID: ${streamId}`);
    let broadcastsDeletedCount = 0;
    let broadcastsAttemptedCount = 0;
    let broadcastProcessingSuccess = false;

    try {
        const auth = await authorize(channelId);
        const youtube = google.youtube({ version: 'v3', auth });

        const broadcastResult = await deleteBroadcastsBoundToStream(streamId, channelId);
        console.log(`[YouTubeAPI] Broadcast deletion result for stream ${streamId}:`, broadcastResult);
        broadcastsDeletedCount = broadcastResult.successCount || 0;
        broadcastsAttemptedCount = broadcastResult.totalAttempted || 0;
        broadcastProcessingSuccess = broadcastResult.success;

        await youtube.liveStreams.delete({
            id: streamId
        });
        console.log(`[YouTubeAPI] Successfully deleted stream key: ${streamId}`);
        return {
            success: true,
            message: `Successfully deleted stream key ${streamId}. Broadcasts: ${broadcastsDeletedCount} deleted / ${broadcastsAttemptedCount} attempted.`,
            broadcastsDeleted: broadcastsDeletedCount,
            broadcastsAttempted: broadcastsAttemptedCount,
            broadcastProcessingSuccess: broadcastProcessingSuccess
        };

    } catch (error) {
        console.error(`[YouTubeAPI] Error deleting stream key ${streamId}:`, error.message);
        const requiresManual = error.message?.includes('deletion is not allowed') || error.message?.includes('permission denied');
        return {
            success: false,
            message: `Failed to delete stream key ${streamId}: ${error.message}${requiresManual ? ' (Manual deletion may be required)' : ''}`,
            errorDetails: error.message,
            requiresManualDeletion: requiresManual,
            broadcastsDeleted: broadcastsDeletedCount, // Still report what happened to broadcasts
            broadcastsAttempted: broadcastsAttemptedCount,
            broadcastProcessingSuccess: broadcastProcessingSuccess
        };
    }
}

// Function to transition a broadcast's status
export async function getStreamStatus(auth, streamId) {
    const youtube = google.youtube({ version: 'v3', auth });
    try {
        const response = await youtube.liveStreams.list({
            part: 'id,status',
            id: streamId,
        });
        if (response.data.items && response.data.items.length > 0) {
            return response.data.items[0].status.streamStatus;
        }
        return null; // Stream not found
    } catch (error) {
        console.error(`[YouTubeAPI] Error fetching stream status for ${streamId}:`, error.message);
        throw error;
    }
}

export async function waitForStreamActive(auth, streamId, timeout = 120000) {
    const startTime = Date.now();
    const pollInterval = 3000; // Poll every 3 seconds

    console.log(`[YouTubeAPI] Waiting for stream ${streamId} to become active...`);

    while (Date.now() - startTime < timeout) {
        try {
            const status = await getStreamStatus(auth, streamId);
            console.log(`[YouTubeAPI] Current status for stream ${streamId}: ${status}`);
            if (status === 'active') {
                console.log(`[YouTubeAPI] Stream ${streamId} is now active!`);
                return true;
            }
        } catch (error) {
            console.error(`[YouTubeAPI] Error while polling for active stream ${streamId}:`, error.message);
            // Decide if the error is fatal or if polling should continue
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    console.error(`[YouTubeAPI] Timeout: Stream ${streamId} did not become active within ${timeout / 1000} seconds.`);
    return false;
}

// Function to transition a broadcast's status
export async function transitionBroadcast(auth, broadcastId, status) {
    const youtube = google.youtube({ version: 'v3', auth });
    try {
        console.log(`[YouTubeAPI] Transitioning broadcast ${broadcastId} to ${status}...`);
        const response = await youtube.liveBroadcasts.transition({
            part: 'id,snippet,status',
            id: broadcastId,
            broadcastStatus: status,
        });
        console.log(`[YouTubeAPI] Successfully transitioned broadcast ${broadcastId} to ${status}.`);
        return { success: true, data: response.data };
    } catch (error) {
        console.error(`[YouTubeAPI] Error transitioning broadcast ${broadcastId} to ${status}:`, error.message);
        throw error;
    }
}

// Function to get authenticated channel information
export async function getAuthenticatedChannelInfo(specificChannelId = null, redirectUri = null) {
    console.log(`[YouTubeAPI] Fetching authenticated channel info ${specificChannelId ? 'for channel: ' + specificChannelId : ''}`);
    try {
        const channelIdToUse = specificChannelId;
        if (!channelIdToUse) {
            throw new Error('A channel ID must be provided to fetch authenticated info.');
        }

        const auth = await authorize(channelIdToUse, redirectUri);
        const youtube = google.youtube({ version: 'v3', auth });

        const response = await youtube.channels.list({
            part: 'snippet,contentDetails,statistics',
            mine: true,
        });

        if (response.data.items && response.data.items.length > 0) {
            const channel = response.data.items[0];
            console.log(`[YouTubeAPI] Successfully fetched info for channel: ${channel.snippet.title}`);
            return {
                success: true,
                id: channel.id,
                title: channel.snippet.title,
                description: channel.snippet.description,
                thumbnail: channel.snippet.thumbnails.default.url,
                publishedAt: channel.snippet.publishedAt
            };
        } else {
            console.error('[YouTubeAPI] Could not find channel information for the authenticated user.');
            return { success: false, message: 'Could not find channel information.' };
        }
    } catch (error) {
        console.error('[YouTubeAPI] Error fetching authenticated channel info:', error.message);
        let userMessage = `Failed to fetch channel info: ${error.message}`;
        let errorType = error.response?.data?.error;

        if (errorType === 'invalid_grant') {
            userMessage = 'Authentication has expired or been revoked. Please go to settings and reconnect the YouTube channel.';
            console.error(`[YouTubeAPI] 'invalid_grant' error for channel ${specificChannelId}. Marking token as invalid.`);

            // Mark the token as invalid in the token file
            try {
                const allAuths = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
                const authIndex = allAuths.findIndex(auth => auth.channelId === specificChannelId);
                if (authIndex !== -1) {
                    allAuths[authIndex].refreshTokenInvalid = true;
                    fs.writeFileSync(TOKEN_PATH, JSON.stringify(allAuths, null, 2));
                    console.log(`[YouTubeAPI] Successfully marked channel ${specificChannelId} as having an invalid refresh token.`);
                }
            } catch (fileError) {
                console.error(`[YouTubeAPI] CRITICAL: Failed to write invalid token status to ${TOKEN_PATH}:`, fileError);
            }
        } else if (errorType === 'invalid_credentials') {
            userMessage = 'Invalid credentials. Please reconnect your YouTube account.';
        } else if (error.response?.status === 403) {
            userMessage = 'Permission denied. Please ensure your YouTube account has the necessary permissions.';
        }

        return {
            success: false,
            message: userMessage,
            errorType: errorType,
            errorDetails: error.response?.data
        };
    }
}

// Function to list all live streams (stream keys) from YouTube
export async function listAllStreams() {
    console.log('[YouTubeAPI] Fetching all live streams');
    try {
        const auth = await authorize();
        const youtube = google.youtube({ version: 'v3', auth });

        const response = await youtube.liveStreams.list({
            part: ['id', 'snippet', 'cdn', 'status'],
            mine: true,
            maxResults: 50
        });

        const streams = response.data.items || [];
        console.log(`[YouTubeAPI] Found ${streams.length} live stream(s)`);
        return { success: true, streams };
    } catch (error) {
        console.error('[YouTubeAPI] Error fetching live streams:', error.message);
        return {
            success: false,
            message: `Failed to fetch live streams: ${error.message}`,
            streams: []
        };
    }
}

// --- Rewritten Multi-Channel Stream Caching System ---


export const activeStreams = new Map();

function initializeStreamCacheForChannel(channelId) {
    if (!channelId) return;
    if (!channelStreamCaches[channelId]) {
        // This is the fix: Initialize with 'idle' and 'active' arrays.
        channelStreamCaches[channelId] = { idle: [], active: [], lastRefreshed: null };
    }
}
export function isStreamInUse(streamId) {
    return activeStreams.has(streamId);
}

export async function refreshIdleStreamCache(youtube, channelId) {
    console.log(`[YouTubeAPI_Cache] Full sync of stream cache for channel ${channelId}...`);
    initializeStreamCacheForChannel(channelId);
    const cache = channelStreamCaches[channelId];

    try {
        const response = await youtube.liveStreams.list({
            part: 'id,snippet,cdn,status',
            mine: true,
            maxResults: 50,
        });

        const allStreamsFromAPI = response.data.items || [];

        // An idle stream is one that is not 'active', 'error', or 'creating'.
        const idleStreams = allStreamsFromAPI.filter(stream =>
            !['active', 'error', 'creating'].includes(stream.status.streamStatus)
        );

        // Overwrite the local idle cache with the source of truth from the API.
        cache.idle = idleStreams;

        // Synchronize the local activeStreams map. If a stream is in our active map
        // but the API says it's idle, remove it from our active map.
        const idleStreamIds = new Set(idleStreams.map(s => s.id));
        for (const [streamId, activeStreamData] of activeStreams.entries()) {
            if (activeStreamData.channelId === channelId && idleStreamIds.has(streamId)) {
                console.log(`[YouTubeAPI_Cache] Sync: Stream ${streamId} is idle on YouTube. Removing from local active list.`);
                activeStreams.delete(streamId);
            }
        }

        console.log(`[YouTubeAPI_Cache] Cache synced for channel ${channelId}. Found ${cache.idle.length} idle streams.`);
    } catch (error) {
        console.error(`[YouTubeAPI_Cache] Error refreshing stream cache for channel ${channelId}:`, error.message);
        throw error; // Re-throw to be handled by the caller
    }
}

/**
 * Creates a new live stream for the specified channel
 * @param {string} channelId - The channel ID to create the stream for
 * @param {string} title - The title for the new stream
 * @param {string} description - The description for the new stream
 * @returns {Promise<Object>} Object containing the new stream or error
 */
async function createLiveStream(channelId, title, description) {
    try {
        const auth = await authorize(channelId);
        const youtube = google.youtube({ version: 'v3', auth });

        const streamResponse = await youtube.liveStreams.insert({
            part: 'snippet,cdn,status',
            resource: {
                snippet: {
                    title: title || `Stream for channel ${channelId}`,
                    description: description || ''
                },
                cdn: {
                    frameRate: 'variable',
                    ingestionType: 'rtmp',
                    resolution: 'variable',
                    format: '1080p'
                }
            },
        });

        const newStream = streamResponse.data;
        console.log(`[YouTubeAPI] Successfully created new live stream key: ${newStream.id}`);
        return {
            success: true,
            stream: newStream,
            streamKey: newStream.cdn.ingestionInfo.streamName
        };
    } catch (error) {
        console.error(`[YouTubeAPI] Error creating new live stream key for channel ${channelId}:`, error.message);
        return {
            success: false,
            message: error.message,
            error: error,
            needsNewKey: true
        };
    }
}
/**
 * Checks the list of active (but unused) streams for a channel and recycles any that are still 'idle' on YouTube.
 * This is more efficient than fetching all streams again.
 * @param {object} youtube - The authenticated YouTube API client.
 * @param {string} channelId - The channel ID to check.
 * @returns {boolean} - True if a stream was successfully recycled, false otherwise.
 */
async function recycleActiveStreams(youtube, channelId) {
    const channelCache = channelStreamCaches[channelId];
    if (!channelCache || !channelCache.active || channelCache.active.length === 0) {
        return false;
    }

    // First, try to find a stream that is active in our cache but not in use by FFmpeg
    for (const stream of channelCache.active) {
        const streamKey = stream.cdn.ingestionInfo.streamName;
        if (!ffmpegActiveKeys.has(streamKey)) {
            console.log(`[RECYCLE] Fast recycling stream key ${streamKey} for channel ${channelId} (not in use by FFmpeg).`);
            returnStreamToCache(stream, channelId);
            return true; // A stream was successfully recycled
        }
    }

    // If no fast-recyclable streams were found, check the YouTube API for the remaining streams.
    console.log(`[RECYCLE] No fast-recyclable streams found for channel ${channelId}. Checking YouTube API for streams in use.`);
    const streamsInUseIds = channelCache.active
        .filter(s => ffmpegActiveKeys.has(s.cdn.ingestionInfo.streamName))
        .map(s => s.id);

    if (streamsInUseIds.length === 0) {
        console.log(`[RECYCLE] No streams are marked as in-use by FFmpeg. Nothing to check via API.`);
        return false;
    }

    try {
        const response = await youtube.liveStreams.list({
            part: 'id,status',
            id: streamsInUseIds.join(','),
        });

        const streamsFromYouTube = response.data.items || [];
        for (const stream of streamsFromYouTube) {
            if (stream.status.streamStatus === 'idle') {
                console.log(`[YouTubeAPI_Cache] Recycling unused stream ${stream.id} which was marked as active.`);
                const streamToRecycle = channelCache.active.find(s => s.id === stream.id);
                if (streamToRecycle) {
                    returnStreamToCache(streamToRecycle, channelId);
                    return true; // A stream was successfully recycled
                }
            }
        }
    } catch (error) {
        console.error(`[YouTubeAPI_Cache] Error during stream recycling for channel ${channelId}:`, error.message);
    }
    return false; // No streams were recycled
}

/**
 * Gets an existing stream key or creates a new one if needed
 * @param {string} channelId - The YouTube channel ID
 * @param {string} title - Title for the stream (used when creating a new one)
 * @param {string} description - Description for the stream (used when creating a new one)
 * @param {boolean} forceNew - Whether to force creation of a new stream key
 * @returns {Promise<Object>} Object containing stream info or error
 */
export async function getOrCreateStreamKey(channelId, title, description, forceNew = false, excludeStreamId = null) {
    console.log(`[YouTubeAPI] getOrCreateStreamKey for channel ${channelId}${forceNew ? ' (force new)' : ''}`);

    // Maximum number of retry attempts
    const MAX_RETRIES = 2;
    let attempt = 0;
    let lastError = null;

    while (attempt <= MAX_RETRIES) {
        try {
            const auth = await authorize(channelId);
            const youtube = google.youtube({ version: 'v3', auth });
            let stream = null;
            if (forceNew) {
                console.log(`[YouTubeAPI] Previous key was busy. Searching for another idle key...`);
            }

            // Try to find an idle stream in the cache, excluding the busy one if specified.
            if (!forceNew || excludeStreamId) {
                stream = getIdleStreamFromCache(channelId, excludeStreamId);

                // If the cache is empty or had no suitable streams, refresh it from the API and try again.
                if (!stream) {
                    console.log(`[YouTubeAPI] No suitable idle stream in local cache. Refreshing from API...`);
                    await refreshIdleStreamCache(youtube, channelId);
                    stream = getIdleStreamFromCache(channelId, excludeStreamId); // Try again after refresh
                }
            }

            // If we found an idle stream, use it and return.
            if (stream) {
                console.log(`[YouTubeAPI] Found and using idle stream ${stream.id} from cache.`);
                markStreamAsActive(stream, channelId);
                return {
                    success: true,
                    stream: stream,
                    streamKey: stream.cdn.ingestionInfo.streamName,
                    isNew: false,
                    fromCache: true,
                };
            }

            // If we are here, it means no idle streams are available. Create a new one.
            console.log(`[YouTubeAPI] No idle streams available. Creating a new stream...`);
            const response = await youtube.liveStreams.insert({
                part: 'snippet,cdn,status',
                requestBody: {
                    snippet: {
                        title: title || `Stream for channel ${channelId}`,
                        description: description || ''
                    },
                    cdn: {
                        frameRate: 'variable',
                        ingestionType: 'rtmp',
                        resolution: 'variable',
                        format: '1080p'
                    }
                }
            });

            stream = response.data;
            addStreamToCache(stream, channelId);

            return {
                success: true,
                stream: stream,
                streamKey: stream.cdn.ingestionInfo.streamName,
                isNew: true,
                fromCache: false
            };

        } catch (error) {
            lastError = error;
            console.error(`[YouTubeAPI] Attempt ${attempt + 1} failed:`, error.message);

            // Check for non-retryable errors that will never succeed
            const isNonRetryable =
                error.message.includes('Invalid Credentials') ||
                error.message.includes('invalid_grant') ||
                error.message.includes('session has expired') ||
                error.message.includes('not enabled for live streaming') ||
                error.message.includes('liveStreamingNotEnabled') ||
                error.message.includes('exceeded the number of videos') ||
                error.message.includes('quotaExceeded') ||
                error.code === 403 && error.message.includes('Permission denied');

            if (isNonRetryable) {
                console.error('[YouTubeAPI] Non-retryable error encountered, stopping retries:', error.message);
                break;
            }

            // Wait before retrying
            if (attempt < MAX_RETRIES) {
                const delayMs = 1000 * Math.pow(2, attempt); // Exponential backoff
                console.log(`[YouTubeAPI] Retrying in ${delayMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }

            attempt++;
        }
    }

    // If we get here, all attempts failed
    const errorMessage = lastError?.message || 'Unknown error';
    console.error(`[YouTubeAPI] Failed after ${attempt} attempts:`, errorMessage);

    return {
        success: false,
        message: errorMessage,
        error: lastError,
        needsNewKey: true,
        needsCacheRefresh: true
    };
}

async function deleteOtherBroadcasts(youtube, streamId, keepBroadcastId = null) {
    if (!streamId) {
        console.log('[YouTubeAPI_Cleanup] Invalid streamId provided to deleteOtherBroadcasts. Skipping.');
        return;
    }
    console.log(`[YouTubeAPI_Cleanup] Cleaning up broadcasts for stream ${streamId}, attempting to keep broadcast ${keepBroadcastId || 'none'}.`);
    try {
        const broadcastsResponse = await youtube.liveBroadcasts.list({
            part: 'id,snippet,status,contentDetails',
            mine: true,
            maxResults: 50,
        });

        if (broadcastsResponse.data.items && broadcastsResponse.data.items.length > 0) {
            for (const broadcast of broadcastsResponse.data.items) {
                if (!broadcast.contentDetails || broadcast.contentDetails.boundStreamId !== streamId) {
                    continue;
                }

                if (broadcast.id === keepBroadcastId) {
                    console.log(`[YouTubeAPI_Cleanup] Keeping designated broadcast ${broadcast.id} (Title: "${broadcast.snippet.title}").`);
                    continue;
                }

                const status = broadcast.status.lifeCycleStatus;
                const deletableStatuses = ['created', 'ready', 'revoked', 'testStarting', 'testing', 'complete'];
                if (deletableStatuses.includes(status)) {
                    console.log(`[YouTubeAPI_Cleanup] Deleting broadcast ${broadcast.id} (Status: ${status}, Title: "${broadcast.snippet.title}") bound to stream ${streamId}.`);
                    try {
                        await youtube.liveBroadcasts.delete({ id: broadcast.id });
                        console.log(`[YouTubeAPI_Cleanup] Successfully deleted broadcast ${broadcast.id}.`);
                    } catch (deleteError) {
                        console.error(`[YouTubeAPI_Cleanup] Failed to delete broadcast ${broadcast.id}:`, deleteError.message);
                    }
                } else {
                    console.log(`[YouTubeAPI_Cleanup] Skipping broadcast ${broadcast.id} (Status: ${status}, Title: "${broadcast.snippet.title}") as it's not in a deletable state.`);
                }
            }
        } else {
            console.log(`[YouTubeAPI_Cleanup] No broadcasts found for the channel to check for cleanup.`);
        }
    } catch (listError) {
        console.error(`[YouTubeAPI_Cleanup] Error listing broadcasts for stream ${streamId} during cleanup:`, listError.message);
    }
}

async function _updateYouTubeBroadcast(youtube, broadcast, title, description, privacyStatus, scheduledStartTime) {
    console.log(`[YouTubeAPI_UPDATE] Updating broadcast ${broadcast.id} with Title: "${title}"`);

    try {
        const resource = {
            id: broadcast.id,
            snippet: {
                title: title,
                description: description,
                // Use the new start time if provided, otherwise fall back to the broadcast's existing start time.
                scheduledStartTime: scheduledStartTime || broadcast.snippet.scheduledStartTime,
            },
            status: {
                privacyStatus: privacyStatus,
            },
        };

        // If there's no start time at all (neither new nor existing), we cannot include it.
        if (!resource.snippet.scheduledStartTime) {
            delete resource.snippet.scheduledStartTime;
        }

        const response = await youtube.liveBroadcasts.update({
            part: 'snippet,status',
            resource: resource,
        });

        console.log(`[YouTubeAPI_UPDATE] Successfully updated broadcast ${broadcast.id}.`);
        return response.data;
    } catch (error) {
        console.error(`[YouTubeAPI_UPDATE] Error updating broadcast ${broadcast.id}:`, error.message);
        throw error; // Re-throw the error to be caught by the calling function
    }
}

// Helper function to create a new broadcast
async function _createYouTubeBroadcast(youtube, title, description, privacyStatus, scheduledStartTime) {
    // Final safeguard to ensure scheduledStartTime is never null.
    if (!scheduledStartTime) {
        scheduledStartTime = new Date(Date.now() + 10000).toISOString();
    }
    console.log(`[YouTubeAPI_CREATE] Creating new broadcast with Title: "${title}"`);
    const broadcastResponse = await youtube.liveBroadcasts.insert({
        part: 'id,snippet,contentDetails,status',
        resource: {
            snippet: {
                title: title,
                description: description,
                // Only include scheduledStartTime if it is explicitly provided.
                ...(scheduledStartTime && { scheduledStartTime }),
            },
            contentDetails: {
                enableAutoStart: true,
                enableAutoStop: true,
                enableDvr: true,
                enableMonitorStream: true,
            },
            status: {
                privacyStatus: privacyStatus,
            },
        },
    });
    return broadcastResponse.data;
}

// ... (rest of the code remains the same)

export async function findOrCreateReusableBroadcast(channelId, title, description, privacyStatus, scheduledStartTime, preferredStreamKey) {
    console.log(`[YouTubeAPI] Attempting to find or create a reusable broadcast for channel ${channelId}.`);
    const auth = await authorize(channelId);
    const youtube = google.youtube({ version: 'v3', auth });

    // --- Strict Mode: A preferred stream key is now required. ---
    if (!preferredStreamKey) {
        console.error('[YouTubeAPI] CRITICAL: No stream key was provided to findOrCreateReusableBroadcast.');
        throw new Error('A stream key must be provided to find or create a broadcast.');
    }

    try {
        console.log(`[YouTubeAPI] Searching for stream with key "${preferredStreamKey}".`);
        const streamsListResponse = await youtube.liveStreams.list({
            part: 'id,cdn,status,snippet',
            mine: true,
            maxResults: 50
        });

        const preferredStream = (streamsListResponse.data.items || []).find(s =>
            s.cdn?.ingestionInfo?.streamName === preferredStreamKey
        );

        // If the specific stream key doesn't exist, request a new one
        if (!preferredStream) {
            console.log(`[YouTubeAPI] Stream key "${preferredStreamKey}" not found on YouTube. Requesting a new key.`);
            return {
                success: false,
                needsNewKey: true,
                message: `Stream key not found on YouTube: ${preferredStreamKey}`
            };
        }

        // If we're using a preferred stream key but it's already in use, return it to cache and request a new one
        if (preferredStreamKey) {
            const broadcastsListResponse = await youtube.liveBroadcasts.list({
                part: 'id,snippet,status,contentDetails',
                mine: true,
                maxResults: 50
            });

            const activeBroadcast = (broadcastsListResponse.data.items || []).find(b => {
                const isUsingStream = b.contentDetails?.boundStreamId === preferredStream.id;
                const isLive = b.status?.lifeCycleStatus === 'live';
                return isUsingStream && isLive;
            });

            if (activeBroadcast) {
                console.log(`[YouTubeAPI] Stream ${preferredStream.id} is in use by live broadcast ${activeBroadcast.id}. Requesting new key.`);
                return {
                    success: false,
                    needsNewKey: true,
                    message: 'Stream is currently in use by an active broadcast.'
                };
            }
        };

        const preferredStreamId = preferredStream.id;
        console.log(`[YouTubeAPI] Found stream ${preferredStreamId} for key "${preferredStreamKey}".`);

        // First, check if this stream is already in use in an active broadcast
        let broadcastsResponse;
        try {
            console.log(`[YouTubeAPI] 🔍 Checking if stream ${preferredStreamId} is in use...`);

            // More efficient check: first query for *active* broadcasts, then *upcoming*.
            const activeBroadcastsResponse = await youtube.liveBroadcasts.list({
                part: 'id,snippet,status,contentDetails',
                broadcastStatus: 'active',
                maxResults: 25
            });

            const activeBroadcast = (activeBroadcastsResponse.data.items || []).find(b =>
                b.snippet.channelId === channelId && b.contentDetails?.boundStreamId === preferredStreamId
            );

            if (activeBroadcast) {
                console.log(`[YouTubeAPI] 🔴 Stream IN USE - Broadcast ${activeBroadcast.id} is LIVE.`);
                return { success: false, needsNewKey: true, message: `Stream key is already live with broadcast ${activeBroadcast.id}.` };
            }

            // If not active, check for a reusable *upcoming* broadcast.
            const upcomingBroadcastsResponse = await youtube.liveBroadcasts.list({
                part: 'id,snippet,status,contentDetails',
                broadcastStatus: 'upcoming',
                maxResults: 50
            });

            const broadcastsUsingStream = (upcomingBroadcastsResponse.data.items || [])
                .filter(b => b.snippet.channelId === channelId && b.contentDetails?.boundStreamId === preferredStreamId)
                .sort((a, b) => new Date(b.snippet.publishedAt) - new Date(a.snippet.publishedAt));

            console.log(`[YouTubeAPI] Found ${broadcastsUsingStream.length} broadcasts using stream ${preferredStreamId}`);

            // The logic above has already confirmed no active broadcast exists.
            // Now, we find the most recent reusable broadcast from the upcoming list.
            const mostRecentBroadcast = broadcastsUsingStream[0];
            if (mostRecentBroadcast) {
                const mostRecentStatus = mostRecentBroadcast.status?.lifeCycleStatus?.toLowerCase();

                // Only reuse if the broadcast is in a reusable state and not active
                const reusableStates = ['ready', 'created', 'testing'];
                if (reusableStates.includes(mostRecentStatus)) {
                    // Double-check if the stream is actually available
                    try {
                        const streamStatus = await youtube.liveStreams.list({
                            part: 'status',
                            id: preferredStreamId
                        });

                        const streamStatusText = streamStatus?.data?.items?.[0]?.status?.streamStatus;
                        if (streamStatusText === 'active') {
                            console.log(`[YouTubeAPI] 🔴 Stream ${preferredStreamId} is ACTIVE, cannot reuse`);
                            return { success: false, needsNewKey: true, message: 'Stream is currently active' };
                        }
                    } catch (e) {
                        console.error('[YouTubeAPI] Error checking stream status:', e.message);
                    }
                    console.log(`[YouTubeAPI] Reusing ${mostRecentStatus} broadcast ${mostRecentBroadcast.id} for stream ${preferredStreamId}`);
                    // Update the broadcast with new details before returning
                    const updatedBroadcast = await _updateYouTubeBroadcast(
                        youtube,
                        mostRecentBroadcast,
                        title,
                        description,
                        privacyStatus,
                        null // Pass null because we are reusing a 'ready' broadcast and don't need to set a new time.
                    );
                    return {
                        success: true,
                        broadcast: updatedBroadcast,
                        stream: preferredStream,
                        isReused: true
                    };
                } else {
                    console.log(`[YouTubeAPI] Cannot reuse broadcast ${mostRecentBroadcast.id} in state: ${mostRecentStatus}`);
                }
            }

            if (activeBroadcast) {
                console.log(`[YouTubeAPI] ❌ Stream ${preferredStreamId} is IN USE by broadcast ${activeBroadcast.id}`);
                console.log(`[YouTubeAPI] 📺 Broadcast Title: "${activeBroadcast.snippet?.title || 'No Title'}"`);
                console.log(`[YouTubeAPI] 🔗 Watch URL: https://youtube.com/watch?v=${activeBroadcast.id}`);

                // Return the stream to cache since we can't use it
                returnStreamToCache(preferredStream, channelId);
                return {
                    success: false,
                    needsNewKey: true,
                    message: 'Stream is currently in use by an active broadcast.'
                };
            } else {
                console.log(`[YouTubeAPI] ✅ Stream ${preferredStreamId} is AVAILABLE for use`);
            }
        } catch (error) {
            console.error('[YouTubeAPI] Error checking for active broadcasts:', error.message);
            // Continue with the stream if we can't verify its status
        }

        // Find all broadcasts bound to this stream
        const broadcastsListResponse = await youtube.liveBroadcasts.list({
            part: 'id,snippet,status,contentDetails',
            mine: true,
            maxResults: 50
        });

        // Find all broadcasts bound to this stream
        const boundBroadcasts = (broadcastsListResponse.data.items || []).filter(b =>
            b.contentDetails?.boundStreamId === preferredStreamId
        );

        // If we found any bound broadcasts, check for reusable ones
        if (boundBroadcasts.length > 0) {
            // Look for a ready or created broadcast that we can reuse
            let reusableBroadcast = boundBroadcasts.find(b =>
                (b.status.lifeCycleStatus === 'ready' || b.status.lifeCycleStatus === 'created') &&
                b.snippet?.scheduledStartTime
            );

            // If we found a reusable broadcast, update it
            if (reusableBroadcast) {
                const status = reusableBroadcast.status.lifeCycleStatus;
                console.log(`[YouTubeAPI] Found reusable ${status} broadcast ${reusableBroadcast.id}.`);

                // Update the broadcast with new details
                console.log(`[YouTubeAPI] Updating broadcast with new title: '${title}'.`);
                const updatedBroadcast = await _updateYouTubeBroadcast(
                    youtube,
                    reusableBroadcast,
                    title,
                    description,
                    privacyStatus,
                    null // Explicitly pass null for scheduledStartTime as it's not needed for a 'ready' broadcast
                );

                markStreamAsActive(preferredStream, channelId);
                return {
                    success: true,
                    broadcast: updatedBroadcast,
                    stream: preferredStream,
                    channelId,
                    wasReused: true
                };
            }
        }

        // If we get here, we need to create a new broadcast
        console.log(`[YouTubeAPI] Creating a new broadcast for stream ${preferredStreamId}.`);
        const newBroadcast = await _createYouTubeBroadcast(
            youtube,
            title,
            description,
            privacyStatus,
            scheduledStartTime
        );

        // Bind the stream to the new broadcast
        await youtube.liveBroadcasts.bind({
            part: 'id',
            id: newBroadcast.id,
            streamId: preferredStream.id
        });

        markStreamAsActive(preferredStream, channelId);
        console.log(`[YouTubeAPI] Successfully created and bound new broadcast ${newBroadcast.id} to stream ${preferredStream.id}.`);

        // Fetch the broadcast again to get all details after binding.
        const finalBroadcastResponse = await youtube.liveBroadcasts.list({
            part: 'id,snippet,contentDetails,status',
            id: newBroadcast.id
        });

        return {
            success: true,
            broadcast: finalBroadcastResponse.data.items[0],
            stream: preferredStream,
            channelId,
            wasReused: false
        };

    } catch (error) {
        console.error('[YouTubeAPI] Error in findOrCreateReusableBroadcast:', error.message);
        if (error.response?.data?.error?.errors) {
            console.error('[YouTubeAPI] YouTube API Error Details:', error.response.data.error.errors);

            // If we get a "liveStreamNotFound" error, we should request a new key
            if (error.response.data.error.errors.some(e => e.reason === 'liveStreamNotFound')) {
                console.log('[YouTubeAPI] Stream not found, requesting new key.');
                return { success: false, needsNewKey: true };
            }
        }

        // Re-throw the original error or a new one if it's a known condition.
        throw error;
    }
}

export async function createLiveBroadcast(title, description, channelId, streamKey = null, privacyStatus = 'public', scheduledStartTime = null) {
    // If no scheduled start time is provided, default to 10 seconds from now.
    if (!scheduledStartTime) {
        scheduledStartTime = new Date(Date.now() + 10000).toISOString();
    }
    const auth = await authorize(channelId);
    const youtube = google.youtube({ version: 'v3', auth });

    // Helper function to create clean objects for the response to prevent serialization errors
    const createCleanResponse = (broadcast, stream, wasNew = false) => {
        const cleanBroadcast = {
            kind: broadcast.kind,
            etag: broadcast.etag,
            id: broadcast.id,
            snippet: broadcast.snippet,
            status: broadcast.status,
            contentDetails: broadcast.contentDetails,
        };
        const cleanStream = {
            kind: stream.kind,
            etag: stream.etag,
            id: stream.id,
            snippet: stream.snippet,
            cdn: stream.cdn,
            status: stream.status,
        };
        return {
            broadcast: cleanBroadcast,
            stream: cleanStream,
            streamKey: stream.cdn.ingestionInfo.streamName,
            ingestionAddress: stream.cdn.ingestionInfo.ingestionAddress,
            wasNew: wasNew,
        };
    };

    // --- Scenario 1: A specific stream key is provided ---
    if (streamKey) {
        console.log(`[YouTubeAPI] Attempting to reuse or create broadcast for specific stream: ${streamKey}`);
        let liveStreamObject;
        try {
            const streamCheck = await youtube.liveStreams.list({
                part: 'id,status,cdn,snippet',
                id: streamKey,
            });
            if (!streamCheck.data.items || streamCheck.data.items.length === 0) {
                throw new Error('Stream not found on YouTube.');
            }
            liveStreamObject = streamCheck.data.items[0];
        } catch (error) {
            console.error(`[YouTubeAPI] Provided stream key ${streamKey} is invalid or not found.`, error.message);
            throw new Error(`The selected stream key (${streamKey}) is no longer valid on YouTube.`);
        }

        // First try to find an existing broadcast for this stream
        const broadcastsResponse = await youtube.liveBroadcasts.list({ part: 'id,snippet,status,contentDetails', mine: true, maxResults: 50 });
        const allUserBroadcasts = broadcastsResponse.data.items || [];
        const allUpcomingBroadcasts = allUserBroadcasts.filter(
            b => b.status && (b.status.lifeCycleStatus === 'created' || b.status.lifeCycleStatus === 'ready')
        );
        const existingBroadcasts = (allUpcomingBroadcasts || []).filter(b => {
            const status = b.status.lifeCycleStatus;
            return b.contentDetails.boundStreamId === streamKey && status !== 'complete' && status !== 'revoked';
        });
        console.log(`[YouTubeAPI] Found ${existingBroadcasts.length} upcoming broadcast(s) bound to stream ${streamKey}.`);

        try {
            if (existingBroadcasts.length > 0) {
                // Sort by scheduled start time (newest first)
                existingBroadcasts.sort((a, b) => new Date(b.snippet.scheduledStartTime) - new Date(a.snippet.scheduledStartTime));
                const broadcastToReuse = existingBroadcasts[0];

                console.log(`[YouTubeAPI] Reusing newest broadcast: ${broadcastToReuse.id} (${broadcastToReuse.snippet.title})`);
                const updatedBroadcast = await _updateYouTubeBroadcast(youtube, broadcastToReuse, title, description, privacyStatus, scheduledStartTime);


                return createCleanResponse(updatedBroadcast, liveStreamObject, false);
            } else {
                // No existing broadcast found, create a new one
                console.log(`[YouTubeAPI] No reusable broadcast found for stream ${streamKey}. Creating a new one.`);
                const newBroadcast = await _createYouTubeBroadcast(youtube, title, description, privacyStatus, scheduledStartTime);

                // Bind the stream to the new broadcast
                const boundBroadcastResponse = await youtube.liveBroadcasts.bind({
                    part: 'id,snippet,contentDetails,status',
                    id: newBroadcast.id,
                    streamId: streamKey,
                });


                return createCleanResponse(boundBroadcastResponse.data, liveStreamObject, true);
            }
        } catch (error) {
            console.error(`[YouTubeAPI] Error during specific broadcast reuse/creation for stream ${streamKey}:`, error.message);
            throw error;
        }
    } else {
        // --- Scenario 2: No specific stream key, use cache or create new ---
        console.log('[YouTubeAPI] No specific stream key provided. Using getOrCreateStreamKey logic...');

        const streamResult = await getOrCreateStreamKey(channelId, `Stream for ${title}`, 'Managed by AutoLivePro');

        if (!streamResult.success) {
            console.error('[YouTubeAPI] Failed to get or create a stream key in the fallback logic.');
            throw new Error(streamResult.message || 'Could not obtain a valid YouTube stream key.');
        }

        const streamToUse = streamResult.stream;
        console.log(`[YouTubeAPI] Obtained stream ${streamToUse.id} to create a new broadcast. Was new: ${streamResult.isNew}`);

        try {
            const broadcastsResponse = await youtube.liveBroadcasts.list({ part: 'id,snippet,status,contentDetails', mine: true, maxResults: 50 });
            const allUserBroadcasts = broadcastsResponse.data.items || [];

            const allUpcomingBroadcasts = allUserBroadcasts.filter(
                b => b.status && (b.status.lifeCycleStatus === 'created' || b.status.lifeCycleStatus === 'ready')
            );
            const existingBroadcasts = (allUpcomingBroadcasts || []).filter(b => {
                const status = b.status.lifeCycleStatus;
                return b.contentDetails.boundStreamId === streamToUse.id && status !== 'complete' && status !== 'revoked';
            });
            console.log(`[YouTubeAPI] Found ${existingBroadcasts.length} upcoming broadcast(s) bound to stream ${streamToUse.id}.`);

            if (existingBroadcasts.length > 0) {
                const broadcastToReuse = existingBroadcasts[0];
                console.log(`[YouTubeAPI] Found existing broadcast ${broadcastToReuse.id} with status ${broadcastToReuse.status.lifeCycleStatus}.`);

                // Only reuse broadcasts that are in a valid, non-terminal state.
                if (['ready', 'created', 'testing'].includes(broadcastToReuse.status.lifeCycleStatus)) {
                    console.log(`[YouTubeAPI] Reusing broadcast: ${broadcastToReuse.id} (${broadcastToReuse.snippet.title})`);
                    const updatedBroadcast = await _updateYouTubeBroadcast(youtube, broadcastToReuse, title, description, privacyStatus, scheduledStartTime);
                    return createCleanResponse(updatedBroadcast, streamToUse, false);
                }

                console.log(`[YouTubeAPI] Cannot reuse broadcast ${broadcastToReuse.id} in state: ${broadcastToReuse.status.lifeCycleStatus}. Will create a new one.`);
            }

            console.log(`[YouTubeAPI] No reusable broadcast found for stream ${streamToUse.id}. Creating a new one.`);
            const newBroadcast = await _createYouTubeBroadcast(youtube, title, description, privacyStatus, scheduledStartTime);

            console.log(`[YouTubeAPI] Binding stream ${streamToUse.id} to new broadcast ${newBroadcast.id}`);
            const boundBroadcastResponse = await youtube.liveBroadcasts.bind({
                part: 'id,snippet,contentDetails,status',
                id: newBroadcast.id,
                streamId: streamToUse.id,
            });


            return createCleanResponse(boundBroadcastResponse.data, streamToUse, true);
        } catch (error) {
            console.error(`[YouTubeAPI] Error during broadcast reuse/creation for stream ${streamToUse.id}:`, error.message);
            returnStreamToCache(streamToUse, channelId);
            throw error;
        }
    }
}

// ... (rest of the code remains the same)
/**
 * Sets a thumbnail for a video or live broadcast
 * @param {string} channelId - The YouTube channel ID
 * @param {string} videoId - The YouTube video/broadcast ID
 * @param {Buffer|ReadableStream} imageBuffer - The image data
 * @returns {Promise<Object>} The API response
 */
export async function setThumbnail(channelId, videoId, imageBuffer) {
    console.log(`[YouTubeAPI] Setting thumbnail for video ${videoId}`);
    const auth = await authorize(channelId);
    const youtube = google.youtube({ version: 'v3', auth });

    try {
        const response = await youtube.thumbnails.set({
            videoId: videoId,
            media: {
                body: imageBuffer,
                mimeType: 'image/jpeg'
            },
        });
        console.log(`[YouTubeAPI] Successfully set thumbnail for video ${videoId}`);
        return { success: true, data: response.data };
    } catch (error) {
        console.error(`[YouTubeAPI] Error setting thumbnail for video ${videoId}:`, error.message);
        // Non-fatal, don't throw to stop the stream
        return { success: false, error: error.message };
    }
}

export async function updateBroadcastMetadata(channelId, broadcastId, newTitle, newDescription) {
    console.log(`[YouTubeAPI] Updating metadata for broadcast ${broadcastId}: Title="${newTitle}", Desc="${newDescription}"`);
    const auth = await authorize(channelId);
    const youtube = google.youtube({ version: 'v3', auth });

    try {
        const response = await youtube.liveBroadcasts.update({
            part: 'snippet',
            resource: {
                id: broadcastId,
                snippet: {
                    title: newTitle,
                    description: newDescription,
                },
            },
        });
        console.log(`[YouTubeAPI] Successfully updated metadata for broadcast ${broadcastId}.`);
        return { success: true, data: response.data };
    } catch (error) {
        console.error(`[YouTubeAPI] Error updating metadata for broadcast ${broadcastId}:`, error.message);
        throw error;
    }
}

export async function uploadVideo(channelId, videoPath, videoMetadata, onProgress) {
    console.log(`[YouTubeAPI] Starting video upload for channel ${channelId}`);
    const auth = await authorize(channelId);
    const youtube = google.youtube({ version: 'v3', auth });
    const fileSize = fs.statSync(videoPath).size;

    let attempts = 3;
    for (let i = 1; i <= attempts; i++) {
        try {
            const response = await youtube.videos.insert({
                part: 'snippet,status',
                requestBody: {
                    snippet: {
                        title: videoMetadata.title,
                        description: videoMetadata.description,
                        tags: videoMetadata.tags,
                    },
                    status: {
                        privacyStatus: videoMetadata.privacyStatus,
                        ...(videoMetadata.publishAt && { publishAt: videoMetadata.publishAt }),
                    },
                },
                media: {
                    body: fs.createReadStream(videoPath),
                },
            }, {
                onUploadProgress: evt => {
                    const progress = (evt.bytesRead / fileSize) * 100;
                    const percent = Math.round(progress);
                    console.log(`[YouTubeAPI] Upload Progress: ${percent}%`);
                    if (onProgress) onProgress(percent);
                }
            });
            return { success: true, data: response.data };
        } catch (error) {
            console.error(`[YouTubeAPI] Upload attempt ${i} failed:`, error.message);
            const isNonRetryable = error.message.includes('exceeded the number of videos') || error.message.includes('quotaExceeded');
            if (i === attempts || isNonRetryable) {
                return { success: false, error: `Upload failed: ${error.message}` };
            }
            await new Promise(res => setTimeout(res, 5000)); // Wait 5 seconds before retrying
        }
    }
}

/**
 * Deletes the token for a specific channel ID from tokens.json
 * @param {string} channelId 
 */
export async function deleteToken(channelId) {
    try {
        if (!fs.existsSync(TOKEN_PATH)) return;
        const tokens = await fs.readJson(TOKEN_PATH);

        if (tokens[channelId]) {
            delete tokens[channelId];
            await fs.writeJson(TOKEN_PATH, tokens, { spaces: 4 });
            console.log(`[YouTubeAPI] Successfully deleted token for channel: ${channelId}`);
        }
    } catch (error) {
        console.error(`[YouTubeAPI] Error deleting token for channel ${channelId}:`, error.message);
    }
}
