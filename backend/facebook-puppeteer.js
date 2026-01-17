import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs-extra';
import path from 'path';

puppeteer.use(StealthPlugin());

const COOKIES_PATH = path.join(process.cwd(), 'facebook_cookies.json');

/**
 * Automates video upload to Facebook using Puppeteer
 * @param {string} videoPath - Absolute path to the video file
 * @param {string} description - Description/caption for the post
 * @param {Object} options - Additional options
 */
export async function uploadVideoWithPuppeteer(videoPath, description, options = {}) {
    console.log('[Puppeteer] Starting Facebook upload automation...');

    if (!await fs.pathExists(videoPath)) {
        throw new Error(`Video file not found: ${videoPath}`);
    }

    if (!await fs.pathExists(COOKIES_PATH)) {
        throw new Error('Facebook cookies not found. Please provide cookies in facebook_cookies.json');
    }

    // Auto-detect: headless on server (no DISPLAY), visible on local PC
    const isServer = !process.env.DISPLAY && process.platform === 'linux';

    const browser = await puppeteer.launch({
        headless: isServer, // Headless on VPS, visible on local
        defaultViewport: null, // Full page
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-notifications',
            '--start-maximized'
        ]
    });

    const page = await browser.newPage();

    try {
        const cookies = await fs.readJson(COOKIES_PATH);
        await page.setCookie(...cookies);
        console.log('[Puppeteer] Cookies loaded.');

        await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });

        // Language-Agnostic Login Check
        const isLoggedIn = await page.evaluate(() => {
            return !!(
                document.querySelector('a[href*="/me/"]') ||
                document.querySelector('[role="navigation"]') ||
                document.querySelector('[aria-label="Facebook"]') ||
                document.querySelector('[aria-label="فيسبوك"]')
            );
        });

        if (!isLoggedIn) {
            console.log('[Puppeteer] Login check failed. Cookies might be expired.');
            await page.screenshot({ path: `fb_login_failed_${Date.now()}.png` });
            throw new Error('Login failed. Please refresh your cookies.');
        }
        console.log('[Puppeteer] Successfully logged into Facebook.');

        // 1. Upload Video directly to the hidden input
        console.log('[Puppeteer] Uploading video file directly...');
        const fileInputSelector = 'input[type="file"]';
        const fileInput = await page.waitForSelector(fileInputSelector, { timeout: 15000 });
        await fileInput.uploadFile(videoPath);
        console.log('[Puppeteer] Video selected via direct file input.');

        await new Promise(r => setTimeout(r, 8000)); // Wait for dialog to appear and transition

        // 2. Add Description
        const textSelectors = [
            '[aria-label="What\'s on your mind?"]',
            '[aria-label^="بماذا تفكر"]',
            '[contenteditable="true"]',
            '[role="textbox"]'
        ];

        let descriptionAdded = false;
        for (const sel of textSelectors) {
            try {
                await page.waitForSelector(sel, { timeout: 5000 });
                await page.click(sel);
                await page.keyboard.type(description);
                descriptionAdded = true;
                console.log('[Puppeteer] Description added.');
                break;
            } catch (e) { }
        }

        // Selectors for the final Post (نشر) button
        const postSelectors = [
            'div[aria-label="نشر"][role="button"]',
            'div[aria-label="Post"][role="button"]',
            'div[role="button"] span:text("نشر")',
            'div[role="button"] span:text("Post")',
            '[aria-label="نشر"]',
            '[aria-label="Post"]',
            'span:text("نشر")',
            'span:text("Post")'
        ];

        // 3. Handle "Next" (التالي) buttons until we reach the final step
        const nextSelectors = [
            'div.x1qughib.x1qjc9v5.xozqiw3.x1q0g3np.xpdmqnj.x1g0dm76.xsag5q8.xz9dl7a.x1lxpwgx.x165d6jo.x4vbgl9.x1rdy4ex > div', // Latest precise selector (div)
            'div.x1qughib.x1qjc9v5.xozqiw3.x1q0g3np.xpdmqnj.x1g0dm76.xsag5q8.xz9dl7a.x1lxpwgx.x165d6jo.x4vbgl9.x1rdy4ex > div > div > div', // Nested precise selector
            'div[aria-label="التالي"][role="button"]',
            'div[aria-label="Next"][role="button"]',
            'div.html-div.xdj266r.xat24cr.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x6s0dn4.x78zum5.xl56j7k.x14ayic.xwyz465.x1e0frkt',
            'span:text("التالي")',
            'span:text("Next")',
            '[aria-label="Next"]',
            '[aria-label="التالي"]',
            'div[role="button"] span:text("التالي")',
            'div[role="button"] span:text("Next")',
            'div[role="none"] span:text("التالي")',
            'div[role="none"] span:text("Next")'
        ];

        console.log('[Puppeteer] Checking for "Next" (التالي) buttons (might be multiple steps)...');
        let nextStepFound = true;
        let nextAttempt = 0;
        while (nextStepFound && nextAttempt < 5) {
            nextStepFound = false;
            nextAttempt++;

            // STOP if "Post" (نشر) button is already visible!
            const isPostVisible = await page.evaluate((sels) => {
                for (const s of sels) {
                    try {
                        if (s.includes(':text') || s.includes(':has-text')) continue;
                        const el = document.querySelector(s);
                        if (el) {
                            const rect = el.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0) return true;
                        }
                    } catch (e) { }
                }
                return false;
            }, postSelectors);

            if (isPostVisible) {
                console.log('[Puppeteer] Found final Post button! No more Next steps needed.');
                break;
            }

            for (const sel of nextSelectors) {
                try {
                    const nextBtn = await page.waitForSelector(sel, { timeout: 3000 });

                    const canClick = await page.evaluate((s) => {
                        try {
                            if (s.includes(':text') || s.includes(':has-text')) return true;
                            const b = document.querySelector(s);
                            if (!b) return false;
                            const rect = b.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0 && b.getAttribute('aria-disabled') !== 'true' && !b.disabled;
                        } catch (e) { return false; }
                    }, sel);

                    if (canClick) {
                        try {
                            await page.click(sel, { force: true });
                        } catch (e) {
                            if (!sel.includes(':text') && !sel.includes(':has-text')) {
                                await page.$eval(sel, el => el.click());
                            }
                        }
                        console.log(`[Puppeteer] Clicked Next step ${nextAttempt} via: ${sel}`);
                        await new Promise(r => setTimeout(r, 4000));
                        nextStepFound = true;
                        break;
                    }
                } catch (e) { }
            }
        }

        // 4. Click Post (نشر)
        console.log('[Puppeteer] Waiting for the final "Post" (نشر) button...');
        let clicked = false;

        for (let i = 0; i < 12; i++) { // Check for up to 60 seconds
            for (const sel of postSelectors) {
                try {
                    const btn = await page.$(sel);
                    if (btn) {
                        const isReady = await page.evaluate((s) => {
                            const b = document.querySelector(s);
                            return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled;
                        }, sel);

                        if (isReady) {
                            try {
                                await page.click(sel, { force: true });
                            } catch (e) {
                                await page.$eval(sel, el => el.click());
                            }
                            clicked = true;
                            console.log(`[Puppeteer] Success! Video posted via: ${sel}`);
                            break;
                        }
                    }
                } catch (e) { }
            }
            if (clicked) break;
            console.log(`[Puppeteer] Post button not ready yet... (${i + 1}/12)`);
            await new Promise(r => setTimeout(r, 5000));
        }

        if (!clicked) throw new Error('Could not click "Post" (نشر) button after upload.');

        await new Promise(r => setTimeout(r, 5000)); // Final wait for post to register
        return { success: true };

    } catch (err) {
        console.error('[Puppeteer] Error during automation:', err.message);
        await page.screenshot({ path: `fb_error_${Date.now()}.png` });
        return { success: false, error: err.message };
    } finally {
        await browser.close();
    }
}
