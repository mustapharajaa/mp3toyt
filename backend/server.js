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

import { trackVisitor } from './visitors.js';

// Visitor Tracking Middleware
app.use(async (req, res, next) => {
    try {
        let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        if (typeof ip === 'string' && ip.includes(',')) {
            ip = ip.split(',')[0].trim();
        }

        // Only track if it's a page request
        if (req.method === 'GET' && (req.path === '/app' || req.path === '/' || req.path === '/app/')) {
            console.log(`[Visitor Debug] Request to ${req.path} from ${ip}`);
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
    saveUninitialized: false, // Don't create session until something is stored
    cookie: {
        secure: false, // Set to true if using HTTPS
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
