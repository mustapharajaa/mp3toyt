import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SCOPES = [
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/userinfo.profile'
];

export const TOKEN_PATH = path.join(__dirname, '../tokens.json');
export const CREDENTIALS_PATH = path.join(__dirname, '../credentials.json');
export const ACTIVE_STREAMS_PATH = path.join(__dirname, '../active_streams.json'); // Maintained for compatibility
export const CHANNELS_PATH = path.join(__dirname, '../channels.json');
export const FACEBOOK_TOKENS_PATH = path.join(__dirname, '../facebook_tokens.json');
export const FACEBOOK_CREDENTIALS_PATH = path.join(__dirname, '../facebook_credentials.json');
export const USERS_PATH = path.join(__dirname, '../users.json');
