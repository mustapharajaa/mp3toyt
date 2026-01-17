import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FACEBOOK_TOKENS_PATH = path.join(__dirname, '../facebook_tokens.json');

async function debugToken() {
    try {
        const fbTokens = await fs.readJson(FACEBOOK_TOKENS_PATH).catch(() => []);
        const adminDirect = fbTokens.find(t => t.accountId === 'admin_direct');

        if (!adminDirect || !adminDirect.access_token) {
            console.error('❌ No admin direct token found.');
            return;
        }

        const token = adminDirect.access_token;
        console.log('🔍 Debugging Token...');

        // 1. Get Token Info (me)
        try {
            const meRes = await axios.get(`https://graph.facebook.com/v20.0/me?fields=id,name,permissions&access_token=${token}`);
            console.log('✅ User Identity:', meRes.data.name, `(ID: ${meRes.data.id})`);

            // Note: permissions endpoint is usually /me/permissions
            const permRes = await axios.get(`https://graph.facebook.com/v20.0/me/permissions?access_token=${token}`);
            const granted = permRes.data.data.filter(p => p.status === 'granted').map(p => p.permission);
            console.log('📜 Granted Permissions:', granted.join(', '));
        } catch (err) {
            console.error('❌ Error fetching user info:', err.response?.data || err.message);
        }

        // 2. Get Pages
        try {
            const pagesRes = await axios.get(`https://graph.facebook.com/v20.0/me/accounts?access_token=${token}`);
            const pages = pagesRes.data.data;
            console.log(`\n📄 Found ${pages.length} Pages:`);
            pages.forEach(p => {
                console.log(`   - ${p.name} (ID: ${p.id}) [Has Token: ${!!p.access_token}]`);
            });
        } catch (err) {
            console.error('❌ Error fetching pages:', err.response?.data || err.message);
        }

    } catch (err) {
        console.error('💥 Script Error:', err.message);
    }
}

debugToken();
