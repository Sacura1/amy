const express = require('express');
const session = require('express-session');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Database setup (using JSON file for simplicity - easy to backup and migrate)
const DB_PATH = path.join(__dirname, 'verified-users.json');
const LEADERBOARD_PATH = path.join(__dirname, 'leaderboard.json');

// Initialize database file if it doesn't exist
if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: [] }, null, 2));
}

// Initialize leaderboard file if it doesn't exist
if (!fs.existsSync(LEADERBOARD_PATH)) {
    fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify({
        leaderboard: [],
        lastUpdated: new Date().toISOString(),
        minimumAMY: 0
    }, null, 2));
}

// Database helper functions
const db = {
    read: () => {
        const data = fs.readFileSync(DB_PATH, 'utf8');
        return JSON.parse(data);
    },
    write: (data) => {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    },
    getUsers: () => {
        return db.read().users;
    },
    addUser: (user) => {
        const data = db.read();
        const existingIndex = data.users.findIndex(u =>
            u.wallet.toLowerCase() === user.wallet.toLowerCase()
        );

        if (existingIndex >= 0) {
            data.users[existingIndex] = user;
        } else {
            data.users.push(user);
        }

        db.write(data);
        return user;
    },
    getUserByWallet: (wallet) => {
        const users = db.getUsers();
        return users.find(u => u.wallet.toLowerCase() === wallet.toLowerCase());
    }
};

// Leaderboard helper functions
const leaderboard = {
    read: () => {
        const data = fs.readFileSync(LEADERBOARD_PATH, 'utf8');
        return JSON.parse(data);
    },
    write: (data) => {
        fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify(data, null, 2));
    },
    getAll: () => {
        return leaderboard.read();
    },
    update: (data) => {
        const leaderboardData = {
            leaderboard: data.leaderboard || [],
            lastUpdated: new Date().toISOString(),
            minimumAMY: data.minimumAMY || 0
        };
        leaderboard.write(leaderboardData);
        return leaderboardData;
    },
    addEntry: (entry) => {
        const data = leaderboard.read();
        data.leaderboard.push(entry);
        data.lastUpdated = new Date().toISOString();
        leaderboard.write(data);
        return data;
    },
    updateEntry: (position, entry) => {
        const data = leaderboard.read();
        const index = data.leaderboard.findIndex(e => e.position === position);
        if (index >= 0) {
            data.leaderboard[index] = { ...data.leaderboard[index], ...entry };
            data.lastUpdated = new Date().toISOString();
            leaderboard.write(data);
        }
        return data;
    },
    deleteEntry: (position) => {
        const data = leaderboard.read();
        data.leaderboard = data.leaderboard.filter(e => e.position !== position);
        data.lastUpdated = new Date().toISOString();
        leaderboard.write(data);
        return data;
    }
};

// Admin wallet whitelist - ADD YOUR ADMIN WALLET ADDRESSES HERE
const ADMIN_WALLETS = (process.env.ADMIN_WALLETS || '')
    .split(',')
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length > 0);

console.log('📋 Admin wallets loaded:', ADMIN_WALLETS.length);

// AMY Token Configuration
const AMY_TOKEN_ADDRESS = '0x098a75bAedDEc78f9A8D0830d6B86eAc5cC8894e';
const MINIMUM_AMY_BALANCE = 0; // TEMPORARILY SET TO 0 FOR TESTING - Change back to 300 for production

// Middleware
app.use(cors({
    origin:'https://amybera.xyz',
    credentials: true
}));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'amy-verification-secret-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
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

    // Verify state (CSRF protection)
    if (state !== req.session.state) {
        return res.status(403).send('State mismatch. Possible CSRF attack.');
    }

    try {
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
                },
                auth: {
                    username: process.env.TWITTER_CLIENT_ID,
                    password: process.env.TWITTER_CLIENT_SECRET
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
        res.redirect(`${frontendUrl}/profile.html?x_connected=true&username=${twitterUser.username}&wallet=${req.session.wallet}`);

    } catch (error) {
        console.error('❌ OAuth error:', error.response?.data || error.message);
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        res.redirect(`${frontendUrl}/profile.html?error=oauth_failed`);
    }
});

// ============================================
// VERIFICATION API ROUTES
// ============================================

// Verify user holdings and save to database
app.post('/api/verify', async (req, res) => {
    const { wallet, xUsername, amyBalance } = req.body;

    // Validation
    if (!wallet || !xUsername) {
        return res.status(400).json({
            error: 'Missing required fields',
            required: ['wallet', 'xUsername', 'amyBalance']
        });
    }

    // Check minimum balance
    if (amyBalance < MINIMUM_AMY_BALANCE) {
        return res.status(400).json({
            success: false,
            error: 'Insufficient AMY balance',
            required: MINIMUM_AMY_BALANCE,
            current: amyBalance
        });
    }

    try {
        // Save to database
        const userData = {
            wallet: wallet.toLowerCase(),
            xUsername: xUsername,
            amyBalance: parseFloat(amyBalance),
            verifiedAt: new Date().toISOString(),
            timestamp: Date.now()
        };

        db.addUser(userData);

        console.log('✅ User verified and saved:', userData.wallet, '@' + userData.xUsername);

        res.json({
            success: true,
            message: 'User verified successfully',
            data: userData
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
app.get('/api/status/:wallet', (req, res) => {
    const wallet = req.params.wallet;

    if (!wallet) {
        return res.status(400).json({ error: 'Wallet address required' });
    }

    const user = db.getUserByWallet(wallet);

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
app.get('/api/users', isAdmin, (req, res) => {
    try {
        const users = db.getUsers();

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

// Download CSV spreadsheet (admin only)
app.get('/api/download', isAdmin, (req, res) => {
    try {
        const users = db.getUsers();

        if (users.length === 0) {
            return res.status(404).json({ error: 'No verified users found' });
        }

        // Generate CSV
        let csv = 'X Username,Wallet Address,AMY Balance,Verified Date\n';

        users.forEach(user => {
            const date = new Date(user.verifiedAt).toLocaleString();
            csv += `@${user.xUsername},${user.wallet},${user.amyBalance.toFixed(2)},${date}\n`;
        });

        // Send as downloadable file
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=AMY_Verified_Holders_${Date.now()}.csv`);
        res.send(csv);

        console.log('📥 CSV downloaded by admin:', req.query.wallet);

    } catch (error) {
        console.error('❌ Error generating CSV:', error);
        res.status(500).json({ error: 'Failed to generate CSV' });
    }
});

// Get user data by X username (public endpoint)
app.get('/api/user/:username', (req, res) => {
    try {
        const username = req.params.username.toLowerCase();
        const users = db.getUsers();

        // Find user by X username
        const user = users.find(u => u.xUsername.toLowerCase() === username);

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
app.get('/api/leaderboard', (req, res) => {
    try {
        const data = leaderboard.getAll();
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
app.post('/api/leaderboard', isAdmin, (req, res) => {
    try {
        const { leaderboard: leaderboardData, minimumAMY } = req.body;

        if (!Array.isArray(leaderboardData)) {
            return res.status(400).json({ error: 'Leaderboard must be an array' });
        }

        const data = leaderboard.update({
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
app.post('/api/leaderboard/entry', isAdmin, (req, res) => {
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

        const data = leaderboard.addEntry(entry);

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
app.put('/api/leaderboard/:position', isAdmin, (req, res) => {
    try {
        const position = parseInt(req.params.position);
        const { xUsername, mindshare } = req.body;

        const entry = {};
        if (xUsername !== undefined) entry.xUsername = xUsername;
        if (mindshare !== undefined) entry.mindshare = parseFloat(mindshare);
        entry.position = position;

        const data = leaderboard.updateEntry(position, entry);

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
app.delete('/api/leaderboard/:position', isAdmin, (req, res) => {
    try {
        const position = parseInt(req.params.position);
        const data = leaderboard.deleteEntry(position);

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

// Get stats (admin only)
app.get('/api/stats', isAdmin, (req, res) => {
    try {
        const users = db.getUsers();
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
app.delete('/api/user/:wallet', isAdmin, (req, res) => {
    try {
        const wallet = req.params.wallet;
        const data = db.read();

        const initialLength = data.users.length;
        data.users = data.users.filter(u =>
            u.wallet.toLowerCase() !== wallet.toLowerCase()
        );

        if (data.users.length < initialLength) {
            db.write(data);
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
    console.log(`💾 Database: ${DB_PATH}`);
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
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('👋 SIGTERM received, shutting down gracefully...');
    process.exit(0);
});
