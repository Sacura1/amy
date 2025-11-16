const express = require('express');
const session = require('express-session');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const ethers = require('ethers');
require('dotenv').config();

// Import database module (PostgreSQL or JSON fallback)
const database = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

// Database helper functions (with JSON fallback for local development)
let db, leaderboard, nonces;
let usePostgres = false;

// Setup JSON files as default (synchronous)
const DATA_DIR = __dirname;
const DB_PATH = path.join(DATA_DIR, 'verified-users.json');
const LEADERBOARD_PATH = path.join(DATA_DIR, 'leaderboard.json');
const NONCES_PATH = path.join(DATA_DIR, 'nonces.json');

// Initialize JSON files if they don't exist
if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: [] }, null, 2));
}
if (!fs.existsSync(LEADERBOARD_PATH)) {
    fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify({
        leaderboard: [],
        lastUpdated: new Date().toISOString(),
        minimumAMY: 0
    }, null, 2));
}
if (!fs.existsSync(NONCES_PATH)) {
    fs.writeFileSync(NONCES_PATH, JSON.stringify({ nonces: [] }, null, 2));
}

// JSON database helper functions (default)
db = {
    getUsers: () => {
        const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        return data.users;
    },
    addUser: (user) => {
        const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        const existingIndex = data.users.findIndex(u =>
            u.wallet.toLowerCase() === user.wallet.toLowerCase()
        );
        if (existingIndex >= 0) {
            data.users[existingIndex] = user;
        } else {
            data.users.push(user);
        }
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        return user;
    },
    getUserByWallet: (wallet) => {
        const users = db.getUsers();
        return users.find(u => u.wallet.toLowerCase() === wallet.toLowerCase());
    },
    getUserByUsername: (username) => {
        const users = db.getUsers();
        return users.find(u => u.xUsername.toLowerCase() === username.toLowerCase());
    },
    deleteUser: (wallet) => {
        const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        const initialLength = data.users.length;
        data.users = data.users.filter(u => u.wallet.toLowerCase() !== wallet.toLowerCase());
        if (data.users.length < initialLength) {
            fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
            return true;
        }
        return false;
    }
};

leaderboard = {
    getAll: () => {
        return JSON.parse(fs.readFileSync(LEADERBOARD_PATH, 'utf8'));
    },
    update: (data) => {
        const leaderboardData = {
            leaderboard: data.leaderboard || [],
            lastUpdated: new Date().toISOString(),
            minimumAMY: data.minimumAMY || 0
        };
        fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify(leaderboardData, null, 2));
        return leaderboardData;
    },
    addEntry: (entry) => {
        const data = leaderboard.getAll();
        data.leaderboard.push(entry);
        data.lastUpdated = new Date().toISOString();
        fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify(data, null, 2));
        return data;
    },
    updateEntry: (position, entry) => {
        const data = leaderboard.getAll();
        const index = data.leaderboard.findIndex(e => e.position === position);
        if (index >= 0) {
            data.leaderboard[index] = { ...data.leaderboard[index], ...entry };
            data.lastUpdated = new Date().toISOString();
            fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify(data, null, 2));
        }
        return data;
    },
    deleteEntry: (position) => {
        const data = leaderboard.getAll();
        data.leaderboard = data.leaderboard.filter(e => e.position !== position);
        data.lastUpdated = new Date().toISOString();
        fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify(data, null, 2));
        return data;
    }
};

nonces = {
    exists: (nonce) => {
        const data = JSON.parse(fs.readFileSync(NONCES_PATH, 'utf8'));
        return data.nonces.some(n => n.nonce === nonce);
    },
    add: (nonce, wallet, timestamp) => {
        const data = JSON.parse(fs.readFileSync(NONCES_PATH, 'utf8'));
        data.nonces.push({
            nonce: nonce,
            wallet: wallet.toLowerCase(),
            timestamp: timestamp,
            usedAt: Date.now()
        });
        fs.writeFileSync(NONCES_PATH, JSON.stringify(data, null, 2));
    },
    cleanup: () => {
        const data = JSON.parse(fs.readFileSync(NONCES_PATH, 'utf8'));
        const MAX_AGE = 24 * 60 * 60 * 1000;
        const now = Date.now();
        data.nonces = data.nonces.filter(n => (now - n.usedAt) < MAX_AGE);
        fs.writeFileSync(NONCES_PATH, JSON.stringify(data, null, 2));
        console.log('🧹 Cleaned up old nonces, remaining:', data.nonces.length);
    }
};

// Try to initialize PostgreSQL (will override JSON if successful)
(async () => {
    usePostgres = await database.initDatabase();

    if (usePostgres) {
        // Override with PostgreSQL database
        db = database.db;
        leaderboard = database.leaderboard;
        nonces = database.nonces;
        console.log('✅ PostgreSQL database ready');

        // Run initial nonce cleanup for PostgreSQL
        try {
            await nonces.cleanup();
        } catch (err) {
            console.error('Cleanup error:', err);
        }
    } else {
        console.log('📁 Data directory:', DATA_DIR);

        // Run initial nonce cleanup for JSON
        nonces.cleanup();
    }
})();

// Admin wallet whitelist - ADD YOUR ADMIN WALLET ADDRESSES HERE
const ADMIN_WALLETS = (process.env.ADMIN_WALLETS || '')
    .split(',')
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length > 0);

console.log('📋 Admin wallets loaded:', ADMIN_WALLETS.length);

// AMY Token Configuration
const AMY_TOKEN_ADDRESS = '0x098a75bAedDEc78f9A8D0830d6B86eAc5cC8894e';
const MINIMUM_AMY_BALANCE = parseInt(process.env.MINIMUM_AMY_BALANCE) || 300;

console.log('💎 Minimum AMY balance requirement:', MINIMUM_AMY_BALANCE);

// Middleware
app.use(cors({
    origin:'https://amyonbera.com',
    credentials: true
}));
app.use(express.json());

// Trust proxy - important for Railway deployment
app.set('trust proxy', 1);

app.use(session({
    secret: process.env.SESSION_SECRET || 'amy-verification-secret-change-this',
    resave: false,
    saveUninitialized: true, // Changed to true to ensure session is created
    proxy: true, // Trust the reverse proxy
    cookie: {
        secure: process.env.NODE_ENV === 'production', // HTTPS only in production
        httpOnly: true,
        sameSite: process.env.NODE_ENV === 'production' ? 'lax' : 'lax', // Allow same-site navigation
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        domain: process.env.NODE_ENV === 'production' ? undefined : undefined // Let browser handle it
    }
}));

// PKCE helper functions for Twitter OAuth
function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// Middleware to check if wallet is admin
function isAdmin(req, res, next) {
    const wallet = req.query.wallet || req.body.wallet;

    if (!wallet) {
        return res.status(401).json({ error: 'Wallet address required' });
    }

    if (!ADMIN_WALLETS.includes(wallet.toLowerCase())) {
        return res.status(403).json({ error: 'Unauthorized: Not an admin wallet' });
    }

    next();
}

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'AMY Verification Backend Running',
        endpoints: {
            oauth: '/auth/x',
            verify: '/api/verify',
            status: '/api/status/:wallet',
            user: '/api/user/:username',
            download: '/api/download (admin only)',
            users: '/api/users (admin only)'
        }
    });
});

// ============================================
// X OAUTH ROUTES
// ============================================

// Route 1: Initiate X OAuth flow
app.get('/auth/x', (req, res) => {
    const wallet = req.query.wallet;

    if (!wallet) {
        return res.status(400).send('Wallet address required. Use: /auth/x?wallet=0x...');
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = crypto.randomBytes(16).toString('hex');

    // Store in session
    req.session.codeVerifier = codeVerifier;
    req.session.state = state;
    req.session.wallet = wallet;

    console.log('🔐 Starting OAuth flow');
    console.log('Session ID:', req.sessionID);
    console.log('State generated:', state);
    console.log('Wallet:', wallet);

    const authUrl = `https://x.com/i/oauth2/authorize?` +
        `response_type=code` +
        `&client_id=${process.env.TWITTER_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(process.env.TWITTER_CALLBACK_URL)}` +
        `&scope=tweet.read%20users.read` +
        `&state=${state}` +
        `&code_challenge=${codeChallenge}` +
        `&code_challenge_method=S256`;

    res.redirect(authUrl);
});

// Route 2: X OAuth callback
app.get('/auth/x/callback', async (req, res) => {
    const { code, state } = req.query;

    // Debug logging
    console.log('📥 OAuth callback received');
    console.log('State from query:', state);
    console.log('State from session:', req.session.state);
    console.log('Session ID:', req.sessionID);
    console.log('Code verifier in session:', req.session.codeVerifier ? 'EXISTS' : 'MISSING');
    console.log('Wallet in session:', req.session.wallet || 'MISSING');

    // Check if session exists
    if (!req.session || !req.session.state) {
        console.error('❌ Session lost - no state in session');
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        return res.redirect(`${frontendUrl}/profile?error=session_lost`);
    }

    // Verify state (CSRF protection)
    if (state !== req.session.state) {
        console.error('❌ State mismatch:', { received: state, expected: req.session.state });
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        return res.redirect(`${frontendUrl}/profile?error=state_mismatch`);
    }

    try {
        // Create Basic Auth header manually
        const credentials = Buffer.from(
            `${process.env.TWITTER_CLIENT_ID}:${process.env.TWITTER_CLIENT_SECRET}`
        ).toString('base64');

        // Exchange code for access token
        const tokenResponse = await axios.post(
            'https://api.twitter.com/2/oauth2/token',
            new URLSearchParams({
                code: code,
                grant_type: 'authorization_code',
                client_id: process.env.TWITTER_CLIENT_ID,
                redirect_uri: process.env.TWITTER_CALLBACK_URL,
                code_verifier: req.session.codeVerifier
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${credentials}`
                }
            }
        );

        const accessToken = tokenResponse.data.access_token;

        // Get user profile from Twitter
        const userResponse = await axios.get('https://api.twitter.com/2/users/me', {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });

        const twitterUser = userResponse.data.data;

        // Store Twitter info in session
        req.session.twitterUser = {
            id: twitterUser.id,
            username: twitterUser.username,
            name: twitterUser.name
        };

        // Redirect back to profile page with success
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        res.redirect(`${frontendUrl}/profile?x_connected=true&username=${twitterUser.username}&wallet=${req.session.wallet}`);

    } catch (error) {
        console.error('❌ OAuth error:', error.response?.data || error.message);
        console.error('Full error details:', {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            message: error.message
        });
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        res.redirect(`${frontendUrl}/profile?error=oauth_failed`);
    }
});

// ============================================
// VERIFICATION API ROUTES
// ============================================

// Verify user holdings and save to database
app.post('/api/verify', async (req, res) => {
    const { wallet, xUsername, amyBalance, signature, message, timestamp } = req.body;

    // 1. Validate required fields
    if (!wallet || !xUsername || !signature || !message || !timestamp) {
        return res.status(400).json({
            success: false,
            error: 'Missing required fields',
            required: ['wallet', 'xUsername', 'amyBalance', 'signature', 'message', 'timestamp']
        });
    }

    // 2. Validate wallet address format
    if (!ethers.utils.isAddress(wallet)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid wallet address format'
        });
    }

    // 3. Check timestamp (reject signatures older than 24 hours)
    const MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    const age = Date.now() - parseInt(timestamp);

    if (age > MAX_AGE) {
        return res.status(400).json({
            success: false,
            error: 'Signature expired. Please reconnect your wallet.'
        });
    }

    if (age < 0) {
        return res.status(400).json({
            success: false,
            error: 'Invalid timestamp (timestamp is in the future)'
        });
    }

    // 4. Verify the signature
    let recoveredAddress;
    try {
        recoveredAddress = ethers.utils.verifyMessage(message, signature);
    } catch (error) {
        console.error('❌ Signature verification error:', error);
        return res.status(400).json({
            success: false,
            error: 'Invalid signature format'
        });
    }

    // 5. Check if recovered address matches claimed wallet
    if (recoveredAddress.toLowerCase() !== wallet.toLowerCase()) {
        console.error('❌ Signature mismatch:', {
            claimed: wallet,
            recovered: recoveredAddress
        });
        return res.status(401).json({
            success: false,
            error: 'Signature verification failed. Wallet address does not match.'
        });
    }

    // 6. Check for replay attacks (nonce verification)
    const nonceMatch = message.match(/Nonce: (\d+)/);
    if (nonceMatch) {
        const nonce = nonceMatch[1];

        // Check if nonce was already used
        if (await nonces.exists(nonce)) {
            console.error('❌ Replay attack detected - nonce already used:', nonce);
            return res.status(400).json({
                success: false,
                error: 'This signature has already been used. Please reconnect your wallet.'
            });
        }

        // Store nonce to prevent future replay attacks
        await nonces.add(nonce, wallet, timestamp);
        console.log('✅ Nonce stored:', nonce);
    }

    // 7. Check minimum balance
    if (amyBalance < MINIMUM_AMY_BALANCE) {
        return res.status(400).json({
            success: false,
            error: 'Insufficient AMY balance',
            required: MINIMUM_AMY_BALANCE,
            current: amyBalance
        });
    }

    // ✅ Signature verified! User owns this wallet
    console.log('✅ Signature verified for wallet:', wallet);

    try {
        // Save to database
        const userData = {
            wallet: wallet.toLowerCase(),
            xUsername: xUsername,
            amyBalance: parseFloat(amyBalance),
            verifiedAt: new Date().toISOString(),
            timestamp: Date.now(),
            signatureVerified: true,
            signatureTimestamp: parseInt(timestamp)
        };

        await db.addUser(userData);

        console.log('✅ User verified and saved:', userData.wallet, '@' + userData.xUsername);

        res.json({
            success: true,
            message: 'Wallet verified successfully',
            data: {
                wallet: userData.wallet,
                xUsername: userData.xUsername,
                amyBalance: userData.amyBalance,
                verified: true,
                signatureVerified: true
            }
        });

    } catch (error) {
        console.error('❌ Error saving user:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to save verification data'
        });
    }
});

// Check verification status for a wallet
app.get('/api/status/:wallet', async (req, res) => {
    const wallet = req.params.wallet;

    if (!wallet) {
        return res.status(400).json({ error: 'Wallet address required' });
    }

    const user = await db.getUserByWallet(wallet);

    if (user) {
        res.json({
            verified: true,
            data: user
        });
    } else {
        res.json({
            verified: false,
            data: null
        });
    }
});

// ============================================
// ADMIN-ONLY ROUTES
// ============================================

// Get all verified users (admin only)
app.get('/api/users', isAdmin, async (req, res) => {
    try {
        const users = await db.getUsers();

        res.json({
            success: true,
            count: users.length,
            users: users
        });

    } catch (error) {
        console.error('❌ Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Download JSON spreadsheet (admin only)
app.get('/api/download', isAdmin, async (req, res) => {
    try {
        const users = await db.getUsers();

        console.log('📊 Download request - Total users in DB:', users.length);

        if (users.length === 0) {
            console.log('⚠️ No verified users found');
            return res.status(404).json({ error: 'No verified users found' });
        }

        // Format data for JSON export
        const exportData = users.map(user => ({
            xUsername: `@${user.xUsername}`,
            walletAddress: user.wallet,
            amyBalance: parseFloat(user.amyBalance.toFixed(2)),
            verifiedDate: new Date(user.verifiedAt).toISOString(),
            timestamp: user.timestamp,
            signatureVerified: user.signatureVerified || false
        }));

        console.log('✅ Exporting', exportData.length, 'users as JSON');

        // Send as JSON response
        res.json(exportData);

        console.log('📥 JSON downloaded by admin:', req.query.wallet);

    } catch (error) {
        console.error('❌ Error generating JSON:', error);
        res.status(500).json({ error: 'Failed to generate JSON' });
    }
});

// Get user data by X username (public endpoint)
app.get('/api/user/:username', async (req, res) => {
    try {
        const username = req.params.username.toLowerCase();

        // Try direct lookup first (faster for PostgreSQL)
        let user = await db.getUserByUsername(username);

        // Fallback to searching all users (for JSON)
        if (!user) {
            const users = await db.getUsers();
            user = users.find(u => u.xUsername.toLowerCase() === username);
        }

        if (user) {
            res.json({
                success: true,
                verified: true,
                data: {
                    xUsername: user.xUsername,
                    walletAddress: user.wallet,
                    amyBalance: user.amyBalance,
                    verifiedAt: user.verifiedAt,
                    eligible: user.amyBalance >= MINIMUM_AMY_BALANCE
                }
            });
        } else {
            res.json({
                success: true,
                verified: false,
                data: null
            });
        }

    } catch (error) {
        console.error('❌ Error fetching user:', error);
        res.status(500).json({ error: 'Failed to fetch user data' });
    }
});

// ============================================
// LEADERBOARD API ROUTES
// ============================================

// Get leaderboard (public)
app.get('/api/leaderboard', async (req, res) => {
    try {
        const data = await leaderboard.getAll();
        res.json({
            success: true,
            data: data
        });
    } catch (error) {
        console.error('❌ Error fetching leaderboard:', error);
        res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
});

// Update entire leaderboard (admin only)
app.post('/api/leaderboard', isAdmin, async (req, res) => {
    try {
        const { leaderboard: leaderboardData, minimumAMY } = req.body;

        if (!Array.isArray(leaderboardData)) {
            return res.status(400).json({ error: 'Leaderboard must be an array' });
        }

        const data = await leaderboard.update({
            leaderboard: leaderboardData,
            minimumAMY: minimumAMY || 0
        });

        console.log('✅ Leaderboard updated by admin:', req.body.wallet || req.query.wallet);

        res.json({
            success: true,
            message: 'Leaderboard updated successfully',
            data: data
        });

    } catch (error) {
        console.error('❌ Error updating leaderboard:', error);
        res.status(500).json({ error: 'Failed to update leaderboard' });
    }
});

// Add leaderboard entry (admin only)
app.post('/api/leaderboard/entry', isAdmin, async (req, res) => {
    try {
        const { position, xUsername, mindshare } = req.body;

        if (!position || !xUsername) {
            return res.status(400).json({ error: 'Position and xUsername are required' });
        }

        const entry = {
            position: parseInt(position),
            xUsername: xUsername,
            mindshare: parseFloat(mindshare) || 0
        };

        const data = await leaderboard.addEntry(entry);

        console.log('✅ Leaderboard entry added by admin:', entry);

        res.json({
            success: true,
            message: 'Entry added successfully',
            data: data
        });

    } catch (error) {
        console.error('❌ Error adding leaderboard entry:', error);
        res.status(500).json({ error: 'Failed to add entry' });
    }
});

// Update leaderboard entry (admin only)
app.put('/api/leaderboard/:position', isAdmin, async (req, res) => {
    try {
        const position = parseInt(req.params.position);
        const { xUsername, mindshare } = req.body;

        const entry = {};
        if (xUsername !== undefined) entry.xUsername = xUsername;
        if (mindshare !== undefined) entry.mindshare = parseFloat(mindshare);
        entry.position = position;

        const data = await leaderboard.updateEntry(position, entry);

        console.log('✅ Leaderboard entry updated by admin:', position);

        res.json({
            success: true,
            message: 'Entry updated successfully',
            data: data
        });

    } catch (error) {
        console.error('❌ Error updating leaderboard entry:', error);
        res.status(500).json({ error: 'Failed to update entry' });
    }
});

// Delete leaderboard entry (admin only)
app.delete('/api/leaderboard/:position', isAdmin, async (req, res) => {
    try {
        const position = parseInt(req.params.position);
        const data = await leaderboard.deleteEntry(position);

        console.log('🗑️ Leaderboard entry deleted by admin:', position);

        res.json({
            success: true,
            message: 'Entry deleted successfully',
            data: data
        });

    } catch (error) {
        console.error('❌ Error deleting leaderboard entry:', error);
        res.status(500).json({ error: 'Failed to delete entry' });
    }
});

// Bulk update leaderboard (admin only)
app.post('/api/leaderboard/bulk', isAdmin, async (req, res) => {
    try {
        const { entries } = req.body;

        if (!Array.isArray(entries)) {
            return res.status(400).json({ error: 'Entries must be an array' });
        }

        // Clear existing leaderboard and add all new entries
        const data = await leaderboard.update({
            leaderboard: entries,
            minimumAMY: MINIMUM_AMY_BALANCE
        });

        console.log('✅ Bulk leaderboard update by admin:', entries.length, 'entries');

        res.json({
            success: true,
            message: `Successfully updated ${entries.length} entries`,
            data: data
        });

    } catch (error) {
        console.error('❌ Error bulk updating leaderboard:', error);
        res.status(500).json({ error: 'Failed to bulk update leaderboard' });
    }
});

// Get stats (admin only)
app.get('/api/stats', isAdmin, async (req, res) => {
    try {
        const users = await db.getUsers();
        const totalBalance = users.reduce((sum, user) => sum + user.amyBalance, 0);

        res.json({
            success: true,
            stats: {
                totalVerified: users.length,
                totalAmyHeld: totalBalance,
                averageBalance: users.length > 0 ? totalBalance / users.length : 0,
                lastVerification: users.length > 0 ? users[users.length - 1].verifiedAt : null
            }
        });

    } catch (error) {
        console.error('❌ Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// Delete user (admin only)
app.delete('/api/user/:wallet', isAdmin, async (req, res) => {
    try {
        const wallet = req.params.wallet;
        const deleted = await db.deleteUser(wallet);

        if (deleted) {
            res.json({ success: true, message: 'User deleted' });
            console.log('🗑️ User deleted by admin:', wallet);
        } else {
            res.status(404).json({ error: 'User not found' });
        }

    } catch (error) {
        console.error('❌ Error deleting user:', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// Bulk restore users from backup (admin only)
app.post('/api/users/restore', isAdmin, async (req, res) => {
    try {
        const { users } = req.body;

        if (!Array.isArray(users)) {
            return res.status(400).json({ error: 'Users must be an array' });
        }

        // Validate each user has required fields
        for (const user of users) {
            if (!user.wallet || !user.xUsername || user.amyBalance === undefined) {
                return res.status(400).json({
                    error: 'Each user must have wallet, xUsername, and amyBalance'
                });
            }
        }

        // Add or update each user
        let added = 0;
        let updated = 0;

        for (const user of users) {
            const existing = await db.getUserByWallet(user.wallet);

            if (existing) {
                updated++;
            } else {
                added++;
            }

            await db.addUser(user);
        }

        const allUsers = await db.getUsers();

        console.log(`✅ Bulk restore completed: ${added} added, ${updated} updated`);

        res.json({
            success: true,
            message: `Restored ${users.length} users`,
            added: added,
            updated: updated,
            total: allUsers.length
        });

    } catch (error) {
        console.error('❌ Error restoring users:', error);
        res.status(500).json({ error: 'Failed to restore users' });
    }
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log('╔════════════════════════════════════════════╗');
    console.log('║   🚀 AMY Verification Backend Server      ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log('');
    console.log(`📡 Server running on: http://localhost:${PORT}`);
    console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
    console.log(`🔐 Admin wallets: ${ADMIN_WALLETS.length}`);
    console.log(`💾 Database: ${usePostgres ? 'PostgreSQL' : 'JSON files'}`);
    console.log(`🔒 Signature verification: ENABLED`);
    console.log(`🛡️ Replay attack prevention: ENABLED`);
    console.log('');
    console.log('📍 Endpoints:');
    console.log(`   OAuth: http://localhost:${PORT}/auth/x?wallet=0x...`);
    console.log(`   Verify: POST http://localhost:${PORT}/api/verify`);
    console.log(`   Status: GET http://localhost:${PORT}/api/status/:wallet`);
    console.log(`   User: GET http://localhost:${PORT}/api/user/:username (public)`);
    console.log(`   Download: GET http://localhost:${PORT}/api/download?wallet=0x... (admin)`);
    console.log(`   Users: GET http://localhost:${PORT}/api/users?wallet=0x... (admin)`);
    console.log('');
    console.log('✅ Ready to accept connections!');
    console.log('');

    // Run nonce cleanup every hour
    setInterval(async () => {
        try {
            await nonces.cleanup();
        } catch (err) {
            console.error('Periodic cleanup error:', err);
        }
    }, 60 * 60 * 1000); // Run every hour
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('👋 SIGTERM received, shutting down gracefully...');
    process.exit(0);
});
