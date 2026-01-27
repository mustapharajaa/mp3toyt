import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VISITORS_PATH = path.join(__dirname, '../visitors.json');

/**
 * Loads visitors from the JSON file.
 */
async function loadVisitors() {
    try {
        if (!await fs.pathExists(VISITORS_PATH)) {
            return { totalVisitors: 0, uniqueVisitors: 0, visitorsPerCountry: {}, ipAddresses: {} };
        }
        const data = await fs.readJson(VISITORS_PATH);
        // Migration/Safety check for old structure
        return {
            totalVisitors: data.totalVisitors || data.totalHits || 0,
            uniqueVisitors: data.uniqueVisitors || 0,
            visitorsPerCountry: data.visitorsPerCountry || data.countries || {},
            ipAddresses: data.ipAddresses || data.ips || {}
        };
    } catch (error) {
        console.error('Error loading visitors:', error);
        return { totalVisitors: 0, uniqueVisitors: 0, visitorsPerCountry: {}, ipAddresses: {} };
    }
}

/**
 * Saves visitors to the JSON file.
 */
async function saveVisitors(data) {
    try {
        await fs.writeJson(VISITORS_PATH, data, { spaces: 2 });
    } catch (error) {
        console.error('Error saving visitors:', error);
    }
}

/**
 * Tracks a visitor by IP and geolocates if new.
 */
export async function trackVisitor(ip) {
    if (!ip) return;

    const data = await loadVisitors();
    data.totalVisitors++;

    if (!data.ipAddresses[ip]) {
        data.uniqueVisitors++;

        // Handle local/private IPs explicitly
        const isLocal = ip === '::1' ||
            ip === '127.0.0.1' ||
            ip.startsWith('::ffff:127.') ||
            ip.startsWith('192.168.') ||
            ip.startsWith('10.') ||
            ip.startsWith('172.16.') || // Simplistic private range check
            ip.startsWith('172.31.');

        if (isLocal) {
            data.ipAddresses[ip] = {
                country: 'Localhost/Private',
                hits: 1,
                lastSeen: new Date().toISOString()
            };
            data.visitorsPerCountry['Localhost/Private'] = (data.visitorsPerCountry['Localhost/Private'] || 0) + 1;
        } else {
            try {
                // Geolocate using ip-api.com
                const response = await axios.get(`http://ip-api.com/json/${ip}`);
                const geo = response.data;

                if (geo.status === 'success') {
                    const country = geo.country || 'Unknown';
                    data.ipAddresses[ip] = {
                        country,
                        hits: 1,
                        lastSeen: new Date().toISOString()
                    };
                    data.visitorsPerCountry[country] = (data.visitorsPerCountry[country] || 0) + 1;
                } else {
                    data.ipAddresses[ip] = {
                        country: 'Unknown',
                        hits: 1,
                        lastSeen: new Date().toISOString()
                    };
                }
            } catch (error) {
                console.error(`[Visitor Debug] Error geolocating IP ${ip}:`, error.message);
                data.ipAddresses[ip] = {
                    country: 'Error',
                    hits: 1,
                    lastSeen: new Date().toISOString()
                };
            }
        }
    } else {
        data.ipAddresses[ip].hits++;
        data.ipAddresses[ip].lastSeen = new Date().toISOString();
    }

    await saveVisitors(data);
}

/**
 * Returns summary stats for admins.
 */
export async function getStats() {
    const data = await loadVisitors();
    return {
        totalVisitors: data.totalVisitors,
        uniqueVisitors: data.uniqueVisitors,
        visitorsPerCountry: data.visitorsPerCountry,
        ipAddresses: data.ipAddresses
    };
}
