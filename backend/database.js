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

        // Add social connection columns and make x_username nullable (for Discord/Telegram-first users)
        await client.query(`
            DO $$
            BEGIN
                -- Add discord_username column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='verified_users' AND column_name='discord_username') THEN
                    ALTER TABLE verified_users ADD COLUMN discord_username VARCHAR(255);
                END IF;
                -- Add telegram_username column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='verified_users' AND column_name='telegram_username') THEN
                    ALTER TABLE verified_users ADD COLUMN telegram_username VARCHAR(255);
                END IF;
                -- Add email column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='verified_users' AND column_name='email') THEN
                    ALTER TABLE verified_users ADD COLUMN email VARCHAR(255);
                END IF;
                -- Make x_username nullable (users can now connect Discord/Telegram first)
                ALTER TABLE verified_users ALTER COLUMN x_username DROP NOT NULL;
                -- Make amy_balance nullable with default 0
                ALTER TABLE verified_users ALTER COLUMN amy_balance SET DEFAULT 0;
                ALTER TABLE verified_users ALTER COLUMN amy_balance DROP NOT NULL;
                -- Make verified_at nullable with default now
                ALTER TABLE verified_users ALTER COLUMN verified_at SET DEFAULT CURRENT_TIMESTAMP;
                ALTER TABLE verified_users ALTER COLUMN verified_at DROP NOT NULL;
                -- Make timestamp nullable with default 0
                ALTER TABLE verified_users ALTER COLUMN timestamp SET DEFAULT 0;
                ALTER TABLE verified_users ALTER COLUMN timestamp DROP NOT NULL;
            EXCEPTION
                WHEN others THEN
                    -- Ignore errors if columns already modified
                    NULL;
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

        // Add category and description columns to points_history table
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='points_history' AND column_name='category') THEN
                    ALTER TABLE points_history ADD COLUMN category VARCHAR(50);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='points_history' AND column_name='description') THEN
                    ALTER TABLE points_history ADD COLUMN description VARCHAR(255);
                END IF;
            END $$;
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
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='sailr_value_usd') THEN
                    ALTER TABLE amy_points ADD COLUMN sailr_value_usd DECIMAL(20, 2) DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='sailr_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN sailr_multiplier INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='plvhedge_value_usd') THEN
                    ALTER TABLE amy_points ADD COLUMN plvhedge_value_usd DECIMAL(20, 2) DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='plvhedge_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN plvhedge_multiplier INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='plsbera_value_usd') THEN
                    ALTER TABLE amy_points ADD COLUMN plsbera_value_usd DECIMAL(20, 2) DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='plsbera_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN plsbera_multiplier INTEGER DEFAULT 1;
                END IF;
            END $$;
        `);

        // Add social connection columns to verified_users
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='verified_users' AND column_name='discord_username') THEN
                    ALTER TABLE verified_users ADD COLUMN discord_username VARCHAR(255);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='verified_users' AND column_name='telegram_username') THEN
                    ALTER TABLE verified_users ADD COLUMN telegram_username VARCHAR(255);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='verified_users' AND column_name='email') THEN
                    ALTER TABLE verified_users ADD COLUMN email VARCHAR(255);
                END IF;
            END $$;
        `);

        // Create user_profiles table for extended profile data
        await client.query(`
            CREATE TABLE IF NOT EXISTS user_profiles (
                wallet VARCHAR(42) PRIMARY KEY,
                display_name VARCHAR(50),
                bio VARCHAR(140),
                avatar_type VARCHAR(10) DEFAULT 'default',
                avatar_url VARCHAR(500),
                avatar_nft_address VARCHAR(42),
                avatar_nft_token_id VARCHAR(100),
                background_id VARCHAR(50) DEFAULT 'default',
                filter_id VARCHAR(50) DEFAULT 'default',
                animation_id VARCHAR(50) DEFAULT 'default',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add avatar_data column for base64 storage if it doesn't exist
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_profiles' AND column_name='avatar_data') THEN
                    ALTER TABLE user_profiles ADD COLUMN avatar_data TEXT;
                END IF;
            END $$;
        `);
        // Create user_badges table for equipped badges (5 slots)
        await client.query(`
            CREATE TABLE IF NOT EXISTS user_badges (
                id SERIAL PRIMARY KEY,
                wallet VARCHAR(42) NOT NULL,
                slot_number INTEGER NOT NULL CHECK (slot_number >= 1 AND slot_number <= 5),
                badge_id VARCHAR(50) NOT NULL,
                equipped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(wallet, slot_number)
            );
        `);

        // Create customization_items table for purchasable items
        await client.query(`
            CREATE TABLE IF NOT EXISTS customization_items (
                id VARCHAR(50) PRIMARY KEY,
                type VARCHAR(20) NOT NULL,
                name VARCHAR(100) NOT NULL,
                preview_url VARCHAR(500),
                cost_points INTEGER NOT NULL DEFAULT 0,
                is_default BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create user_purchases table for tracking bought items
        await client.query(`
            CREATE TABLE IF NOT EXISTS user_purchases (
                id SERIAL PRIMARY KEY,
                wallet VARCHAR(42) NOT NULL,
                item_id VARCHAR(50) NOT NULL,
                purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                points_spent INTEGER NOT NULL,
                UNIQUE(wallet, item_id)
            );
        `);

        // Add index for faster badge queries
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_user_badges_wallet ON user_badges(wallet);
        `);

        // Add index for faster purchase queries
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_user_purchases_wallet ON user_purchases(wallet);
        `);

        // Create email_verifications table for SendGrid verification codes
        await client.query(`
            CREATE TABLE IF NOT EXISTS email_verifications (
                wallet VARCHAR(42) PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                code VARCHAR(6) NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('✅ Database tables created/verified');

        // Migrate from JSON files if tables are empty
        await migrateFromJSON(client);

        // Populate holders table from existing verified users (one-time migration)
        await populateHoldersFromVerifiedUsers(client);

        // Seed customization items if table is empty
        await seedCustomizationItems(client);

        // Fix old points history entries with ugly reason strings
        await migratePointsHistoryDescriptions(client);

    } catch (error) {
        console.error('❌ Error creating tables:', error);
    } finally {
        client.release();
    }
}

// Migrate old points_history entries to have proper category and description
async function migratePointsHistoryDescriptions(client) {
    try {
        // First, do a quick batch update for simple hourly_earning entries
        const simpleResult = await client.query(`
            UPDATE points_history
            SET category = 'DAILY_EARN',
                description = 'Hourly points earned from holding $AMY'
            WHERE reason = 'hourly_earning'
            AND (category IS NULL OR description IS NULL OR description LIKE 'hourly_%')
        `);

        if (simpleResult.rowCount > 0) {
            console.log(`✅ Fixed ${simpleResult.rowCount} simple hourly entries`);
        }

        // Now handle entries with multipliers using SQL pattern matching
        // LP multiplier patterns
        await client.query(`
            UPDATE points_history
            SET category = 'DAILY_EARN',
                description = 'Hourly earning with ' ||
                    SUBSTRING(reason FROM 'total(\\d+)x') || 'x multiplier (' ||
                    CASE WHEN reason ~ 'lp\\d+x' THEN 'AMY/HONEY LP ' || SUBSTRING(reason FROM 'lp(\\d+)x') || 'x' ELSE '' END ||
                    CASE WHEN reason ~ 'lp\\d+x' AND reason ~ '(sailr|plvh|plsb)' THEN ' + ' ELSE '' END ||
                    CASE WHEN reason ~ 'sailr\\d+x' THEN 'SAIL.r ' || SUBSTRING(reason FROM 'sailr(\\d+)x') || 'x' ELSE '' END ||
                    CASE WHEN reason ~ 'sailr\\d+x' AND reason ~ '(plvh|plsb)' THEN ' + ' ELSE '' END ||
                    CASE WHEN reason ~ 'plvh\\d+x' THEN 'plvHEDGE ' || SUBSTRING(reason FROM 'plvh(\\d+)x') || 'x' ELSE '' END ||
                    CASE WHEN reason ~ 'plvh\\d+x' AND reason ~ 'plsb' THEN ' + ' ELSE '' END ||
                    CASE WHEN reason ~ 'plsb\\d+x' THEN 'plsBERA ' || SUBSTRING(reason FROM 'plsb(\\d+)x') || 'x' ELSE '' END ||
                    ')'
            WHERE reason LIKE 'hourly_%total%'
            AND reason != 'hourly_earning'
            AND (category IS NULL OR description IS NULL OR description LIKE 'hourly_%')
        `);

        console.log(`✅ Points history migration complete`);
    } catch (error) {
        console.error('❌ Error migrating points history descriptions:', error.message);
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

// Seed/update customization items
async function seedCustomizationItems(client) {
    try {
        console.log('🌱 Seeding/updating customization items...');

        // Backgrounds (mobile/desktop variants handled by frontend)
        const backgrounds = [
            { id: 'bg_default', type: 'background', name: 'Default', previewUrl: null, costPoints: 0, isDefault: true },
            { id: 'bg_1', type: 'background', name: 'BG 1', previewUrl: '/bg_desktop_1.jpg', costPoints: 50, isDefault: false },
            { id: 'bg_2', type: 'background', name: 'BG 2', previewUrl: '/bg_desktop_2.jpg', costPoints: 50, isDefault: false },
            { id: 'bg_3', type: 'background', name: 'BG 3', previewUrl: '/bg_desktop_3.jpg', costPoints: 50, isDefault: false },
            { id: 'bg_4', type: 'background', name: 'BG 4', previewUrl: '/bg_desktop_4.jpg', costPoints: 50, isDefault: false },
            { id: 'bg_5', type: 'background', name: 'BG 5', previewUrl: '/bg_desktop_5.jpg', costPoints: 100, isDefault: false },
            { id: 'bg_6', type: 'background', name: 'BG 6', previewUrl: '/bg_desktop_6.jpg', costPoints: 150, isDefault: false },
            { id: 'bg_fuzzy', type: 'background', name: 'Fuzzy Hold', previewUrl: '/fuzzy_desktop.png', costPoints: 500, isDefault: false },
        ];

        // Filters - Color filters
        const filters = [
            { id: 'filter_none', type: 'filter', name: 'None', previewUrl: null, costPoints: 0, isDefault: true },
            { id: 'filter_grey', type: 'filter', name: 'Grey', previewUrl: null, costPoints: 50, isDefault: false },
            { id: 'filter_blue', type: 'filter', name: 'Blue', previewUrl: null, costPoints: 50, isDefault: false },
            { id: 'filter_pink', type: 'filter', name: 'Pink', previewUrl: null, costPoints: 50, isDefault: false },
            { id: 'filter_yellow', type: 'filter', name: 'Yellow', previewUrl: null, costPoints: 50, isDefault: false },
            { id: 'filter_green', type: 'filter', name: 'Green', previewUrl: null, costPoints: 50, isDefault: false },
            // Image-based texture filters
            { id: 'filter_crack', type: 'filter', name: 'Crack', previewUrl: '/crack.png', costPoints: 250, isDefault: false },
            { id: 'filter_dust', type: 'filter', name: 'Dust', previewUrl: '/dust.png', costPoints: 250, isDefault: false },
            { id: 'filter_film_grain', type: 'filter', name: 'Film Grain', previewUrl: '/film_grain.png', costPoints: 250, isDefault: false },
            { id: 'filter_film', type: 'filter', name: 'Film', previewUrl: '/film.png', costPoints: 250, isDefault: false },
            { id: 'filter_halftone', type: 'filter', name: 'Halftone', previewUrl: '/halftone.png', costPoints: 250, isDefault: false },
            { id: 'filter_noise', type: 'filter', name: 'Noise', previewUrl: '/noise_texture.png', costPoints: 250, isDefault: false },
            { id: 'filter_redacted', type: 'filter', name: 'Redacted', previewUrl: '/redacted.png', costPoints: 250, isDefault: false },
            { id: 'filter_scanlines', type: 'filter', name: 'Scanlines', previewUrl: '/scanlines.png', costPoints: 250, isDefault: false },
            { id: 'filter_vhs', type: 'filter', name: 'VHS', previewUrl: '/vhs_effect.png', costPoints: 250, isDefault: false },
        ];

        // Animations
        const animations = [
            { id: 'anim_none', type: 'animation', name: 'Turn OFF', previewUrl: null, costPoints: 0, isDefault: true },
            { id: 'anim_floating', type: 'animation', name: 'Turn ON', previewUrl: null, costPoints: 0, isDefault: true },
            { id: 'anim_custom', type: 'animation', name: 'Custom', previewUrl: null, costPoints: 9999, isDefault: false },
        ];

        const allItems = [...backgrounds, ...filters, ...animations];

        for (const item of allItems) {
            await client.query(
                `INSERT INTO customization_items (id, type, name, preview_url, cost_points, is_default)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (id) DO UPDATE SET
                 type = $2, name = $3, preview_url = $4, cost_points = $5, is_default = $6`,
                [item.id, item.type, item.name, item.previewUrl, item.costPoints, item.isDefault]
            );
        }

        console.log(`✅ Seeded/updated ${allItems.length} customization items`);

    } catch (error) {
        console.error('❌ Error seeding customization items:', error);
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

// Points history categories
const POINTS_CATEGORIES = {
    DAILY_EARN: 'DAILY_EARN',
    GIVEAWAY: 'GIVEAWAY',
    COSMETIC_BACKGROUND_BUY: 'COSMETIC_BACKGROUND_BUY',
    COSMETIC_FILTER_BUY: 'COSMETIC_FILTER_BUY',
    RAFFLE_ENTRY: 'RAFFLE_ENTRY',
    PREDICTION_WAGER: 'PREDICTION_WAGER',
    PREDICTION_PAYOUT: 'PREDICTION_PAYOUT',
    PREDICTION_REFUND: 'PREDICTION_REFUND'
};

// Category descriptions for display
const CATEGORY_DESCRIPTIONS = {
    DAILY_EARN: 'Daily Points Earned',
    GIVEAWAY: 'Amy Point Giveaway',
    COSMETIC_BACKGROUND_BUY: 'Background Purchase',
    COSMETIC_FILTER_BUY: 'Filter Purchase',
    RAFFLE_ENTRY: 'Raffle Entry',
    PREDICTION_WAGER: 'Prediction Market Wager',
    PREDICTION_PAYOUT: 'Prediction Market Payout',
    PREDICTION_REFUND: 'Prediction Market Refund'
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
    awardPoints: async (wallet, pointsToAward, reason, amyBalance, tier, category = null, description = null) => {
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

            // Log to history with category and description
            await client.query(
                `INSERT INTO points_history (wallet, points_earned, reason, amy_balance_at_time, tier_at_time, category, description)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [wallet.toLowerCase(), pointsToAward, reason, amyBalance, tier, category, description]
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

    // Update token holdings data for a user (SAIL.r, plvHEDGE, and plsBERA)
    updateTokenData: async (wallet, sailrValueUsd, sailrMultiplier, plvhedgeValueUsd, plvhedgeMultiplier, plsberaValueUsd, plsberaMultiplier) => {
        if (!pool) return null;
        await pool.query(
            `UPDATE amy_points SET
             sailr_value_usd = $1,
             sailr_multiplier = $2,
             plvhedge_value_usd = $3,
             plvhedge_multiplier = $4,
             plsbera_value_usd = $5,
             plsbera_multiplier = $6
             WHERE LOWER(wallet) = LOWER($7)`,
            [sailrValueUsd, sailrMultiplier, plvhedgeValueUsd, plvhedgeMultiplier, plsberaValueUsd, plsberaMultiplier, wallet]
        );
        return { sailrValueUsd, sailrMultiplier, plvhedgeValueUsd, plvhedgeMultiplier, plsberaValueUsd, plsberaMultiplier };
    },

    // Get points history for a wallet
    getHistory: async (wallet, limit = 50) => {
        if (!pool) return [];
        const result = await pool.query(
            `SELECT points_earned as "pointsEarned", reason, category, description,
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
    calculateTier: calculateTier,

    // Add bonus points by X username (for giveaways)
    addBonusByUsername: async (xUsername, pointsToAdd, reason = 'admin_bonus') => {
        if (!pool) return { success: false, error: 'Database not available' };

        const cleanUsername = xUsername.replace(/^@/, '').trim();

        let result = await pool.query(
            `SELECT wallet, x_username as "xUsername", total_points as "totalPoints",
             last_amy_balance as "lastAmyBalance", current_tier as "currentTier"
             FROM amy_points WHERE LOWER(x_username) = LOWER($1)`,
            [cleanUsername]
        );

        if (!result.rows[0]) {
            const verifiedUser = await pool.query(
                `SELECT wallet, x_username as "xUsername", amy_balance as "amyBalance"
                 FROM verified_users WHERE LOWER(x_username) = LOWER($1)`,
                [cleanUsername]
            );

            if (!verifiedUser.rows[0]) {
                return { success: false, error: `User @${cleanUsername} not found` };
            }

            const user = verifiedUser.rows[0];
            const tier = calculateTier(parseFloat(user.amyBalance) || 0);
            await pool.query(
                `INSERT INTO amy_points (wallet, x_username, last_amy_balance, current_tier, points_per_hour)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (wallet) DO UPDATE SET x_username = $2`,
                [user.wallet.toLowerCase(), user.xUsername, user.amyBalance || 0, tier, POINTS_TIERS[tier].pointsPerHour]
            );

            result = await pool.query(
                `SELECT wallet, x_username as "xUsername", total_points as "totalPoints",
                 last_amy_balance as "lastAmyBalance", current_tier as "currentTier"
                 FROM amy_points WHERE LOWER(wallet) = LOWER($1)`,
                [user.wallet]
            );
        }

        const user = result.rows[0];
        if (!user) {
            return { success: false, error: `User @${cleanUsername} not found` };
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            await client.query(
                `UPDATE amy_points SET
                 total_points = total_points + $1,
                 last_points_update = CURRENT_TIMESTAMP
                 WHERE LOWER(wallet) = LOWER($2)`,
                [pointsToAdd, user.wallet]
            );

            await client.query(
                `INSERT INTO points_history (wallet, points_earned, reason, amy_balance_at_time, tier_at_time, category, description)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [user.wallet.toLowerCase(), pointsToAdd, reason, user.lastAmyBalance || 0, user.currentTier || 'none', 'GIVEAWAY', 'Amy Point Giveaway']
            );

            await client.query('COMMIT');

            const updated = await pool.query(
                `SELECT total_points as "totalPoints" FROM amy_points WHERE LOWER(wallet) = LOWER($1)`,
                [user.wallet]
            );

            return {
                success: true,
                xUsername: user.xUsername,
                wallet: user.wallet,
                pointsAdded: pointsToAdd,
                newTotal: parseFloat(updated.rows[0]?.totalPoints) || pointsToAdd
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
};



// Badge definitions - earned badges based on user activity
const BADGE_DEFINITIONS = {
    verified: { id: 'verified', name: 'Verified', description: 'Connected X account', icon: '✓' },
    og_holder: { id: 'og_holder', name: 'OG Holder', description: 'Early AMY holder', icon: '🏆' },
    lp_x3: { id: 'lp_x3', name: 'LP Bronze', description: '$10+ LP position', icon: '🥉' },
    lp_x5: { id: 'lp_x5', name: 'LP Silver', description: '$100+ LP position', icon: '🥈' },
    lp_x10: { id: 'lp_x10', name: 'LP Gold', description: '$500+ LP position', icon: '🥇' },
    sailr_x3: { id: 'sailr_x3', name: 'SAIL.r Bronze', description: '$10+ SAIL.r', icon: '⛵' },
    sailr_x5: { id: 'sailr_x5', name: 'SAIL.r Silver', description: '$100+ SAIL.r', icon: '⛵' },
    sailr_x10: { id: 'sailr_x10', name: 'SAIL.r Gold', description: '$500+ SAIL.r', icon: '⛵' },
    plvhedge_x3: { id: 'plvhedge_x3', name: 'plvHEDGE Bronze', description: '$10+ plvHEDGE', icon: '🛡️' },
    plvhedge_x5: { id: 'plvhedge_x5', name: 'plvHEDGE Silver', description: '$100+ plvHEDGE', icon: '🛡️' },
    plvhedge_x10: { id: 'plvhedge_x10', name: 'plvHEDGE Gold', description: '$500+ plvHEDGE', icon: '🛡️' },
    plsbera_x3: { id: 'plsbera_x3', name: 'plsBERA Bronze', description: '$10+ plsBERA staked', icon: '🐻' },
    plsbera_x5: { id: 'plsbera_x5', name: 'plsBERA Silver', description: '$100+ plsBERA staked', icon: '🐻' },
    plsbera_x10: { id: 'plsbera_x10', name: 'plsBERA Gold', description: '$500+ plsBERA staked', icon: '🐻' },
    referrer_5: { id: 'referrer_5', name: 'Referrer', description: '5+ referrals', icon: '👥' },
    referrer_10: { id: 'referrer_10', name: 'Super Referrer', description: '10+ referrals', icon: '👥' },
    points_1k: { id: 'points_1k', name: 'Point Collector', description: '1,000+ points', icon: '⭐' },
    points_10k: { id: 'points_10k', name: 'Point Master', description: '10,000+ points', icon: '💫' }
};

// User profiles helper functions
const profiles = {
    // Get or create profile for a wallet
    getOrCreate: async (wallet) => {
        if (!pool) return null;

        const existing = await pool.query(
            `SELECT wallet, display_name as "displayName", bio, avatar_type as "avatarType",
             avatar_url as "avatarUrl", avatar_data as "avatarData",
             avatar_nft_address as "avatarNftAddress",
             avatar_nft_token_id as "avatarNftTokenId", background_id as "backgroundId",
             filter_id as "filterId", animation_id as "animationId",
             created_at as "createdAt", updated_at as "updatedAt"
             FROM user_profiles WHERE LOWER(wallet) = LOWER($1)`,
            [wallet]
        );

        if (existing.rows[0]) {
            return existing.rows[0];
        }

        // Create new profile
        await pool.query(
            `INSERT INTO user_profiles (wallet) VALUES ($1)`,
            [wallet.toLowerCase()]
        );

        return {
            wallet: wallet.toLowerCase(),
            displayName: null,
            bio: null,
            avatarType: 'default',
            avatarUrl: null,
            avatarData: null,
            avatarNftAddress: null,
            avatarNftTokenId: null,
            backgroundId: 'default',
            filterId: 'default',
            animationId: 'default',
            createdAt: new Date(),
            updatedAt: new Date()
        };
    },

    // Get profile by wallet
    getByWallet: async (wallet) => {
        if (!pool) return null;
        const result = await pool.query(
            `SELECT wallet, display_name as "displayName", bio, avatar_type as "avatarType",
             avatar_url as "avatarUrl", avatar_data as "avatarData",
             avatar_nft_address as "avatarNftAddress",
             avatar_nft_token_id as "avatarNftTokenId", background_id as "backgroundId",
             filter_id as "filterId", animation_id as "animationId",
             created_at as "createdAt", updated_at as "updatedAt"
             FROM user_profiles WHERE LOWER(wallet) = LOWER($1)`,
            [wallet]
        );
        return result.rows[0] || null;
    },

    // Update profile (bio, display name)
    update: async (wallet, updates) => {
        if (!pool) return null;
        const { displayName, bio } = updates;

        await pool.query(
            `INSERT INTO user_profiles (wallet, display_name, bio, updated_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (wallet) DO UPDATE SET
             display_name = COALESCE($2, user_profiles.display_name),
             bio = COALESCE($3, user_profiles.bio),
             updated_at = CURRENT_TIMESTAMP`,
            [wallet.toLowerCase(), displayName, bio]
        );

        return await profiles.getByWallet(wallet);
    },

    // Update avatar (upload with base64)
    updateAvatar: async (wallet, avatarUrl, avatarData = null) => {
        if (!pool) return null;
        // First ensure profile exists
        await profiles.getOrCreate(wallet);
        // Then update avatar - store base64 if provided
        await pool.query(
            `UPDATE user_profiles SET
             avatar_type = 'upload',
             avatar_url = $1,
             avatar_data = $2,
             avatar_nft_address = NULL,
             avatar_nft_token_id = NULL,
             updated_at = CURRENT_TIMESTAMP
             WHERE LOWER(wallet) = LOWER($3)`,
            [avatarUrl, avatarData, wallet]
        );
        return await profiles.getByWallet(wallet);
    },

    // Update avatar (NFT)
    updateAvatarNft: async (wallet, nftAddress, tokenId) => {
        if (!pool) return null;
        await pool.query(
            `UPDATE user_profiles SET
             avatar_type = 'nft',
             avatar_url = NULL,
             avatar_nft_address = $1,
             avatar_nft_token_id = $2,
             updated_at = CURRENT_TIMESTAMP
             WHERE LOWER(wallet) = LOWER($3)`,
            [nftAddress, tokenId, wallet]
        );
        return await profiles.getByWallet(wallet);
    },

    // Apply customization (background, filter, animation)
    applyCustomization: async (wallet, type, itemId) => {
        if (!pool) return null;

        const columnMap = {
            background: 'background_id',
            filter: 'filter_id',
            animation: 'animation_id'
        };

        const column = columnMap[type];
        if (!column) return null;

        await pool.query(
            `UPDATE user_profiles SET
             ${column} = $1,
             updated_at = CURRENT_TIMESTAMP
             WHERE LOWER(wallet) = LOWER($2)`,
            [itemId, wallet]
        );
        return await profiles.getByWallet(wallet);
    }
};

// User badges helper functions
const badges = {
    // Get all badge definitions
    getDefinitions: () => BADGE_DEFINITIONS,

    // Get equipped badges for a wallet (5 slots)
    getEquipped: async (wallet) => {
        if (!pool) return [];
        const result = await pool.query(
            `SELECT slot_number as "slotNumber", badge_id as "badgeId", equipped_at as "equippedAt"
             FROM user_badges
             WHERE LOWER(wallet) = LOWER($1)
             ORDER BY slot_number ASC`,
            [wallet]
        );
        return result.rows;
    },

    // Equip a badge to a slot (1-5)
    equip: async (wallet, slotNumber, badgeId) => {
        if (!pool) return null;
        if (slotNumber < 1 || slotNumber > 5) {
            return { success: false, error: 'Slot number must be between 1 and 5' };
        }

        await pool.query(
            `INSERT INTO user_badges (wallet, slot_number, badge_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (wallet, slot_number) DO UPDATE SET
             badge_id = $3,
             equipped_at = CURRENT_TIMESTAMP`,
            [wallet.toLowerCase(), slotNumber, badgeId]
        );
        return { success: true };
    },

    // Unequip a badge from a slot
    unequip: async (wallet, slotNumber) => {
        if (!pool) return null;
        await pool.query(
            `DELETE FROM user_badges
             WHERE LOWER(wallet) = LOWER($1) AND slot_number = $2`,
            [wallet, slotNumber]
        );
        return { success: true };
    },

    // Get earned badges for a user (calculated based on their stats)
    getEarned: async (wallet) => {
        if (!pool) return [];

        const earned = [];

        // Get user data including token holdings
        const userData = await pool.query(
            `SELECT v.x_username, p.total_points, p.lp_multiplier, p.lp_value_usd,
             p.sailr_multiplier, p.sailr_value_usd, p.plvhedge_multiplier, p.plvhedge_value_usd,
             p.plsbera_multiplier, p.plsbera_value_usd, r.referral_count
             FROM verified_users v
             LEFT JOIN amy_points p ON LOWER(v.wallet) = LOWER(p.wallet)
             LEFT JOIN referrals r ON LOWER(v.wallet) = LOWER(r.wallet)
             WHERE LOWER(v.wallet) = LOWER($1)`,
            [wallet]
        );

        if (userData.rows[0]) {
            const user = userData.rows[0];

            // Verified badge (has X username)
            if (user.x_username) {
                earned.push(BADGE_DEFINITIONS.verified);
            }

            // LP (Bulla Exchange) badges
            const lpUsd = parseFloat(user.lp_value_usd) || 0;
            if (lpUsd >= 500) earned.push(BADGE_DEFINITIONS.lp_x10);
            else if (lpUsd >= 100) earned.push(BADGE_DEFINITIONS.lp_x5);
            else if (lpUsd >= 10) earned.push(BADGE_DEFINITIONS.lp_x3);

            // SAIL.r badges
            const sailrUsd = parseFloat(user.sailr_value_usd) || 0;
            if (sailrUsd >= 500) earned.push(BADGE_DEFINITIONS.sailr_x10);
            else if (sailrUsd >= 100) earned.push(BADGE_DEFINITIONS.sailr_x5);
            else if (sailrUsd >= 10) earned.push(BADGE_DEFINITIONS.sailr_x3);

            // plvHEDGE badges
            const plvhedgeUsd = parseFloat(user.plvhedge_value_usd) || 0;
            if (plvhedgeUsd >= 500) earned.push(BADGE_DEFINITIONS.plvhedge_x10);
            else if (plvhedgeUsd >= 100) earned.push(BADGE_DEFINITIONS.plvhedge_x5);
            else if (plvhedgeUsd >= 10) earned.push(BADGE_DEFINITIONS.plvhedge_x3);

            // plsBERA badges
            const plsberaUsd = parseFloat(user.plsbera_value_usd) || 0;
            if (plsberaUsd >= 500) earned.push(BADGE_DEFINITIONS.plsbera_x10);
            else if (plsberaUsd >= 100) earned.push(BADGE_DEFINITIONS.plsbera_x5);
            else if (plsberaUsd >= 10) earned.push(BADGE_DEFINITIONS.plsbera_x3);

            // Referral badges
            const refs = parseInt(user.referral_count) || 0;
            if (refs >= 10) earned.push(BADGE_DEFINITIONS.referrer_10);
            else if (refs >= 5) earned.push(BADGE_DEFINITIONS.referrer_5);

            // Points badges
            const pts = parseFloat(user.total_points) || 0;
            if (pts >= 10000) earned.push(BADGE_DEFINITIONS.points_10k);
            else if (pts >= 1000) earned.push(BADGE_DEFINITIONS.points_1k);
        }

        return earned;
    }
};

// Customization items helper functions
const customization = {
    // Get all items (optionally by type)
    getItems: async (type = null) => {
        if (!pool) return [];
        let query = `SELECT id, type, name, preview_url as "previewUrl",
                     cost_points as "costPoints", is_default as "isDefault"
                     FROM customization_items`;
        const params = [];

        if (type) {
            query += ' WHERE type = $1';
            params.push(type);
        }

        query += ' ORDER BY is_default DESC, cost_points ASC';

        const result = await pool.query(query, params);
        return result.rows;
    },

    // Get item by ID
    getById: async (itemId) => {
        if (!pool) return null;
        const result = await pool.query(
            `SELECT id, type, name, preview_url as "previewUrl",
             cost_points as "costPoints", is_default as "isDefault"
             FROM customization_items WHERE id = $1`,
            [itemId]
        );
        return result.rows[0] || null;
    },

    // Add a new item (admin)
    addItem: async (item) => {
        if (!pool) return null;
        const { id, type, name, previewUrl, costPoints, isDefault } = item;
        await pool.query(
            `INSERT INTO customization_items (id, type, name, preview_url, cost_points, is_default)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO UPDATE SET
             type = $2, name = $3, preview_url = $4, cost_points = $5, is_default = $6`,
            [id, type, name, previewUrl, costPoints || 0, isDefault || false]
        );
        return await customization.getById(id);
    },

    // Get user's purchased items
    getPurchased: async (wallet) => {
        if (!pool) return [];
        const result = await pool.query(
            `SELECT ci.id, ci.type, ci.name, ci.preview_url as "previewUrl",
             up.purchased_at as "purchasedAt", up.points_spent as "pointsSpent"
             FROM user_purchases up
             JOIN customization_items ci ON up.item_id = ci.id
             WHERE LOWER(up.wallet) = LOWER($1)
             ORDER BY up.purchased_at DESC`,
            [wallet]
        );
        return result.rows;
    },

    // Check if user owns an item
    ownsItem: async (wallet, itemId) => {
        if (!pool) return false;
        const result = await pool.query(
            `SELECT 1 FROM user_purchases
             WHERE LOWER(wallet) = LOWER($1) AND item_id = $2`,
            [wallet, itemId]
        );
        return result.rows.length > 0;
    },

    // Purchase an item (deducts points)
    purchase: async (wallet, itemId) => {
        if (!pool) return { success: false, error: 'Database not available' };

        // Get item
        const item = await customization.getById(itemId);
        if (!item) {
            return { success: false, error: 'Item not found' };
        }

        // Check if already owned or is default
        if (item.isDefault) {
            return { success: false, error: 'Default items do not need to be purchased' };
        }

        const owned = await customization.ownsItem(wallet, itemId);
        if (owned) {
            return { success: false, error: 'You already own this item' };
        }

        // Check if user has enough points
        const pointsData = await points.getByWallet(wallet);
        if (!pointsData || parseFloat(pointsData.totalPoints) < item.costPoints) {
            return { success: false, error: 'Not enough Amy Points' };
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Deduct points
            await client.query(
                `UPDATE amy_points SET
                 total_points = total_points - $1,
                 last_points_update = CURRENT_TIMESTAMP
                 WHERE LOWER(wallet) = LOWER($2)`,
                [item.costPoints, wallet]
            );

            // Log the purchase as negative points in history
            await client.query(
                `INSERT INTO points_history (wallet, points_earned, reason, amy_balance_at_time, tier_at_time, category, description)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [wallet.toLowerCase(), -item.costPoints, `purchase_${itemId}`, pointsData.lastAmyBalance || 0, pointsData.currentTier || 'none', item.type === 'background' ? 'COSMETIC_BACKGROUND_BUY' : 'COSMETIC_FILTER_BUY', item.type === 'background' ? `Background ${item.name} Purchase` : `Filter ${item.name} Purchase`]
            );

            // Record purchase
            await client.query(
                `INSERT INTO user_purchases (wallet, item_id, points_spent)
                 VALUES ($1, $2, $3)`,
                [wallet.toLowerCase(), itemId, item.costPoints]
            );

            await client.query('COMMIT');

            return {
                success: true,
                item: item,
                pointsSpent: item.costPoints,
                newBalance: parseFloat(pointsData.totalPoints) - item.costPoints
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
};

// Email verification helper functions (using SendGrid)
const emailVerification = {
    // Create verification code for a wallet
    createVerification: async (wallet, email) => {
        if (!pool) return null;

        // Generate 6-digit code
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        // Delete any existing verification for this wallet
        await pool.query(
            'DELETE FROM email_verifications WHERE LOWER(wallet) = LOWER($1)',
            [wallet]
        );

        // Create new verification
        await pool.query(
            `INSERT INTO email_verifications (wallet, email, code, expires_at)
             VALUES ($1, $2, $3, $4)`,
            [wallet.toLowerCase(), email.toLowerCase(), code, expiresAt]
        );

        return { code, expiresAt };
    },

    // Verify code and link email to wallet
    verifyCode: async (wallet, code) => {
        if (!pool) return { success: false, error: 'Database not available' };

        // Get verification record
        const result = await pool.query(
            `SELECT email, code, expires_at as "expiresAt"
             FROM email_verifications
             WHERE LOWER(wallet) = LOWER($1)`,
            [wallet]
        );

        if (!result.rows[0]) {
            return { success: false, error: 'No verification pending. Please request a new code.' };
        }

        const verification = result.rows[0];

        // Check if expired
        if (new Date() > new Date(verification.expiresAt)) {
            await pool.query(
                'DELETE FROM email_verifications WHERE LOWER(wallet) = LOWER($1)',
                [wallet]
            );
            return { success: false, error: 'Verification code expired. Please request a new one.' };
        }

        // Check code
        if (verification.code !== code) {
            return { success: false, error: 'Invalid verification code.' };
        }

        // Check if email is already linked to another wallet
        const existingEmail = await pool.query(
            `SELECT wallet FROM verified_users
             WHERE LOWER(email) = LOWER($1) AND LOWER(wallet) != LOWER($2)`,
            [verification.email, wallet]
        );

        if (existingEmail.rows.length > 0) {
            return { success: false, error: 'This email is already linked to another wallet.' };
        }

        // Link email to wallet
        await pool.query(
            `UPDATE verified_users SET email = $1 WHERE LOWER(wallet) = LOWER($2)`,
            [verification.email, wallet]
        );

        // Delete verification record
        await pool.query(
            'DELETE FROM email_verifications WHERE LOWER(wallet) = LOWER($1)',
            [wallet]
        );

        return { success: true, email: verification.email };
    },

    // Check if email is already linked
    isEmailLinked: async (email) => {
        if (!pool) return false;
        const result = await pool.query(
            `SELECT 1 FROM verified_users WHERE LOWER(email) = LOWER($1)`,
            [email]
        );
        return result.rows.length > 0;
    }
};

// Social connections helper functions (for syncing Thirdweb linked profiles)
const social = {
    // Update social connections for a user
    updateConnections: async (wallet, connections) => {
        if (!pool) return null;
        const { discord, telegram, email } = connections;

        // First ensure the user exists in verified_users
        await pool.query(
            `INSERT INTO verified_users (wallet)
             VALUES ($1)
             ON CONFLICT (wallet) DO NOTHING`,
            [wallet.toLowerCase()]
        );

        // Then update the social connections
        await pool.query(
            `UPDATE verified_users SET
             discord_username = COALESCE($1, discord_username),
             telegram_username = COALESCE($2, telegram_username),
             email = COALESCE($3, email)
             WHERE LOWER(wallet) = LOWER($4)`,
            [discord, telegram, email, wallet]
        );

        return await social.getConnections(wallet);
    },

    // Get social connections for a user
    getConnections: async (wallet) => {
        if (!pool) return null;
        const result = await pool.query(
            `SELECT x_username as "xUsername", discord_username as "discordUsername",
             telegram_username as "telegramUsername", email
             FROM verified_users WHERE LOWER(wallet) = LOWER($1)`,
            [wallet]
        );
        return result.rows[0] || null;
    }
};

module.exports = {
    initDatabase,
    db,
    leaderboard,
    nonces,
    referrals,
    holders,
    points,
    profiles,
    badges,
    customization,
    social,
    emailVerification,
    POINTS_TIERS,
    POINTS_CATEGORIES,
    CATEGORY_DESCRIPTIONS,
    BADGE_DEFINITIONS
};
