import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FACEBOOK_TOKENS_PATH = path.join(__dirname, '../facebook_tokens.json');

const ADMIN_TOKEN = 'EAAQx83bVmGQBQRZCRSHsH0WiPq08qFoGkrvpAalQrsXOiE0hVjQ37n2og2WQzL2xRQN2GFvxSMV8IV8Sd67rX037O1HhNMS1ZC29bv2bMokK3MpygER7k17m7nnSGrny7sVBcNFdWWf5fucXp8QtHHZAHrNoe5cZCnEZAPK3rqwXyd15KARTdjsZBGw9SJPW5LpSuARVyfWf1PLn7P2Dt2tUVUQaMVUqh9';

async function init() {
    try {
        let tokens = [];
        if (await fs.pathExists(FACEBOOK_TOKENS_PATH)) {
            tokens = await fs.readJson(FACEBOOK_TOKENS_PATH);
        }

        const index = tokens.findIndex(t => t.accountId === 'admin_direct');
        const tokenObj = {
            accountId: 'admin_direct',
            accountTitle: 'Admin Direct Access',
            access_token: ADMIN_TOKEN,
            type: 'direct',
            updatedAt: new Date().toISOString()
        };

        if (index > -1) {
            tokens[index] = tokenObj;
        } else {
            tokens.push(tokenObj);
        }

        await fs.writeJson(FACEBOOK_TOKENS_PATH, tokens, { spaces: 2 });
        console.log('✅ Admin Direct Facebook Token initialized successfully.');
    } catch (err) {
        console.error('❌ Failed to initialize token:', err.message);
    }
}

init();
