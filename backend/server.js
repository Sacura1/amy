const express = require('express');
const session = require('express-session');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const ethers = require('ethers');
const multer = require('multer');
const sgMail = require('@sendgrid/mail');
require('dotenv').config();

// Configure SendGrid
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    console.log('📧 SendGrid configured');
} else {
    console.log('⚠️ SendGrid API key not configured - email verification will not work');
}

// Configure multer for avatar uploads
const UPLOADS_DIR = path.join(__dirname, 'uploads', 'avatars');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        // Generate unique filename: wallet_timestamp.ext
        const wallet = req.body.wallet || req.params.wallet || 'unknown';
        const ext = path.extname(file.originalname).toLowerCase();
        const filename = `${wallet.toLowerCase()}_${Date.now()}${ext}`;
        cb(null, filename);
    }
});

const avatarUpload = multer({
    storage: avatarStorage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB max
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
        }
    }
});

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
        return users.find(u => u.xUsername && u.xUsername.toLowerCase() === username.toLowerCase());
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

// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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
    // Check header first (preferred), then query params, then body.adminWallet (avoid conflict with body.wallet which may be target user)
    const wallet = req.headers['x-wallet-address'] || req.query.wallet || req.body.adminWallet;

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
// DISCORD OAUTH ROUTES
// ============================================

// Route: Initiate Discord OAuth flow
app.get('/auth/discord', (req, res) => {
    const wallet = req.query.wallet;

    if (!wallet) {
        return res.status(400).send('Wallet address required. Use: /auth/discord?wallet=0x...');
    }

    const state = crypto.randomBytes(16).toString('hex');

    // Store in session
    req.session.discordState = state;
    req.session.wallet = wallet;

    console.log('🔐 Starting Discord OAuth flow');
    console.log('Session ID:', req.sessionID);
    console.log('State generated:', state);
    console.log('Wallet:', wallet);

    const authUrl = `https://discord.com/api/oauth2/authorize?` +
        `client_id=${process.env.DISCORD_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(process.env.DISCORD_CALLBACK_URL)}` +
        `&response_type=code` +
        `&scope=identify` +
        `&state=${state}`;

    res.redirect(authUrl);
});

// Route: Discord OAuth callback
app.get('/auth/discord/callback', async (req, res) => {
    const { code, state } = req.query;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    console.log('📥 Discord OAuth callback received');
    console.log('State from query:', state);
    console.log('State from session:', req.session.discordState);

    // Check if session exists
    if (!req.session || !req.session.discordState) {
        console.error('❌ Session lost - no discordState in session');
        return res.redirect(`${frontendUrl}/app/profile?error=session_lost&provider=discord`);
    }

    // Verify state (CSRF protection)
    if (state !== req.session.discordState) {
        console.error('❌ State mismatch');
        return res.redirect(`${frontendUrl}/app/profile?error=state_mismatch&provider=discord`);
    }

    try {
        console.log('🔄 Exchanging Discord code for token...');

        // Exchange code for access token
        const tokenResponse = await axios.post(
            'https://discord.com/api/oauth2/token',
            new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: process.env.DISCORD_CALLBACK_URL
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const accessToken = tokenResponse.data.access_token;

        // Get user profile from Discord
        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });

        const discordUser = userResponse.data;
        console.log('✅ Discord user fetched:', discordUser.username);

        // Save Discord username to database
        const wallet = req.session.wallet;
        if (wallet) {
            await database.social.updateConnections(wallet, {
                discord: discordUser.username
            });
            console.log('✅ Discord username saved to database for wallet:', wallet);
        }

        // Redirect back to profile page with success
        res.redirect(`${frontendUrl}/app/profile?discord_connected=true&discord_username=${encodeURIComponent(discordUser.username)}&wallet=${wallet}`);

    } catch (error) {
        console.error('❌ Discord OAuth error:', error.response?.data || error.message);
        const errorMsg = error.response?.data?.error_description || error.message || 'OAuth failed';
        res.redirect(`${frontendUrl}/app/profile?error=discord_oauth_failed&details=${encodeURIComponent(errorMsg)}`);
    }
});

// ============================================
// TELEGRAM AUTH ROUTES
// ============================================

// Route: Initiate Telegram auth (redirect to Telegram login widget page)
app.get('/auth/telegram', (req, res) => {
    const wallet = req.query.wallet;

    if (!wallet) {
        return res.status(400).send('Wallet address required. Use: /auth/telegram?wallet=0x...');
    }

    // Store wallet in session for callback
    req.session.wallet = wallet;
    req.session.telegramAuthPending = true;

    console.log('🔐 Starting Telegram auth flow');
    console.log('Wallet:', wallet);

    // Redirect to a page that shows the Telegram login widget
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/app/profile?telegram_auth=pending&wallet=${wallet}`);
});

// Route: Telegram auth callback (receives data from Telegram Login Widget)
app.post('/auth/telegram/callback', async (req, res) => {
    const { id, first_name, last_name, username, photo_url, auth_date, hash, wallet } = req.body;

    console.log('📥 Telegram auth callback received');
    console.log('Telegram user:', { id, username, first_name });

    if (!wallet || !id || !hash) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    try {
        // Verify the Telegram auth data
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) {
            return res.status(500).json({ success: false, error: 'Telegram bot not configured' });
        }

        // Create the data-check-string
        const dataCheckArr = [];
        if (auth_date) dataCheckArr.push(`auth_date=${auth_date}`);
        if (first_name) dataCheckArr.push(`first_name=${first_name}`);
        if (id) dataCheckArr.push(`id=${id}`);
        if (last_name) dataCheckArr.push(`last_name=${last_name}`);
        if (photo_url) dataCheckArr.push(`photo_url=${photo_url}`);
        if (username) dataCheckArr.push(`username=${username}`);
        dataCheckArr.sort();
        const dataCheckString = dataCheckArr.join('\n');

        // Create secret key from bot token
        const secretKey = crypto.createHash('sha256').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        if (calculatedHash !== hash) {
            console.error('❌ Telegram hash verification failed');
            return res.status(401).json({ success: false, error: 'Invalid Telegram auth data' });
        }

        // Check auth_date is not too old (within 1 day)
        const authTime = parseInt(auth_date);
        const now = Math.floor(Date.now() / 1000);
        if (now - authTime > 86400) {
            return res.status(401).json({ success: false, error: 'Telegram auth expired' });
        }

        // Save Telegram username to database
        const telegramUsername = username || first_name || id.toString();
        await database.social.updateConnections(wallet, {
            telegram: telegramUsername
        });
        console.log('✅ Telegram username saved to database for wallet:', wallet);

        res.json({
            success: true,
            data: {
                username: telegramUsername,
                id: id
            }
        });

    } catch (error) {
        console.error('❌ Telegram auth error:', error.message);
        res.status(500).json({ success: false, error: 'Telegram auth failed' });
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
            user = users.find(u => u.xUsername && u.xUsername.toLowerCase() === username);
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
app.get('/api/points/:wallet', async (req, res, next) => {
    try {
        const wallet = req.params.wallet;

        if (!wallet) {
            return res.status(400).json({ success: false, error: 'Wallet address required' });
        }

        // Skip reserved paths - let more specific routes handle them
        if (['leaderboard', 'tiers', 'update-balance', 'history', 'add-bonus'].includes(wallet.toLowerCase())) {
            return next('route');
        }

        // Validate it's a proper Ethereum address
        if (!ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
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
                    lastAmyBalance: 0,
                    totalMultiplier: 1,
                    lpMultiplier: 1,
                    sailrMultiplier: 1,
                    plvhedgeMultiplier: 1
                }
            });
        }

        // Calculate total multiplier from all sources
        let sailrMult = 1;
        let plvhedgeMult = 1;
        let plsberaMult = 1;
        try {
            const tokenHoldings = await queryAllTokenHoldings(wallet);
            sailrMult = tokenHoldings.sailr.multiplier > 1 ? tokenHoldings.sailr.multiplier : 1;
            plvhedgeMult = tokenHoldings.plvhedge.multiplier > 1 ? tokenHoldings.plvhedge.multiplier : 1;
            plsberaMult = tokenHoldings.plsbera.multiplier > 1 ? tokenHoldings.plsbera.multiplier : 1;
        } catch (err) {
            console.error('Error fetching token holdings for multiplier:', err.message);
        }

        // Fetch RaidShark, Onchain Conviction, and Swapper multipliers from database
        let raidsharkMult = 0;
        let onchainConvictionMult = 0;
        let swapperMult = 0;
        try {
            const badgeMultipliers = await database.points.getMultiplierBadges(wallet);
            raidsharkMult = badgeMultipliers.raidsharkMultiplier > 0 ? badgeMultipliers.raidsharkMultiplier : 0;
            onchainConvictionMult = badgeMultipliers.onchainConvictionMultiplier > 0 ? badgeMultipliers.onchainConvictionMultiplier : 0;
            swapperMult = badgeMultipliers.swapperMultiplier > 0 ? badgeMultipliers.swapperMultiplier : 0;
        } catch (err) {
            console.error('Error fetching badge multipliers:', err.message);
        }

        // Fetch referral multiplier (1 ref = x3, 2 refs = x5, 3+ refs = x10)
        let referralMult = 0;
        try {
            if (referralsDb) {
                const referralEntry = await referralsDb.getByWallet(wallet);
                if (referralEntry && referralEntry.referralCode) {
                    const validReferralCount = await referralsDb.getValidReferralCount(referralEntry.referralCode);
                    if (validReferralCount >= 3) referralMult = 10;
                    else if (validReferralCount >= 2) referralMult = 5;
                    else if (validReferralCount >= 1) referralMult = 3;
                }
            }
        } catch (err) {
            console.error('Error fetching referral multiplier:', err.message);
        }

        const lpMult = parseInt(pointsData.lpMultiplier) > 1 ? parseInt(pointsData.lpMultiplier) : 0;
        // Total multiplier: sum of active multipliers (same as cron job)
        const totalMultiplier = Math.max(1, lpMult + (sailrMult > 1 ? sailrMult : 0) + (plvhedgeMult > 1 ? plvhedgeMult : 0) + (plsberaMult > 1 ? plsberaMult : 0) + raidsharkMult + onchainConvictionMult + referralMult + swapperMult);

        // Calculate effective points per hour (base * multiplier)
        const basePointsPerHour = parseFloat(pointsData.pointsPerHour) || 0;
        const effectivePointsPerHour = basePointsPerHour * totalMultiplier;

        res.json({
            success: true,
            data: {
                ...pointsData,
                tierInfo: POINTS_TIERS[pointsData.currentTier] || POINTS_TIERS['none'],
                totalMultiplier: totalMultiplier,
                effectivePointsPerHour: effectivePointsPerHour,
                sailrMultiplier: sailrMult > 1 ? sailrMult : 0,
                plvhedgeMultiplier: plvhedgeMult > 1 ? plvhedgeMult : 0,
                plsberaMultiplier: plsberaMult > 1 ? plsberaMult : 0,
                raidsharkMultiplier: raidsharkMult > 0 ? raidsharkMult : 0,
                onchainConvictionMultiplier: onchainConvictionMult > 0 ? onchainConvictionMult : 0,
                referralMultiplier: referralMult > 0 ? referralMult : 0,
                swapperMultiplier: swapperMult > 0 ? swapperMult : 0
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

        // Also update holders table for check-in eligibility
        if (holdersDb) {
            try {
                // Get existing holder to preserve xUsername if not provided
                const existingHolder = await holdersDb.getByWallet(wallet);
                const holderUsername = xUsername || existingHolder?.xUsername || null;
                await holdersDb.addOrUpdate(wallet, holderUsername, parseFloat(amyBalance));
            } catch (holderErr) {
                console.error('Error updating holder status:', holderErr);
                // Don't fail the request if holder update fails
            }
        }

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



// Add bonus points to user (admin only - for giveaways)
app.post('/api/points/add-bonus', isAdmin, async (req, res) => {
    try {
        const { xUsername, points, reason } = req.body;

        if (!xUsername || points === undefined) {
            return res.status(400).json({
                success: false,
                error: 'xUsername and points are required'
            });
        }

        if (!pointsDb) {
            return res.status(500).json({
                success: false,
                error: 'Points system not available'
            });
        }

        const result = await pointsDb.addBonusByUsername(
            xUsername,
            parseFloat(points),
            reason || 'admin_bonus'
        );

        if (!result.success) {
            return res.status(400).json(result);
        }

        console.log(`🎁 Bonus points awarded: ${points} to @${result.xUsername} by admin`);

        res.json({
            success: true,
            message: `Added ${points} points to @${result.xUsername}`,
            data: result
        });

    } catch (error) {
        console.error('❌ Error adding bonus points:', error);
        res.status(500).json({ success: false, error: 'Failed to add bonus points' });
    }
});

// Bulk add bonus points (admin only - for giveaways)
app.post('/api/points/add-bonus/bulk', isAdmin, async (req, res) => {
    try {
        const { awards, reason } = req.body;

        if (!Array.isArray(awards) || awards.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'awards array is required with {xUsername, points} entries'
            });
        }

        if (!pointsDb) {
            return res.status(500).json({
                success: false,
                error: 'Points system not available'
            });
        }

        const results = [];
        let successCount = 0;
        let failCount = 0;

        for (const award of awards) {
            if (!award.xUsername || award.points === undefined) {
                results.push({ xUsername: award.xUsername, success: false, error: 'Missing xUsername or points' });
                failCount++;
                continue;
            }

            const result = await pointsDb.addBonusByUsername(
                award.xUsername,
                parseFloat(award.points),
                reason || 'admin_bonus_bulk'
            );

            results.push(result);
            if (result.success) {
                successCount++;
                console.log(`🎁 Bulk bonus: ${award.points} to @${result.xUsername}`);
            } else {
                failCount++;
            }
        }

        console.log(`✅ Bulk bonus complete: ${successCount} success, ${failCount} failed`);

        res.json({
            success: true,
            message: `Processed ${awards.length} awards: ${successCount} success, ${failCount} failed`,
            results
        });

    } catch (error) {
        console.error('❌ Error in bulk bonus:', error);
        res.status(500).json({ success: false, error: 'Failed to process bulk bonus' });
    }
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

// Cache for LP positions (refresh every 6 hours to reduce blockchain queries)
const lpPositionCache = new Map();
const LP_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// Get LP status for a wallet (public)
app.get('/api/lp/:wallet', async (req, res) => {
    try {
        const wallet = req.params.wallet;

        if (!wallet) {
            return res.status(400).json({ success: false, error: 'Wallet address required' });
        }

        const walletLower = wallet.toLowerCase();
        const now = Date.now();

        // Check cache first
        const cached = lpPositionCache.get(walletLower);
        if (cached && (now - cached.timestamp) < LP_CACHE_TTL) {
            return res.json({
                success: true,
                data: {
                    ...cached.data,
                    cached: true,
                    cacheAge: Math.round((now - cached.timestamp) / 1000 / 60), // minutes
                    tiers: LP_MULTIPLIER_TIERS
                }
            });
        }

        // Query LP position from blockchain
        const lpData = await queryLpPositions(wallet);

        // Cache the result
        const responseData = {
            wallet: walletLower,
            lpValueUsd: lpData.lpValueUsd,
            totalLpValueUsd: lpData.totalLpValueUsd,
            lpMultiplier: lpData.lpMultiplier,
            positionsFound: lpData.positionsFound,
            inRangePositions: lpData.inRangePositions,
            isInRange: lpData.isInRange,
            amyPriceUsd: lpData.amyPriceUsd,
        };
        lpPositionCache.set(walletLower, { data: responseData, timestamp: now });

        // Update database with fresh LP data if points system is available
        if (pointsDb) {
            await pointsDb.updateLpData(wallet, lpData.lpValueUsd, lpData.lpMultiplier);
        }

        res.json({
            success: true,
            data: {
                ...responseData,
                cached: false,
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
// TOKEN HOLDINGS TRACKING (SAIL.r, plvHEDGE)
// ============================================

// Token addresses for multiplier badges
const BADGE_TOKENS = {
    SAILR: {
        address: '0x59a61B8d3064A51a95a5D6393c03e2152b1a2770',
        symbol: 'SAIL.r',
        decimals: 18,
        geckoId: 'berachain_0x59a61b8d3064a51a95a5d6393c03e2152b1a2770'
    },
    PLVHEDGE: {
        address: '0x28602B1ae8cA0ff5CD01B96A36f88F72FeBE727A',
        symbol: 'plvHEDGE',
        decimals: 18,
        geckoId: 'berachain_0x28602b1ae8ca0ff5cd01b96a36f88f72febe727a'
    },
    PLSBERA: {
        address: '0xe8bEB147a93BB757DB15e468FaBD119CA087EfAE', // staking contract (balanceOf)
        tokenAddress: '0xc66D1a2460De7b96631f4AC37ce906aCFa6A3c30', // plsBERA token
        symbol: 'plsBERA',
        decimals: 18,
        geckoPoolAddress: '0x225915329b032b3385ac28b0dc53d989e8446fd1' // GeckoTerminal plsBERA/WBERA pool
    }
};

// Token holdings multiplier tiers (same for both tokens)
const TOKEN_MULTIPLIER_TIERS = [
    { minUsd: 500, multiplier: 10 },
    { minUsd: 100, multiplier: 5 },
    { minUsd: 10, multiplier: 3 },
    { minUsd: 0, multiplier: 1 }
];

// Cache for token prices (refresh every 5 minutes)
let tokenPriceCache = {
    sailr: { price: 0, timestamp: 0 },
    plvhedge: { price: 0, timestamp: 0 },
    plsbera: { price: 0, timestamp: 0 }
};
const PRICE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Fetch token price from GeckoTerminal
async function fetchTokenPrice(tokenKey) {
    const token = BADGE_TOKENS[tokenKey];
    const cacheKey = tokenKey.toLowerCase();
    const now = Date.now();

    // Return cached price if still valid
    if (tokenPriceCache[cacheKey] && (now - tokenPriceCache[cacheKey].timestamp) < PRICE_CACHE_TTL) {
        return tokenPriceCache[cacheKey].price;
    }

    try {
        let price = 0;

        // For plsBERA, use pool API to get price
        if (token.geckoPoolAddress) {
            const response = await fetch(
                `https://api.geckoterminal.com/api/v2/networks/berachain/pools/${token.geckoPoolAddress}`,
                { headers: { 'Accept': 'application/json' } }
            );
            if (response.ok) {
                const data = await response.json();
                // Get base token price (plsBERA is the base token in plsBERA/WBERA pool)
                price = parseFloat(data?.data?.attributes?.base_token_price_usd || 0);
            }
        } else {
            // Standard token price lookup
            const response = await fetch(
                `https://api.geckoterminal.com/api/v2/simple/networks/berachain/token_price/${token.address.toLowerCase()}`,
                { headers: { 'Accept': 'application/json' } }
            );

            if (response.ok) {
                const data = await response.json();
                price = parseFloat(data?.data?.attributes?.token_prices?.[token.address.toLowerCase()] || 0);
            }
        }

        if (price > 0) {
            tokenPriceCache[cacheKey] = { price, timestamp: now };
            console.log(`💰 ${token.symbol} price: ${price.toFixed(6)}`);
            return price;
        }

        // Fallback: return cached price even if expired, or 0
        return tokenPriceCache[cacheKey]?.price || 0;
    } catch (error) {
        console.error(`❌ Error fetching ${token.symbol} price:`, error.message);
        return tokenPriceCache[cacheKey]?.price || 0;
    }
}

// Get multiplier for a given USD value
function getTokenMultiplier(usdValue) {
    for (const tier of TOKEN_MULTIPLIER_TIERS) {
        if (usdValue >= tier.minUsd) {
            return tier.multiplier;
        }
    }
    return 1;
}

// Query token balance for a wallet
async function queryTokenBalance(wallet, tokenKey) {
    const token = BADGE_TOKENS[tokenKey];

    try {
        const { ethers } = require('ethers');
        const provider = new ethers.providers.JsonRpcProvider('https://rpc.berachain.com');
        const contract = new ethers.Contract(token.address, ERC20_ABI, provider);

        const balance = await contract.balanceOf(wallet);
        const balanceFormatted = parseFloat(ethers.utils.formatUnits(balance, token.decimals));

        // Get price and calculate USD value
        const price = await fetchTokenPrice(tokenKey);
        const usdValue = balanceFormatted * price;
        const multiplier = getTokenMultiplier(usdValue);

        return {
            token: token.symbol,
            address: token.address,
            balance: balanceFormatted,
            priceUsd: price,
            valueUsd: usdValue,
            multiplier: multiplier,
            isActive: multiplier > 1
        };
    } catch (error) {
        console.error(`❌ Error querying ${token.symbol} balance:`, error.message);
        return {
            token: token.symbol,
            address: token.address,
            balance: 0,
            priceUsd: 0,
            valueUsd: 0,
            multiplier: 1,
            isActive: false
        };
    }
}

// Query all badge token holdings for a wallet
async function queryAllTokenHoldings(wallet) {
    const [sailr, plvhedge, plsbera] = await Promise.all([
        queryTokenBalance(wallet, 'SAILR'),
        queryTokenBalance(wallet, 'PLVHEDGE'),
        queryTokenBalance(wallet, 'PLSBERA')
    ]);

    return {
        sailr,
        plvhedge,
        plsbera,
        tiers: TOKEN_MULTIPLIER_TIERS
    };
}

// API endpoint: Get token holdings for badges
app.get('/api/tokens/:wallet', async (req, res) => {
    try {
        const wallet = req.params.wallet;

        if (!wallet) {
            return res.status(400).json({ success: false, error: 'Wallet address required' });
        }

        const holdings = await queryAllTokenHoldings(wallet);

        // Save token values to database for badge system
        try {
            if (pointsDb) {
                await pointsDb.updateTokenData(
                    wallet,
                    holdings.sailr.valueUsd || 0,
                    holdings.sailr.multiplier || 1,
                    holdings.plvhedge.valueUsd || 0,
                    holdings.plvhedge.multiplier || 1,
                    holdings.plsbera.valueUsd || 0,
                    holdings.plsbera.multiplier || 1
                );
            }
        } catch (err) {
            console.error('Error saving token data:', err.message);
        }

        res.json({
            success: true,
            data: {
                wallet: wallet.toLowerCase(),
                ...holdings
            }
        });

    } catch (error) {
        console.error('❌ Error fetching token holdings:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch token holdings' });
    }
});

// API endpoint: Get token multiplier tiers
app.get('/api/tokens/tiers', (req, res) => {
    res.json({
        success: true,
        data: {
            tiers: TOKEN_MULTIPLIER_TIERS,
            tokens: Object.entries(BADGE_TOKENS).map(([key, token]) => ({
                key: key.toLowerCase(),
                symbol: token.symbol,
                address: token.address
            }))
        }
    });
});

// ============================================
// PROFILE ENDPOINTS
// ============================================

// Get user profile
app.get('/api/profile/:wallet', async (req, res) => {
    try {
        const { wallet } = req.params;

        if (!ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        const profilesDb = database.profiles;
        if (!profilesDb) {
            return res.status(500).json({ success: false, error: 'Profiles not available' });
        }

        const profile = await profilesDb.getOrCreate(wallet);
        const equippedBadges = await database.badges.getEquipped(wallet);
        const earnedBadges = await database.badges.getEarned(wallet);
        const socialConnections = await database.social.getConnections(wallet);

        res.json({
            success: true,
            data: {
                profile,
                badges: {
                    equipped: equippedBadges,
                    earned: earnedBadges
                },
                social: socialConnections
            }
        });
    } catch (error) {
        console.error('❌ Error getting profile:', error);
        res.status(500).json({ success: false, error: 'Failed to get profile' });
    }
});

// Update user profile (bio, display name)
app.post('/api/profile/update', async (req, res) => {
    try {
        const { wallet, displayName, bio } = req.body;

        if (!wallet || !ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        // Validate bio length
        if (bio && bio.length > 140) {
            return res.status(400).json({ success: false, error: 'Bio must be 140 characters or less' });
        }

        // Validate display name length
        if (displayName && displayName.length > 50) {
            return res.status(400).json({ success: false, error: 'Display name must be 50 characters or less' });
        }

        const profile = await database.profiles.update(wallet, { displayName, bio });

        res.json({
            success: true,
            data: profile
        });
    } catch (error) {
        console.error('❌ Error updating profile:', error);
        res.status(500).json({ success: false, error: 'Failed to update profile' });
    }
});

// Upload avatar image
app.post('/api/profile/avatar/upload', avatarUpload.single('avatar'), async (req, res) => {
    try {
        const { wallet } = req.body;

        if (!wallet || !ethers.utils.isAddress(wallet)) {
            // Delete uploaded file if wallet is invalid
            if (req.file) {
                fs.unlinkSync(req.file.path);
            }
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }

        // Read the file and convert to base64
        const fileBuffer = fs.readFileSync(req.file.path);
        const base64Data = `data:${req.file.mimetype};base64,${fileBuffer.toString('base64')}`;

        // Delete the temporary file immediately
        try {
            fs.unlinkSync(req.file.path);
        } catch (err) {
            console.error('Error deleting temp file:', err);
        }

        // Update profile with base64 avatar data (stored in PostgreSQL)
        const profile = await database.profiles.updateAvatar(wallet, null, base64Data);

        res.json({
            success: true,
            data: {
                avatarUrl: null,
                avatarData: base64Data,
                profile: profile
            }
        });
    } catch (error) {
        console.error('❌ Error uploading avatar:', error);
        // Clean up file if error occurred
        if (req.file) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (err) {
                console.error('Error cleaning up file:', err);
            }
        }
        res.status(500).json({ success: false, error: 'Failed to upload avatar' });
    }
});

// Error handler for multer
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ success: false, error: 'File too large. Maximum size is 5MB.' });
        }
        return res.status(400).json({ success: false, error: error.message });
    }
    if (error.message === 'Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.') {
        return res.status(400).json({ success: false, error: error.message });
    }
    next(error);
});

// ============================================
// BADGE ENDPOINTS
// ============================================

// Get all badge definitions
app.get('/api/badges/available', (req, res) => {
    res.json({
        success: true,
        data: database.BADGE_DEFINITIONS
    });
});

// Get user's badges (earned and equipped)
app.get('/api/badges/:wallet', async (req, res) => {
    try {
        const { wallet } = req.params;

        if (!ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        const equipped = await database.badges.getEquipped(wallet);
        const earned = await database.badges.getEarned(wallet);

        res.json({
            success: true,
            data: {
                equipped,
                earned,
                definitions: database.BADGE_DEFINITIONS
            }
        });
    } catch (error) {
        console.error('❌ Error getting badges:', error);
        res.status(500).json({ success: false, error: 'Failed to get badges' });
    }
});

// Equip a badge to a slot
app.post('/api/badges/:wallet/equip', async (req, res) => {
    try {
        const { wallet } = req.params;
        const { slotNumber, badgeId } = req.body;

        if (!ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        if (!slotNumber || slotNumber < 1 || slotNumber > 5) {
            return res.status(400).json({ success: false, error: 'Slot number must be between 1 and 5' });
        }

        if (!badgeId) {
            return res.status(400).json({ success: false, error: 'Badge ID is required' });
        }

        // Verify user has earned this badge
        const earned = await database.badges.getEarned(wallet);
        const hasEarned = earned.some(b => b.id === badgeId);
        if (!hasEarned) {
            return res.status(400).json({ success: false, error: 'You have not earned this badge' });
        }

        const result = await database.badges.equip(wallet, slotNumber, badgeId);
        const equipped = await database.badges.getEquipped(wallet);

        res.json({
            success: true,
            data: equipped
        });
    } catch (error) {
        console.error('❌ Error equipping badge:', error);
        res.status(500).json({ success: false, error: 'Failed to equip badge' });
    }
});

// Unequip a badge from a slot
app.post('/api/badges/:wallet/unequip', async (req, res) => {
    try {
        const { wallet } = req.params;
        const { slotNumber } = req.body;

        if (!ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        if (!slotNumber || slotNumber < 1 || slotNumber > 5) {
            return res.status(400).json({ success: false, error: 'Slot number must be between 1 and 5' });
        }

        await database.badges.unequip(wallet, slotNumber);
        const equipped = await database.badges.getEquipped(wallet);

        res.json({
            success: true,
            data: equipped
        });
    } catch (error) {
        console.error('❌ Error unequipping badge:', error);
        res.status(500).json({ success: false, error: 'Failed to unequip badge' });
    }
});

// ============================================
// CUSTOMIZATION ENDPOINTS
// ============================================

// Get all customization items
app.get('/api/customization/items', async (req, res) => {
    try {
        const { type } = req.query;
        const items = await database.customization.getItems(type || null);

        res.json({
            success: true,
            data: items
        });
    } catch (error) {
        console.error('❌ Error getting customization items:', error);
        res.status(500).json({ success: false, error: 'Failed to get items' });
    }
});

// Get user's owned items
app.get('/api/customization/:wallet/owned', async (req, res) => {
    try {
        const { wallet } = req.params;

        if (!ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        const owned = await database.customization.getPurchased(wallet);

        res.json({
            success: true,
            data: owned
        });
    } catch (error) {
        console.error('❌ Error getting owned items:', error);
        res.status(500).json({ success: false, error: 'Failed to get owned items' });
    }
});

// Purchase a customization item
app.post('/api/customization/purchase', async (req, res) => {
    try {
        const { wallet, itemId } = req.body;

        if (!wallet || !ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        if (!itemId) {
            return res.status(400).json({ success: false, error: 'Item ID is required' });
        }

        const result = await database.customization.purchase(wallet, itemId);

        if (!result.success) {
            return res.status(400).json(result);
        }

        res.json(result);
    } catch (error) {
        console.error('❌ Error purchasing item:', error);
        res.status(500).json({ success: false, error: 'Failed to purchase item' });
    }
});

// Apply a customization (background, filter, animation)
app.post('/api/customization/:wallet/apply', async (req, res) => {
    try {
        const { wallet } = req.params;
        const { type, itemId } = req.body;

        if (!ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        if (!type || !['background', 'filter', 'animation'].includes(type)) {
            return res.status(400).json({ success: false, error: 'Type must be background, filter, or animation' });
        }

        if (!itemId) {
            return res.status(400).json({ success: false, error: 'Item ID is required' });
        }

        // Check if user owns the item (or it's default)
        const item = await database.customization.getById(itemId);
        if (!item) {
            return res.status(404).json({ success: false, error: 'Item not found' });
        }

        if (!item.isDefault) {
            const owns = await database.customization.ownsItem(wallet, itemId);
            if (!owns) {
                return res.status(400).json({ success: false, error: 'You do not own this item' });
            }
        }

        const profile = await database.profiles.applyCustomization(wallet, type, itemId);

        res.json({
            success: true,
            data: profile
        });
    } catch (error) {
        console.error('❌ Error applying customization:', error);
        res.status(500).json({ success: false, error: 'Failed to apply customization' });
    }
});

// ============================================
// SOCIAL CONNECTION ENDPOINTS (Thirdweb)
// ============================================

// Get user's social connections
app.get('/api/social/:wallet', async (req, res) => {
    try {
        const { wallet } = req.params;

        if (!ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        const connections = await database.social.getConnections(wallet);

        res.json({
            success: true,
            data: connections
        });
    } catch (error) {
        console.error('❌ Error getting social connections:', error);
        res.status(500).json({ success: false, error: 'Failed to get social connections' });
    }
});

// Sync social connections from Thirdweb
app.post('/api/social/sync', async (req, res) => {
    try {
        const { wallet, discord, telegram, email } = req.body;

        if (!wallet || !ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        const connections = await database.social.updateConnections(wallet, {
            discord,
            telegram,
            email
        });

        res.json({
            success: true,
            data: connections
        });
    } catch (error) {
        console.error('❌ Error syncing social connections:', error);
        res.status(500).json({ success: false, error: 'Failed to sync social connections' });
    }
});

// ============================================
// EMAIL VERIFICATION (SendGrid)
// ============================================

// Send verification email
app.post('/api/email/send-verification', async (req, res) => {
    try {
        const { wallet, email } = req.body;

        if (!wallet || !ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        if (!email || !email.includes('@')) {
            return res.status(400).json({ success: false, error: 'Invalid email address' });
        }

        if (!process.env.SENDGRID_API_KEY) {
            return res.status(500).json({ success: false, error: 'Email service not configured' });
        }

        // Check if email is already linked to another wallet
        const isLinked = await database.emailVerification.isEmailLinked(email);
        if (isLinked) {
            return res.status(400).json({ success: false, error: 'This email is already linked to another wallet' });
        }

        // Create verification code
        const { code, expiresAt } = await database.emailVerification.createVerification(wallet, email);

        // Send email via SendGrid
        const msg = {
            to: email,
            from: process.env.SENDGRID_FROM_EMAIL || 'noreply@amy.money',
            subject: 'Amy Points - Email Verification Code',
            text: `Your verification code is: ${code}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this, please ignore this email.`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <h2 style="color: #ec4899;">Amy Points - Email Verification</h2>
                    <p>Your verification code is:</p>
                    <div style="background: #1f2937; color: #fbbf24; font-size: 32px; font-weight: bold; text-align: center; padding: 20px; border-radius: 10px; letter-spacing: 5px;">
                        ${code}
                    </div>
                    <p style="color: #9ca3af; margin-top: 20px;">This code expires in 10 minutes.</p>
                    <p style="color: #9ca3af;">If you didn't request this, please ignore this email.</p>
                    <hr style="border: none; border-top: 1px solid #374151; margin: 20px 0;">
                    <p style="color: #6b7280; font-size: 12px;">Amy Points - Berachain</p>
                </div>
            `
        };

        await sgMail.send(msg);
        console.log(`📧 Verification email sent to ${email} for wallet ${wallet}`);

        res.json({
            success: true,
            message: 'Verification code sent to your email',
            expiresAt
        });
    } catch (error) {
        console.error('❌ Error sending verification email:', error);
        res.status(500).json({ success: false, error: 'Failed to send verification email' });
    }
});

// Verify email code
app.post('/api/email/verify', async (req, res) => {
    try {
        const { wallet, code } = req.body;

        if (!wallet || !ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        if (!code || code.length !== 6) {
            return res.status(400).json({ success: false, error: 'Invalid verification code' });
        }

        const result = await database.emailVerification.verifyCode(wallet, code);

        if (!result.success) {
            return res.status(400).json(result);
        }

        console.log(`✅ Email verified for wallet ${wallet}: ${result.email}`);

        res.json({
            success: true,
            message: 'Email verified successfully',
            email: result.email
        });
    } catch (error) {
        console.error('❌ Error verifying email:', error);
        res.status(500).json({ success: false, error: 'Failed to verify email' });
    }
});

// ============================================
// MULTIPLIER BADGE ADMIN ENDPOINTS
// ============================================

// Get multiplier badges for a wallet
app.get('/api/badges/multipliers/:wallet', async (req, res) => {
    try {
        const { wallet } = req.params;
        if (!wallet || !ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        const badges = await database.points.getMultiplierBadges(wallet);
        res.json({ success: true, data: badges });
    } catch (error) {
        console.error('Error getting multiplier badges:', error);
        res.status(500).json({ success: false, error: 'Failed to get multiplier badges' });
    }
});

// Update RaidShark multiplier for a single user (admin only)
app.post('/api/admin/raidshark/update', isAdmin, async (req, res) => {
    try {
        const { wallet, multiplier } = req.body;

        if (!wallet || !ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        if (!multiplier || ![1, 3, 7, 15].includes(multiplier)) {
            return res.status(400).json({ success: false, error: 'Invalid multiplier. Must be 1, 3, 7, or 15' });
        }

        const result = await database.points.updateRaidsharkMultiplier(wallet, multiplier);
        console.log(`🦈 RaidShark multiplier updated: ${wallet} -> ${multiplier}x`);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Error updating RaidShark multiplier:', error);
        res.status(500).json({ success: false, error: 'Failed to update multiplier' });
    }
});

// Bulk update RaidShark multipliers (admin only) - for monthly CSV updates
app.post('/api/admin/raidshark/bulk', isAdmin, async (req, res) => {
    try {
        const { updates } = req.body;
        // updates should be array of { wallet, multiplier }

        if (!Array.isArray(updates) || updates.length === 0) {
            return res.status(400).json({ success: false, error: 'Updates array required' });
        }

        // Validate all entries
        for (const update of updates) {
            if (!update.wallet || !ethers.utils.isAddress(update.wallet)) {
                return res.status(400).json({ success: false, error: `Invalid wallet: ${update.wallet}` });
            }
            if (!update.multiplier || ![1, 3, 7, 15].includes(update.multiplier)) {
                return res.status(400).json({ success: false, error: `Invalid multiplier for ${update.wallet}` });
            }
        }

        const result = await database.points.bulkUpdateRaidshark(updates);
        console.log(`🦈 RaidShark bulk update: ${result.updated} users updated`);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Error bulk updating RaidShark:', error);
        res.status(500).json({ success: false, error: 'Failed to bulk update' });
    }
});

// Update Onchain Conviction multiplier for a single user (admin only)
app.post('/api/admin/conviction/update', isAdmin, async (req, res) => {
    try {
        const { wallet, multiplier } = req.body;

        if (!wallet || !ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        if (!multiplier || ![1, 3, 5, 10].includes(multiplier)) {
            return res.status(400).json({ success: false, error: 'Invalid multiplier. Must be 1, 3, 5, or 10' });
        }

        const result = await database.points.updateOnchainConvictionMultiplier(wallet, multiplier);
        console.log(`⛓️ Onchain Conviction multiplier updated: ${wallet} -> ${multiplier}x`);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Error updating Onchain Conviction multiplier:', error);
        res.status(500).json({ success: false, error: 'Failed to update multiplier' });
    }
});

// Bulk update Onchain Conviction multipliers (admin only)
app.post('/api/admin/conviction/bulk', isAdmin, async (req, res) => {
    try {
        const { updates } = req.body;
        // updates should be array of { wallet, multiplier }

        if (!Array.isArray(updates) || updates.length === 0) {
            return res.status(400).json({ success: false, error: 'Updates array required' });
        }

        // Validate all entries
        for (const update of updates) {
            if (!update.wallet || !ethers.utils.isAddress(update.wallet)) {
                return res.status(400).json({ success: false, error: `Invalid wallet: ${update.wallet}` });
            }
            if (!update.multiplier || ![1, 3, 5, 10].includes(update.multiplier)) {
                return res.status(400).json({ success: false, error: `Invalid multiplier for ${update.wallet}` });
            }
        }

        const result = await database.points.bulkUpdateOnchainConviction(updates);
        console.log(`⛓️ Onchain Conviction bulk update: ${result.updated} users updated`);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Error bulk updating Onchain Conviction:', error);
        res.status(500).json({ success: false, error: 'Failed to bulk update' });
    }
});

// Update RaidShark multiplier by X username (admin only) - easier than wallet lookup
app.post('/api/admin/raidshark/update-by-username', isAdmin, async (req, res) => {
    try {
        const { xUsername, multiplier } = req.body;

        if (!xUsername) {
            return res.status(400).json({ success: false, error: 'X username required' });
        }

        if (!multiplier || ![1, 3, 7, 15].includes(multiplier)) {
            return res.status(400).json({ success: false, error: 'Invalid multiplier. Must be 1, 3, 7, or 15' });
        }

        const result = await database.points.updateRaidsharkByUsername(xUsername, multiplier);
        if (!result.success) {
            return res.status(400).json(result);
        }

        console.log(`🦈 RaidShark multiplier updated: @${result.xUsername} (${result.wallet}) -> ${multiplier}x`);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Error updating RaidShark by username:', error);
        res.status(500).json({ success: false, error: 'Failed to update multiplier' });
    }
});

// Bulk update RaidShark by X usernames (admin only) - for monthly CSV updates
app.post('/api/admin/raidshark/bulk-by-username', isAdmin, async (req, res) => {
    try {
        const { updates } = req.body;
        // updates should be array of { xUsername, multiplier }

        if (!Array.isArray(updates) || updates.length === 0) {
            return res.status(400).json({ success: false, error: 'Updates array required with {xUsername, multiplier} entries' });
        }

        // Validate all entries
        for (const update of updates) {
            if (!update.xUsername) {
                return res.status(400).json({ success: false, error: 'Missing xUsername in update' });
            }
            if (!update.multiplier || ![1, 3, 7, 15].includes(update.multiplier)) {
                return res.status(400).json({ success: false, error: `Invalid multiplier for @${update.xUsername}. Must be 1, 3, 7, or 15` });
            }
        }

        const result = await database.points.bulkUpdateRaidsharkByUsername(updates);
        console.log(`🦈 RaidShark bulk update by username: ${result.updated} success, ${result.failed} failed`);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Error bulk updating RaidShark by username:', error);
        res.status(500).json({ success: false, error: 'Failed to bulk update' });
    }
});

// Get all users with RaidShark badges (admin only) - for viewing current assignments
app.get('/api/admin/raidshark/list', isAdmin, async (req, res) => {
    try {
        const result = await database.pool.query(
            `SELECT wallet, x_username as "xUsername", raidshark_multiplier as "multiplier"
             FROM amy_points
             WHERE raidshark_multiplier > 1
             ORDER BY raidshark_multiplier DESC, x_username ASC`
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Error listing RaidShark users:', error);
        res.status(500).json({ success: false, error: 'Failed to list users' });
    }
});

// Get all users with Onchain Conviction badges (admin only)
app.get('/api/admin/conviction/list', isAdmin, async (req, res) => {
    try {
        const result = await database.pool.query(
            `SELECT wallet, x_username as "xUsername", onchain_conviction_multiplier as "multiplier"
             FROM amy_points
             WHERE onchain_conviction_multiplier > 1
             ORDER BY onchain_conviction_multiplier DESC, wallet ASC`
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Error listing Onchain Conviction users:', error);
        res.status(500).json({ success: false, error: 'Failed to list users' });
    }
});

// ============================================
// SEASONED SWAPPER BADGE ENDPOINTS (Admin)
// ============================================

// Update Swapper multiplier for a single user (admin only)
app.post('/api/admin/swapper/update', isAdmin, async (req, res) => {
    try {
        const { wallet, multiplier } = req.body;

        if (!wallet || !ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        if (multiplier === undefined || ![0, 3, 5, 10].includes(multiplier)) {
            return res.status(400).json({ success: false, error: 'Invalid multiplier. Must be 0, 3, 5, or 10' });
        }

        const result = await database.points.updateSwapperMultiplier(wallet, multiplier);
        console.log(`🔄 Swapper multiplier updated: ${wallet} -> ${multiplier}x`);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Error updating Swapper multiplier:', error);
        res.status(500).json({ success: false, error: 'Failed to update multiplier' });
    }
});

// Bulk update Swapper multipliers (admin only)
app.post('/api/admin/swapper/bulk', isAdmin, async (req, res) => {
    try {
        const { updates } = req.body;
        // updates should be array of { wallet, multiplier }

        if (!Array.isArray(updates) || updates.length === 0) {
            return res.status(400).json({ success: false, error: 'Updates array required' });
        }

        // Validate all entries
        for (const update of updates) {
            if (!update.wallet || !ethers.utils.isAddress(update.wallet)) {
                return res.status(400).json({ success: false, error: `Invalid wallet: ${update.wallet}` });
            }
            if (update.multiplier === undefined || ![0, 3, 5, 10].includes(update.multiplier)) {
                return res.status(400).json({ success: false, error: `Invalid multiplier for ${update.wallet}` });
            }
        }

        const result = await database.points.batchUpdateSwapperMultipliers(updates);
        console.log(`🔄 Swapper bulk update: ${result.updated} users updated`);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Error bulk updating Swapper:', error);
        res.status(500).json({ success: false, error: 'Failed to bulk update' });
    }
});

// Get all users with Swapper badges (admin only)
app.get('/api/admin/swapper/list', isAdmin, async (req, res) => {
    try {
        const result = await database.pool.query(
            `SELECT p.wallet, v.x_username as "xUsername", p.swapper_multiplier as "multiplier"
             FROM amy_points p
             LEFT JOIN verified_users v ON LOWER(p.wallet) = LOWER(v.wallet)
             WHERE p.swapper_multiplier > 0
             ORDER BY p.swapper_multiplier DESC, p.wallet ASC`
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Error listing Swapper users:', error);
        res.status(500).json({ success: false, error: 'Failed to list users' });
    }
});

// ============================================
// DAILY CHECK-IN ENDPOINTS
// ============================================

// Get check-in status for a wallet
app.get('/api/checkin/:wallet', async (req, res) => {
    try {
        const { wallet } = req.params;

        if (!wallet || !ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        const data = await database.checkin.getData(wallet);
        res.json({ success: true, data });
    } catch (error) {
        console.error('Error getting check-in data:', error);
        res.status(500).json({ success: false, error: 'Failed to get check-in data' });
    }
});

// Perform daily check-in
app.post('/api/checkin/:wallet', async (req, res) => {
    try {
        const { wallet } = req.params;

        if (!wallet || !ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        // Check if user is a holder (300+ AMY) - check holders table first, then amy_points as fallback
        const holder = await database.holders.getByWallet(wallet);
        const holderBalance = holder ? parseFloat(holder.amy_balance || 0) : 0;

        // If not in holders table or balance too low, check amy_points table
        let isEligible = holderBalance >= 300;
        if (!isEligible && pointsDb) {
            const pointsData = await pointsDb.getByWallet(wallet);
            if (pointsData && parseFloat(pointsData.lastAmyBalance || 0) >= 300) {
                isEligible = true;
            }
        }

        if (!isEligible) {
            return res.status(403).json({
                success: false,
                error: 'Must hold 300+ AMY to check in'
            });
        }

        const result = await database.checkin.doCheckIn(wallet);

        if (!result.success) {
            return res.status(400).json(result);
        }

        res.json(result);
    } catch (error) {
        console.error('Error performing check-in:', error);
        res.status(500).json({ success: false, error: 'Failed to check in' });
    }
});

// ============================================
// QUEST ENDPOINTS
// ============================================

// Get quest status for a wallet
app.get('/api/quests/:wallet', async (req, res) => {
    try {
        const { wallet } = req.params;

        if (!wallet || !ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        const data = await database.quests.getData(wallet);
        res.json({ success: true, data });
    } catch (error) {
        console.error('Error getting quest data:', error);
        res.status(500).json({ success: false, error: 'Failed to get quest data' });
    }
});

// Complete a quest
app.post('/api/quests/:wallet/complete', async (req, res) => {
    try {
        const { wallet } = req.params;
        const { questId } = req.body;

        if (!wallet || !ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        if (!questId) {
            return res.status(400).json({ success: false, error: 'Quest ID required' });
        }

        const result = await database.quests.completeQuest(wallet, questId);

        if (!result.success) {
            return res.status(400).json(result);
        }

        res.json(result);
    } catch (error) {
        console.error('Error completing quest:', error);
        res.status(500).json({ success: false, error: 'Failed to complete quest' });
    }
});

// ============================================
// SOCIAL DISCONNECT ENDPOINT
// ============================================

// Disconnect a social account
app.post('/api/social/:wallet/disconnect', async (req, res) => {
    try {
        const { wallet } = req.params;
        const { platform } = req.body;

        if (!wallet || !ethers.utils.isAddress(wallet)) {
            return res.status(400).json({ success: false, error: 'Invalid wallet address' });
        }

        if (!platform || !['x', 'discord', 'telegram'].includes(platform)) {
            return res.status(400).json({ success: false, error: 'Invalid platform' });
        }

        // Map platform to database column
        const columnMap = {
            x: 'x_username',
            discord: 'discord_username',
            telegram: 'telegram_username'
        };

        const column = columnMap[platform];

        // Clear the social connection (but keep points/badges)
        if (usePostgres) {
            const { Pool } = require('pg');
            const pool = new Pool({ connectionString: process.env.DATABASE_URL });
            await pool.query(
                `UPDATE verified_users SET ${column} = NULL WHERE LOWER(wallet) = LOWER($1)`,
                [wallet]
            );
            await pool.end();
        } else {
            // JSON fallback - update the user in verified-users.json
            const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
            const userIndex = data.users.findIndex(u => u.wallet.toLowerCase() === wallet.toLowerCase());
            if (userIndex >= 0) {
                if (platform === 'x') {
                    data.users[userIndex].xUsername = null;
                } else if (platform === 'discord') {
                    data.users[userIndex].discordUsername = null;
                } else if (platform === 'telegram') {
                    data.users[userIndex].telegramUsername = null;
                }
                fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
            }
        }

        console.log(`🔌 Disconnected ${platform} for wallet ${wallet}`);
        res.json({ success: true, message: `${platform} disconnected successfully` });
    } catch (error) {
        console.error('Error disconnecting social:', error);
        res.status(500).json({ success: false, error: 'Failed to disconnect social account' });
    }
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

// Update all user balances periodically (verified_users, referrals, holders)
async function updateAllReferralBalances() {
    console.log('🔄 Starting periodic balance update for all users...');

    try {
        // Get ALL verified users (main source of truth)
        const allVerifiedUsers = await db.getUsers();
        console.log(`📊 Found ${allVerifiedUsers.length} verified users to update`);

        const updates = [];
        let updated = 0;
        let failed = 0;

        // Process all verified users
        for (const user of allVerifiedUsers) {
            const balance = await fetchAmyBalance(user.wallet);
            if (balance !== null) {
                updates.push({ wallet: user.wallet, balance, xUsername: user.xUsername });
                updated++;
            } else {
                failed++;
            }

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Batch update all tables
        if (updates.length > 0) {
            // Update verified_users table (main user table for /api/user endpoint)
            if (db && db.batchUpdateBalances) {
                await db.batchUpdateBalances(updates);
                console.log(`👤 Verified users table updated`);
            }

            // Update referrals table
            if (referralsDb) {
                await referralsDb.batchUpdateBalances(updates);
                console.log(`🔗 Referrals table updated`);
            }

            // Update holders table
            if (holdersDb) {
                await holdersDb.batchUpdateBalances(updates);
                console.log(`💎 Holders table updated`);
            }
        }

        console.log(`✅ Balance update complete: ${updated} updated, ${failed} failed`);

    } catch (error) {
        console.error('❌ Error updating balances:', error);
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
        let multiplierUsers = 0;

        for (const user of eligibleUsers) {
            if (user.pointsPerHour > 0) {
                // Fetch token holdings for this user to get all multipliers
                let sailrMult = 0;
                let plvhedgeMult = 0;
                let plsberaMult = 0;
                try {
                    const tokenHoldings = await queryAllTokenHoldings(user.wallet);
                    sailrMult = tokenHoldings.sailr.multiplier > 1 ? tokenHoldings.sailr.multiplier : 0;
                    plvhedgeMult = tokenHoldings.plvhedge.multiplier > 1 ? tokenHoldings.plvhedge.multiplier : 0;
                    plsberaMult = tokenHoldings.plsbera.multiplier > 1 ? tokenHoldings.plsbera.multiplier : 0;

                    // Save updated token data to database (handles stake/unstake changes)
                    if (pointsDb) {
                        await pointsDb.updateTokenData(
                            user.wallet,
                            tokenHoldings.sailr.valueUsd || 0,
                            tokenHoldings.sailr.multiplier || 1,
                            tokenHoldings.plvhedge.valueUsd || 0,
                            tokenHoldings.plvhedge.multiplier || 1,
                            tokenHoldings.plsbera.valueUsd || 0,
                            tokenHoldings.plsbera.multiplier || 1
                        );
                    }
                } catch (err) {
                    // If token query fails, continue with LP only
                }

                // Fetch RaidShark, Onchain Conviction, and Swapper multipliers from database
                let raidsharkMult = 0;
                let onchainConvictionMult = 0;
                let swapperMult = 0;
                try {
                    const badgeMultipliers = await database.points.getMultiplierBadges(user.wallet);
                    raidsharkMult = badgeMultipliers.raidsharkMultiplier > 0 ? badgeMultipliers.raidsharkMultiplier : 0;
                    onchainConvictionMult = badgeMultipliers.onchainConvictionMultiplier > 0 ? badgeMultipliers.onchainConvictionMultiplier : 0;
                    swapperMult = badgeMultipliers.swapperMultiplier > 0 ? badgeMultipliers.swapperMultiplier : 0;
                } catch (err) {
                    // If badge query fails, continue without these multipliers
                }

                // Fetch referral multiplier (1 ref = x3, 2 refs = x5, 3+ refs = x10)
                let referralMult = 0;
                try {
                    if (referralsDb) {
                        const referralEntry = await referralsDb.getByWallet(user.wallet);
                        if (referralEntry && referralEntry.referralCode) {
                            const validReferralCount = await referralsDb.getValidReferralCount(referralEntry.referralCode);
                            if (validReferralCount >= 3) referralMult = 10;
                            else if (validReferralCount >= 2) referralMult = 5;
                            else if (validReferralCount >= 1) referralMult = 3;
                        }
                    }
                } catch (err) {
                    // If referral query fails, continue without this multiplier
                }

                // Calculate total multiplier from all badges (additive)
                const lpMult = parseInt(user.lpMultiplier) > 1 ? parseInt(user.lpMultiplier) : 0;
                const totalMultiplier = Math.max(1, lpMult + sailrMult + plvhedgeMult + plsberaMult + raidsharkMult + onchainConvictionMult + referralMult + swapperMult);

                const basePoints = parseFloat(user.pointsPerHour);
                const finalPoints = basePoints * totalMultiplier;

                // Build human-readable description
                let description = 'Hourly points earned from holding $AMY';
                if (totalMultiplier > 1) {
                    const boostParts = [];
                    if (lpMult > 1) boostParts.push(`AMY/HONEY LP ${lpMult}x`);
                    if (sailrMult > 1) boostParts.push(`SAIL.r ${sailrMult}x`);
                    if (plvhedgeMult > 1) boostParts.push(`plvHEDGE ${plvhedgeMult}x`);
                    if (plsberaMult > 1) boostParts.push(`plsBERA ${plsberaMult}x`);
                    if (raidsharkMult > 1) boostParts.push(`RaidShark ${raidsharkMult}x`);
                    if (onchainConvictionMult > 1) boostParts.push(`Onchain Conviction ${onchainConvictionMult}x`);
                    if (swapperMult > 1) boostParts.push(`Swapper ${swapperMult}x`);
                    if (referralMult > 1) boostParts.push(`Referral ${referralMult}x`);
                    description = `Hourly earning with ${totalMultiplier}x multiplier (${boostParts.join(' + ')})`;
                }

                const result = await pointsDb.awardPoints(
                    user.wallet,
                    finalPoints,
                    'hourly_earning',
                    parseFloat(user.lastAmyBalance),
                    user.currentTier,
                    'DAILY_EARN',
                    description
                );

                if (result && result.success) {
                    awarded++;
                    totalPointsAwarded += finalPoints;
                    if (totalMultiplier > 1) {
                        multiplierUsers++;
                    }
                }

                // Small delay between users to avoid rate limiting on token queries
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        console.log(`✅ Hourly points distributed: ${awarded} users, ${totalPointsAwarded.toFixed(2)} total points, ${multiplierUsers} with multipliers`);

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
