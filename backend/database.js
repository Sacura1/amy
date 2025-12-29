const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// PostgreSQL connection pool
let pool = null;

// Initialize database connection
async function initDatabase() {
    // Check if running on Railway with PostgreSQL
    if (process.env.DATABASE_URL) {
        console.log('🐘 Using PostgreSQL database');
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? {
                rejectUnauthorized: false
            } : false
        });

        // Create tables if they don't exist
        await createTables();
        return true;
    } else {
        console.log('📁 PostgreSQL not configured, using JSON files');
        return false;
    }
}

// Create database tables
async function createTables() {
    const client = await pool.connect();

    try {
        // Create verified_users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS verified_users (
                wallet VARCHAR(42) PRIMARY KEY,
                x_username VARCHAR(255) NOT NULL,
                amy_balance DECIMAL(20, 2) NOT NULL,
                verified_at TIMESTAMP NOT NULL,
                timestamp BIGINT NOT NULL,
                signature_verified BOOLEAN DEFAULT true,
                referral_code VARCHAR(8) UNIQUE,
                referred_by VARCHAR(8),
                referral_count INTEGER DEFAULT 0
            );
        `);

        // Add referral columns if they don't exist (for existing tables)
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='verified_users' AND column_name='referral_code') THEN
                    ALTER TABLE verified_users ADD COLUMN referral_code VARCHAR(8) UNIQUE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='verified_users' AND column_name='referred_by') THEN
                    ALTER TABLE verified_users ADD COLUMN referred_by VARCHAR(8);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='verified_users' AND column_name='referral_count') THEN
                    ALTER TABLE verified_users ADD COLUMN referral_count INTEGER DEFAULT 0;
                END IF;
            END $$;
        `);

        // Create leaderboard table
        await client.query(`
            CREATE TABLE IF NOT EXISTS leaderboard (
                position INTEGER PRIMARY KEY,
                x_username VARCHAR(255) NOT NULL,
                mindshare DECIMAL(10, 2) DEFAULT 0
            );
        `);

        // Create leaderboard_meta table for metadata
        await client.query(`
            CREATE TABLE IF NOT EXISTS leaderboard_meta (
                id INTEGER PRIMARY KEY DEFAULT 1,
                last_updated TIMESTAMP NOT NULL,
                minimum_amy INTEGER NOT NULL,
                CONSTRAINT single_row CHECK (id = 1)
            );
        `);

        // Create nonces table
        await client.query(`
            CREATE TABLE IF NOT EXISTS nonces (
                nonce VARCHAR(255) PRIMARY KEY,
                wallet VARCHAR(42) NOT NULL,
                timestamp BIGINT NOT NULL,
                used_at BIGINT NOT NULL
            );
        `);

        // Create referrals table (separate from verified_users)
        await client.query(`
            CREATE TABLE IF NOT EXISTS referrals (
                wallet VARCHAR(42) PRIMARY KEY,
                x_username VARCHAR(255),
                referral_code VARCHAR(8) UNIQUE,
                referred_by VARCHAR(8),
                referral_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add last_known_balance column if it doesn't exist (for tracking balance changes)
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='referrals' AND column_name='last_known_balance') THEN
                    ALTER TABLE referrals ADD COLUMN last_known_balance DECIMAL(20, 2) DEFAULT 0;
                END IF;
            END $$;
        `);

        // Create holders table (tracks users with 300+ AMY who connected wallet + X)
        await client.query(`
            CREATE TABLE IF NOT EXISTS holders (
                wallet VARCHAR(42) PRIMARY KEY,
                x_username VARCHAR(255) NOT NULL,
                amy_balance DECIMAL(20, 2) NOT NULL,
                first_recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create amy_points table (tracks user points balance and earning history)
        await client.query(`
            CREATE TABLE IF NOT EXISTS amy_points (
                wallet VARCHAR(42) PRIMARY KEY,
                x_username VARCHAR(255),
                total_points DECIMAL(20, 2) DEFAULT 0,
                last_amy_balance DECIMAL(20, 2) DEFAULT 0,
                current_tier VARCHAR(20) DEFAULT 'none',
                points_per_hour DECIMAL(10, 2) DEFAULT 0,
                last_points_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create points_history table (tracks point earning events for auditing)
        await client.query(`
            CREATE TABLE IF NOT EXISTS points_history (
                id SERIAL PRIMARY KEY,
                wallet VARCHAR(42) NOT NULL,
                points_earned DECIMAL(10, 2) NOT NULL,
                reason VARCHAR(100) NOT NULL,
                amy_balance_at_time DECIMAL(20, 2),
                tier_at_time VARCHAR(20),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add index for faster queries on points_history
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_points_history_wallet ON points_history(wallet);
        `);

        // Add LP tracking columns to amy_points table
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='lp_value_usd') THEN
                    ALTER TABLE amy_points ADD COLUMN lp_value_usd DECIMAL(20, 2) DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='lp_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN lp_multiplier INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='last_lp_check') THEN
                    ALTER TABLE amy_points ADD COLUMN last_lp_check TIMESTAMP;
                END IF;
            END $$;
        `);

        console.log('✅ Database tables created/verified');

        // Migrate from JSON files if tables are empty
        await migrateFromJSON(client);

        // Populate holders table from existing verified users (one-time migration)
        await populateHoldersFromVerifiedUsers(client);

    } catch (error) {
        console.error('❌ Error creating tables:', error);
    } finally {
        client.release();
    }
}

// Migrate data from JSON files to PostgreSQL (one-time migration)
async function migrateFromJSON(client) {
    try {
        // Check if already migrated
        const userCount = await client.query('SELECT COUNT(*) FROM verified_users');
        const leaderboardCount = await client.query('SELECT COUNT(*) FROM leaderboard');

        if (userCount.rows[0].count > 0 && leaderboardCount.rows[0].count > 0) {
            console.log('📊 Database already has data, skipping migration');
            return;
        }

        console.log('🔄 Migrating from JSON files...');

        // Migrate verified users
        const usersPath = path.join(__dirname, 'verified-users.json');
        if (fs.existsSync(usersPath)) {
            const usersData = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
            for (const user of usersData.users) {
                await client.query(
                    `INSERT INTO verified_users (wallet, x_username, amy_balance, verified_at, timestamp, signature_verified)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (wallet) DO UPDATE SET
                     x_username = EXCLUDED.x_username,
                     amy_balance = EXCLUDED.amy_balance`,
                    [user.wallet, user.xUsername, user.amyBalance, user.verifiedAt, user.timestamp, user.signatureVerified || true]
                );
            }
            console.log(`✅ Migrated ${usersData.users.length} verified users`);
        }

        // Migrate leaderboard
        const leaderboardPath = path.join(__dirname, 'leaderboard.json');
        if (fs.existsSync(leaderboardPath)) {
            const leaderboardData = JSON.parse(fs.readFileSync(leaderboardPath, 'utf8'));

            for (const entry of leaderboardData.leaderboard) {
                await client.query(
                    `INSERT INTO leaderboard (position, x_username, mindshare)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (position) DO UPDATE SET
                     x_username = EXCLUDED.x_username,
                     mindshare = EXCLUDED.mindshare`,
                    [entry.position, entry.xUsername, entry.mindshare || 0]
                );
            }

            // Insert metadata
            await client.query(
                `INSERT INTO leaderboard_meta (id, last_updated, minimum_amy)
                 VALUES (1, $1, $2)
                 ON CONFLICT (id) DO UPDATE SET
                 last_updated = EXCLUDED.last_updated,
                 minimum_amy = EXCLUDED.minimum_amy`,
                [leaderboardData.lastUpdated || new Date().toISOString(), leaderboardData.minimumAMY || 300]
            );

            console.log(`✅ Migrated ${leaderboardData.leaderboard.length} leaderboard entries`);
        }

    } catch (error) {
        console.error('❌ Migration error:', error);
    }
}

// Populate holders table from existing verified users (run once on startup)
async function populateHoldersFromVerifiedUsers(client) {
    try {
        const MINIMUM_AMY = parseInt(process.env.MINIMUM_AMY_BALANCE) || 300;

        // Check if holders table is empty
        const holdersCount = await client.query('SELECT COUNT(*) FROM holders');
        if (parseInt(holdersCount.rows[0].count) > 0) {
            console.log('📊 Holders table already has data, skipping migration');
            return;
        }

        // Get all verified users with 300+ AMY
        const verifiedUsers = await client.query(
            'SELECT wallet, x_username, amy_balance, verified_at FROM verified_users WHERE amy_balance >= $1',
            [MINIMUM_AMY]
        );

        if (verifiedUsers.rows.length === 0) {
            console.log('📊 No verified users with 300+ AMY to migrate to holders');
            return;
        }

        console.log(`🔄 Migrating ${verifiedUsers.rows.length} verified users to holders table...`);

        // Insert into holders table
        for (const user of verifiedUsers.rows) {
            await client.query(
                `INSERT INTO holders (wallet, x_username, amy_balance, first_recorded_at, last_updated_at)
                 VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                 ON CONFLICT (wallet) DO NOTHING`,
                [user.wallet.toLowerCase(), user.x_username, user.amy_balance, user.verified_at]
            );
        }

        console.log(`✅ Migrated ${verifiedUsers.rows.length} users to holders table`);

    } catch (error) {
        console.error('❌ Error populating holders table:', error);
    }
}

// Database helper functions
const db = {
    // Get all verified users
    getUsers: async () => {
        if (!pool) return [];
        const result = await pool.query(
            'SELECT wallet, x_username as "xUsername", amy_balance as "amyBalance", verified_at as "verifiedAt", timestamp, signature_verified as "signatureVerified", referral_code as "referralCode", referred_by as "referredBy", referral_count as "referralCount" FROM verified_users ORDER BY verified_at DESC'
        );
        return result.rows;
    },

    // Add or update user
    addUser: async (user) => {
        if (!pool) return null;
        await pool.query(
            `INSERT INTO verified_users (wallet, x_username, amy_balance, verified_at, timestamp, signature_verified, referral_code, referred_by, referral_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (wallet) DO UPDATE SET
             x_username = EXCLUDED.x_username,
             amy_balance = EXCLUDED.amy_balance,
             verified_at = EXCLUDED.verified_at,
             timestamp = EXCLUDED.timestamp,
             signature_verified = EXCLUDED.signature_verified`,
            [user.wallet, user.xUsername, user.amyBalance, user.verifiedAt, user.timestamp, user.signatureVerified || true, user.referralCode || null, user.referredBy || null, user.referralCount || 0]
        );
        return user;
    },

    // Get user by wallet
    getUserByWallet: async (wallet) => {
        if (!pool) return null;
        const result = await pool.query(
            'SELECT wallet, x_username as "xUsername", amy_balance as "amyBalance", verified_at as "verifiedAt", timestamp, signature_verified as "signatureVerified", referral_code as "referralCode", referred_by as "referredBy", referral_count as "referralCount" FROM verified_users WHERE LOWER(wallet) = LOWER($1)',
            [wallet]
        );
        return result.rows[0] || null;
    },

    // Get user by X username
    getUserByUsername: async (username) => {
        if (!pool) return null;
        const result = await pool.query(
            'SELECT wallet, x_username as "xUsername", amy_balance as "amyBalance", verified_at as "verifiedAt", timestamp, signature_verified as "signatureVerified", referral_code as "referralCode", referred_by as "referredBy", referral_count as "referralCount" FROM verified_users WHERE LOWER(x_username) = LOWER($1)',
            [username]
        );
        return result.rows[0] || null;
    },

    // Get user by referral code
    getUserByReferralCode: async (referralCode) => {
        if (!pool) return null;
        const result = await pool.query(
            'SELECT wallet, x_username as "xUsername", amy_balance as "amyBalance", verified_at as "verifiedAt", timestamp, signature_verified as "signatureVerified", referral_code as "referralCode", referred_by as "referredBy", referral_count as "referralCount" FROM verified_users WHERE UPPER(referral_code) = UPPER($1)',
            [referralCode]
        );
        return result.rows[0] || null;
    },

    // Generate and save referral code for user
    generateReferralCode: async (wallet) => {
        if (!pool) return null;
        const code = generateRandomCode();
        await pool.query(
            'UPDATE verified_users SET referral_code = $1 WHERE LOWER(wallet) = LOWER($2)',
            [code, wallet]
        );
        return code;
    },

    // Set referred by for user (can only be done once)
    setReferredBy: async (wallet, referralCode) => {
        if (!pool) return { success: false, error: 'Database not available' };

        // Check if user exists and doesn't already have a referrer
        const user = await db.getUserByWallet(wallet);
        if (!user) {
            return { success: false, error: 'User not found' };
        }
        if (user.referredBy) {
            return { success: false, error: 'You have already used a referral code' };
        }

        // Check if referral code exists
        const referrer = await db.getUserByReferralCode(referralCode);
        if (!referrer) {
            return { success: false, error: 'Invalid referral code' };
        }

        // Check user is not referring themselves
        if (referrer.wallet.toLowerCase() === wallet.toLowerCase()) {
            return { success: false, error: 'You cannot use your own referral code' };
        }

        // Update user's referred_by
        await pool.query(
            'UPDATE verified_users SET referred_by = $1 WHERE LOWER(wallet) = LOWER($2)',
            [referralCode.toUpperCase(), wallet]
        );

        // Increment referrer's referral count
        await pool.query(
            'UPDATE verified_users SET referral_count = referral_count + 1 WHERE UPPER(referral_code) = UPPER($1)',
            [referralCode]
        );

        return { success: true, referrer: referrer.xUsername };
    },

    // Get all downlines (users who used a specific referral code)
    getDownlines: async (referralCode) => {
        if (!pool) return [];
        const result = await pool.query(
            'SELECT wallet, x_username as "xUsername", amy_balance as "amyBalance", verified_at as "verifiedAt" FROM verified_users WHERE UPPER(referred_by) = UPPER($1) ORDER BY verified_at DESC',
            [referralCode]
        );
        return result.rows;
    },

    // Delete user
    deleteUser: async (wallet) => {
        if (!pool) return false;
        const result = await pool.query(
            'DELETE FROM verified_users WHERE LOWER(wallet) = LOWER($1)',
            [wallet]
        );
        return result.rowCount > 0;
    },

    // Update user's AMY balance
    updateBalance: async (wallet, balance) => {
        if (!pool) return false;
        const result = await pool.query(
            'UPDATE verified_users SET amy_balance = $1 WHERE LOWER(wallet) = LOWER($2)',
            [balance, wallet]
        );
        return result.rowCount > 0;
    },

    // Batch update balances for multiple users
    batchUpdateBalances: async (updates) => {
        if (!pool || updates.length === 0) return;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const { wallet, balance } of updates) {
                await client.query(
                    'UPDATE verified_users SET amy_balance = $1 WHERE LOWER(wallet) = LOWER($2)',
                    [balance, wallet]
                );
            }
            await client.query('COMMIT');
            console.log(`✅ Updated ${updates.length} verified_users balances`);
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
};

// Generate random 8-character referral code
function generateRandomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing characters like O, 0, I, 1
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Leaderboard helper functions
const leaderboard = {
    // Get all leaderboard entries
    getAll: async () => {
        if (!pool) return { leaderboard: [], lastUpdated: new Date().toISOString(), minimumAMY: 300 };

        const entries = await pool.query('SELECT position, x_username as "xUsername", mindshare FROM leaderboard ORDER BY position ASC');
        const meta = await pool.query('SELECT last_updated as "lastUpdated", minimum_amy as "minimumAMY" FROM leaderboard_meta WHERE id = 1');

        return {
            leaderboard: entries.rows,
            lastUpdated: meta.rows[0]?.lastUpdated || new Date().toISOString(),
            minimumAMY: meta.rows[0]?.minimumAMY || 300
        };
    },

    // Update entire leaderboard
    update: async (data) => {
        if (!pool) return data;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Clear existing leaderboard
            await client.query('DELETE FROM leaderboard');

            // Insert new entries
            for (const entry of data.leaderboard) {
                await client.query(
                    'INSERT INTO leaderboard (position, x_username, mindshare) VALUES ($1, $2, $3)',
                    [entry.position, entry.xUsername, entry.mindshare || 0]
                );
            }

            // Update metadata
            await client.query(
                `INSERT INTO leaderboard_meta (id, last_updated, minimum_amy)
                 VALUES (1, $1, $2)
                 ON CONFLICT (id) DO UPDATE SET
                 last_updated = EXCLUDED.last_updated,
                 minimum_amy = EXCLUDED.minimum_amy`,
                [new Date().toISOString(), data.minimumAMY || 300]
            );

            await client.query('COMMIT');
            return await leaderboard.getAll();
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    // Add single entry
    addEntry: async (entry) => {
        if (!pool) return null;
        await pool.query(
            'INSERT INTO leaderboard (position, x_username, mindshare) VALUES ($1, $2, $3) ON CONFLICT (position) DO UPDATE SET x_username = EXCLUDED.x_username, mindshare = EXCLUDED.mindshare',
            [entry.position, entry.xUsername, entry.mindshare || 0]
        );
        return await leaderboard.getAll();
    },

    // Update entry
    updateEntry: async (position, entry) => {
        if (!pool) return null;
        await pool.query(
            'UPDATE leaderboard SET x_username = $2, mindshare = $3 WHERE position = $1',
            [position, entry.xUsername, entry.mindshare || 0]
        );
        return await leaderboard.getAll();
    },

    // Delete entry
    deleteEntry: async (position) => {
        if (!pool) return null;
        await pool.query('DELETE FROM leaderboard WHERE position = $1', [position]);
        return await leaderboard.getAll();
    }
};

// Nonce helper functions
const nonces = {
    // Check if nonce exists
    exists: async (nonce) => {
        if (!pool) return false;
        const result = await pool.query('SELECT nonce FROM nonces WHERE nonce = $1', [nonce]);
        return result.rows.length > 0;
    },

    // Add nonce
    add: async (nonce, wallet, timestamp) => {
        if (!pool) return;
        await pool.query(
            'INSERT INTO nonces (nonce, wallet, timestamp, used_at) VALUES ($1, $2, $3, $4) ON CONFLICT (nonce) DO NOTHING',
            [nonce, wallet.toLowerCase(), timestamp, Date.now()]
        );
    },

    // Cleanup old nonces
    cleanup: async () => {
        if (!pool) return;
        const MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
        const cutoff = Date.now() - MAX_AGE;

        const result = await pool.query('DELETE FROM nonces WHERE used_at < $1', [cutoff]);
        console.log('🧹 Cleaned up', result.rowCount, 'old nonces');
    }
};

// Referral helper functions (separate table from verified_users)
const referrals = {
    // Get or create referral entry for wallet
    getOrCreate: async (wallet, xUsername = null) => {
        if (!pool) return null;

        // Check if exists
        const existing = await pool.query(
            'SELECT wallet, x_username as "xUsername", referral_code as "referralCode", referred_by as "referredBy", referral_count as "referralCount", last_known_balance as "lastKnownBalance" FROM referrals WHERE LOWER(wallet) = LOWER($1)',
            [wallet]
        );

        if (existing.rows[0]) {
            // Update xUsername if provided and different
            if (xUsername && existing.rows[0].xUsername !== xUsername) {
                await pool.query(
                    'UPDATE referrals SET x_username = $1 WHERE LOWER(wallet) = LOWER($2)',
                    [xUsername, wallet]
                );
                existing.rows[0].xUsername = xUsername;
            }
            return existing.rows[0];
        }

        // Create new entry
        await pool.query(
            'INSERT INTO referrals (wallet, x_username) VALUES ($1, $2)',
            [wallet.toLowerCase(), xUsername]
        );

        return {
            wallet: wallet.toLowerCase(),
            xUsername: xUsername,
            referralCode: null,
            referredBy: null,
            referralCount: 0,
            lastKnownBalance: 0
        };
    },

    // Get referral by wallet
    getByWallet: async (wallet) => {
        if (!pool) return null;
        const result = await pool.query(
            'SELECT wallet, x_username as "xUsername", referral_code as "referralCode", referred_by as "referredBy", referral_count as "referralCount", last_known_balance as "lastKnownBalance" FROM referrals WHERE LOWER(wallet) = LOWER($1)',
            [wallet]
        );
        return result.rows[0] || null;
    },

    // Get referral by code
    getByCode: async (referralCode) => {
        if (!pool) return null;
        const result = await pool.query(
            'SELECT wallet, x_username as "xUsername", referral_code as "referralCode", referred_by as "referredBy", referral_count as "referralCount", last_known_balance as "lastKnownBalance" FROM referrals WHERE UPPER(referral_code) = UPPER($1)',
            [referralCode]
        );
        return result.rows[0] || null;
    },

    // Generate referral code for wallet
    generateCode: async (wallet) => {
        if (!pool) return null;
        const code = generateRandomCode();
        await pool.query(
            'UPDATE referrals SET referral_code = $1 WHERE LOWER(wallet) = LOWER($2)',
            [code, wallet]
        );
        return code;
    },

    // Update user's last known balance
    updateBalance: async (wallet, balance) => {
        if (!pool) return;
        await pool.query(
            'UPDATE referrals SET last_known_balance = $1 WHERE LOWER(wallet) = LOWER($2)',
            [balance, wallet]
        );
    },

    // Use a referral code (just saves the referral link - counts are calculated dynamically)
    useCode: async (wallet, referralCode) => {
        if (!pool) return { success: false, error: 'Database not available' };

        // Get user's referral entry
        const user = await referrals.getByWallet(wallet);
        if (!user) {
            return { success: false, error: 'Please connect your wallet first' };
        }

        if (user.referredBy) {
            return { success: false, error: 'You have already used a referral code' };
        }

        // Check if referral code exists
        const referrer = await referrals.getByCode(referralCode);
        if (!referrer) {
            return { success: false, error: 'Invalid referral code' };
        }

        // Check user is not referring themselves
        if (referrer.wallet.toLowerCase() === wallet.toLowerCase()) {
            return { success: false, error: 'You cannot use your own referral code' };
        }

        // Save the referral link (referred_by) - counts are calculated dynamically
        await pool.query(
            'UPDATE referrals SET referred_by = $1 WHERE LOWER(wallet) = LOWER($2)',
            [referralCode.toUpperCase(), wallet]
        );

        return {
            success: true,
            referrer: referrer.xUsername,
            message: `Referral from @${referrer.xUsername} linked! It counts when you have 300+ $AMY.`
        };
    },

    // Get all users referred by a specific referral code (with their balances)
    getDownlines: async (referralCode) => {
        if (!pool) return [];
        const result = await pool.query(
            'SELECT wallet, x_username as "xUsername", last_known_balance as "lastKnownBalance", created_at as "createdAt" FROM referrals WHERE UPPER(referred_by) = UPPER($1) ORDER BY created_at DESC',
            [referralCode]
        );
        return result.rows;
    },

    // Calculate valid referral count for a user (downlines with 300+ AMY)
    getValidReferralCount: async (referralCode) => {
        if (!pool || !referralCode) return 0;
        const MINIMUM_AMY = parseInt(process.env.MINIMUM_AMY_BALANCE) || 300;
        const result = await pool.query(
            'SELECT COUNT(*) as count FROM referrals WHERE UPPER(referred_by) = UPPER($1) AND last_known_balance >= $2',
            [referralCode, MINIMUM_AMY]
        );
        return parseInt(result.rows[0].count) || 0;
    },

    // Get all referrals (for batch balance updates)
    getAll: async () => {
        if (!pool) return [];
        const result = await pool.query(
            'SELECT wallet, x_username as "xUsername", referral_code as "referralCode", referred_by as "referredBy", last_known_balance as "lastKnownBalance" FROM referrals'
        );
        return result.rows;
    },

    // Batch update balances for multiple wallets
    batchUpdateBalances: async (updates) => {
        if (!pool || !updates.length) return;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const { wallet, balance } of updates) {
                await client.query(
                    'UPDATE referrals SET last_known_balance = $1 WHERE LOWER(wallet) = LOWER($2)',
                    [balance, wallet]
                );
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
};

// Holders helper functions (tracks users with 300+ AMY)
const holders = {
    // Add or update a holder
    addOrUpdate: async (wallet, xUsername, amyBalance) => {
        if (!pool) return null;
        const MINIMUM_AMY = parseInt(process.env.MINIMUM_AMY_BALANCE) || 300;

        // Only save if they have minimum balance
        if (amyBalance < MINIMUM_AMY) {
            // Remove from holders if they no longer qualify
            await pool.query(
                'DELETE FROM holders WHERE LOWER(wallet) = LOWER($1)',
                [wallet]
            );
            return null;
        }

        await pool.query(
            `INSERT INTO holders (wallet, x_username, amy_balance, first_recorded_at, last_updated_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (wallet) DO UPDATE SET
             x_username = EXCLUDED.x_username,
             amy_balance = EXCLUDED.amy_balance,
             last_updated_at = CURRENT_TIMESTAMP`,
            [wallet.toLowerCase(), xUsername, amyBalance]
        );
        return { wallet: wallet.toLowerCase(), xUsername, amyBalance };
    },

    // Get all holders (sorted by balance descending)
    getAll: async () => {
        if (!pool) return [];
        const result = await pool.query(
            `SELECT wallet, x_username as "xUsername", amy_balance as "amyBalance",
             first_recorded_at as "firstRecordedAt", last_updated_at as "lastUpdatedAt"
             FROM holders
             ORDER BY amy_balance DESC`
        );
        return result.rows;
    },

    // Get holder by wallet
    getByWallet: async (wallet) => {
        if (!pool) return null;
        const result = await pool.query(
            `SELECT wallet, x_username as "xUsername", amy_balance as "amyBalance",
             first_recorded_at as "firstRecordedAt", last_updated_at as "lastUpdatedAt"
             FROM holders WHERE LOWER(wallet) = LOWER($1)`,
            [wallet]
        );
        return result.rows[0] || null;
    },

    // Remove a holder
    remove: async (wallet) => {
        if (!pool) return false;
        const result = await pool.query(
            'DELETE FROM holders WHERE LOWER(wallet) = LOWER($1)',
            [wallet]
        );
        return result.rowCount > 0;
    },

    // Get count of holders
    getCount: async () => {
        if (!pool) return 0;
        const result = await pool.query('SELECT COUNT(*) as count FROM holders');
        return parseInt(result.rows[0].count) || 0;
    },

    // Batch update balances (used by periodic job)
    batchUpdateBalances: async (updates) => {
        if (!pool || !updates.length) return;
        const MINIMUM_AMY = parseInt(process.env.MINIMUM_AMY_BALANCE) || 300;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const { wallet, balance } of updates) {
                if (balance >= MINIMUM_AMY) {
                    // Update balance if still above minimum
                    await client.query(
                        `UPDATE holders SET amy_balance = $1, last_updated_at = CURRENT_TIMESTAMP
                         WHERE LOWER(wallet) = LOWER($2)`,
                        [balance, wallet]
                    );
                } else {
                    // Remove if dropped below minimum
                    await client.query(
                        'DELETE FROM holders WHERE LOWER(wallet) = LOWER($1)',
                        [wallet]
                    );
                }
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
};

// Points tier configuration
const POINTS_TIERS = {
    platinum: { minBalance: 100000, pointsPerHour: 10, name: 'Platinum', emoji: '💎' },
    gold: { minBalance: 10000, pointsPerHour: 5, name: 'Gold', emoji: '🥇' },
    silver: { minBalance: 1000, pointsPerHour: 3, name: 'Silver', emoji: '🥈' },
    bronze: { minBalance: 300, pointsPerHour: 1, name: 'Bronze', emoji: '🟫' },
    none: { minBalance: 0, pointsPerHour: 0, name: 'None', emoji: '⚪' }
};

// Calculate tier based on AMY balance
function calculateTier(amyBalance) {
    if (amyBalance >= POINTS_TIERS.platinum.minBalance) return 'platinum';
    if (amyBalance >= POINTS_TIERS.gold.minBalance) return 'gold';
    if (amyBalance >= POINTS_TIERS.silver.minBalance) return 'silver';
    if (amyBalance >= POINTS_TIERS.bronze.minBalance) return 'bronze';
    return 'none';
}

// Points helper functions
const points = {
    // Get or create points entry for a wallet
    getOrCreate: async (wallet, xUsername = null) => {
        if (!pool) return null;

        const existing = await pool.query(
            `SELECT wallet, x_username as "xUsername", total_points as "totalPoints",
             last_amy_balance as "lastAmyBalance", current_tier as "currentTier",
             points_per_hour as "pointsPerHour", last_points_update as "lastPointsUpdate",
             created_at as "createdAt", lp_value_usd as "lpValueUsd",
             lp_multiplier as "lpMultiplier", last_lp_check as "lastLpCheck"
             FROM amy_points WHERE LOWER(wallet) = LOWER($1)`,
            [wallet]
        );

        if (existing.rows[0]) {
            return existing.rows[0];
        }

        // Create new entry
        await pool.query(
            `INSERT INTO amy_points (wallet, x_username) VALUES ($1, $2)`,
            [wallet.toLowerCase(), xUsername]
        );

        return {
            wallet: wallet.toLowerCase(),
            xUsername: xUsername,
            totalPoints: 0,
            lastAmyBalance: 0,
            currentTier: 'none',
            pointsPerHour: 0,
            lastPointsUpdate: new Date(),
            createdAt: new Date(),
            lpValueUsd: 0,
            lpMultiplier: 1,
            lastLpCheck: null
        };
    },

    // Get points for a wallet
    getByWallet: async (wallet) => {
        if (!pool) return null;
        const result = await pool.query(
            `SELECT wallet, x_username as "xUsername", total_points as "totalPoints",
             last_amy_balance as "lastAmyBalance", current_tier as "currentTier",
             points_per_hour as "pointsPerHour", last_points_update as "lastPointsUpdate",
             created_at as "createdAt", lp_value_usd as "lpValueUsd",
             lp_multiplier as "lpMultiplier", last_lp_check as "lastLpCheck"
             FROM amy_points WHERE LOWER(wallet) = LOWER($1)`,
            [wallet]
        );
        return result.rows[0] || null;
    },

    // Update user's balance and recalculate tier (called when balance changes)
    updateBalance: async (wallet, amyBalance, xUsername = null) => {
        if (!pool) return null;

        const tier = calculateTier(amyBalance);
        const pointsPerHour = POINTS_TIERS[tier].pointsPerHour;

        // Upsert the points entry
        await pool.query(
            `INSERT INTO amy_points (wallet, x_username, last_amy_balance, current_tier, points_per_hour, last_points_update)
             VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
             ON CONFLICT (wallet) DO UPDATE SET
             x_username = COALESCE($2, amy_points.x_username),
             last_amy_balance = $3,
             current_tier = $4,
             points_per_hour = $5`,
            [wallet.toLowerCase(), xUsername, amyBalance, tier, pointsPerHour]
        );

        return {
            wallet: wallet.toLowerCase(),
            tier,
            tierInfo: POINTS_TIERS[tier],
            pointsPerHour
        };
    },

    // Award points to a user (called by hourly job)
    awardPoints: async (wallet, pointsToAward, reason, amyBalance, tier) => {
        if (!pool || pointsToAward <= 0) return null;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Update total points
            await client.query(
                `UPDATE amy_points SET
                 total_points = total_points + $1,
                 last_points_update = CURRENT_TIMESTAMP
                 WHERE LOWER(wallet) = LOWER($2)`,
                [pointsToAward, wallet]
            );

            // Log to history
            await client.query(
                `INSERT INTO points_history (wallet, points_earned, reason, amy_balance_at_time, tier_at_time)
                 VALUES ($1, $2, $3, $4, $5)`,
                [wallet.toLowerCase(), pointsToAward, reason, amyBalance, tier]
            );

            await client.query('COMMIT');

            return { success: true, pointsAwarded: pointsToAward };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    // Get all users eligible for points (those with points entry and tier != 'none')
    getAllEligible: async () => {
        if (!pool) return [];
        const result = await pool.query(
            `SELECT wallet, x_username as "xUsername", total_points as "totalPoints",
             last_amy_balance as "lastAmyBalance", current_tier as "currentTier",
             points_per_hour as "pointsPerHour", last_points_update as "lastPointsUpdate",
             lp_value_usd as "lpValueUsd", lp_multiplier as "lpMultiplier"
             FROM amy_points
             WHERE current_tier != 'none' AND points_per_hour > 0
             ORDER BY total_points DESC`
        );
        return result.rows;
    },

    // Update LP data for a user
    updateLpData: async (wallet, lpValueUsd, lpMultiplier) => {
        if (!pool) return null;
        await pool.query(
            `UPDATE amy_points SET
             lp_value_usd = $1,
             lp_multiplier = $2,
             last_lp_check = CURRENT_TIMESTAMP
             WHERE LOWER(wallet) = LOWER($3)`,
            [lpValueUsd, lpMultiplier, wallet]
        );
        return { lpValueUsd, lpMultiplier };
    },

    // Get points history for a wallet
    getHistory: async (wallet, limit = 50) => {
        if (!pool) return [];
        const result = await pool.query(
            `SELECT points_earned as "pointsEarned", reason,
             amy_balance_at_time as "amyBalanceAtTime", tier_at_time as "tierAtTime",
             created_at as "createdAt"
             FROM points_history
             WHERE LOWER(wallet) = LOWER($1)
             ORDER BY created_at DESC
             LIMIT $2`,
            [wallet, limit]
        );
        return result.rows;
    },

    // Get leaderboard (top point holders)
    getLeaderboard: async (limit = 100) => {
        if (!pool) return [];
        const result = await pool.query(
            `SELECT wallet, x_username as "xUsername", total_points as "totalPoints",
             current_tier as "currentTier", points_per_hour as "pointsPerHour"
             FROM amy_points
             WHERE total_points > 0
             ORDER BY total_points DESC
             LIMIT $1`,
            [limit]
        );
        return result.rows;
    },

    // Get tier configuration
    getTiers: () => POINTS_TIERS,

    // Calculate tier for a given balance
    calculateTier: calculateTier
};

module.exports = {
    initDatabase,
    db,
    leaderboard,
    nonces,
    referrals,
    holders,
    points,
    POINTS_TIERS
};
