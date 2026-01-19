import './config.js';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRouter from './index.js';

import session from 'express-session';
import usersRouter from './users.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8000;

// Trust Proxy for Cloudflare/SSL
app.set('trust proxy', 1);

// Force Domain Middleware (Canonical redirection)
app.use((req, res, next) => {
    if (process.env.BASE_URL && req.method === 'GET') {
        try {
            const baseUrl = new URL(process.env.BASE_URL);
            const currentHost = req.get('host');

            // Skip redirect for localhost/dev to avoid breaking local testing
            if (currentHost.includes('localhost') || currentHost.includes('127.0.0.1')) {
                return next();
            }

            // If current host doesn't match BASE_URL host, redirect 301 (Permanent)
            if (currentHost !== baseUrl.host) {
                return res.redirect(301, `${baseUrl.protocol}//${baseUrl.host}${req.originalUrl}`);
            }
        } catch (e) {
            console.error('Middleware redirect error:', e);
        }
    }
    next();
});

import { trackVisitor } from './visitors.js';

// Visitor Tracking Middleware
app.use(async (req, res, next) => {
    try {
        let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        if (typeof ip === 'string') {
            if (ip.includes(',')) ip = ip.split(',')[0].trim();
            if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');
        }

        // Only track if it's a page request
        if (req.method === 'GET' && (req.path === '/app' || req.path === '/' || req.path === '/app/')) {
            trackVisitor(ip);
        }
    } catch (e) {
        console.error('Visitor track error:', e);
    }
    next();
});

// Middleware for parsing JSON and urlencoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session Middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'mp3toyt_secret_key_change_me',
    resave: false,
    saveUninitialized: false,
    proxy: true, // Required for secure cookies behind a reverse proxy (Cloudflare/Nginx)
    cookie: {
        secure: process.env.NODE_ENV === 'production', // Only secure in production
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours 
    }
}));

// Serve static files from the frontend directory
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/temp', express.static(path.join(__dirname, '../temp')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/logos', express.static(path.join(__dirname, '../logos')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Use the API router from index.js
// This maps endpoints like /channels, /upload-file, etc.
app.use('/', apiRouter);

// Mount Users Router
app.use('/api', usersRouter);

// Serve Landing Page at Root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../homepage/home.html'));
});

// Serve homepage static assets
app.use(express.static(path.join(__dirname, '../homepage')));

// Serve App at /app (Protected)
app.get('/app', (req, res) => {
    // Basic session check
    if (req.session && req.session.userId) {
        res.sendFile(path.join(__dirname, '../frontend/app.html'));
    } else {
        res.redirect('/');
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
});
