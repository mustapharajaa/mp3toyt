import { SCOPES, TOKEN_PATH, CREDENTIALS_PATH, ACTIVE_STREAMS_PATH, CHANNELS_PATH, ADMIN_CHANNELS_PATH, FACEBOOK_TOKENS_PATH, FACEBOOK_CREDENTIALS_PATH, AUTOMATION_STATS_PATH, PENDING_AUTOMATION_PATH, LOGOS_DIR } from './config.js'; // Load variables
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { google } from 'googleapis';
import { getAuthenticatedChannelInfo, uploadVideo, getAuthUrl, saveTokenFromCode, deleteToken } from './youtube-api.js';
// import { getFacebookAuthUrl, getFacebookTokenFromCode, getFacebookUserInfo, saveFacebookToken } from './facebook-api.js'; // REMOVED - using bundle-api
import * as bundleApi from './bundle-api.js';
import * as mp3toytChannels from './channels.js';
import { uploadVideoWithPuppeteer } from './facebook-puppeteer.js';
import formidable from 'formidable';

// --- Configuration & Validation ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FFMPEG_PATH = process.env.FFMPEG_PATH;
const FFPROBE_PATH = process.env.FFPROBE_PATH;
const YT_DLP_PATH = process.env.YT_DLP_PATH;
const YOUTUBE_COOKIES_PATH = process.env.YOUTUBE_COOKIES_PATH || path.join(__dirname, '../cookies.txt');

if (!FFMPEG_PATH || !fs.existsSync(FFMPEG_PATH)) {
    console.error('🔴 FATAL: FFMPEG_PATH is not defined in your .env file or the path is incorrect.');
    console.error('👉 Please add FFMPEG_PATH=C:\\path\\to\\ffmpeg.exe to your .env file.');
    process.exit(1);
}
ffmpeg.setFfmpegPath(FFMPEG_PATH);

if (FFPROBE_PATH && fs.existsSync(FFPROBE_PATH)) {
    ffmpeg.setFfprobePath(FFPROBE_PATH);
}

if (!YT_DLP_PATH || !fs.existsSync(YT_DLP_PATH)) {
    console.error('🔴 FATAL: YT_DLP_PATH is not defined in your .env file or the path is incorrect.');
    console.error('👉 Please add YT_DLP_PATH=C:\\path\\to\\yt-dlp.exe to your .env file.');
    process.exit(1);
}
import { isAdmin } from './users.js';
import { getStats } from './visitors.js';

const router = express.Router();
router.use(express.json());

// --- Multer Configuration ---
const UPLOADS_BASE_DIR = path.join(__dirname, '../uploads');
const TEMP_BASE_DIR = path.join(__dirname, '../temp');
const FALLBACK_THUMBNAILS_DIR = path.join(__dirname, '../temp/thumbnails');
const upload = multer();

// In-memory mutex for administrative automation to prevent race conditions during counter updates and channel switching
let automationLock = false;
const releaseAutomationLock = () => { automationLock = false; };
const acquireAutomationLock = async () => {
    while (automationLock) await new Promise(res => setTimeout(res, 50));
    automationLock = true;
};

// Track in-flight automation jobs per user to maintain correct 6-video cycle scheduling
// before they are permanently saved to automation_stats.json upon success.
let automationPendingCounters = {}; // { username: count }

// --- Pending Automation Logic ---
async function processPendingAutomation(username) {
    try {
        if (!(await fs.pathExists(PENDING_AUTOMATION_PATH))) return;

        const allPending = await fs.readJson(PENDING_AUTOMATION_PATH);
        const userPending = allPending.filter(item => item.username === username);

        if (userPending.length === 0) return;

        console.log(`[Pending] Found ${userPending.length} pending items for ${username}. Checking for channels...`);

        // Check for available channels
        const channels = (await mp3toytChannels.getChannelsForUser(username)).filter(c => c.status !== 'exhausted');
        if (channels.length === 0) {
            console.log(`[Pending] Still no channels for ${username}. Staying in memory.`);
            return;
        }

        console.log(`[Pending] Channels available! Processing memory for ${username}...`);

        // Process sequentially to maintain lock integrity
        for (const item of userPending) {
            console.log(`[Pending] Auto-triggering session for ${username}`);
            // We simulate a request call to start-automation logic
            // To avoid code duplication, we'll wrap the logic or just let the user know they can start it.
            // Actually, we can just call an internal function.
            await triggerAutomationInternal(item.links, item.thumbUrl, item.username);
        }

        // Clear processed items
        const remaining = allPending.filter(item => item.username !== username);
        await fs.writeJson(PENDING_AUTOMATION_PATH, remaining, { spaces: 4 });

    } catch (err) {
        console.error(`[Pending Error]`, err.message);
    }
}

async function triggerAutomationInternal(links, thumbUrl, username) {
    // This is a minimal mock of the POST /start-automation body
    // We fetch this via internal fetch or direct call
    try {
        const response = await axios.post(`http://localhost:${process.env.PORT || 8000}/start-automation`, {
            links,
            thumbUrl,
            __internalCall: true // Flag to distinguish if needed
        }, {
            // We need a way to bypass session for internal calls or pass the username
            headers: { 'x-internal-user': username }
        });
        if (response.data.isPending) {
            console.log(`[Pending] Item remained in memory (Capacity Limit reached)`);
        } else {
            console.log(`[Pending] Successfully triggered queue: ${response.data.sessionId}`);
        }
    } catch (err) {
        console.error(`[Pending] Trigger failed:`, err.response?.data?.error || err.message);
    }
}

// Ensure Directories Exist
fs.ensureDirSync(UPLOADS_BASE_DIR);
fs.ensureDirSync(TEMP_BASE_DIR);
fs.ensureDirSync(LOGOS_DIR);
fs.ensureDirSync(FALLBACK_THUMBNAILS_DIR);

// --- Bundle.social Slot Management (Auto-Disconnect) ---
// --- Background Jobs & Sync ---
// Initial sync on startup
bundleApi.syncWithBundle().catch(err => console.error('[Bundle Startup] Initial sync failed:', err.message));

// Periodically sync local state with reality on Bundle.social (every 5 mins)
setInterval(() => {
    bundleApi.syncWithBundle().catch(err => console.error('[Bundle Sync Job] Failed:', err.message));
}, 5 * 60 * 1000);

// Periodically cleanup idle channels (every 30 seconds)
setInterval(async () => {
    try {
        const disconnectedItems = await bundleApi.cleanupIdleChannels();
        if (disconnectedItems && disconnectedItems.length > 0) {
            console.log(`[Auto-Cleanup] Updating status for ${disconnectedItems.length} disconnected items...`);
            // Update channels.json for each disconnected instance
            const allChannels = await mp3toytChannels.getAllChannelsRaw(); // Need raw access or method to find by instance

            for (const item of disconnectedItems) {
                // Find channel(s) that match this instanceId and platform
                const matches = allChannels.filter(c =>
                    c.bundleInstanceId === item.instanceId &&
                    (!c.platform || c.platform.toLowerCase() === item.platform.toLowerCase())
                );

                for (const match of matches) {
                    console.log(`[Auto-Cleanup] Marking channel ${match.channelTitle} (${match.channelId}) as disconnected.`);
                    await mp3toytChannels.saveChannel({
                        ...match,
                        status: 'disconnected'
                    }, match.username);
                }
            }
        }
    } catch (err) {
        console.error('[Auto-Cleanup Job] Failed:', err.message);
    }
}, 30 * 1000);

async function disconnectUserBundleChannels(username) {
    if (!username || username === 'guest') return;
    try {
        const userChannels = await mp3toytChannels.getChannelsForUser(username);
        const bundleChannels = userChannels.filter(c => !!c.socialAccountId);

        if (bundleChannels.length === 0) return;

        console.log(`[Bundle Cleanup] Disconnecting ${bundleChannels.length} channels for ${username}`);

        for (const ch of bundleChannels) {
            if (ch.bundleInstanceId !== undefined) {
                await bundleApi.disconnectPlatform(ch.bundleInstanceId, ch.platform);
            }
            // Remove from local database
            await mp3toytChannels.deleteChannel(ch.channelId, username);
        }
    } catch (err) {
        console.error(`[Bundle Cleanup] Failed to disconnect channels for ${username}:`, err.message);
    }
}

// refreshActivity is now handled by bundleApi.updateActivity and its internal tracking

/**
 * Picks a random image from the fallback thumbnails directory.
 */
async function getRandomFallbackThumbnail() {
    try {
        if (!await fs.pathExists(FALLBACK_THUMBNAILS_DIR)) return null;
        const files = await fs.readdir(FALLBACK_THUMBNAILS_DIR);
        const images = files.filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
        if (images.length === 0) return null;
        const randomImage = images[Math.floor(Math.random() * images.length)];
        return path.join(FALLBACK_THUMBNAILS_DIR, randomImage);
    } catch (err) {
        console.error('[Automation] Error picking fallback thumbnail:', err.message);
        return null;
    }
}

// --- API Endpoints ---

// --- Helper to construct full URLs (supports BASE_URL env) ---
function getRedirectUri(req, path) {
    if (process.env.BASE_URL) {
        // Ensure path starts with /
        const cleanPath = path.startsWith('/') ? path : `/${path}`;
        return `${process.env.BASE_URL.replace(/\/$/, '')}${cleanPath}`;
    }
    return `${req.protocol}://${req.get('host')}${path.startsWith('/') ? path : `/${path}`}`;
}

router.get('/download-audio', async (req, res) => {
    const { url, sessionId } = req.query;
    const downloadStartTime = Date.now();
    if (!sessionId) {
        return res.status(400).json({ success: false, message: 'Session ID is missing.' });
    }
    if (!url || !(url.includes('youtube.com') || url.includes('youtu.be'))) {
        return res.status(400).json({ success: false, message: 'A valid YouTube URL is required.' });
    }

    try {
        const username = req.session && req.session.username ? req.session.username : 'guest';
        const sessionDir = path.join(TEMP_BASE_DIR, username, sessionId);
        await fs.ensureDir(sessionDir);

        // Use a generic name for discovery later, robust args handled in helper
        const downloadPath = path.join(sessionDir, 'dl_audio.%(ext)s');

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const sendProgress = (message) => {
            res.write(`data: ${JSON.stringify({ message })}\n\n`);
        };

        const onProgress = (percent) => {
            sendProgress(`Downloading... ${percent}%`);
        };

        downloadAudio(url, downloadPath, 'best', onProgress)
            .then(async () => {
                try {
                    const files = await fs.readdir(sessionDir);
                    const downloadedFile = files.find(f => f.endsWith('.opus') || f.endsWith('.m4a') || f.endsWith('.webm') || f.endsWith('.mp3'));

                    if (downloadedFile) {
                        const oldPath = path.join(sessionDir, downloadedFile);
                        const extension = path.extname(downloadedFile);
                        const finalAudioPath = path.join(sessionDir, `audio_${Date.now()}${extension}`); // Unique name


                        await fs.rename(oldPath, finalAudioPath);
                        console.log(`[yt-dlp] Audio processed and renamed successfully to ${finalAudioPath}`);
                        sendProgress('Processing audio...');
                        const downloadTimeSeconds = Math.ceil((Date.now() - downloadStartTime) / 1000);

                        ffmpeg.ffprobe(finalAudioPath, async (err, metadata) => {
                            if (err) {
                                console.error('Error getting audio duration:', err);
                                res.write(`data: ${JSON.stringify({ success: true, message: 'Audio ready (no duration)', audioPath: finalAudioPath, downloadTimeSeconds })}\n\n`);
                                return res.end();
                            }

                            // Log success

                            // Calculate total duration for session
                            const totalSeconds = await getTotalSessionAudioDuration(sessionDir);
                            const tMinutes = Math.floor(totalSeconds / 60);
                            const tSeconds = totalSeconds % 60;
                            const totalDurationFormatted = `${tMinutes}:${tSeconds.toString().padStart(2, '0')}`;

                            const audioDuration = Math.round(metadata.format.duration);
                            const minutes = Math.floor(audioDuration / 60);
                            const seconds = audioDuration % 60;
                            const formattedDuration = `${minutes}:${seconds.toString().padStart(2, '0')}`;

                            res.write(`data: ${JSON.stringify({
                                success: true,
                                message: 'Audio ready',
                                audioPath: finalAudioPath,
                                downloadTimeSeconds: downloadTimeSeconds,
                                audioDuration: formattedDuration,
                                totalDuration: totalDurationFormatted
                            })}\n\n`);
                            res.end();
                        });
                    } else {
                        res.write(`data: ${JSON.stringify({ success: false, error: 'Audio processing failed: output file not found.' })}\n\n`);
                        res.end();
                    }
                } catch (renameError) {
                    res.write(`data: ${JSON.stringify({ success: false, message: 'Server error after audio download.' })}\n\n`);
                    res.end();
                }
            })
            .catch((err) => {
                const isCookieError = err.message.includes('cookies are no longer valid') || err.message.includes('Sign in to confirm');
                if (isCookieError) {
                    res.write(`data: ${JSON.stringify({ success: false, error: 'YouTube cookies have expired. Please refresh them.' })}\n\n`);
                } else {
                    res.write(`data: ${JSON.stringify({ success: false, error: 'Failed to download audio.' })}\n\n`);
                }
                res.end();
            });
    } catch (error) {
        console.error('[Server Error] Failed to initiate audio download:', error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Server error while trying to download audio.' });
        } else {
            res.write(`data: ${JSON.stringify({ success: false, message: 'Server error while trying to download audio.' })}\n\n`);
            res.end();
        }
    }
});

/**
 * Fetches title, description, and tags for a YouTube video using yt-dlp
 */
async function getYoutubeMetadata(link) {
    const args = [
        '--no-playlist',
        '--print', '%(title)s',
        '--print', '%(description)s',
        '--print', '%(tags)j',
        '--js-runtimes', 'node',
        link
    ];

    if (YOUTUBE_COOKIES_PATH && fs.existsSync(YOUTUBE_COOKIES_PATH)) {
        args.push('--cookies', YOUTUBE_COOKIES_PATH);
    }

    return new Promise((resolve) => {
        const proc = spawn(YT_DLP_PATH, args);
        proc.stdout.setEncoding('utf8'); // Force UTF-8 encoding

        let output = '';
        proc.stdout.on('data', (data) => output += data);

        proc.on('close', (code) => {
            if (code === 0) {
                // Split by newline but handle potential empty lines in JSON
                const parts = output.trim().split('\n');

                // Title is the first line
                const title = parts[0] || 'Music Video';

                // Tags JSON is usually the last line
                let tags = [];
                let description = '';

                try {
                    const lastLine = parts[parts.length - 1];
                    if (lastLine.trim().startsWith('[') || lastLine.trim().startsWith('{')) {
                        tags = JSON.parse(lastLine);
                        description = parts.slice(1, -1).join('\n') || '';
                    } else {
                        description = parts.slice(1).join('\n') || '';
                    }
                } catch (e) {
                    description = parts.slice(1).join('\n') || '';
                }

                // Sanitize Description: Keep only Hashtags and Tags metadata
                // 1. Extract hashtags from description
                const hashtags = (description.match(/#[\w\u0590-\u05ff]+/g) || []);
                // 2. Remove duplicates
                const uniqueHashtags = [...new Set(hashtags)];

                // 3. Construct clean description
                const cleanDescription = [
                    uniqueHashtags.join(' '),
                    '',
                    tags && Array.isArray(tags) ? tags.join(', ') : ''
                ].filter(line => line.trim().length > 0).join('\n\n');

                console.log(`[Metadata] Extracted Title: ${title}`);
                console.log(`[Metadata] Cleaned Description (Hashtags: ${uniqueHashtags.length}, Tags: ${tags?.length || 0})`);

                resolve({
                    title: title,
                    description: cleanDescription,
                    tags: tags && Array.isArray(tags) ? tags : [] // Return raw tags for the tags field
                });
            } else {
                console.warn(`[Metadata] yt-dlp failed with code ${code}. Using default title.`);
                resolve({ title: 'Music Video', description: '', tags: [] });
            }
        });
    });
}

// Helper function for robust image downloading (Main App & Automation)
async function downloadImage(url, imagePath, username, sessionId) {
    let targetUrl = url;

    // Detect YouTube URL and extract thumbnail
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
        console.log(`[Thumbnail] Detecting YouTube URL: ${url}`);

        // Fast Path: Extract ID using regex
        const videoIdMatch = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
        const videoId = videoIdMatch ? videoIdMatch[1] : null;

        if (videoId) {
            console.log(`[Thumbnail] Fast Path Success. Video ID: ${videoId}`);
            targetUrl = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
        } else {
            console.log(`[Thumbnail] Fast Path Failed, falling back to yt-dlp...`);
            targetUrl = await new Promise((resolve, reject) => {
                const args = ['--get-thumbnail', url, '--js-runtimes', 'node'];
                if (YOUTUBE_COOKIES_PATH && fs.existsSync(YOUTUBE_COOKIES_PATH)) {
                    args.push('--cookies', YOUTUBE_COOKIES_PATH);
                }
                const proc = spawn(YT_DLP_PATH, args);
                let out = '';
                proc.stdout.on('data', d => out += d.toString());
                proc.on('close', code => {
                    if (code === 0 && out.trim()) resolve(out.trim());
                    else reject(new Error('Failed to get thumbnail URL from YouTube'));
                });
            });
        }
        console.log(`[Thumbnail] targetUrl set to: ${targetUrl}`);
    }

    let response;
    try {
        response = await axios({ url: targetUrl, responseType: 'stream' });
    } catch (err) {
        // Fallback for maxresdefault (sometimes it doesn't exist)
        if (targetUrl.includes('maxresdefault.jpg')) {
            console.log(`[Thumbnail] maxresdefault failed, trying hqdefault...`);
            const fallbackUrl = targetUrl.replace('maxresdefault.jpg', 'hqdefault.jpg');
            response = await axios({ url: fallbackUrl, responseType: 'stream' });
            targetUrl = fallbackUrl;
        } else {
            throw err;
        }
    }

    const writer = fs.createWriteStream(imagePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// Helper function for robust audio downloading (Main App & Automation)
async function downloadAudio(link, audioPath, format = 'best', onProgress = null) {
    const args = [
        '--retries', '4',
        '--socket-timeout', '23',
        '--no-playlist',
        '--concurrent-fragments', '8',
        '--no-part', // Do not use .part files
        '--ppa', 'ffmpeg_i:-ss 0', // Force a sanity check on the file with ffmpeg
        '--ffmpeg-location', FFMPEG_PATH,
        '-f', 'ba[ext=webm]/ba', // Prefer native webm (opus) to avoid server conversion
        '-x',
        '--audio-format', format,
        '--output', audioPath,
        '--js-runtimes', 'node', // Added for YouTube challenge solving (EJS)
        link
    ];

    if (YOUTUBE_COOKIES_PATH && fs.existsSync(YOUTUBE_COOKIES_PATH)) {
        args.push('--cookies', YOUTUBE_COOKIES_PATH);
    }

    return new Promise((resolve, reject) => {
        const dl = spawn(YT_DLP_PATH, args);

        if (onProgress) {
            dl.stdout.on('data', (data) => {
                const output = data.toString();
                const progressMatch = output.match(/\b(\d{1,3}(\.\d+)?)%/);
                if (progressMatch) {
                    onProgress(Math.floor(parseFloat(progressMatch[1])));
                }
            });
        }

        let errorOutput = '';
        dl.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        dl.on('close', (code) => {
            if (code === 0) resolve();
            else {
                console.error(`[Audio Download Error] Code ${code}: ${errorOutput}`);
                reject(new Error(`yt-dlp failed (Code ${code}): ${errorOutput}`));
            }
        });

        dl.on('error', (err) => {
            console.error('[Audio Download Spawn Error]', err);
            reject(err);
        });
    });
}

router.post('/download-image', async (req, res) => {
    const { url, sessionId } = req.body;
    if (!sessionId || !url) {
        return res.status(400).json({ success: false, message: 'Session ID and Image URL are required.' });
    }

    try {
        const username = req.session && req.session.username ? req.session.username : 'guest';
        const sessionDir = path.join(TEMP_BASE_DIR, username, sessionId);
        await fs.ensureDir(sessionDir);
        const imagePath = path.join(sessionDir, 'image.jpg');

        await downloadImage(url, imagePath, username, sessionId);

        res.json({
            success: true,
            filePath: `/temp/${username}/${sessionId}/image.jpg`
        });
    } catch (error) {
        console.error('[Image Download Error]', error);
        res.status(500).json({ success: false, message: 'Failed to download image from URL.' });
    }
});

router.post('/upload-file', (req, res) => {
    const form = formidable({
        maxFileSize: 1024 * 1024 * 1024, // 1GB
        maxTotalFileSize: 1024 * 1024 * 1024, // 1GB
    });

    form.parse(req, async (err, fields, files) => {
        try {
            if (err) {
                console.error('Error parsing form:', err);
                return res.status(500).json({ success: false, message: 'Error processing upload. File might be too large.' });
            }

            const sessionId = Array.isArray(fields.sessionId) ? fields.sessionId[0] : fields.sessionId;
            const fileType = Array.isArray(fields.fileType) ? fields.fileType[0] : fields.fileType;
            const file = files.file ? (Array.isArray(files.file) ? files.file[0] : files.file) : null;

            if (!sessionId || !fileType || !file) {
                return res.status(400).json({ success: false, message: 'Session ID, file type, and file are required.' });
            }

            const username = req.session && req.session.username ? req.session.username : 'guest';
            // refreshActivity(username); // Handled by actual usage now
            const sessionDir = path.join(TEMP_BASE_DIR, username, sessionId);
            await fs.ensureDir(sessionDir);

            let destFilename;
            if (fileType === 'audio') {
                const extension = path.extname(file.originalFilename || 'audio.mp3');
                destFilename = `audio_${Date.now()}${extension}`;
            } else if (fileType === 'overlay') {
                const extension = path.extname(file.originalFilename || 'overlay.mp4');
                destFilename = `overlay_${Date.now()}${extension}`;
            } else {
                const extension = path.extname(file.originalFilename || 'image.jpg');
                destFilename = `image${extension}`;
            }
            const destPath = path.join(sessionDir, destFilename);

            // Use copyFile instead of readFile/writeFile for memory efficiency
            if (!file.filepath) throw new Error('File path missing in upload object');
            await fs.copyFile(file.filepath, destPath);

            let totalDurationFormatted = null;
            if (fileType === 'audio') {
                const totalSeconds = await getTotalSessionAudioDuration(sessionDir);
                const tMinutes = Math.floor(totalSeconds / 60);
                const tSeconds = totalSeconds % 60;
                totalDurationFormatted = `${tMinutes}:${tSeconds.toString().padStart(2, '0')}`;
            }

            res.json({
                success: true,
                message: 'File uploaded successfully.',
                filePath: `/temp/${username}/${sessionId}/${destFilename}`,
                fileType: fileType, // Useful for frontend to know which status to update
                totalDuration: totalDurationFormatted
            });
        } catch (error) {
            console.error('Error in /upload-file handler:', error);
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: 'Server error while saving file.' });
            }
        }
    });
});

router.post('/remove-file', async (req, res) => {
    const { sessionId, type } = req.body;
    if (!sessionId || !type) {
        return res.status(400).json({ success: false, message: 'Session ID and file type are required.' });
    }

    try {
        const username = req.session && req.session.username ? req.session.username : 'guest';
        const sessionDir = path.join(TEMP_BASE_DIR, username, sessionId);
        if (!await fs.pathExists(sessionDir)) {
            return res.json({ success: true, message: 'Session does not exist, nothing to remove.' });
        }

        let filePattern;
        if (type === 'audio') {
            filePattern = /^(audio_|audio\.).*\.(opus|mp3|m4a|wav|webm)$/;
        } else if (type === 'image') {
            filePattern = /^image\..*$/;
        } else {
            return res.status(400).json({ success: false, message: 'Invalid file type.' });
        }

        const files = await fs.readdir(sessionDir);
        const targetFiles = files.filter(f => filePattern.test(f));

        if (targetFiles.length > 0) {
            await Promise.all(targetFiles.map(f => fs.remove(path.join(sessionDir, f))));
            res.json({ success: true, message: `${type} removed successfully (${targetFiles.length} files).` });
        } else {
            res.json({ success: true, message: 'File not found, likely already removed.' });
        }

    } catch (error) {
        console.error('Error removing file:', error);
        res.status(500).json({ success: false, message: 'Server error removing file.' });
    }
});

router.get('/channels', async (req, res) => {
    try {
        const username = req.session && req.session.username ? req.session.username : null;
        if (!username) return res.status(401).json({ success: false, message: 'Unauthorized' });

        let allChannels = [];

        // YouTube & Facebook Channels (Unified)
        const userChannels = await mp3toytChannels.getChannelsForUser(username);

        // Process channels (scaling, isConnected check, logo caching)
        const processedChannels = await Promise.all(userChannels.map(async c => {
            const logoName = `${c.platform || 'youtube'}_${c.channelId}.jpg`;
            const localLogoPath = path.join(LOGOS_DIR, logoName);
            const localLogoUrl = `/logos/${logoName}`;

            const isCached = await fs.pathExists(localLogoPath);

            if (c.thumbnail && !isCached) {
                // Start download in background
                (async () => {
                    try {
                        const response = await axios({
                            url: c.thumbnail,
                            responseType: 'stream',
                            timeout: 5000,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                            }
                        });
                        const writer = fs.createWriteStream(localLogoPath);
                        response.data.pipe(writer);
                        await new Promise((resolve, reject) => {
                            writer.on('finish', resolve);
                            writer.on('error', reject);
                        });
                        console.log(`[LogoCache] Successfully cached logo for ${c.channelId}`);
                    } catch (err) {
                        console.error(`[LogoCache] Background cache failed for ${c.channelId}:`, err.message);
                    }
                })();
            }

            // Check if the channel's API slot is actually connected
            let isConnected = true;
            if (c.bundleInstanceId !== undefined) {
                const inst = bundleApi.getInstanceById(c.bundleInstanceId);
                const lookupKey = inst ? inst.key : c.bundleInstanceId;
                const usage = bundleApi.getUsageForKey(lookupKey);
                let liveConnected = true;
                if (c.platform === 'facebook' && !usage.facebookConnected) liveConnected = false;
                if (c.platform === 'youtube' && !usage.youtubeConnected) liveConnected = false;

                if (!liveConnected) {
                    if (c.status === 'connected') {
                        liveConnected = true;
                    } else {
                        isConnected = false;
                    }
                }
            }

            return {
                ...c,
                thumbnail: isCached ? localLogoUrl : c.thumbnail,
                platform: c.platform || 'youtube',
                isConnected: isConnected
            };
        }));

        console.log(`[/channels] Sending ${processedChannels.length} channels for ${username}`);
        res.json(processedChannels);
    } catch (error) {
        console.error('Error reading channels file:', error);
        res.status(500).json({ error: 'Failed to load channels.' });
    }
});

// Define and ensure directories exist
const UPLOADS_DIR = UPLOADS_BASE_DIR;
const VIDEOS_DIR = UPLOADS_DIR;
// fs.ensureDirSync(UPLOADS_DIR); // Moved up
// fs.ensureDirSync(TEMP_BASE_DIR); // Moved up

// --- Job Queue for Video Processing ---
const videoQueue = [];
const jobStatus = {}; // Store job status by sessionId
let isProcessingVideo = false;

// --- Automatic Cleanup for Abandoned Sessions ---
async function cleanupAbandonedSessions() {
    const tempDir = TEMP_BASE_DIR;
    if (!await fs.pathExists(tempDir)) return;
    const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000); // 3 Hours

    try {
        const userFolders = await fs.readdir(tempDir);
        for (const userFolder of userFolders) {
            const userFolderPath = path.join(tempDir, userFolder);
            const stats = await fs.stat(userFolderPath);

            if (stats.isDirectory()) {
                const sessionFolders = await fs.readdir(userFolderPath);
                for (const sessionFolder of sessionFolders) {
                    const sessionFolderPath = path.join(userFolderPath, sessionFolder);
                    try {
                        const sessionStats = await fs.stat(sessionFolderPath);
                        if (sessionStats.isDirectory() && sessionStats.mtime.getTime() < threeHoursAgo) {
                            const isSessionInQueue = videoQueue.some(job => job.sessionId === sessionFolder);
                            if (!isSessionInQueue && (!jobStatus[sessionFolder] || (jobStatus[sessionFolder].status !== 'processing' && jobStatus[sessionFolder].status !== 'uploading'))) {
                                console.log(`[Cleanup] Deleting abandoned session folder (>3h): ${sessionFolderPath}`);
                                await fs.remove(sessionFolderPath);
                            }
                        }
                    } catch (err) {
                        console.error(`[Cleanup] Error processing session folder ${sessionFolderPath}:`, err);
                    }
                }

                // Optional: remove empty user folders
                const remaining = await fs.readdir(userFolderPath);
                if (remaining.length === 0) {
                    await fs.rmdir(userFolderPath);
                }
            }
        }
    } catch (err) {
        console.error(`[Cleanup] Error scanning temp dir:`, err);
    }
}
setInterval(cleanupAbandonedSessions, 60 * 60 * 1000); // Check every hour

// --- Video Processing Logic ---
// Helper to concatenate multiple audio files
async function concatenateAudioFiles(sessionDir) {
    const files = await fs.readdir(sessionDir);

    // Find all audio files (starting with audio_) BUT EXCLUDE already merged files (audio_merged_)
    const audioFiles = files
        .filter(f => f.match(/^audio_\d+.*\.(opus|mp3|m4a|wav|webm)$/)) // Only matches audio_TIMESTAMP...
        .sort(); // Sorts by timestamp in filename

    if (audioFiles.length === 0) return null;
    if (audioFiles.length === 1) return path.join(sessionDir, audioFiles[0]);

    console.log(`[FFmpeg] Concatenating ${audioFiles.length} audio files...`);
    const listPath = path.join(sessionDir, 'concat_list.txt');
    const extension = path.extname(audioFiles[0]) || '.mp3';
    const outputPath = path.join(sessionDir, `audio_merged_${Date.now()}${extension}`);

    // Create file list for ffmpeg
    const fileContent = audioFiles.map(f => `file '${path.join(sessionDir, f).replace(/'/g, "'\\''")}'`).join('\n');
    await fs.writeFile(listPath, fileContent);

    // Run concat (Stream Copy - Fast/Zero CPU)
    await new Promise((resolve, reject) => {
        ffmpeg()
            .input(listPath)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions(['-c copy'])
            .output(outputPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
    });

    return outputPath;
}

// Helper function to get audio duration using a Promise
function getAudioDuration(audioPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(audioPath, (err, metadata) => {
            // ... existing getAudioDuration body ...
            if (err) {
                return reject(new Error(`FFprobe error: ${err.message}`));
            }
            const duration = metadata.format.duration;
            if (!duration || duration === 0) {
                return reject(new Error('Could not determine audio duration or audio is empty.'));
            }
            resolve(duration);
        });
    });
}


// Helper to calculate total duration of all audio files in a session
async function getTotalSessionAudioDuration(sessionDir) {
    if (!await fs.pathExists(sessionDir)) return 0;
    const files = await fs.readdir(sessionDir);
    const audioFiles = files.filter(f => /^(audio_|audio\.).*\.(opus|mp3|m4a|wav|webm)$/.test(f));

    let totalSeconds = 0;
    for (const file of audioFiles) {
        try {
            const duration = await getAudioDuration(path.join(sessionDir, file));
            totalSeconds += duration;
        } catch (e) {
            console.error(`Failed to get duration for ${file}:`, e.message);
        }
    }
    return Math.round(totalSeconds);
}

// Updated function to handle merged audio and overlays (v188)
async function createVideoWithFfmpeg(sessionId, audioPathInput, imagePath, videoPath, overlay = null, plan = 'free') {
    const sessionDir = path.dirname(imagePath);
    let audioPath = audioPathInput;

    // Try to concatenate if multiple files exist
    try {
        const mergedPath = await concatenateAudioFiles(sessionDir);
        if (mergedPath) audioPath = mergedPath;
    } catch (err) {
        console.error('Concatenation failed, falling back to single file:', err);
    }

    let attempts = 3;

    // Verify audio
    try {
        await fs.access(audioPath, fs.constants.R_OK);
        const stats = await fs.stat(audioPath);
        if (stats.size === 0) throw new Error('Audio file is empty');
        console.log(`[FFmpeg] Audio file verified: ${audioPath} (${stats.size} bytes)`);
    } catch (err) {
        console.error(`[FFmpeg] Error accessing audio file: ${err.message}`);
        throw new Error(`Audio file error: ${err.message}`);
    }

    const totalDurationSeconds = await getAudioDuration(audioPath);
    console.log(`[FFmpeg] Audio duration: ${totalDurationSeconds} seconds.`);

    // --- STEP 1: Create 1-minute Base Loop Video ---
    const loopVideoPath = path.join(path.dirname(videoPath), `loop_${sessionId}.mp4`);
    const LOOP_DURATION = 60; // 1 minute base loop
    const exactDuration = (totalDurationSeconds < LOOP_DURATION) ? Math.ceil(totalDurationSeconds) + 1 : LOOP_DURATION;

    console.log(`[FFmpeg] Creating base loop video of ${exactDuration} seconds...`);

    await new Promise((resolve, reject) => {
        let command = ffmpeg().input(imagePath).inputOptions(['-loop 1', '-framerate 1']);

        const iconPath = path.join(__dirname, 'assets', 'music_icon.png');
        const watermarkText = 'uploaded via liveenity.com';

        if (overlay && overlay.path) {
            const relativeOverlayPath = overlay.path.startsWith('/') ? overlay.path.substring(1) : overlay.path;
            const overlayFullPath = path.join(__dirname, '..', relativeOverlayPath);
            command = command.input(overlayFullPath);
            if (overlay.type === 'video') {
                command = command.inputOptions('-stream_loop -1');
            }

            const x = Math.round(overlay.x * 1280);
            const y = Math.round(overlay.y * 720);
            const w = Math.round(overlay.w * 1280 / 2) * 2;
            const h = Math.round(overlay.h * 720 / 2) * 2;

            let filterChain = [
                `[0:v]scale=1280:720,setsar=1[bg]`,
                `[1:v]scale=${w}:${h}[ovrl]`,
                `[bg][ovrl]overlay=${x}:${y}:shortest=1[v_merged]`
            ];

            let finalOutput = 'v_merged';

            if (plan === 'free') {
                console.log('[FFmpeg] Enforcing Free Plan Watermark (Overlay Mode)');
                command = command.input(iconPath);
                // Draw a very long black bar to satisfy "long in right/left"
                filterChain.push(`[v_merged]drawbox=y=0:x=w-1000:w=1000:h=40:color=black@1:t=fill[v_box]`);
                filterChain.push(`[2:v]scale=-1:32[icon_scaled]`);
                // Overlay icon on the left side of the bar
                filterChain.push(`[v_box][icon_scaled]overlay=x=main_w-990:y=4[v_with_icon]`);
                // Draw text to the right of the icon
                filterChain.push(`[v_with_icon]drawtext=text='${watermarkText}':fontcolor=white:fontsize=32:x=main_w-940:y=2[out]`);
                finalOutput = 'out';
            }

            command
                .complexFilter(filterChain.join(';'), finalOutput)
                .outputOptions([
                    '-t', `${exactDuration}`,
                    '-r', '24',
                    '-preset', 'ultrafast',
                    '-tune', 'stillimage',
                    '-crf', '32',
                    '-threads', '0',
                    '-pix_fmt', 'yuv420p',
                    '-an'
                ]);
        } else {
            // Optimized No-Overlay Path
            if (plan === 'free') {
                console.log('[FFmpeg] Enforcing Free Plan Watermark (Standard Mode)');
                command = command.input(iconPath);
                command
                    .complexFilter([
                        '[0:v]scale=1280:720,setsar=1[bg]',
                        '[bg]drawbox=y=0:x=w-1000:w=1000:h=40:color=black@1:t=fill[v_box]',
                        '[1:v]scale=-1:32[icon_scaled]',
                        '[v_box][icon_scaled]overlay=x=main_w-990:y=4[v_with_icon]',
                        `[v_with_icon]drawtext=text='${watermarkText}':fontcolor=white:fontsize=32:x=main_w-940:y=2[out]`
                    ], 'out')
                    .outputOptions([
                        '-t', `${exactDuration}`,
                        '-r', '24',
                        '-preset', 'ultrafast',
                        '-tune', 'stillimage',
                        '-crf', '32',
                        '-threads', '0',
                        '-pix_fmt', 'yuv420p',
                        '-an'
                    ]);
            } else {
                command
                    .videoFilters('scale=1280:720,setsar=1')
                    .outputOptions([
                        '-t', `${exactDuration}`,
                        '-r', '24',
                        '-preset', 'ultrafast',
                        '-tune', 'stillimage',
                        '-crf', '32',
                        '-threads', '0',
                        '-pix_fmt', 'yuv420p',
                        '-an'
                    ]);
            }
        }

        command
            .videoCodec(process.env.VIDEO_CODEC || 'libx264')
            .output(loopVideoPath)
            .on('start', (cmd) => console.log('[FFmpeg] Step 1 Command:', cmd))
            .on('end', resolve)
            .on('error', (err, stdout, stderr) => {
                console.error('[FFmpeg] Step 1 Error:', err.message);
                console.error('[FFmpeg] Step 1 stderr:', stderr);
                reject(new Error('Base loop creation failed: ' + err.message));
            })
            .run();
    });

    console.log('[FFmpeg] Base loop created. Now assembling final video...');

    // --- STEP 2: Concat/Loop the Base Video with Audio (Copy Mode) ---
    // Calculate how many times we need to loop the 60s chunk to cover the audio
    const loopCount = Math.ceil(totalDurationSeconds / exactDuration) + 1; // +1 buffer

    for (let i = 1; i <= attempts; i++) {
        try {
            await new Promise((resolve, reject) => {
                console.log(`[FFmpeg] Assembly Attempt ${i}: Looping base video ${loopCount} times...`);

                const command = ffmpeg()
                    .input(loopVideoPath)
                    .inputOptions([
                        `-stream_loop ${loopCount}`
                    ])
                    .input(audioPath)
                    .outputOptions([
                        '-c copy',
                        '-map 0:v',
                        '-map 1:a',
                        '-shortest',
                        '-movflags +faststart'
                    ])
                    .output(videoPath);

                console.log('[FFmpeg] Assembly Command:', command._getArguments().join(' '));

                command
                    .on('end', () => {
                        console.log('[FFmpeg] Final assembly finished.');
                        resolve();
                    })
                    .on('error', (err, stdout, stderr) => {
                        console.error('[FFmpeg] Assembly Error:', err.message);
                        reject(err);
                    })
                    .run();
            });

            // Cleanup the temp loop file
            try { await fs.unlink(loopVideoPath); } catch (e) { /* ignore */ }
            return; // Success

        } catch (error) {
            console.error(`[FFmpeg] Assembly attempt ${i} failed:`, error.message);
            if (i === attempts) throw error;
            await new Promise(res => setTimeout(res, 2000));
        }
    }
}

async function processVideoQueue() {
    if (isProcessingVideo || videoQueue.length === 0) return;
    isProcessingVideo = true;
    const job = videoQueue.shift();
    const { sessionId, audioPath, imagePath, title, description, tags, visibility, publishAt, channelId, overlay, plan, username, deleteChannelOnSuccess } = job;
    console.log(`[Queue] Processing job: sessionId=${sessionId}, platform=${job.platform}, publishAt=${publishAt}`);
    const outputVideoPath = path.join(VIDEOS_DIR, `${sessionId}_${Date.now()}.mp4`);

    try {
        // 1. Resolve channel metadata
        let channelMeta = job.channelMeta;
        if (!channelMeta) {
            const userChannels = await mp3toytChannels.getChannelsForUser(username);
            channelMeta = userChannels.find(c => c.channelId === channelId);
        }

        if (!channelMeta) {
            throw new Error(`Channel ${channelId} not found for user ${username}.`);
        }

        const platform = channelMeta.platform || 'youtube';
        const isBundle = !!channelMeta.socialAccountId;
        const bundleInstanceId = channelMeta.bundleInstanceId;

        jobStatus[sessionId] = { status: 'processing', message: 'Creating video file...', platform };

        // Mark activity as starting
        if (isBundle) {
            await bundleApi.updateActivity(bundleInstanceId, channelId, platform);
        }

        const creationStartTime = Date.now();
        await createVideoWithFfmpeg(sessionId, audioPath, imagePath, outputVideoPath, overlay, plan);
        const creationTime = Math.round((Date.now() - creationStartTime) / 1000);

        // Update activity again before upload starts (prevents cleanup during long renders)
        if (isBundle) {
            await bundleApi.updateActivity(bundleInstanceId, channelId, platform);
        }

        // Log final video size
        try {
            const stats = await fs.stat(outputVideoPath);
            const sizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
            console.log(`[Queue] Final video created: ${outputVideoPath} (${sizeInMB} MB)`);
        } catch (sizeErr) {
            console.warn('[Queue] Could not determine final video size:', sizeErr.message);
        }

        jobStatus[sessionId] = { status: 'uploading', message: `Uploading to ${platform === 'facebook' ? 'Facebook' : 'YouTube'}... 0%`, platform };
        const uploadStartTime = Date.now();

        let uploadResult;
        let videoUrl;

        if (isBundle) {
            // Bundle.social Upload (Facebook or YouTube)
            console.log(`[Queue] Uploading to Bundle.social (${platform}) via instance ${bundleInstanceId}: ${outputVideoPath}`);
            if (jobStatus[sessionId]) jobStatus[sessionId].message = `Uploading to ${platform}...`;
            const mediaId = await bundleApi.uploadVideo(bundleInstanceId, outputVideoPath);

            if (!mediaId) throw new Error('Failed to upload to Bundle.social');

            if (jobStatus[sessionId]) jobStatus[sessionId].message = `Publishing to ${platform}...`;
            const postText = `${title}\n\n${description || ''}`;

            if (platform === 'facebook') {
                bundleApi.postToFacebook(bundleInstanceId, channelId, mediaId, postText, publishAt)
                    .then(res => console.log(`[Queue] Background Facebook post result:`, JSON.stringify(res)))
                    .catch(err => console.error(`[Queue] Background Facebook post failed:`, err.message));
            } else {
                bundleApi.postToYoutube(bundleInstanceId, channelId, mediaId, postText, publishAt)
                    .then(res => console.log(`[Queue] Background Bundle YouTube post result:`, JSON.stringify(res)))
                    .catch(err => console.error(`[Queue] Background Bundle YouTube post failed:`, err.message));
            }

            uploadResult = {
                success: true,
                data: { id: mediaId },
                url: `https://bundle.social/dashboard`
            };
        } else if (platform === 'facebook' && username === 'erraja') {
            // Direct Facebook Posting for Admin (erraja) using Puppeteer
            console.log(`[Queue] Using Puppeteer Automation for Facebook admin: erraja`);
            if (jobStatus[sessionId]) jobStatus[sessionId].message = `Automating Facebook upload...`;

            const postText = `${title}\n\n${description || ''}`;
            const result = await uploadVideoWithPuppeteer(outputVideoPath, postText);

            if (result.success) {
                uploadResult = {
                    success: true,
                    data: { id: 'automated-post' },
                    url: 'https://www.facebook.com'
                };
            } else {
                uploadResult = {
                    success: false,
                    error: result.error || 'Puppeteer automation failed.'
                };
            }
        } else {
            // Direct YouTube API (Only for admin or specific claimed direct channels)
            console.log(`[Queue] Using direct YouTube API for user: ${username}`);
            const privacyStatus = (visibility === 'schedule' || publishAt) ? 'private' : visibility;
            const videoMetadata = {
                title,
                description,
                tags: Array.isArray(tags) ? tags : (tags ? tags.split(',').map(tag => tag.trim()) : []),
                privacyStatus,
                ...(publishAt && { publishAt })
            };

            uploadResult = await uploadVideo(channelId, outputVideoPath, videoMetadata, (percent) => {
                if (jobStatus[sessionId]) jobStatus[sessionId].message = `Uploading to YouTube... ${percent}%`;
            });
        }

        if (!uploadResult.success) throw new Error(uploadResult.error || 'Upload failed.');

        // Final activity update upon successful upload
        if (isBundle) {
            await bundleApi.updateActivity(bundleInstanceId, channelId, platform);
        }

        const uploadTime = Math.round((Date.now() - uploadStartTime) / 1000);

        // Use the URL returned by the upload process if available
        videoUrl = uploadResult.url || (
            (platform === 'facebook')
                ? `https://www.facebook.com/${uploadResult.data.id}`
                : `https://www.youtube.com/watch?v=${uploadResult.data.id}`
        );

        jobStatus[sessionId] = {
            status: 'complete',
            message: platform === 'facebook' ? 'Scheduled on Bundle.social!' : 'Upload Complete!',
            videoUrl,
            creationTime,
            uploadTime,
            platform,
            publishAt
        };

        // Note: Automation stats tracking removed for manual Facebook uploads.
        // Stats should only increment for actual scheduled automation posts.

    } catch (error) {
        console.error(`[Queue] Error for session ${sessionId}:`, error.message);
        jobStatus[sessionId] = { status: 'failed', message: `An error occurred: ${error.message}` };

        if (username === 'erraja' && (error.message.includes('exceeded the number of videos') || error.message.includes('quotaExceeded'))) {
            console.log(`[Queue] Admin channel ${channelId} has hit its limit. Auto-deleting for clean system.`);
            try {
                await mp3toytChannels.deleteChannel(channelId, username);
                await deleteToken(channelId);
            } catch (delErr) {
                console.error(`[Queue] Failed to auto-delete exhausted admin channel ${channelId}:`, delErr.message);
            }
        }
    } finally {
        try {
            await acquireAutomationLock();
            // Update stats if successful
            if (jobStatus[sessionId].status === 'complete') {
                let stats = {};
                if (await fs.pathExists(AUTOMATION_STATS_PATH)) {
                    stats = await fs.readJson(AUTOMATION_STATS_PATH);
                }
                stats[username] = (stats[username] || 0) + 1;
                stats.total_lifetime_videos = (stats.total_lifetime_videos || 0) + 1;
                await fs.writeJson(AUTOMATION_STATS_PATH, stats, { spaces: 4 });
                console.log(`[Automation Stats] Updated for ${username}: ${stats[username]} total videos.`);
            }

            // Always decrement pending counter regardless of success/failure
            if (username && automationPendingCounters[username] > 0) {
                automationPendingCounters[username]--;
            }
        } catch (lockErr) {
            console.error('[Automation Stats] Failed to update stats or decrement counter:', lockErr);
        } finally {
            releaseAutomationLock();
        }

        // Delay cleanup to avoid race conditions with the client starting a new session
        setTimeout(async () => {
            const sessionDir = path.dirname(audioPath);
            if (await fs.pathExists(sessionDir)) {
                await fs.remove(sessionDir).catch(err => console.error(`[Cleanup] Failed to remove session dir ${sessionDir}:`, err));
            }
            if (await fs.pathExists(outputVideoPath)) {
                await fs.remove(outputVideoPath).catch(err => console.error(`[Cleanup] Failed to remove video file ${outputVideoPath}:`, err));
            }
        }, 5000); // 5-second delay

        isProcessingVideo = false;
        processVideoQueue();
    }
}

// ... (rest of the code remains the same)
router.get('/session-status', async (req, res) => {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ success: false, message: 'Session ID is missing.' });
    try {
        const username = req.session && req.session.username ? req.session.username : 'guest';
        const sessionDir = path.join(TEMP_BASE_DIR, username, sessionId);
        let audioFiles = [];
        let imageExists = false;
        let foundImageFilename = null;

        if (await fs.pathExists(sessionDir)) {
            const files = await fs.readdir(sessionDir);
            audioFiles = files.filter(f => /^(audio_|audio\.).*\.(opus|mp3|m4a|wav|webm)$/.test(f));
            // Find the image file (could be any extension)
            const imageFile = files.find(f => f.startsWith('image.'));
            if (imageFile) {
                imageExists = true;
                foundImageFilename = imageFile;
            }
        }

        let totalDurationFormatted = null;
        if (audioFiles.length > 0) {
            const totalSeconds = await getTotalSessionAudioDuration(sessionDir);
            const tMinutes = Math.floor(totalSeconds / 60);
            const tSeconds = totalSeconds % 60;
            totalDurationFormatted = `${tMinutes}:${tSeconds.toString().padStart(2, '0')}`;
        }

        res.json({
            success: true,
            audio: audioFiles.length > 0,
            audioCount: audioFiles.length,
            totalDuration: totalDurationFormatted,
            image: imageExists,
            imageUrl: imageExists ? `/temp/${username}/${sessionId}/${foundImageFilename}` : null
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error checking session status.' });
    }
});

router.post('/create-video', upload.none(), async (req, res) => {
    const { sessionId, title, description, tags, visibility, publishAt, channelId, platform, overlay } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, error: 'Session ID is missing.' });

    try {
        const username = req.session && req.session.username ? req.session.username : 'guest';
        const sessionDir = path.join(TEMP_BASE_DIR, username, sessionId);
        if (!await fs.pathExists(sessionDir)) {
            return res.status(400).json({ success: false, error: 'Session has expired or files were not uploaded.' });
        }

        const files = await fs.readdir(sessionDir);
        const audioFilename = files.find(f => f.startsWith('audio_') || f.startsWith('audio.')); // Find any audio
        const imageFilename = files.find(f => f.startsWith('image.')); // Find any image (jpg, webp, etc.)

        if (!audioFilename) {
            return res.status(400).json({ success: false, error: 'Audio file not found.' });
        }

        if (!imageFilename) {
            return res.status(400).json({ success: false, error: 'Image file not found.' });
        }

        const audioPath = path.join(sessionDir, audioFilename);
        const imagePath = path.join(sessionDir, imageFilename);

        const plan = req.session && req.session.plan ? req.session.plan : 'free';
        const usernameForActivity = req.session && req.session.username ? req.session.username : 'guest';
        console.log(`[Queue] Adding job for user: ${usernameForActivity} (Plan: ${plan})`);
        // refreshActivity(usernameForActivity); // Handled by actual usage now

        jobStatus[sessionId] = { status: 'queued', message: 'Your video is in the queue.' };
        videoQueue.push({ sessionId, audioPath, imagePath, title, description, tags, visibility, publishAt, channelId, platform: platform || 'youtube', overlay, plan, username });

        // Start processing the queue, but don't block the response.
        try {
            processVideoQueue();
        } catch (processError) {
            console.error(`[Queue] Failed to start queue processing for session ${sessionId}:`, processError);
        }

        res.json({ success: true, message: 'Your video has been added to the queue.', sessionId });
    } catch (error) {
        console.error(`[API Error] /create-video failed for session ${sessionId}:`, error);
        res.status(500).json({ success: false, error: 'Failed to add video to the queue. Check server logs for details.' });
    }
});

router.post('/start-automation', async (req, res) => {
    const { links, thumbUrl, __internalCall } = req.body;
    let username = req.session && req.session.username ? req.session.username : 'guest';
    const userId = req.session && req.session.userId ? req.session.userId : null;

    // Internal Bypass for Pending Queue Processor
    if (__internalCall && req.headers['x-internal-user']) {
        username = req.headers['x-internal-user'];
    }

    // Automation is restricted to erraja only
    if (username !== 'erraja') {
        console.warn(`[Automation Security] Non-admin user ${username} tried to start automation.`);
        return res.status(403).json({ success: false, error: 'Automation is restricted to administrative accounts.' });
    }

    if (!links || !Array.isArray(links) || links.length === 0) {
        return res.status(400).json({ success: false, error: 'No links provided.' });
    }

    try {
        // 2. Determine Channel (Atomic Selection with Lock)
        await acquireAutomationLock();
        let stats = {};
        let activeChannel;
        let activeDeleteOnSuccess;
        let activeUserCount;
        let allChannels = [];

        try {
            if (await fs.pathExists(AUTOMATION_STATS_PATH)) {
                stats = await fs.readJson(AUTOMATION_STATS_PATH);
            }

            // Re-fetch channels inside lock to get latest status
            if (username && username !== 'guest') {
                allChannels = (await mp3toytChannels.getChannelsForUser(username)).filter(c => c.status !== 'exhausted');
            }

            const savedCount = stats[username] || 0;
            const pendingCount = automationPendingCounters[username] || 0;
            const effectiveCount = savedCount + pendingCount;
            const channelIndex = Math.floor(effectiveCount / 6);

            // CAPACITY CHECK: If no channels OR we've assigned all available slots (6 per channel)
            if (allChannels.length === 0 || channelIndex >= allChannels.length) {
                console.log(`[Automation] No capacity for ${username} (${allChannels.length} channels, ${effectiveCount} assigned). Saving to memory...`);
                let pending = [];
                if (await fs.pathExists(PENDING_AUTOMATION_PATH)) {
                    pending = await fs.readJson(PENDING_AUTOMATION_PATH);
                }
                pending.push({ links, thumbUrl, username, timestamp: new Date().toISOString() });
                await fs.writeJson(PENDING_AUTOMATION_PATH, pending, { spaces: 4 });

                releaseAutomationLock();
                return res.json({
                    success: true,
                    isPending: true,
                    message: allChannels.length === 0
                        ? 'No active channels found. Saved to memory.'
                        : 'All channel slots are full. Saved to memory and will process once a slot opens or a new channel is connected.'
                });
            }

            activeChannel = allChannels[channelIndex];

            // Determine if this specific upload will trigger the switch (6th video of its channel)
            const nextCount = (effectiveCount + 1);
            activeUserCount = effectiveCount; // Used for scheduling logic below
            activeDeleteOnSuccess = nextCount % 6 === 0;

            console.log(`[Automation] Consuming Channel: ${activeChannel.channelTitle} (ID: ${activeChannel.channelId}) | Saved: ${savedCount}, Pending: ${pendingCount}, Total Assigned: ${nextCount}/6`);

            // Track this as pending immediately to "reserve" the slot
            automationPendingCounters[username] = (automationPendingCounters[username] || 0) + 1;

        } finally {
            releaseAutomationLock();
        }

        // 3. Setup Session
        const sessionId = `auto_${uuidv4().substring(0, 8)}`;
        const sessionDir = path.join(TEMP_BASE_DIR, username, sessionId);
        await fs.ensureDir(sessionDir);

        // 4. Download Thumbnail with Fallback
        let imagePath = path.join(sessionDir, 'image.jpg');
        let thumbnailSuccess = false;

        if (thumbUrl) {
            console.log(`[Automation] Downloading thumbnail: ${thumbUrl}`);
            try {
                await downloadImage(thumbUrl, imagePath, username, sessionId);
                if (await fs.pathExists(imagePath)) {
                    thumbnailSuccess = true;
                    console.log(`[Automation] Thumbnail downloaded: ${imagePath}`);
                }
            } catch (err) {
                console.warn(`[Automation] Thumbnail download failed: ${err.message}. Using fallback.`);
            }
        }

        if (!thumbnailSuccess) {
            console.log(`[Automation] No thumbnail provided or download failed. Picking fallback...`);
            const fallbackPath = await getRandomFallbackThumbnail();
            if (fallbackPath) {
                await fs.copy(fallbackPath, imagePath);
                console.log(`[Automation] Using fallback thumbnail: ${fallbackPath}`);
            } else {
                console.error(`[Automation] CRITICAL: No fallback thumbnails found in ${FALLBACK_THUMBNAILS_DIR}`);
                // If everything fails, we still need AN image to prevent FFmpeg crash
                // We'll try to find any image in the logos directory or just let it fail later
            }
        }

        // 5. Start background processing (Don't block response)
        (async () => {
            try {
                const downloadedFiles = [];
                let videoTitle = '';
                let videoDescription = '';

                // Fetch metadata from the first link (for title/description)
                console.log(`[Automation] Fetching metadata for title/description...`);
                const meta = await getYoutubeMetadata(links[0]);
                videoTitle = meta.title;
                videoDescription = meta.description;
                const videoTags = meta.tags || [];

                // Download all audio links
                for (let i = 0; i < links.length; i++) {
                    const link = links[i];
                    console.log(`[Automation] [Song ${i + 1}/${links.length}] Downloading audio (Opus): ${link}`);
                    const audioFilename = `audio_${i}_${Date.now()}.opus`;
                    const audioPath = path.join(sessionDir, audioFilename);

                    await downloadAudio(link, audioPath, 'opus');
                    console.log(`[Automation] [Song ${i + 1}/${links.length}] Downloaded successfully.`);

                    if (await fs.pathExists(audioPath)) {
                        downloadedFiles.push(audioPath);
                    }
                }

                if (downloadedFiles.length === 0) throw new Error('No audio files downloaded.');

                // 6. Concatenate if multiple songs
                let finalAudioPath = downloadedFiles[0];
                if (downloadedFiles.length > 1) {
                    console.log(`[Automation] Merging ${downloadedFiles.length} songs into one video...`);
                    finalAudioPath = await concatenateAudioFiles(sessionDir);
                    console.log(`[Automation] Merging complete: ${finalAudioPath}`);
                }
                // 7. Determine Scheduling (6-video cycle based on userCount before increment)
                const cycleIndex = activeUserCount % 6;
                let visibility = 'public';
                let publishAt = null;

                console.log(`[Automation] [User: ${username}] Scheduling for count: ${activeUserCount} (Cycle Index: ${cycleIndex}/5)`);

                if (cycleIndex > 0) {
                    visibility = 'private'; // Scheduled videos must be private first
                    const daysOffset = cycleIndex * 2;
                    const publishDate = new Date();
                    publishDate.setDate(publishDate.getDate() + daysOffset);

                    // Randomize hour (9 AM to 9 PM) and minutes
                    const randomHour = Math.floor(Math.random() * (21 - 9 + 1)) + 9;
                    const randomMin = Math.floor(Math.random() * 60);
                    publishDate.setHours(randomHour, randomMin, 0, 0);

                    publishAt = publishDate.toISOString();
                    console.log(`[Automation] [Mode: SCHEDULED] Scheduled for ${daysOffset} days from now: ${publishAt}`);
                } else {
                    const randomDays = Math.floor(Math.random() * 3); // 0, 1, or 2 days
                    if (randomDays === 0) {
                        console.log(`[Automation] [Mode: PUBLIC] First video of cycle. Uploading immediately.`);
                    } else {
                        visibility = 'private';
                        const publishDate = new Date();
                        publishDate.setDate(publishDate.getDate() + randomDays);

                        const randomHour = Math.floor(Math.random() * (21 - 9 + 1)) + 9;
                        const randomMin = Math.floor(Math.random() * 60);
                        publishDate.setHours(randomHour, randomMin, 0, 0);

                        publishAt = publishDate.toISOString();
                        console.log(`[Automation] [Mode: RANDOM_SCHEDULE] First video scheduled for ${randomDays} days from now: ${publishAt}`);
                    }
                }

                // 8. Add to videoQueue
                const platform = activeChannel.platform || 'youtube';
                console.log(`[Automation] Queuing for ${activeChannel.channelTitle} (${platform}) | Visibility: ${visibility} | Schedule: ${publishAt || 'N/A'}`);

                jobStatus[sessionId] = { status: 'queued', message: 'Automated video prepared.' };
                videoQueue.push({
                    sessionId,
                    audioPath: finalAudioPath,
                    imagePath,
                    title: videoTitle,
                    description: videoDescription,
                    tags: videoTags,
                    visibility,
                    publishAt,
                    channelId: activeChannel.channelId,
                    platform,
                    plan: 'free',
                    username,
                    deleteChannelOnSuccess: activeDeleteOnSuccess,
                    channelMeta: activeChannel
                });

                console.log(`[Automation] Background tasks queued. Lifetime Total: ${stats.total_lifetime_videos}`);
                processVideoQueue();

            } catch (bgError) {
                console.error(`[Automation BG Error] Session ${sessionId}:`, bgError.message);
                jobStatus[sessionId] = { status: 'failed', message: bgError.message };
                // Decrement pending counter if the background job fails
                if (username && automationPendingCounters[username] > 0) {
                    automationPendingCounters[username]--;
                }
            }
        })();

        res.json({
            success: true,
            message: `Video queued for ${activeChannel.channelTitle}. Songs: ${links.length}. Next switch in ${6 - ((activeUserCount + 1) % 6)} videos.`,
            sessionId
        });

    } catch (error) {
        console.error('[Automation Error]', error);
        res.status(500).json({ success: false, error: 'Failed to start automation.' });
    }
});

router.get('/job-status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const status = jobStatus[sessionId];
    if (!status) return res.status(404).json({ status: 'not_found', message: 'Job not found.' });
    res.json(status);
    if (status.status === 'complete' || status.status === 'failed') {
        // Only delete after 60s IF it hasn't been replaced by a new job
        setTimeout(() => {
            if (jobStatus[sessionId] && (jobStatus[sessionId].status === 'complete' || jobStatus[sessionId].status === 'failed')) {
                delete jobStatus[sessionId];
            }
        }, 60000);
    }
});

// --- Authentication Routes ---

router.get('/auth/mp3toyt', async (req, res) => {
    try {
        const username = req.session && req.session.username ? req.session.username : 'guest';

        if (username !== 'erraja') {
            console.log(`[Auth] Redirecting regular user ${username} to Bundle.social for YouTube`);
            const redirectUri = getRedirectUri(req, '/auth/youtube/callback');
            const connectUrl = await bundleApi.getYoutubeConnectUrl(redirectUri);
            if (!connectUrl) throw new Error('Could not generate Bundle.social YouTube connect URL');
            return res.redirect(connectUrl);
        }

        // Generate the redirect URI based on the request host
        const redirectUri = `${req.protocol}://${req.get('host')}/mp3toyt/oauth2callback`;

        // getAuthUrl will throw if credentials.json is bad, triggering the catch block below
        const authUrl = getAuthUrl(redirectUri, 'mp3toyt');

        console.log(`[Auth] Generating URL for erraja with redirect: ${redirectUri}`);
        res.redirect(authUrl);
    } catch (error) {
        console.error('[Auth Error]', error);
        if (error.message.includes('No available Bundle.social slots')) {
            return res.status(503).send('we coldnt connet to account. Please try again later.');
        }
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>YouTube Authentication Error</title>
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
                <style>
                    body { font-family: 'Inter', -apple-system, sans-serif; background-color: #f0f2f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
                    .card { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); max-width: 550px; width: 100%; text-align: center; border: 1px solid #e0e0e0; position: relative; }
                    .icon { font-size: 64px; color: #ef4444; margin-bottom: 20px; }
                    h2 { color: #1f2937; margin: 0 0 10px; font-size: 24px; }
                    .message { color: #6b7280; background: #fff5f5; border: 1px solid #fee2e2; padding: 15px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 20px 0; word-break: break-word; }
                    .steps { text-align: left; background: #f9fafb; padding: 20px; border-radius: 12px; margin-bottom: 25px; }
                    .steps h3 { margin-top: 0; font-size: 16px; color: #374151; }
                    .steps ol { padding-left: 20px; color: #4b5563; font-size: 14px; line-height: 1.6; }
                    .actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
                    .btn { padding: 12px 24px; border-radius: 8px; font-weight: 600; cursor: pointer; text-decoration: none; transition: all 0.2s; border: none; font-size: 15px; display: inline-flex; align-items: center; gap: 8px; }
                    .btn-primary { background: #1877f2; color: white; }
                    .btn-primary:hover { background: #166fe5; transform: translateY(-1px); }
                    .btn-secondary { background: #e4e6eb; color: #050505; }
                    .btn-secondary:hover { background: #d8dadf; }
                    
                    /* Modal Styles */
                    .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); z-index: 1000; align-items: center; justify-content: center; }
                    .modal-content { background: white; padding: 30px; border-radius: 16px; width: 90%; max-width: 600px; position: relative; }
                    .close-modal { position: absolute; top: 15px; right: 20px; font-size: 28px; cursor: pointer; color: #666; }
                    textarea { width: 100%; min-height: 300px; margin-top: 15px; padding: 12px; border: 1px solid #ddd; border-radius: 8px; font-family: monospace; font-size: 13px; box-sizing: border-box; }
                    .notification { position: fixed; bottom: 20px; right: 20px; padding: 15px 25px; border-radius: 8px; color: white; display: none; z-index: 2000; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="icon"><i class="fas fa-exclamation-circle"></i></div>
                    <h2>YouTube Authentication Error</h2>
                    <div class="message">${error.message}</div>
                    <div class="steps">
                        <h3>How to fix this:</h3>
                        <ol>
                            <li>Go to <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color: #1877f2;">Google Cloud Console</a></li>
                            <li>Download your <strong>OAuth 2.0 Client ID</strong> JSON</li>
                            <li>Click **"Fix in Editor"** below to paste the JSON content</li>
                        </ol>
                    </div>
                    <div class="actions">
                        <button onclick="openEditor()" class="btn btn-primary"><i class="fas fa-edit"></i> Fix in Editor</button>
                        <a href="/auth/mp3toyt" class="btn btn-secondary"><i class="fas fa-sync"></i> Try Again</a>
                        <a href="/" class="btn btn-secondary">Go Back</a>
                    </div>
                </div>

                <!-- Editor Modal -->
                <div id="editorModal" class="modal">
                    <div class="modal-content">
                        <span class="close-modal" onclick="closeEditor()">&times;</span>
                        <h2 style="margin-top: 0; color: #1877f2;"><i class="fas fa-key"></i> Credentials Editor</h2>
                        <p style="font-size: 14px; color: #666;">Paste your <code>credentials.json</code> content here:</p>
                        <textarea id="credentials-json" placeholder='{ "web": { ... } }'></textarea>
                        <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
                            <button onclick="closeEditor()" class="btn btn-secondary">Cancel</button>
                            <button id="saveBtn" onclick="saveCredentials()" class="btn btn-primary">Save Changes</button>
                        </div>
                    </div>
                </div>

                <div id="notification" class="notification"></div>

                <script>
                    function openEditor() {
                        document.getElementById('editorModal').style.display = 'flex';
                        fetch('/get-credentials').then(r => r.json()).then(data => {
                            if(data.success) document.getElementById('credentials-json').value = data.credentials;
                        });
                    }
                    function closeEditor() { document.getElementById('editorModal').style.display = 'none'; }
                    function showNotification(msg, type='success') {
                        const n = document.getElementById('notification');
                        n.textContent = msg;
                        n.style.backgroundColor = type === 'success' ? '#22c55e' : '#ef4444';
                        n.style.display = 'block';
                        setTimeout(() => n.style.display = 'none', 3000);
                    }
                    async function saveCredentials() {
                        const btn = document.getElementById('saveBtn');
                        const json = document.getElementById('credentials-json').value;
                        
                        try {
                            const parsed = JSON.parse(json);
                            if (!parsed.web && !parsed.installed) {
                                showNotification('Invalid structure. Missing "web" or "installed" key.', 'error');
                                return;
                            }
                        } catch (e) {
                            showNotification('Invalid JSON format.', 'error');
                            return;
                        }

                        btn.disabled = true;
                        btn.textContent = 'Saving...';
                        try {
                            const res = await fetch('/save-credentials', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ credentials: json })
                            });
                            const data = await res.json();
                            if (data.success) {
                                showNotification('Saved successfully!');
                                setTimeout(() => {
                                    if (window.opener) {
                                        window.opener.location.reload();
                                        window.close();
                                    } else {
                                        window.location.href = '/app?success=credentials_updated';
                                    }
                                }, 600);
                            } else {
                                showNotification(data.message || 'Error saving', 'error');
                            }
                        } catch (e) { showNotification('Network error', 'error'); }
                        finally { btn.disabled = false; btn.textContent = 'Save Changes'; }
                    }
                    window.onclick = (e) => { if (e.target.className === 'modal') closeEditor(); }
                </script>
            </body>
            </html>
        `);
    }
});

// --- Facebook Authentication (via Bundle.social) ---

router.get('/auth/facebook', async (req, res) => {
    try {
        // We use the same callback URL, though strictly speaking Bundle might just need *any* URL to redirect back to.
        const redirectUri = getRedirectUri(req, '/auth/facebook/callback');
        const connectUrl = await bundleApi.getFacebookConnectUrl(redirectUri);

        if (!connectUrl) {
            return res.status(500).send('Could not generate Bundle.social connection URL. Ensure BUNDLE_API_KEY is set and a Team exists.');
        }

        console.log('[Bundle Auth] Redirecting to:', connectUrl);
        res.redirect(connectUrl);
    } catch (error) {
        console.error('[Bundle Auth Error]', error);
        if (error.message.includes('No available Bundle.social slots')) {
            return res.status(503).send('we coldnt conect to facebook. Please try again in 10 minutes.');
        }
        res.status(500).send('Facebook Authentication Initialization Failed');
    }
});

// Utility to claim channels from Bundle.social for the current user
async function claimBundleChannels(username, targetInstanceId = null) {
    if (!username || username === 'guest') return [];
    try {
        console.log(`[Bundle Claim] Claiming ${targetInstanceId !== null ? 'Targeted' : 'Fresh'} channels for user: ${username}`);

        // 1. Fetch channel data from Bundle (Targeted or Global)
        const bundleChannels = await bundleApi.getConnectedChannels(targetInstanceId);

        // 2. Fetch all local channels to detect conflicts across users
        const allLocalChannels = await mp3toytChannels.getAllChannelsRaw();
        const claimedIds = [];

        for (const ch of bundleChannels) {
            // A. GLOBAL CHANNEL CONFLICT: Is THIS specific channel already linked elsewhere?
            const globalConflict = allLocalChannels.find(lc =>
                lc.channelId === ch.channelId &&
                lc.bundleInstanceId !== ch.bundleInstanceId
            );

            if (globalConflict) {
                console.log(`[Bundle Claim] Global Conflict! Channel ${ch.channelTitle} already exists on Key ${globalConflict.bundleInstanceId}. Disconnecting old instance...`);
                await bundleApi.disconnectPlatform(globalConflict.bundleInstanceId, ch.platform);
            }

            // B. LOCAL SLOT EXCLUSION: Bundle only allows ONE YT/FB per API Key.
            // If Key 1 now has "Channel B", we must remove "Channel A" from our file
            // because it's physically gone from that key slot.
            const slotOccupant = allLocalChannels.find(lc =>
                lc.bundleInstanceId === ch.bundleInstanceId &&
                lc.platform === ch.platform &&
                lc.channelId !== ch.channelId // Different channel, same slot
            );

            if (slotOccupant) {
                console.log(`[Bundle Claim] Slot Exclusion! Key ${ch.bundleInstanceId} (${ch.platform}) now belongs to ${ch.channelTitle}. Removing old record for ${slotOccupant.channelTitle}`);
                await mp3toytChannels.deleteChannel(slotOccupant.channelId);
            }

            // Save/Update the channel for this user
            await mp3toytChannels.saveChannel({
                channelId: ch.channelId,
                channelTitle: ch.channelTitle,
                thumbnail: ch.thumbnail,
                platform: ch.platform,
                socialAccountId: ch.socialAccountId,
                socialAccountId: ch.socialAccountId,
                bundleInstanceId: ch.bundleInstanceId,
                status: 'connected'
            }, username);

            // IMMEDIATE TIMESTAMP: Mark as active NOW so the 5-min timer starts ticking instantly.
            // This prevents the "Free Safety Period" (waiting for next sync).
            await bundleApi.markChannelActive(ch.bundleInstanceId, ch.channelId, ch.platform);

            claimedIds.push(ch.channelId);
        }

        console.log(`[Bundle Claim] Successfully claimed ${bundleChannels.length} channels for user: ${username}`);
        return claimedIds;
    } catch (err) {
        console.error(`[Bundle Claim] Failed for ${username}:`, err.message);
        return [];
    }
}

router.get('/auth/facebook/callback', async (req, res) => {
    // When returning from Bundle's connect flow, the user has already connected the account to Bundle.
    const username = req.session && req.session.username ? req.session.username : 'guest';
    const { inst } = req.query;

    // Attempt to claim any new channels (Targeted if inst provided)
    let newChannelId = '';
    if (username !== 'guest') {
        const claimed = await claimBundleChannels(username, inst);
        if (claimed.length > 0) {
            newChannelId = claimed[0];
            // Trigger Pending Queue
            processPendingAutomation(username).catch(e => console.error('[Pending Trigger Error FB]', e.message));
        }
    }

    res.send(`
        <html>
            <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f0f2f5; margin: 0;">
                <script>
                    window.newChannelId = "${newChannelId}";
                    if (window.opener) {
                        // Refresh the main app with a success parameter to trigger notification
                        window.opener.location.href = '/app?success=facebook' + (window.newChannelId ? '&new_channel_id=' + window.newChannelId : '');
                        window.close();
                    } else {
                        // Not a popup? Redirect current window
                        window.location.href = '/app?success=facebook' + (window.newChannelId ? '&new_channel_id=' + window.newChannelId : '');
                    }
                    
                    // Fallback UI
                    setTimeout(() => {
                        document.body.innerHTML = '<div style="text-align:center;"><h2>Connected!</h2><p>Returning to app...</p></div>';
                        if (!window.opener) window.location.href = '/app?success=facebook' + (window.newChannelId ? '&new_channel_id=' + window.newChannelId : '');
                    }, 500);
                </script>
            </body>
        </html>
    `);
});

router.get('/auth/youtube/callback', async (req, res) => {
    const username = req.session && req.session.username ? req.session.username : 'guest';
    const { inst } = req.query;
    let newChannelId = '';
    if (username !== 'guest') {
        const claimed = await claimBundleChannels(username, inst);
        if (claimed.length > 0) {
            newChannelId = claimed[0];
            // Trigger Pending Queue
            processPendingAutomation(username).catch(e => console.error('[Pending Trigger Error YT]', e.message));
        }
    }
    res.send(`
        <html>
            <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f0f2f5; margin: 0;">
                <script>
                    window.newChannelId = "${newChannelId}";
                    if (window.opener) {
                        // Refresh the main app with a success parameter to trigger notification
                        window.opener.location.href = '/app?success=youtube' + (window.newChannelId ? '&new_channel_id=' + window.newChannelId : '');
                        window.close();
                    } else {
                        // Not a popup? Redirect current window
                        window.location.href = '/app?success=youtube' + (window.newChannelId ? '&new_channel_id=' + window.newChannelId : '');
                    }

                    // Fallback UI
                    setTimeout(() => {
                        document.body.innerHTML = '<div style="text-align:center;"><h2>Connected!</h2><p>Returning to app...</p></div>';
                        if (!window.opener) window.location.href = '/app?success=youtube' + (window.newChannelId ? '&new_channel_id=' + window.newChannelId : '');
                    }, 500);
                </script>
            </body>
        </html>
    `);
});

router.get('/mp3toyt/oauth2callback', async (req, res) => {
    const { code } = req.query;
    const redirectUri = getRedirectUri(req, '/mp3toyt/oauth2callback');

    console.log(`[Auth] Callback received with code length: ${code ? code.length : 0}`);

    if (!code) {
        return res.status(400).send('Authorization code is missing.');
    }

    try {
        // Capture the username from the current session
        const username = req.session && req.session.username ? req.session.username : 'guest';

        if (username !== 'erraja') {
            console.warn(`[Auth] Blocked non-admin user ${username} from direct YouTube OAuth callback`);
            return res.status(403).send('Direct YouTube API access is restricted to admin only. Please use Bundle.social.');
        }

        // Exchange code for tokens
        const savedAuth = await saveTokenFromCode(code, redirectUri);

        if (savedAuth && savedAuth.channelId) {
            console.log(`[Auth] Authenticated channel: ${savedAuth.channelTitle} (${savedAuth.channelId})`);

            const channelData = {
                channelId: savedAuth.channelId,
                channelTitle: savedAuth.channelTitle,
                username: username, // Link to current user
                thumbnail: savedAuth.channelThumbnail, // Save thumbnail
                authenticatedAt: new Date().toISOString()
            };

            await mp3toytChannels.saveChannel(channelData, username);
            console.log(`[Auth] Channel saved.`);

            // Trigger Pending Queue
            processPendingAutomation(username).catch(e => console.error('[Pending Trigger Error]', e.message));

            res.send(`
                <html>
                <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f0f2f5; margin: 0;">
                    <script>
                        window.newChannelId = "${savedAuth.channelId}";
                        if (window.opener) {
                            window.opener.location.href = '/app?success=youtube&new_channel_id=' + window.newChannelId;
                            window.close();
                        } else {
                            window.location.href = '/app?success=youtube&new_channel_id=' + window.newChannelId;
                        }
                    </script>
                </body>
                </html>
            `);
        } else {
            console.error('[Auth] Failed to obtain valid channel info from token.');
            return res.status(500).send('Failed to authenticate with YouTube.');
        }
    } catch (error) {
        console.error('[Auth] Error during token exchange:', error);
        return res.status(500).send('An error occurred during authentication.');
    }
});

// Route to delete a connected channel
router.post('/delete-channel', async (req, res) => {
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ success: false, error: 'Channel ID required' });

    console.log(`[Delete Channel] Request to remove channel: ${channelId}`);

    try {
        // 1. Find the channel first to get metadata (Bundle ID, platform)
        const username = req.session && req.session.username ? req.session.username : 'guest';
        const userChannels = await mp3toytChannels.getChannelsForUser(username);
        const channelToDelete = userChannels.find(c => c.channelId === channelId);

        if (!channelToDelete) {
            return res.status(404).json({ success: false, error: 'Channel not found or not owned by you' });
        }

        console.log(`[Delete Channel] user ${username} removing channel: ${channelId} (${channelToDelete.platform})`);

        // 2. If it's a Bundle.social channel, disconnect it from their API (Non-blocking for speed)
        if (channelToDelete.socialAccountId && channelToDelete.bundleInstanceId !== undefined) {
            console.log(`[Delete Channel] Backgrounding Bundle.social disconnection for instance ${channelToDelete.bundleInstanceId}`);
            bundleApi.disconnectPlatform(channelToDelete.bundleInstanceId, channelToDelete.platform)
                .then((res) => {
                    if (res && res.success) {
                        console.log(`[Delete Channel] ✅ Background disconnect success for instance ${channelToDelete.bundleInstanceId}`);
                    } else {
                        console.warn(`[Delete Channel] ⚠️ Background disconnect reported issue: ${res ? res.error : 'Unknown'}`);
                    }
                })
                .catch(bundleErr => {
                    console.warn(`[Delete Channel] ❌ Background Bundle API disconnect crashed:`, bundleErr.message);
                });
        }

        // 3. Remove from channels.json
        await mp3toytChannels.deleteChannel(channelId, username);

        // 4. Remove from tokens.json (if it exists there - for erraja direct accounts)
        if (username === 'erraja') {
            if (await fs.exists(TOKEN_PATH)) {
                let tokens = await fs.readJson(TOKEN_PATH);
                const initialLength = tokens.length;
                tokens = tokens.filter(t => t.channelId !== channelId);
                if (tokens.length < initialLength) {
                    await fs.writeJson(TOKEN_PATH, tokens, { spaces: 2 });
                    console.log(`[Delete Channel] Removed from ${TOKEN_PATH}`);
                }
            }
        }

        res.json({ success: true, message: 'Channel disconnected successfully.' });
    } catch (error) {
        console.error(`[Delete Channel] Error:`, error);
        res.status(500).json({ success: false, error: 'Failed to delete channel.' });
    }
});

// --- Cookies Management ---
router.get('/get-cookies', async (req, res) => {
    try {
        if (await fs.pathExists(YOUTUBE_COOKIES_PATH)) {
            const content = await fs.readFile(YOUTUBE_COOKIES_PATH, 'utf8');
            res.json({ success: true, cookies: content });
        } else {
            res.json({ success: true, cookies: '' });
        }
    } catch (error) {
        console.error('Error reading cookies:', error);
        res.status(500).json({ success: false, message: 'Failed to read cookies file.' });
    }
});

router.post('/save-cookies', async (req, res) => {
    const { cookies } = req.body;
    try {
        await fs.writeFile(YOUTUBE_COOKIES_PATH, cookies, 'utf8');
        res.json({ success: true, message: 'Cookies saved successfully.' });
    } catch (error) {
        console.error('Error saving cookies:', error);
        res.status(500).json({ success: false, message: 'Failed to save cookies file.' });
    }
});

// --- Credentials Management ---
router.get('/get-credentials', async (req, res) => {
    try {
        if (await fs.pathExists(CREDENTIALS_PATH)) {
            const content = await fs.readFile(CREDENTIALS_PATH, 'utf8');
            res.json({ success: true, credentials: content });
        } else {
            res.json({ success: true, credentials: '{}' });
        }
    } catch (error) {
        console.error('Error reading credentials:', error);
        res.status(500).json({ success: false, message: 'Failed to read credentials file.', error: error.message });
    }
});

router.post('/save-credentials', async (req, res) => {
    const { credentials } = req.body;
    try {
        if (!credentials || credentials.trim().length === 0) {
            return res.status(400).json({ success: false, message: 'Empty content.' });
        }

        // Validate JSON and structure
        const parsed = JSON.parse(credentials);
        if (!parsed.web && !parsed.installed) {
            throw new Error('JSON missing "web" or "installed" root key.');
        }

        console.log(`[Credentials] Received save request. Raw length: ${credentials?.length}`);
        // Write file
        await fs.writeFile(CREDENTIALS_PATH, credentials, 'utf8');
        console.log(`[Credentials] Saved successfully to ${CREDENTIALS_PATH}. Bytes: ${credentials?.length}`);

        res.json({ success: true, message: 'Credentials saved successfully.' });
    } catch (error) {
        console.error('[Credentials Error] Save failed:', error.message);
        res.status(500).json({
            success: false,
            message: error instanceof SyntaxError ? 'Invalid JSON format.' : (error.message || 'Failed to save file.'),
            error: error.message
        });
    }
});

// --- Tokens Management ---
router.get('/get-tokens', async (req, res) => {
    try {
        if (await fs.pathExists(TOKEN_PATH)) {
            const content = await fs.readFile(TOKEN_PATH, 'utf8');
            res.json({ success: true, tokens: content });
        } else {
            res.json({ success: true, tokens: '[]' });
        }
    } catch (error) {
        console.error('Error reading tokens:', error);
        res.status(500).json({ success: false, message: 'Failed to read tokens file.', error: error.message });
    }
});

router.post('/save-tokens', async (req, res) => {
    const { tokens } = req.body;
    try {
        JSON.parse(tokens); // Validate JSON
        await fs.writeFile(TOKEN_PATH, tokens, 'utf8');
        res.json({ success: true, message: 'Tokens saved successfully.' });
    } catch (error) {
        console.error('Error saving tokens:', error);
        res.status(500).json({ success: false, message: error instanceof SyntaxError ? 'Invalid JSON format.' : 'Failed to save tokens file.', error: error.message });
    }
});

// --- Channels Management ---
router.get('/get-channels-json', async (req, res) => {
    try {
        const username = req.session && req.session.username ? req.session.username : 'guest';
        const targetPath = (username === 'erraja') ? ADMIN_CHANNELS_PATH : CHANNELS_PATH;

        if (await fs.pathExists(targetPath)) {
            const content = await fs.readFile(targetPath, 'utf8');
            res.json({ success: true, channels: content });
        } else {
            res.json({ success: true, channels: '{"channels":[]}' });
        }
    } catch (error) {
        console.error('Error reading channels file:', error);
        res.status(500).json({ success: false, message: 'Failed to read channels file.', error: error.message });
    }
});

router.post('/save-channels-json', async (req, res) => {
    const { channels } = req.body;
    try {
        const username = req.session && req.session.username ? req.session.username : 'guest';
        const targetPath = (username === 'erraja') ? ADMIN_CHANNELS_PATH : CHANNELS_PATH;

        JSON.parse(channels); // Validate JSON
        await fs.writeFile(targetPath, channels, 'utf8');
        res.json({ success: true, message: 'Channels data saved successfully.' });
    } catch (error) {
        console.error('Error saving channels file:', error);
        res.status(500).json({ success: false, message: error instanceof SyntaxError ? 'Invalid JSON format.' : 'Failed to save channels file.', error: error.message });
    }
});

// --- Facebook Credentials Management ---

router.get('/get-facebook-credentials', async (req, res) => {
    try {
        if (await fs.pathExists(FACEBOOK_CREDENTIALS_PATH)) {
            const creds = await fs.readJson(FACEBOOK_CREDENTIALS_PATH);
            res.json({ success: true, credentials: JSON.stringify(creds, null, 2) });
        } else {
            res.json({ success: true, credentials: '{ "appId": "", "appSecret": "" }' });
        }
    } catch (error) {
        console.error('Error reading FB credentials:', error);
        res.status(500).json({ success: false, message: 'Failed to read Facebook credentials' });
    }
});

router.post('/save-facebook-credentials', async (req, res) => {
    const { credentials } = req.body;
    try {
        const creds = JSON.parse(credentials);
        await fs.writeJson(FACEBOOK_CREDENTIALS_PATH, creds, { spaces: 2 });

        // Update environment variables for the current process
        process.env.FACEBOOK_APP_ID = creds.appId;
        process.env.FACEBOOK_APP_SECRET = creds.appSecret;

        res.json({ success: true, message: 'Facebook credentials saved successfully' });
    } catch (error) {
        console.error('Error saving FB credentials:', error);
        res.status(500).json({ success: false, message: 'Invalid JSON format or write error' });
    }
});

// --- Facebook Cookies Management (Puppeteer) ---

router.get('/get-facebook-cookies', async (req, res) => {
    try {
        const username = req.session && req.session.username ? req.session.username : 'guest';
        if (username !== 'erraja') return res.status(403).json({ success: false, message: 'Admin only.' });

        const COOKIES_PATH = path.join(process.cwd(), 'facebook_cookies.json');
        if (await fs.pathExists(COOKIES_PATH)) {
            const cookies = await fs.readJson(COOKIES_PATH);
            res.json({ success: true, cookies: JSON.stringify(cookies, null, 2) });
        } else {
            res.json({ success: true, cookies: '[]' });
        }
    } catch (error) {
        console.error('Error reading FB cookies:', error);
        res.status(500).json({ success: false, message: 'Failed to read Facebook cookies' });
    }
});

router.post('/save-facebook-cookies', async (req, res) => {
    const { cookies } = req.body;
    try {
        const username = req.session && req.session.username ? req.session.username : 'guest';
        if (username !== 'erraja') return res.status(403).json({ success: false, message: 'Admin only.' });

        const parsedCookies = JSON.parse(cookies);
        const COOKIES_PATH = path.join(process.cwd(), 'facebook_cookies.json');
        await fs.writeJson(COOKIES_PATH, parsedCookies, { spaces: 2 });

        res.json({ success: true, message: 'Facebook cookies saved successfully' });
    } catch (error) {
        console.error('Error saving FB cookies:', error);
        res.status(500).json({ success: false, message: 'Invalid JSON format or write error' });
    }
});

router.get('/api/visitor-stats', isAdmin, async (req, res) => {
    try {
        const stats = await getStats();
        res.json({ success: true, stats });
    } catch (error) {
        console.error('Error fetching visitor stats:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch visitor stats' });
    }
});

export default router;
