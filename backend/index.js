import { SCOPES, TOKEN_PATH, CREDENTIALS_PATH, ACTIVE_STREAMS_PATH } from './config.js'; // Load variables
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
import { getAuthenticatedChannelInfo, uploadVideo, getAuthUrl, saveTokenFromCode } from './youtube-api.js';
import * as mp3toytChannels from './channels.js';
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

const router = express.Router();
router.use(express.json());

// --- Multer Configuration ---
// --- Multer Configuration ---
const UPLOADS_BASE_DIR = path.join(__dirname, '../uploads');
const TEMP_BASE_DIR = path.join(__dirname, '../temp');
const upload = multer();

// --- API Endpoints ---

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
        const sessionDir = path.join(TEMP_BASE_DIR, sessionId);
        await fs.ensureDir(sessionDir);
        const finalAudioPath = path.join(sessionDir, 'audio.opus');

        const args = [
            '--retries', '4',
            '--socket-timeout', '23',
            '--no-playlist',
            '--concurrent-fragments', '8',
            '--no-part', // Do not use .part files
            '--ppa', 'ffmpeg_i:-ss 0', // Force a sanity check on the file with ffmpeg
            '--ffmpeg-location', FFMPEG_PATH,
            '-x',
            '--audio-format', 'best',
            '-o', `${sessionDir}/%(title)s.%(ext)s`,
        ];
        if (YOUTUBE_COOKIES_PATH && await fs.pathExists(YOUTUBE_COOKIES_PATH)) {
            args.push('--cookies', YOUTUBE_COOKIES_PATH);
        }

        args.push(url);

        const ytDlpProcess = spawn(YT_DLP_PATH, args);

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const sendProgress = (message) => {
            res.write(`data: ${JSON.stringify({ message })}\n\n`);
        };

        ytDlpProcess.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`[yt-dlp] ${output}`);
            const progressMatch = output.match(/\b(\d{1,3}(\.\d+)?)%/);
            if (progressMatch) {
                const percent = Math.floor(parseFloat(progressMatch[1]));
                sendProgress(`Downloading... ${percent}%`);
            }
        });

        let errorOutput = '';
        let isCookieError = false;

        ytDlpProcess.stderr.on('data', (data) => {
            const errorData = data.toString();
            errorOutput += errorData;
            console.log(`[yt-dlp Error]: ${errorData}`);
            if (errorData.includes('cookies are no longer valid') || errorData.includes('Sign in to confirm')) {
                isCookieError = true;
            }
        });

        ytDlpProcess.on('error', (err) => {
            console.error('[yt-dlp Spawn Error]', err);
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: 'Failed to start the download process.' });
            } else {
                res.write(`data: ${JSON.stringify({ success: false, error: 'Failed to start the download process.' })}\n\n`);
                res.end();
            }
        });

        ytDlpProcess.on('close', async (code) => {
            if (code === 0) {
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
            } else {
                if (isCookieError) {
                    res.write(`data: ${JSON.stringify({ success: false, error: 'YouTube cookies have expired. Please refresh them.' })}\n\n`);
                } else {
                    res.write(`data: ${JSON.stringify({ success: false, error: 'Failed to download audio.' })}\n\n`);
                }
                res.end();
            }
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

router.post('/download-image', async (req, res) => {
    const { url, sessionId } = req.body;
    if (!sessionId || !url) {
        return res.status(400).json({ success: false, message: 'Session ID and Image URL are required.' });
    }

    try {
        const sessionDir = path.join(TEMP_BASE_DIR, sessionId);
        await fs.ensureDir(sessionDir);
        const imagePath = path.join(sessionDir, 'image.jpg');

        let targetUrl = url;

        // Detect YouTube URL and extract thumbnail (v184)
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
            console.log(`[Thumbnail] Detecting YouTube URL: ${url}`);

            // Fast Path: Extract ID using regex
            const videoIdMatch = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
            const videoId = videoIdMatch ? videoIdMatch[1] : null;

            if (videoId) {
                console.log(`[Thumbnail] Fast Path Success. Video ID: ${videoId}`);
                targetUrl = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
            } else {
                console.log(`[Thumbnail] Fast Path Failed, falling back to yt-dlp...`);
                targetUrl = await new Promise((resolve, reject) => {
                    const args = ['--get-thumbnail', url];
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

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        res.json({ success: true, filePath: imagePath });
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

            const sessionDir = path.join(TEMP_BASE_DIR, sessionId);
            await fs.ensureDir(sessionDir);

            let destFilename;
            if (fileType === 'audio') {
                const extension = path.extname(file.originalFilename || 'audio.mp3');
                destFilename = `audio_${Date.now()}${extension}`;
            } else if (fileType === 'overlay') {
                const extension = path.extname(file.originalFilename || 'overlay.mp4');
                destFilename = `overlay_${Date.now()}${extension}`;
            } else {
                destFilename = 'image.jpg';
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
                filePath: `/temp/${sessionId}/${destFilename}`,
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
        const sessionDir = path.join(TEMP_BASE_DIR, sessionId);
        if (!await fs.pathExists(sessionDir)) {
            return res.json({ success: true, message: 'Session does not exist, nothing to remove.' });
        }

        let filePattern;
        if (type === 'audio') {
            filePattern = /^(audio_|audio\.).*\.(opus|mp3|m4a|wav|webm)$/;
        } else if (type === 'image') {
            filePattern = /^image\.jpg$/;
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
        const channelsPath = path.join(__dirname, '../channels.json');
        if (await fs.pathExists(channelsPath)) {
            const channels = await fs.readJson(channelsPath);
            res.json(channels);
        } else {
            res.json([]);
        }
    } catch (error) {
        console.error('Error reading channels file:', error);
        res.status(500).json({ error: 'Failed to load channels.' });
    }
});

// Define and ensure directories exist
const UPLOADS_DIR = UPLOADS_BASE_DIR;
const VIDEOS_DIR = UPLOADS_DIR;
fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(TEMP_BASE_DIR);
// fs.ensureDirSync(VIDEOS_DIR); // Redundant now

// --- Job Queue for Video Processing ---
const videoQueue = [];
const jobStatus = {}; // Store job status by sessionId
let isProcessingVideo = false;

// --- Automatic Cleanup for Abandoned Sessions ---
async function cleanupAbandonedSessions() {
    const tempDir = TEMP_BASE_DIR;
    if (!await fs.pathExists(tempDir)) return;
    const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
    const sessionFolders = await fs.readdir(tempDir);
    for (const folder of sessionFolders) {
        const folderPath = path.join(tempDir, folder);
        try {
            const stats = await fs.stat(folderPath);
            if (stats.isDirectory() && stats.mtime.getTime() < threeDaysAgo) {
                const isSessionInQueue = videoQueue.some(job => job.sessionId === folder);
                if (!isSessionInQueue && (!jobStatus[folder] || (jobStatus[folder].status !== 'processing' && jobStatus[folder].status !== 'uploading'))) {
                    console.log(`[Cleanup] Deleting abandoned session folder: ${folderPath}`);
                    await fs.remove(folderPath);
                }
            }
        } catch (err) {
            console.error(`[Cleanup] Error processing folder ${folderPath}:`, err);
        }
    }
}
setInterval(cleanupAbandonedSessions, 3 * 24 * 60 * 60 * 1000);

// --- Video Processing Logic ---
// Helper to concatenate multiple audio files
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
async function createVideoWithFfmpeg(sessionId, audioPathInput, imagePath, videoPath, overlay = null) {
    // If audioPathInput is passed, use it (single file case for backward compat or direct path)
    // But we prefer to look up all files in the session.
    // The queue processor sends 'audioPath' but that might be just one file.
    // Let's resolve the actual audio to use by concatenation.

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
    // ... rest of createVideoWithFfmpeg

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
    // If audio is shorter than loop, just make loop = audio length (plus minimal buffer)
    const exactDuration = (totalDurationSeconds < LOOP_DURATION) ? Math.ceil(totalDurationSeconds) + 1 : LOOP_DURATION;

    console.log(`[FFmpeg] Creating base loop video of ${exactDuration} seconds...`);

    await new Promise((resolve, reject) => {
        let command = ffmpeg().input(imagePath).inputOptions(['-loop 1', '-framerate 1']);

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

            command
                .complexFilter(`[0:v]scale=1280:720,setsar=1[bg];[1:v]scale=${w}:${h}[ovrl];[bg][ovrl]overlay=${x}:${y}:shortest=1`)
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
            // Optimized No-Overlay Path (v188-restore)
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
    // Note: -stream_loop counts REPEATS, so 0 = play once. We need loopCount - 1 repeats.
    // However, -stream_loop -1 is infinite, but -c copy cannot cut accurately.
    // User specifically accepted "video longer than audio is fine".
    // So we use -stream_loop {repeats} which is extremely fast.

    for (let i = 1; i <= attempts; i++) {
        try {
            await new Promise((resolve, reject) => {
                console.log(`[FFmpeg] Assembly Attempt ${i}: Looping base video ${loopCount} times...`);

                // Using a fresh command for the assembly
                const command = ffmpeg()
                    .input(loopVideoPath)
                    .inputOptions([
                        `-stream_loop ${loopCount}` // Loop the input N times
                    ])
                    .input(audioPath)
                    .outputOptions([
                        '-c copy', // COPY BOTH STREAMS (Instant Speed)
                        '-map 0:v',
                        '-map 1:a',
                        '-shortest', // Stop when shortest stream ends (Audio) - might not be frame-perfect in copy mode but "video slightly longer" is accepted
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
    const { sessionId, audioPath, imagePath, title, description, tags, visibility, publishAt, channelId, overlay } = job;
    const outputVideoPath = path.join(VIDEOS_DIR, `${sessionId}_${Date.now()}.mp4`);

    try {
        jobStatus[sessionId] = { status: 'processing', message: 'Creating video file...' };
        const creationStartTime = Date.now();
        await createVideoWithFfmpeg(sessionId, audioPath, imagePath, outputVideoPath, overlay);
        const creationTime = Math.round((Date.now() - creationStartTime) / 1000);

        jobStatus[sessionId] = { status: 'uploading', message: 'Uploading to YouTube... 0%' };
        const uploadStartTime = Date.now();
        const videoMetadata = { title, description, tags: tags ? tags.split(',').map(tag => tag.trim()) : [], privacyStatus: publishAt ? 'private' : visibility, ...(publishAt && { publishAt }) };
        const uploadResult = await uploadVideo(channelId, outputVideoPath, videoMetadata, (percent) => {
            jobStatus[sessionId].message = `Uploading to YouTube... ${percent}%`;
        });
        const uploadTime = Math.round((Date.now() - uploadStartTime) / 1000);

        if (!uploadResult.success) throw new Error(uploadResult.error || 'YouTube upload failed.');

        jobStatus[sessionId] = {
            status: 'complete',
            message: 'Upload Complete!',
            videoUrl: `https://www.youtube.com/watch?v=${uploadResult.data.id}`,
            creationTime,
            uploadTime
        };
    } catch (error) {
        console.error(`[Queue] Error for session ${sessionId}:`, error.message);
        jobStatus[sessionId] = { status: 'failed', message: `An error occurred: ${error.message}` };
    } finally {
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
        const sessionDir = path.join(TEMP_BASE_DIR, sessionId);

        let audioFiles = [];
        let imageExists = false;

        if (await fs.pathExists(sessionDir)) {
            const files = await fs.readdir(sessionDir);
            audioFiles = files.filter(f => /^(audio_|audio\.).*\.(opus|mp3|m4a|wav|webm)$/.test(f));
            imageExists = files.includes('image.jpg');
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
            imageUrl: imageExists ? `/temp/${sessionId}/image.jpg` : null
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error checking session status.' });
    }
});

router.post('/create-video', upload.none(), async (req, res) => {
    const { sessionId, title, description, tags, visibility, publishAt, channelId, overlay } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, error: 'Session ID is missing.' });

    try {
        const sessionDir = path.join(TEMP_BASE_DIR, sessionId);
        const imagePath = path.join(sessionDir, 'image.jpg');

        if (!await fs.pathExists(sessionDir)) {
            return res.status(400).json({ success: false, error: 'Session has expired or files were not uploaded.' });
        }

        const files = await fs.readdir(sessionDir);
        const audioFilename = files.find(f => f.startsWith('audio_') || f.startsWith('audio.')); // Find any audio

        if (!audioFilename) {
            return res.status(400).json({ success: false, error: 'Audio file not found.' });
        }

        const audioPath = path.join(sessionDir, audioFilename); // Pass the first one found, createVideoWithFfmpeg will concat all

        if (!await fs.pathExists(imagePath)) {
            return res.status(400).json({ success: false, error: 'Image file not found.' });
        }

        jobStatus[sessionId] = { status: 'queued', message: 'Your video is in the queue.' };
        videoQueue.push({ sessionId, audioPath, imagePath, title, description, tags, visibility, publishAt, channelId, overlay });

        // Start processing the queue, but don't block the response.
        // Added a try-catch in case the initial call to processVideoQueue has a synchronous error.
        try {
            processVideoQueue();
        } catch (processError) {
            console.error(`[Queue] Failed to start queue processing for session ${sessionId}:`, processError);
            // Even if starting fails, the job is queued. The next successful job will trigger it.
        }

        res.json({ success: true, message: 'Your video has been added to the queue.', sessionId });
    } catch (error) {
        console.error(`[API Error] /create-video failed for session ${sessionId}:`, error);
        res.status(500).json({ success: false, error: 'Failed to add video to the queue. Check server logs for details.' });
    }
});

router.get('/job-status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const status = jobStatus[sessionId];
    if (!status) return res.status(404).json({ status: 'not_found', message: 'Job not found.' });
    res.json(status);
    if (status.status === 'complete' || status.status === 'failed') {
        setTimeout(() => { delete jobStatus[sessionId]; }, 60000);
    }
});

// --- Authentication Routes ---

router.get('/auth/mp3toyt', (req, res) => {
    try {
        // Generate the redirect URI based on the request host
        // This allows it to work on localhost or a real domain
        const redirectUri = `${req.protocol}://${req.get('host')}/mp3toyt/oauth2callback`;
        console.log(`[Auth] Generating URL with redirect: ${redirectUri}`);

        // getAuthUrl should accept (redirectUri, context)
        const authUrl = getAuthUrl(redirectUri, 'mp3toyt');
        res.redirect(authUrl);
    } catch (error) {
        console.error('[Auth Error]', error);
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
                                setTimeout(closeEditor, 500);
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

router.get('/mp3toyt/oauth2callback', async (req, res) => {
    const { code } = req.query;
    const redirectUri = `${req.protocol}://${req.get('host')}/mp3toyt/oauth2callback`;

    console.log(`[Auth] Callback received with code length: ${code ? code.length : 0}`);

    if (!code) {
        return res.status(400).send('Authorization code is missing.');
    }

    try {
        // Exchange code for tokens
        const savedAuth = await saveTokenFromCode(code, redirectUri);

        if (savedAuth && savedAuth.channelId) {
            console.log(`[Auth] Authenticated channel: ${savedAuth.channelTitle} (${savedAuth.channelId})`);

            const channelData = {
                channelId: savedAuth.channelId,
                channelTitle: savedAuth.channelTitle,
                thumbnail: savedAuth.channelThumbnail, // Save thumbnail
                authenticatedAt: new Date().toISOString()
            };

            await mp3toytChannels.addChannel(channelData);
            console.log(`[Auth] Channel saved.`);

            return res.redirect(`/?new_channel_id=${savedAuth.channelId}`);
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
        // 1. Remove from channels.json
        const channelsPath = path.join(__dirname, '../channels.json');
        if (await fs.exists(channelsPath)) {
            const data = await fs.readJson(channelsPath);
            if (data.channels) {
                const initialLength = data.channels.length;
                data.channels = data.channels.filter(c => c.channelId !== channelId);
                if (data.channels.length < initialLength) {
                    await fs.writeJson(channelsPath, data, { spaces: 2 });
                    console.log(`[Delete Channel] Removed from channels.json`);
                }
            }
        }

        // 2. Remove from tokens.json (Actual Auth Revocation from app)
        const tokensPath = path.join(__dirname, '../tokens.json');
        if (await fs.exists(tokensPath)) {
            let tokens = await fs.readJson(tokensPath);
            const initialLength = tokens.length;
            tokens = tokens.filter(t => t.channelId !== channelId);
            if (tokens.length < initialLength) {
                await fs.writeJson(tokensPath, tokens, { spaces: 2 });
                console.log(`[Delete Channel] Removed from tokens.json`);
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
        // Validate JSON
        JSON.parse(credentials);
        await fs.writeFile(CREDENTIALS_PATH, credentials, 'utf8');
        res.json({ success: true, message: 'Credentials saved successfully.' });
    } catch (error) {
        console.error('Error saving credentials:', error);
        res.status(500).json({ success: false, message: error instanceof SyntaxError ? 'Invalid JSON format.' : 'Failed to save credentials file.', error: error.message });
    }
});

export default router;
