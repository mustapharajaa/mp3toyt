import express from 'express';
import fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { USERS_PATH } from './config.js';

const router = express.Router();

/**
 * Helper to load users from JSON
 */
async function loadUsers() {
    try {
        if (!await fs.pathExists(USERS_PATH)) {
            return []; // Return empty if file doesn't exist
        }
        return await fs.readJson(USERS_PATH);
    } catch (error) {
        console.error('Error loading users:', error);
        return [];
    }
}

/**
 * Helper to save users to JSON
 */
async function saveUsers(users) {
    try {
        await fs.writeJson(USERS_PATH, users, { spaces: 2 });
    } catch (error) {
        console.error('Error saving users:', error);
    }
}

/**
 * Middleware to check if user is authenticated
 */
export function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }
    res.status(401).json({ success: false, message: 'Unauthorized' });
}

/**
 * Middleware to check if user is admin
 */
export async function isAdmin(req, res, next) {
    if (req.session && req.session.userId) {
        // First check session
        if (req.session.role === 'admin') return next();

        // Fallback: load fresh data from file in case it was changed manually
        try {
            const users = await loadUsers();
            const user = users.find(u => u.id === req.session.userId);
            if (user && user.role === 'admin') {
                req.session.role = 'admin'; // Sync it
                return next();
            }
        } catch (error) {
            console.error('Error in isAdmin check:', error);
        }
    }
    res.status(403).json({ success: false, message: 'Forbidden: Admins only' });
}

// --- Auth Endpoints ---

// Register
router.post('/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username and password are required.' });
        }

        const users = await loadUsers();

        if (users.find(u => u.username === username)) {
            return res.status(400).json({ success: false, message: 'Username already exists.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        // First user is always admin
        const role = users.length === 0 ? 'admin' : 'user';

        const newUser = {
            id: uuidv4(),
            username,
            password: hashedPassword, // Store hashed password
            role,
            plan: 'free', // Default plan
            createdAt: new Date().toISOString()
        };

        users.push(newUser);
        await saveUsers(users);

        res.json({ success: true, message: 'User registered successfully.' });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ success: false, message: 'Server error during registration.' });
    }
});

// Login
router.post('/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const users = await loadUsers();
        const user = users.find(u => u.username === username);

        if (!user || !await bcrypt.compare(password, user.password)) {
            return res.status(401).json({ success: false, message: 'Invalid username or password.' });
        }

        // Set session
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        req.session.plan = user.plan || 'free'; // Store plan in session

        res.json({ success: true, message: 'Login successful.', user: { id: user.id, username: user.username, role: user.role, plan: user.plan || 'free' } });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});

// Logout
router.post('/auth/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Could not log out.' });
        }
        res.json({ success: true, message: 'Logged out successfully.' });
    });
});

// Get Current User
router.get('/auth/me', async (req, res) => {
    if (req.session && req.session.userId) {
        try {
            const users = await loadUsers();
            const user = users.find(u => u.id === req.session.userId);

            if (user) {
                // Keep session in sync with file
                req.session.role = user.role;
                req.session.plan = user.plan || 'free';

                return res.json({
                    success: true,
                    user: {
                        id: user.id,
                        username: user.username,
                        role: user.role,
                        plan: user.plan || 'free'
                    }
                });
            }
            // If user not found in file (e.g. deleted), clear session
            req.session.destroy();
            res.json({ success: false, user: null });
        } catch (error) {
            console.error('Error in /auth/me:', error);
            res.status(500).json({ success: false, message: 'Server error' });
        }
    } else {
        res.json({ success: false, user: null });
    }
});

// --- User Management Endpoints (Admin Only) ---

// List Users
router.get('/users', isAuthenticated, isAdmin, async (req, res) => {
    const users = await loadUsers();
    // Return users without passwords
    const safeUsers = users.map(u => ({
        id: u.id,
        username: u.username,
        role: u.role,
        plan: u.plan || 'free', // Backwards compatibility
        createdAt: u.createdAt
    }));
    res.json(safeUsers);
});

// Delete User
router.delete('/users/:id', isAuthenticated, isAdmin, async (req, res) => {
    const { id } = req.params;
    let users = await loadUsers();

    // Prevent deleting your own account
    if (id === req.session.userId) {
        return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
    }

    const initialLength = users.length;
    users = users.filter(u => u.id !== id);

    if (users.length === initialLength) {
        return res.status(404).json({ success: false, message: 'User not found.' });
    }

    await saveUsers(users);
    res.json({ success: true, message: 'User deleted.' });
});

// Change Role (Optional enhancement)
router.post('/users/:id/role', isAuthenticated, isAdmin, async (req, res) => {
    const { id } = req.params;
    const { role } = req.body; // 'admin' or 'user'

    if (!['admin', 'user'].includes(role)) {
        return res.status(400).json({ success: false, message: 'Invalid role.' });
    }

    const users = await loadUsers();
    const user = users.find(u => u.id === id);

    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Prevent demoting yourself if you are the only admin (simple check: usually safe to just block demoting yourself)
    if (id === req.session.userId && role !== 'admin') {
        return res.status(400).json({ success: false, message: 'You cannot demote yourself.' });
    }

    user.role = role;
    await saveUsers(users);
    res.json({ success: true, message: 'User role updated.' });
});

// Change Plan
router.post('/users/:id/plan', isAuthenticated, isAdmin, async (req, res) => {
    const { id } = req.params;
    const { plan } = req.body; // 'free', 'basic', 'pro'

    const validPlans = ['free', 'basic', 'pro'];
    if (!validPlans.includes(plan)) {
        return res.status(400).json({ success: false, message: 'Invalid plan.' });
    }

    const users = await loadUsers();
    const user = users.find(u => u.id === id);

    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found.' });
    }

    user.plan = plan;
    await saveUsers(users);
    res.json({ success: true, message: 'User plan updated.' });
});

export default router;
