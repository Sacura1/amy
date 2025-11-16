const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// PostgreSQL connection pool
let pool = null;

// Initialize database connection
function initDatabase() {
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
        createTables();
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
                signature_verified BOOLEAN DEFAULT true
            );
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

        console.log('✅ Database tables created/verified');

        // Migrate from JSON files if tables are empty
        await migrateFromJSON(client);

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

// Database helper functions
const db = {
    // Get all verified users
    getUsers: async () => {
        if (!pool) return [];
        const result = await pool.query(
            'SELECT wallet, x_username as "xUsername", amy_balance as "amyBalance", verified_at as "verifiedAt", timestamp, signature_verified as "signatureVerified" FROM verified_users ORDER BY verified_at DESC'
        );
        return result.rows;
    },

    // Add or update user
    addUser: async (user) => {
        if (!pool) return null;
        await pool.query(
            `INSERT INTO verified_users (wallet, x_username, amy_balance, verified_at, timestamp, signature_verified)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (wallet) DO UPDATE SET
             x_username = EXCLUDED.x_username,
             amy_balance = EXCLUDED.amy_balance,
             verified_at = EXCLUDED.verified_at,
             timestamp = EXCLUDED.timestamp,
             signature_verified = EXCLUDED.signature_verified`,
            [user.wallet, user.xUsername, user.amyBalance, user.verifiedAt, user.timestamp, user.signatureVerified || true]
        );
        return user;
    },

    // Get user by wallet
    getUserByWallet: async (wallet) => {
        if (!pool) return null;
        const result = await pool.query(
            'SELECT wallet, x_username as "xUsername", amy_balance as "amyBalance", verified_at as "verifiedAt", timestamp, signature_verified as "signatureVerified" FROM verified_users WHERE LOWER(wallet) = LOWER($1)',
            [wallet]
        );
        return result.rows[0] || null;
    },

    // Get user by X username
    getUserByUsername: async (username) => {
        if (!pool) return null;
        const result = await pool.query(
            'SELECT wallet, x_username as "xUsername", amy_balance as "amyBalance", verified_at as "verifiedAt", timestamp, signature_verified as "signatureVerified" FROM verified_users WHERE LOWER(x_username) = LOWER($1)',
            [username]
        );
        return result.rows[0] || null;
    },

    // Delete user
    deleteUser: async (wallet) => {
        if (!pool) return false;
        const result = await pool.query(
            'DELETE FROM verified_users WHERE LOWER(wallet) = LOWER($1)',
            [wallet]
        );
        return result.rowCount > 0;
    }
};

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

module.exports = {
    initDatabase,
    db,
    leaderboard,
    nonces
};
