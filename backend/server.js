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
let referralsDb = null; // Will be set after PostgreSQL init
let holdersDb = null; // Will be set after PostgreSQL init
let pointsDb = null; // Will be set after PostgreSQL init
let POINTS_TIERS = null; // Will be set after PostgreSQL init

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

// Generate random 8-character referral code
function generateRandomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing characters like O, 0, I, 1
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
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
            // Preserve referral data when updating
            const existing = data.users[existingIndex];
            user.referralCode = user.referralCode || existing.referralCode;
            user.referredBy = user.referredBy || existing.referredBy;
            user.referralCount = existing.referralCount || 0;
            data.users[existingIndex] = user;
        } else {
            user.referralCode = user.referralCode || null;
            user.referredBy = user.referredBy || null;
            user.referralCount = user.referralCount || 0;
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
    getUserByReferralCode: (referralCode) => {
        const users = db.getUsers();
        return users.find(u => u.referralCode && u.referralCode.toUpperCase() === referralCode.toUpperCase());
    },
    generateReferralCode: (wallet) => {
        const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        const userIndex = data.users.findIndex(u => u.wallet.toLowerCase() === wallet.toLowerCase());
        if (userIndex < 0) return null;

        const code = generateRandomCode();
        data.users[userIndex].referralCode = code;
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        return code;
    },
    setReferredBy: (wallet, referralCode) => {
        const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        const userIndex = data.users.findIndex(u => u.wallet.toLowerCase() === wallet.toLowerCase());

        if (userIndex < 0) {
            return { success: false, error: 'User not found' };
        }

        const user = data.users[userIndex];
        if (user.referredBy) {
            return { success: false, error: 'You have already used a referral code' };
        }

        // Find referrer
        const referrerIndex = data.users.findIndex(u => u.referralCode && u.referralCode.toUpperCase() === referralCode.toUpperCase());
        if (referrerIndex < 0) {
            return { success: false, error: 'Invalid referral code' };
        }

        const referrer = data.users[referrerIndex];
        if (referrer.wallet.toLowerCase() === wallet.toLowerCase()) {
            return { success: false, error: 'You cannot use your own referral code' };
        }

        // Update user's referred_by
        data.users[userIndex].referredBy = referralCode.toUpperCase();

        // Increment referrer's referral count
        data.users[referrerIndex].referralCount = (data.users[referrerIndex].referralCount || 0) + 1;

        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        return { success: true, referrer: referrer.xUsername };
    },
    getDownlines: (referralCode) => {
        const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        // Find all users who used this referral code
        const downlines = data.users.filter(u =>
            u.referredBy && u.referredBy.toUpperCase() === referralCode.toUpperCase()
        ).map(u => ({
            wallet: u.wallet,
            xUsername: u.xUsername,
            amyBalance: u.amyBalance,
            verifiedAt: u.verifiedAt
        }));
        return downlines;
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
        referralsDb = database.referrals;
        holdersDb = database.holders;
        pointsDb = database.points;
        POINTS_TIERS = database.POINTS_TIERS;
        console.log('✅ PostgreSQL database ready');

        // Run initial nonce cleanup for PostgreSQL
        try {
            await nonces.cleanup();
        } catch (err) {
            console.error('Cleanup error:', err);
        }
    } else {
        console.log('📁 Data directory:', DATA_DIR);

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

// Middleware - Allow multiple CORS origins
const allowedOrigins = [
    'https://amyonbera.com',
    'https://www.amyonbera.com',
    'https://amy-on-bera.vercel.app',
    'https://amy-on-bera.vercel'
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);

        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.log('❌ CORS blocked origin:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
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
        return res.redirect(`${frontendUrl}/app/profile?error=session_lost`);
    }

    // Verify state (CSRF protection)
    if (state !== req.session.state) {
        console.error('❌ State mismatch:', { received: state, expected: req.session.state });
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        return res.redirect(`${frontendUrl}/app/profile?error=state_mismatch`);
    }

    try {
        // Create Basic Auth header manually
        const credentials = Buffer.from(
            `${process.env.TWITTER_CLIENT_ID}:${process.env.TWITTER_CLIENT_SECRET}`
        ).toString('base64');

        console.log('🔄 Exchanging code for token...');
        console.log('Callback URL being used:', process.env.TWITTER_CALLBACK_URL);
        console.log('Client ID:', process.env.TWITTER_CLIENT_ID ? 'SET' : 'MISSING');
        console.log('Client Secret:', process.env.TWITTER_CLIENT_SECRET ? 'SET' : 'MISSING');

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
        res.redirect(`${frontendUrl}/app/profile?x_connected=true&username=${twitterUser.username}&wallet=${req.session.wallet}`);

    } catch (error) {
        console.error('❌ OAuth error:', error.response?.data || error.message);
        console.error('Full error details:', {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            message: error.message
        });

        // Include more details in the redirect for debugging
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const errorCode = error.response?.data?.error || 'unknown';
        const errorDesc = error.response?.data?.error_description || error.message || 'Token exchange failed';
        res.redirect(`${frontendUrl}/app/profile?error=oauth_failed&reason=${encodeURIComponent(errorCode)}&details=${encodeURIComponent(errorDesc)}`);
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

        // Also add to holders table if they have 300+ AMY
        if (holdersDb && parseFloat(amyBalance) >= MINIMUM_AMY_BALANCE) {
            await holdersDb.addOrUpdate(userData.wallet, userData.xUsername, userData.amyBalance);
            console.log('💎 User added to holders:', userData.wallet, '@' + userData.xUsername);
        }

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
// TOKEN HOLDERS API ROUTES
// ============================================

// Excluded usernames from public holders list (project admins)
const EXCLUDED_HOLDERS = ['Joedark01', 'viccweb3', '0xWunda_', 'doruOlt'];

// Get all token holders (public - for leaderboard page)
app.get('/api/holders', async (req, res) => {
    try {
        if (!holdersDb) {
            return res.json({
                success: true,
                count: 0,
                holders: [],
                minimumAMY: MINIMUM_AMY_BALANCE
            });
        }

        const allHolders = await holdersDb.getAll();

        // Filter out excluded admin usernames
        const holders = allHolders.filter(h =>
            !EXCLUDED_HOLDERS.includes(h.xUsername)
        );

        res.json({
            success: true,
            count: holders.length,
            holders: holders,
            minimumAMY: MINIMUM_AMY_BALANCE
        });

    } catch (error) {
        console.error('❌ Error fetching holders:', error);
        res.status(500).json({ error: 'Failed to fetch holders' });
    }
});

// Get all token holders - admin only (includes all users, no filtering)
app.get('/api/holders/all', isAdmin, async (req, res) => {
    try {
        if (!holdersDb) {
            return res.json({
                success: true,
                count: 0,
                holders: [],
                minimumAMY: MINIMUM_AMY_BALANCE
            });
        }

        const allHolders = await holdersDb.getAll();

        res.json({
            success: true,
            count: allHolders.length,
            holders: allHolders,
            minimumAMY: MINIMUM_AMY_BALANCE
        });

    } catch (error) {
        console.error('❌ Error fetching all holders:', error);
        res.status(500).json({ error: 'Failed to fetch holders' });
    }
});

// Update holder balance (called when user loads profile)
app.post('/api/holders/update', async (req, res) => {
    try {
        const { wallet, xUsername, amyBalance } = req.body;

        if (!wallet || !xUsername || amyBalance === undefined) {
            return res.status(400).json({
                success: false,
                error: 'Wallet, xUsername, and amyBalance are required'
            });
        }

        if (!holdersDb) {
            return res.status(500).json({
                success: false,
                error: 'Holders system not available'
            });
        }

        // This will add/update if >= 300 AMY, or remove if below
        const result = await holdersDb.addOrUpdate(wallet, xUsername, parseFloat(amyBalance));

        res.json({
            success: true,
            isHolder: result !== null,
            data: result
        });

    } catch (error) {
        console.error('❌ Error updating holder:', error);
        res.status(500).json({ success: false, error: 'Failed to update holder' });
    }
});

// ============================================
// REFERRAL API ROUTES (uses separate referrals table)
// ============================================

// Initialize/register user for referrals (called when wallet+X connected)
app.post('/api/referral/register', async (req, res) => {
    try {
        const { wallet, xUsername } = req.body;

        if (!wallet) {
            return res.status(400).json({ success: false, error: 'Wallet address required' });
        }

        if (!referralsDb) {
            return res.status(500).json({ success: false, error: 'Referral system not available' });
        }

        // Create or get referral entry
        const entry = await referralsDb.getOrCreate(wallet, xUsername);

        res.json({
            success: true,
            data: entry
        });

    } catch (error) {
        console.error('❌ Error registering for referrals:', error);
        res.status(500).json({ success: false, error: 'Failed to register for referrals' });
    }
});

// Generate referral code for user
app.post('/api/referral/generate', async (req, res) => {
    try {
        const { wallet, xUsername, amyBalance } = req.body;

        if (!wallet) {
            return res.status(400).json({ success: false, error: 'Wallet address required' });
        }

        if (!referralsDb) {
            return res.status(500).json({ success: false, error: 'Referral system not available' });
        }

        // Get or create referral entry
        let entry = await referralsDb.getOrCreate(wallet, xUsername);

        // Check if user already has a referral code
        if (entry.referralCode) {
            return res.json({
                success: true,
                referralCode: entry.referralCode,
                message: 'Referral code already exists'
            });
        }

        // Check if user has minimum AMY balance to generate a code
        // Fetch live balance if not provided
        let balance = amyBalance;
        if (balance === undefined) {
            balance = await fetchAmyBalance(wallet);
        }

        if (balance === null || balance < MINIMUM_AMY_BALANCE) {
            return res.status(400).json({
                success: false,
                error: `You need at least ${MINIMUM_AMY_BALANCE} $AMY to generate a referral code`
            });
        }

        // Generate new referral code
        const code = await referralsDb.generateCode(wallet);

        if (!code) {
            return res.status(500).json({ success: false, error: 'Failed to generate referral code' });
        }

        console.log('🎫 Referral code generated for wallet:', wallet, '- Code:', code);

        res.json({
            success: true,
            referralCode: code,
            message: 'Referral code generated successfully'
        });

    } catch (error) {
        console.error('❌ Error generating referral code:', error);
        res.status(500).json({ success: false, error: 'Failed to generate referral code' });
    }
});

// Get referral info for user (with dynamic count based on current balances)
app.get('/api/referral/:wallet', async (req, res) => {
    try {
        const wallet = req.params.wallet;

        if (!wallet) {
            return res.status(400).json({ success: false, error: 'Wallet address required' });
        }

        if (!referralsDb) {
            return res.status(500).json({ success: false, error: 'Referral system not available' });
        }

        const entry = await referralsDb.getByWallet(wallet);

        if (!entry) {
            return res.json({ success: true, data: null });
        }

        // Calculate valid referral count dynamically (downlines with 300+ AMY)
        const validReferralCount = entry.referralCode
            ? await referralsDb.getValidReferralCount(entry.referralCode)
            : 0;

        res.json({
            success: true,
            data: {
                referralCode: entry.referralCode || null,
                referredBy: entry.referredBy || null,
                referralCount: validReferralCount, // Dynamic count based on balances
                lastKnownBalance: entry.lastKnownBalance || 0
            }
        });

    } catch (error) {
        console.error('❌ Error fetching referral info:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch referral info' });
    }
});

// Update user's balance in referrals table (called when user loads profile)
app.post('/api/referral/update-balance', async (req, res) => {
    try {
        const { wallet, balance } = req.body;

        if (!wallet || balance === undefined) {
            return res.status(400).json({ success: false, error: 'Wallet and balance required' });
        }

        if (!referralsDb) {
            return res.status(500).json({ success: false, error: 'Referral system not available' });
        }

        // Update the user's balance
        await referralsDb.updateBalance(wallet, balance);

        res.json({ success: true });

    } catch (error) {
        console.error('❌ Error updating balance:', error);
        res.status(500).json({ success: false, error: 'Failed to update balance' });
    }
});

// Use a referral code (can only be done once per user)
app.post('/api/referral/use', async (req, res) => {
    try {
        const { wallet, referralCode } = req.body;

        if (!wallet || !referralCode) {
            return res.status(400).json({ success: false, error: 'Wallet address and referral code required' });
        }

        // Validate referral code format
        if (referralCode.length !== 8) {
            return res.status(400).json({ success: false, error: 'Invalid referral code format' });
        }

        if (!referralsDb) {
            return res.status(500).json({ success: false, error: 'Referral system not available' });
        }

        // Make sure user has a referral entry first
        await referralsDb.getOrCreate(wallet);

        // Use the referral code (counts are calculated dynamically based on balance)
        const result = await referralsDb.useCode(wallet, referralCode);

        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error });
        }

        console.log('🤝 Referral linked - Wallet:', wallet, '- Code:', referralCode, '- Referrer:', result.referrer);

        res.json({
            success: true,
            message: result.message,
            referrer: result.referrer
        });

    } catch (error) {
        console.error('❌ Error using referral code:', error);
        res.status(500).json({ success: false, error: 'Failed to use referral code' });
    }
});

// Get all downlines (users referred by a specific user)
app.get('/api/referral/downlines/:wallet', async (req, res) => {
    try {
        const wallet = req.params.wallet;

        if (!wallet) {
            return res.status(400).json({ success: false, error: 'Wallet address required' });
        }

        if (!referralsDb) {
            return res.status(500).json({ success: false, error: 'Referral system not available' });
        }

        // Get the user's referral code first
        const entry = await referralsDb.getByWallet(wallet);
        if (!entry || !entry.referralCode) {
            return res.json({
                success: true,
                data: {
                    referralCode: null,
                    downlines: [],
                    totalDownlines: 0,
                    validDownlines: 0
                }
            });
        }

        // Get all users who used this referral code
        const downlines = await referralsDb.getDownlines(entry.referralCode);

        // Mark each downline as valid or pending based on their balance
        const downlinesWithStatus = downlines.map(d => ({
            ...d,
            isValid: (d.lastKnownBalance || 0) >= MINIMUM_AMY_BALANCE
        }));

        const validCount = downlinesWithStatus.filter(d => d.isValid).length;

        res.json({
            success: true,
            data: {
                referralCode: entry.referralCode,
                downlines: downlinesWithStatus,
                totalDownlines: downlines.length,
                validDownlines: validCount
            }
        });

    } catch (error) {
        console.error('❌ Error fetching downlines:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch downlines' });
    }
});

// ============================================
// POINTS API ROUTES
// ============================================

// Get points for a wallet (public)
app.get('/api/points/:wallet', async (req, res) => {
    try {
        const wallet = req.params.wallet;

        if (!wallet) {
            return res.status(400).json({ success: false, error: 'Wallet address required' });
        }

        if (!pointsDb) {
            return res.status(500).json({ success: false, error: 'Points system not available' });
        }

        const pointsData = await pointsDb.getByWallet(wallet);

        if (!pointsData) {
            // Return default data for new users
            return res.json({
                success: true,
                data: {
                    wallet: wallet.toLowerCase(),
                    totalPoints: 0,
                    currentTier: 'none',
                    tierInfo: POINTS_TIERS['none'],
                    pointsPerHour: 0,
                    lastAmyBalance: 0
                }
            });
        }

        res.json({
            success: true,
            data: {
                ...pointsData,
                tierInfo: POINTS_TIERS[pointsData.currentTier] || POINTS_TIERS['none']
            }
        });

    } catch (error) {
        console.error('❌ Error fetching points:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch points' });
    }
});

// Update user's balance and tier for points system (called when loading profile/points page)
app.post('/api/points/update-balance', async (req, res) => {
    try {
        const { wallet, amyBalance, xUsername } = req.body;

        if (!wallet || amyBalance === undefined) {
            return res.status(400).json({ success: false, error: 'Wallet and amyBalance required' });
        }

        if (!pointsDb) {
            return res.status(500).json({ success: false, error: 'Points system not available' });
        }

        // Update balance and recalculate tier
        const result = await pointsDb.updateBalance(wallet, parseFloat(amyBalance), xUsername);

        // Get updated points data
        const pointsData = await pointsDb.getByWallet(wallet);

        res.json({
            success: true,
            data: {
                ...pointsData,
                tierInfo: POINTS_TIERS[result.tier] || POINTS_TIERS['none']
            }
        });

    } catch (error) {
        console.error('❌ Error updating points balance:', error);
        res.status(500).json({ success: false, error: 'Failed to update balance' });
    }
});

// Get points history for a wallet (public)
app.get('/api/points/history/:wallet', async (req, res) => {
    try {
        const wallet = req.params.wallet;
        const limit = parseInt(req.query.limit) || 50;

        if (!wallet) {
            return res.status(400).json({ success: false, error: 'Wallet address required' });
        }

        if (!pointsDb) {
            return res.status(500).json({ success: false, error: 'Points system not available' });
        }

        const history = await pointsDb.getHistory(wallet, limit);

        res.json({
            success: true,
            data: history
        });

    } catch (error) {
        console.error('❌ Error fetching points history:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch points history' });
    }
});

// Get points leaderboard (public)
app.get('/api/points/leaderboard', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;

        if (!pointsDb) {
            return res.json({
                success: true,
                data: []
            });
        }

        const leaderboardData = await pointsDb.getLeaderboard(limit);

        // Add tier info to each entry
        const enrichedData = leaderboardData.map(entry => ({
            ...entry,
            tierInfo: POINTS_TIERS[entry.currentTier] || POINTS_TIERS['none']
        }));

        res.json({
            success: true,
            data: enrichedData
        });

    } catch (error) {
        console.error('❌ Error fetching points leaderboard:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
    }
});

// Get tier configuration (public)
app.get('/api/points/tiers', (req, res) => {
    res.json({
        success: true,
        data: POINTS_TIERS || {
            platinum: { minBalance: 100000, pointsPerHour: 10, name: 'Platinum', emoji: '💎' },
            gold: { minBalance: 10000, pointsPerHour: 5, name: 'Gold', emoji: '🥇' },
            silver: { minBalance: 1000, pointsPerHour: 3, name: 'Silver', emoji: '🥈' },
            bronze: { minBalance: 300, pointsPerHour: 1, name: 'Bronze', emoji: '🟫' },
            none: { minBalance: 0, pointsPerHour: 0, name: 'None', emoji: '⚪' }
        }
    });
});

// ============================================
// OAUTH USER SAVE ENDPOINT
// ============================================

// Save user after OAuth (no signature required - OAuth already verified)
app.post('/api/oauth/save', async (req, res) => {
    try {
        const { wallet, xUsername, amyBalance } = req.body;

        if (!wallet || !xUsername) {
            return res.status(400).json({
                success: false,
                error: 'Wallet and xUsername are required'
            });
        }

        // Validate wallet address format
        if (!ethers.utils.isAddress(wallet)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid wallet address format'
            });
        }

        console.log('💾 Saving OAuth user:', wallet, '@' + xUsername);

        // Save to verified_users table (so checkXStatus works)
        const userData = {
            wallet: wallet.toLowerCase(),
            xUsername: xUsername,
            amyBalance: parseFloat(amyBalance) || 0,
            verifiedAt: new Date().toISOString(),
            timestamp: Date.now(),
            signatureVerified: false, // OAuth verified, not signature
            signatureTimestamp: Date.now()
        };

        await db.addUser(userData);

        // Also register for referrals
        if (referralsDb) {
            await referralsDb.getOrCreate(wallet, xUsername);
        }

        // Also add to holders table if they have 300+ AMY
        if (holdersDb && parseFloat(amyBalance) >= MINIMUM_AMY_BALANCE) {
            await holdersDb.addOrUpdate(wallet, xUsername, parseFloat(amyBalance));
        }

        // Initialize points entry
        if (pointsDb) {
            await pointsDb.updateBalance(wallet, parseFloat(amyBalance) || 0, xUsername);
        }

        console.log('✅ OAuth user saved:', wallet, '@' + xUsername);

        res.json({
            success: true,
            message: 'User saved successfully',
            data: userData
        });

    } catch (error) {
        console.error('❌ Error saving OAuth user:', error);
        res.status(500).json({ success: false, error: 'Failed to save user' });
    }
});

// ============================================
// LP TRACKING API ROUTES
// ============================================

// Get LP status for a wallet (public)
app.get('/api/lp/:wallet', async (req, res) => {
    try {
        const wallet = req.params.wallet;

        if (!wallet) {
            return res.status(400).json({ success: false, error: 'Wallet address required' });
        }

        // Query LP position from blockchain
        const lpData = await queryLpPositions(wallet);

        // Update database with fresh LP data if points system is available
        if (pointsDb) {
            await pointsDb.updateLpData(wallet, lpData.lpValueUsd, lpData.lpMultiplier);
        }

        res.json({
            success: true,
            data: {
                wallet: wallet.toLowerCase(),
                lpValueUsd: lpData.lpValueUsd,
                totalLpValueUsd: lpData.totalLpValueUsd,
                lpMultiplier: lpData.lpMultiplier,
                positionsFound: lpData.positionsFound,
                inRangePositions: lpData.inRangePositions,
                isInRange: lpData.isInRange,
                amyPriceUsd: lpData.amyPriceUsd,
                tiers: LP_MULTIPLIER_TIERS
            }
        });

    } catch (error) {
        console.error('❌ Error fetching LP status:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch LP status' });
    }
});

// Get LP multiplier tiers configuration (public)
app.get('/api/lp/tiers', (req, res) => {
    res.json({
        success: true,
        data: LP_MULTIPLIER_TIERS
    });
});

// ============================================
// PERIODIC JOBS
// ============================================

// ERC20 ABI for balanceOf
const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];

// ============================================
// LP TRACKING CONFIGURATION
// ============================================

// Bulla Exchange contract addresses on Berachain
const BULLA_CONTRACTS = {
    nonfungiblePositionManager: '0xc228fbF18864B6e91d15abfcc2039f87a5F66741',
    farmingCenter: '0x8dE1e590bdcBb65864e69dC2B5B020d9855E99A2',
    amyHoneyPool: '0xff716930eefb37b5b4ac55b1901dc5704b098d84'
};

// Token addresses
const TOKENS = {
    AMY: '0x098a75baeddec78f9a8d0830d6b86eac5cc8894e'.toLowerCase(),
    HONEY: '0xfcbd14dc51f0a4d49d5e53c2e0950e0bc26d0dce'.toLowerCase()
};

// LP Multiplier tiers
const LP_MULTIPLIER_TIERS = [
    { minUsd: 500, multiplier: 100 },
    { minUsd: 100, multiplier: 10 },
    { minUsd: 10, multiplier: 3 },
    { minUsd: 0, multiplier: 1 }
];

// NonfungiblePositionManager ABI (Algebra Integral - no tickSpacing in positions)
const NFPM_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'
];

// Algebra Pool ABI (for getting current tick and price)
const POOL_ABI = [
    'function globalState() view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked)',
    'function token0() view returns (address)',
    'function token1() view returns (address)'
];

// FarmingCenter ABI (for checking staked positions)
const FARMING_CENTER_ABI = [
    'function deposits(uint256 tokenId) view returns (uint256 L2TokenId, uint32 numberOfFarms, bool inLimitFarming, address owner)',
    'event Deposit(uint256 indexed tokenId, address indexed owner)'
];

// EternalFarming ABI (to check farms)
const ETERNAL_FARMING_ABI = [
    'function farms(uint256 tokenId, bytes32 incentiveId) view returns (uint128 liquidity, int24 tickLower, int24 tickUpper)'
];

// Calculate LP multiplier from USD value
function calculateLpMultiplier(usdValue) {
    for (const tier of LP_MULTIPLIER_TIERS) {
        if (usdValue >= tier.minUsd) {
            return tier.multiplier;
        }
    }
    return 1;
}

// Calculate token amounts from liquidity and tick range
// Based on Uniswap V3 math
function getTokenAmountsFromLiquidity(liquidity, tickLower, tickUpper, currentTick) {
    const sqrtPriceLower = Math.sqrt(1.0001 ** tickLower);
    const sqrtPriceUpper = Math.sqrt(1.0001 ** tickUpper);
    const sqrtPriceCurrent = Math.sqrt(1.0001 ** currentTick);

    let amount0 = 0;
    let amount1 = 0;

    if (currentTick < tickLower) {
        // All in token0
        amount0 = liquidity * (1 / sqrtPriceLower - 1 / sqrtPriceUpper);
    } else if (currentTick >= tickUpper) {
        // All in token1
        amount1 = liquidity * (sqrtPriceUpper - sqrtPriceLower);
    } else {
        // In range - mix of both
        amount0 = liquidity * (1 / sqrtPriceCurrent - 1 / sqrtPriceUpper);
        amount1 = liquidity * (sqrtPriceCurrent - sqrtPriceLower);
    }

    return { amount0, amount1 };
}

// Query LP positions for a wallet in the AMY/HONEY pool
async function queryLpPositions(walletAddress) {
    try {
        const provider = new ethers.providers.JsonRpcProvider('https://rpc.berachain.com');

        const nfpm = new ethers.Contract(BULLA_CONTRACTS.nonfungiblePositionManager, NFPM_ABI, provider);
        const pool = new ethers.Contract(BULLA_CONTRACTS.amyHoneyPool, POOL_ABI, provider);
        const farmingCenter = new ethers.Contract(BULLA_CONTRACTS.farmingCenter, FARMING_CENTER_ABI, provider);

        // Get current pool state for price calculation
        const globalState = await pool.globalState();
        const currentTick = globalState.tick;

        // Get pool tokens to determine order
        const token0 = (await pool.token0()).toLowerCase();
        const token1 = (await pool.token1()).toLowerCase();

        // Calculate AMY price from tick
        // price = 1.0001^tick gives token1/token0 ratio
        const priceRatio = 1.0001 ** currentTick;
        // If AMY is token0, priceRatio is HONEY per AMY
        // If AMY is token1, priceRatio is AMY per HONEY
        const amyIsToken0 = token0 === TOKENS.AMY;
        const amyPriceInHoney = amyIsToken0 ? priceRatio : (1 / priceRatio);
        // HONEY is ~$1 stablecoin
        const amyPriceUsd = amyPriceInHoney;

        console.log(`🔍 LP Check for ${walletAddress.slice(0, 8)}... - AMY price: $${amyPriceUsd.toFixed(4)}`);

        // Get NFT balance (positions held in wallet)
        const nftBalance = await nfpm.balanceOf(walletAddress);
        const nftCount = nftBalance.toNumber();

        let totalLpValueUsd = 0;
        let inRangeValueUsd = 0;
        let positionsFound = 0;
        let inRangePositions = 0;

        // Check positions held directly in wallet
        for (let i = 0; i < nftCount; i++) {
            try {
                const tokenId = await nfpm.tokenOfOwnerByIndex(walletAddress, i);

                // Get position data with error handling
                let position;
                try {
                    position = await nfpm.positions(tokenId);
                } catch (posErr) {
                    console.log(`   ⏭️ Wallet position ${i} (token #${tokenId}): ${posErr.code || posErr.message}`);
                    continue;
                }

                // Safely check tokens
                if (!position.token0 || !position.token1) {
                    continue;
                }

                // Check if this position is for the AMY/HONEY pool
                const posToken0 = position.token0.toLowerCase();
                const posToken1 = position.token1.toLowerCase();

                const isAmyHoneyPool =
                    (posToken0 === TOKENS.AMY && posToken1 === TOKENS.HONEY) ||
                    (posToken0 === TOKENS.HONEY && posToken1 === TOKENS.AMY);

                if (!isAmyHoneyPool) continue;
                if (!position.liquidity || position.liquidity.isZero()) continue;

                positionsFound++;

                // Check if position is in range
                const isInRange = currentTick >= position.tickLower && currentTick < position.tickUpper;

                // Calculate token amounts
                const liquidity = parseFloat(position.liquidity.toString());
                const { amount0, amount1 } = getTokenAmountsFromLiquidity(
                    liquidity,
                    position.tickLower,
                    position.tickUpper,
                    currentTick
                );

                // Convert to decimal amounts (18 decimals for both tokens)
                const amount0Decimal = amount0 / 1e18;
                const amount1Decimal = amount1 / 1e18;

                // Calculate USD value
                let positionUsd;
                if (posToken0 === TOKENS.AMY) {
                    // amount0 is AMY, amount1 is HONEY
                    positionUsd = (amount0Decimal * amyPriceUsd) + amount1Decimal;
                } else {
                    // amount0 is HONEY, amount1 is AMY
                    positionUsd = amount0Decimal + (amount1Decimal * amyPriceUsd);
                }

                totalLpValueUsd += positionUsd;

                // Only count in-range positions for multiplier
                if (isInRange) {
                    inRangeValueUsd += positionUsd;
                    inRangePositions++;
                }

                console.log(`   ✅ Wallet position #${tokenId}: $${positionUsd.toFixed(2)} ${isInRange ? '(in range)' : '(out of range)'}`);
            } catch (err) {
                console.log(`   ⏭️ Error checking wallet position ${i}:`, err.message);
            }
        }

        // Check FarmingCenter for staked positions using event indexing
        try {
            // Query Deposit events for this user - limit to last 10,000 blocks (RPC limit)
            // For older deposits, we'd need to index events separately or use a subgraph
            const currentBlock = await provider.getBlockNumber();
            const fromBlock = Math.max(0, currentBlock - 9900); // Stay under 10k limit

            const depositFilter = farmingCenter.filters.Deposit(null, walletAddress);
            const depositEvents = await farmingCenter.queryFilter(depositFilter, fromBlock, currentBlock);

            if (depositEvents.length > 0) {
                console.log(`📌 Found ${depositEvents.length} FarmingCenter deposit events for user (blocks ${fromBlock}-${currentBlock})`);

                for (const event of depositEvents) {
                    const tokenId = event.args.tokenId;

                    try {
                        // Verify the position is still staked (owner matches)
                        let deposit;
                        try {
                            deposit = await farmingCenter.deposits(tokenId);
                        } catch (depositErr) {
                            console.log(`   ⏭️ Token #${tokenId}: deposit lookup failed, skipping`);
                            continue;
                        }

                        if (!deposit.owner || deposit.owner.toLowerCase() !== walletAddress.toLowerCase()) {
                            // User withdrew this position, skip
                            continue;
                        }

                        // Get position data with retry
                        let position;
                        try {
                            position = await nfpm.positions(tokenId);
                        } catch (posErr) {
                            console.log(`   ⏭️ Token #${tokenId}: position lookup failed, skipping`);
                            continue;
                        }

                        // Safely check tokens
                        if (!position.token0 || !position.token1) {
                            console.log(`   ⏭️ Token #${tokenId}: no token data, skipping`);
                            continue;
                        }

                        // Check if this position is for the AMY/HONEY pool
                        const posToken0 = position.token0.toLowerCase();
                        const posToken1 = position.token1.toLowerCase();

                        const isAmyHoneyPool =
                            (posToken0 === TOKENS.AMY && posToken1 === TOKENS.HONEY) ||
                            (posToken0 === TOKENS.HONEY && posToken1 === TOKENS.AMY);

                        if (!isAmyHoneyPool) continue;
                        if (!position.liquidity || position.liquidity.isZero()) continue;

                        positionsFound++;

                        // Check if position is in range
                        const isPositionInRange = currentTick >= position.tickLower && currentTick < position.tickUpper;

                        // Calculate token amounts
                        const liquidity = parseFloat(position.liquidity.toString());
                        const { amount0, amount1 } = getTokenAmountsFromLiquidity(
                            liquidity,
                            position.tickLower,
                            position.tickUpper,
                            currentTick
                        );

                        const amount0Decimal = amount0 / 1e18;
                        const amount1Decimal = amount1 / 1e18;

                        let positionUsd;
                        if (posToken0 === TOKENS.AMY) {
                            positionUsd = (amount0Decimal * amyPriceUsd) + amount1Decimal;
                        } else {
                            positionUsd = amount0Decimal + (amount1Decimal * amyPriceUsd);
                        }

                        totalLpValueUsd += positionUsd;

                        if (isPositionInRange) {
                            inRangeValueUsd += positionUsd;
                            inRangePositions++;
                        }

                        console.log(`   ✅ Staked position #${tokenId}: $${positionUsd.toFixed(2)} ${isPositionInRange ? '(in range)' : '(out of range)'}`);
                    } catch (err) {
                        // Position might have been burned or error
                        console.log(`   ⏭️ Token #${tokenId}: ${err.message || 'unknown error'}`);
                    }
                }
            }
        } catch (err) {
            console.error('Error checking farming center:', err.message);
        }

        // Multiplier is based on IN-RANGE positions only
        const multiplier = calculateLpMultiplier(inRangeValueUsd);
        const isInRange = inRangePositions > 0;

        console.log(`✅ LP result: $${inRangeValueUsd.toFixed(2)} in-range (of $${totalLpValueUsd.toFixed(2)} total), ${inRangePositions}/${positionsFound} positions in range, ${multiplier}x multiplier`);

        return {
            lpValueUsd: inRangeValueUsd,
            totalLpValueUsd: totalLpValueUsd,
            lpMultiplier: multiplier,
            positionsFound,
            inRangePositions,
            isInRange,
            amyPriceUsd
        };
    } catch (error) {
        console.error(`❌ Error querying LP positions for ${walletAddress}:`, error.message);
        return {
            lpValueUsd: 0,
            totalLpValueUsd: 0,
            lpMultiplier: 1,
            positionsFound: 0,
            inRangePositions: 0,
            isInRange: false,
            amyPriceUsd: 0
        };
    }
}

// Update LP data for all eligible users
async function updateAllLpPositions() {
    if (!pointsDb) {
        console.log('⏭️ Skipping LP update - points system not available');
        return;
    }

    console.log('🔄 Starting LP positions update...');

    try {
        const eligibleUsers = await pointsDb.getAllEligible();
        console.log(`📊 Checking LP for ${eligibleUsers.length} eligible users`);

        let updated = 0;
        let withLp = 0;

        for (const user of eligibleUsers) {
            const lpData = await queryLpPositions(user.wallet);

            // Update database with LP data
            await pointsDb.updateLpData(user.wallet, lpData.lpValueUsd, lpData.lpMultiplier);

            updated++;
            if (lpData.lpMultiplier > 1) {
                withLp++;
            }

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        console.log(`✅ LP update complete: ${updated} users checked, ${withLp} have active LP multipliers`);

    } catch (error) {
        console.error('❌ Error updating LP positions:', error);
    }
}

// Fetch AMY balance for a wallet
async function fetchAmyBalance(walletAddress) {
    try {
        const provider = new ethers.providers.JsonRpcProvider('https://rpc.berachain.com');
        const tokenContract = new ethers.Contract(AMY_TOKEN_ADDRESS, ERC20_ABI, provider);
        const balance = await tokenContract.balanceOf(walletAddress);
        return parseFloat(ethers.utils.formatUnits(balance, 18));
    } catch (error) {
        console.error(`Failed to fetch balance for ${walletAddress}:`, error.message);
        return null;
    }
}

// Update all referral balances periodically
async function updateAllReferralBalances() {
    if (!referralsDb) {
        console.log('⏭️ Skipping balance update - referral system not available');
        return;
    }

    console.log('🔄 Starting periodic referral balance update...');

    try {
        const allReferrals = await referralsDb.getAll();
        console.log(`📊 Found ${allReferrals.length} referral entries to update`);

        const updates = [];
        let updated = 0;
        let failed = 0;

        // Process in batches to avoid rate limiting
        for (const entry of allReferrals) {
            const balance = await fetchAmyBalance(entry.wallet);
            if (balance !== null) {
                updates.push({ wallet: entry.wallet, balance, xUsername: entry.xUsername });
                updated++;
            } else {
                failed++;
            }

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Batch update all balances
        if (updates.length > 0) {
            await referralsDb.batchUpdateBalances(updates);

            // Also update holders table
            if (holdersDb) {
                await holdersDb.batchUpdateBalances(updates);
                console.log(`💎 Holders table also updated`);
            }
        }

        console.log(`✅ Balance update complete: ${updated} updated, ${failed} failed`);

    } catch (error) {
        console.error('❌ Error updating referral balances:', error);
    }
}

// Award hourly points to all eligible users
async function awardHourlyPoints() {
    if (!pointsDb) {
        console.log('⏭️ Skipping hourly points - points system not available');
        return;
    }

    console.log('🎯 Starting hourly points distribution...');

    try {
        // First, update all balances to ensure tiers are current
        const allReferrals = referralsDb ? await referralsDb.getAll() : [];

        // Update points table with current balances
        for (const entry of allReferrals) {
            const balance = await fetchAmyBalance(entry.wallet);
            if (balance !== null) {
                await pointsDb.updateBalance(entry.wallet, balance, entry.xUsername);
            }
            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        // Update LP positions for all users (check their LP and update multipliers)
        await updateAllLpPositions();

        // Get all eligible users (those with a tier that earns points)
        const eligibleUsers = await pointsDb.getAllEligible();
        console.log(`📊 Found ${eligibleUsers.length} users eligible for points`);

        let awarded = 0;
        let totalPointsAwarded = 0;
        let lpBonusUsers = 0;

        for (const user of eligibleUsers) {
            if (user.pointsPerHour > 0) {
                // Apply LP multiplier to base points
                const basePoints = parseFloat(user.pointsPerHour);
                const lpMultiplier = parseInt(user.lpMultiplier) || 1;
                const finalPoints = basePoints * lpMultiplier;

                const reason = lpMultiplier > 1
                    ? `hourly_earning_lp_${lpMultiplier}x`
                    : 'hourly_earning';

                const result = await pointsDb.awardPoints(
                    user.wallet,
                    finalPoints,
                    reason,
                    parseFloat(user.lastAmyBalance),
                    user.currentTier
                );

                if (result && result.success) {
                    awarded++;
                    totalPointsAwarded += finalPoints;
                    if (lpMultiplier > 1) {
                        lpBonusUsers++;
                    }
                }
            }
        }

        console.log(`✅ Hourly points distributed: ${awarded} users, ${totalPointsAwarded.toFixed(2)} total points, ${lpBonusUsers} with LP bonus`);

    } catch (error) {
        console.error('❌ Error awarding hourly points:', error);
    }
}

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

    // Run referral balance update every 30 minutes
    setInterval(async () => {
        try {
            await updateAllReferralBalances();
        } catch (err) {
            console.error('Periodic balance update error:', err);
        }
    }, 30 * 60 * 1000); // Run every 30 minutes

    // Run hourly points distribution every hour
    setInterval(async () => {
        try {
            await awardHourlyPoints();
        } catch (err) {
            console.error('Hourly points error:', err);
        }
    }, 60 * 60 * 1000); // Run every hour

    // Run initial balance update after 1 minute (give time for DB to initialize)
    setTimeout(async () => {
        try {
            await updateAllReferralBalances();
        } catch (err) {
            console.error('Initial balance update error:', err);
        }
    }, 60 * 1000); // Run 1 minute after startup

    // Run initial points distribution after 2 minutes
    setTimeout(async () => {
        try {
            await awardHourlyPoints();
        } catch (err) {
            console.error('Initial points distribution error:', err);
        }
    }, 2 * 60 * 1000); // Run 2 minutes after startup
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('👋 SIGTERM received, shutting down gracefully...');
    process.exit(0);
});
