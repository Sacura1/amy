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

        // Add Dawn season referral archive columns
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='referrals' AND column_name='dawn_referral_count') THEN
                    ALTER TABLE referrals ADD COLUMN dawn_referral_count INTEGER DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='referrals' AND column_name='dawn_referral_multiplier') THEN
                    ALTER TABLE referrals ADD COLUMN dawn_referral_multiplier INTEGER DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='referrals' AND column_name='referral_season') THEN
                    ALTER TABLE referrals ADD COLUMN referral_season VARCHAR(20) DEFAULT 'season2';
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
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='honeybend_value_usd') THEN
                    ALTER TABLE amy_points ADD COLUMN honeybend_value_usd DECIMAL(20, 2) DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='honeybend_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN honeybend_multiplier INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='stakedbera_value_usd') THEN
                    ALTER TABLE amy_points ADD COLUMN stakedbera_value_usd DECIMAL(20, 2) DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='stakedbera_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN stakedbera_multiplier INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='raidshark_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN raidshark_multiplier INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='onchain_conviction_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN onchain_conviction_multiplier INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='swapper_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN swapper_multiplier INTEGER DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='telegram_mod_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN telegram_mod_multiplier INTEGER DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='discord_mod_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN discord_mod_multiplier INTEGER DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='surfusd_value_usd') THEN
                    ALTER TABLE amy_points ADD COLUMN surfusd_value_usd DECIMAL(20, 2) DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='surfusd_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN surfusd_multiplier INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='surfcbbtc_value_usd') THEN
                    ALTER TABLE amy_points ADD COLUMN surfcbbtc_value_usd DECIMAL(20, 2) DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='surfcbbtc_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN surfcbbtc_multiplier INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='surfweth_value_usd') THEN
                    ALTER TABLE amy_points ADD COLUMN surfweth_value_usd DECIMAL(20, 2) DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='surfweth_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN surfweth_multiplier INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='bgt_value_usd') THEN
                    ALTER TABLE amy_points ADD COLUMN bgt_value_usd DECIMAL(20, 2) DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='bgt_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN bgt_multiplier INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='snrusd_value_usd') THEN
                    ALTER TABLE amy_points ADD COLUMN snrusd_value_usd DECIMAL(20, 2) DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='snrusd_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN snrusd_multiplier INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='jnrusd_value_usd') THEN
                    ALTER TABLE amy_points ADD COLUMN jnrusd_value_usd DECIMAL(20, 2) DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='jnrusd_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN jnrusd_multiplier INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='bullas_count') THEN
                    ALTER TABLE amy_points ADD COLUMN bullas_count INTEGER DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='bullas_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN bullas_multiplier INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='booga_bullas_count') THEN
                    ALTER TABLE amy_points ADD COLUMN booga_bullas_count INTEGER DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='booga_bullas_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN booga_bullas_multiplier INTEGER DEFAULT 1;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='ember_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN ember_multiplier INTEGER DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='amy_points' AND column_name='genesis_multiplier') THEN
                    ALTER TABLE amy_points ADD COLUMN genesis_multiplier INTEGER DEFAULT 0;
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                slot_id VARCHAR(50),
                novelty_name VARCHAR(100)
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                slot_id VARCHAR(50),
                novelty_name VARCHAR(100)
            );
        `);

        // Create daily_checkins table for streak tracking
        await client.query(`
            CREATE TABLE IF NOT EXISTS daily_checkins (
                wallet VARCHAR(42) PRIMARY KEY,
                last_checkin_date DATE,
                current_streak_day INTEGER DEFAULT 0,
                streak_points_total INTEGER DEFAULT 0,
                total_checkins INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create quests table for tracking quest completions
        await client.query(`
            CREATE TABLE IF NOT EXISTS user_quests (
                wallet VARCHAR(42) PRIMARY KEY,
                follow_amy_x BOOLEAN DEFAULT FALSE,
                follow_amy_x_at TIMESTAMP,
                join_amy_discord BOOLEAN DEFAULT FALSE,
                join_amy_discord_at TIMESTAMP,
                join_amy_telegram BOOLEAN DEFAULT FALSE,
                join_amy_telegram_at TIMESTAMP,
                follow_amy_instagram BOOLEAN DEFAULT FALSE,
                follow_amy_instagram_at TIMESTAMP,
                quest_points_earned INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add Instagram quest columns if they don't exist
        await client.query(`
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_quests' AND column_name='follow_amy_instagram') THEN
                    ALTER TABLE user_quests ADD COLUMN follow_amy_instagram BOOLEAN DEFAULT FALSE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_quests' AND column_name='follow_amy_instagram_at') THEN
                    ALTER TABLE user_quests ADD COLUMN follow_amy_instagram_at TIMESTAMP;
                END IF;
            END $$;
        `);

        // Add connection quest columns (one-time rewards for connecting socials)
        await client.query(`
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_quests' AND column_name='connect_x') THEN
                    ALTER TABLE user_quests ADD COLUMN connect_x BOOLEAN DEFAULT FALSE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_quests' AND column_name='connect_x_at') THEN
                    ALTER TABLE user_quests ADD COLUMN connect_x_at TIMESTAMP;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_quests' AND column_name='connect_discord') THEN
                    ALTER TABLE user_quests ADD COLUMN connect_discord BOOLEAN DEFAULT FALSE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_quests' AND column_name='connect_discord_at') THEN
                    ALTER TABLE user_quests ADD COLUMN connect_discord_at TIMESTAMP;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_quests' AND column_name='connect_telegram') THEN
                    ALTER TABLE user_quests ADD COLUMN connect_telegram BOOLEAN DEFAULT FALSE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_quests' AND column_name='connect_telegram_at') THEN
                    ALTER TABLE user_quests ADD COLUMN connect_telegram_at TIMESTAMP;
                END IF;
            END $$;
        `);

        // Create raffles table
        await client.query(`
            CREATE TABLE IF NOT EXISTS raffles (
                id SERIAL PRIMARY KEY,
                title VARCHAR(200) NOT NULL,
                prize_description VARCHAR(500),
                image_url VARCHAR(500),
                ticket_cost INTEGER DEFAULT 50,
                status VARCHAR(20) DEFAULT 'TNM',
                countdown_hours INTEGER NOT NULL,
                live_at TIMESTAMP,
                ends_at TIMESTAMP,
                winner_wallet VARCHAR(42),
                total_tickets INTEGER DEFAULT 0,
                unique_participants INTEGER DEFAULT 0,
                total_points_committed INTEGER DEFAULT 0,
                created_by VARCHAR(42),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                slot_id VARCHAR(50),
                novelty_name VARCHAR(100)
            );
        `);

        // Ensure raffle IDs start at 7001 (bump sequence if not already there)
        await client.query(`
            DO $$
            BEGIN
                IF (SELECT last_value FROM raffles_id_seq) < 7000 THEN
                    PERFORM setval('raffles_id_seq', 7000, true);
                END IF;
            END $$;
        `);

        // Fix typo: "Bulas" -> "Bullas" in existing raffle titles
        await client.query(`
            UPDATE raffles SET title = REPLACE(title, 'Bulas', 'Bullas') WHERE title LIKE '%Bulas%';
        `);

        // Add threshold columns if they don't exist
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='raffles' AND column_name='threshold_points') THEN
                    ALTER TABLE raffles ADD COLUMN threshold_points INTEGER DEFAULT 5000;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='raffles' AND column_name='threshold_participants') THEN
                    ALTER TABLE raffles ADD COLUMN threshold_participants INTEGER DEFAULT 10;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='raffles' AND column_name='slot_id') THEN
                    ALTER TABLE raffles ADD COLUMN slot_id VARCHAR(50);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='raffles' AND column_name='novelty_name') THEN
                    ALTER TABLE raffles ADD COLUMN novelty_name VARCHAR(100);
                END IF;
            END $$;
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS consumed_queue_items (
                slot_id VARCHAR(50) NOT NULL,
                queue_position INTEGER NOT NULL,
                consumed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (slot_id, queue_position)
            );
        `);
        // One-time migration: reassign raffle IDs < 7001 to start at 7001
        const lowIds = await client.query(`SELECT COUNT(*) FROM raffles WHERE id < 7001`);
        if (parseInt(lowIds.rows[0].count) > 0) {
            console.log('🔄 Reassigning raffle IDs < 7001 to start at 7001...');
            await client.query(`
                DO $$
                DECLARE
                    r RECORD;
                    new_id INT;
                BEGIN
                    new_id := 7001;
                    FOR r IN SELECT id FROM raffles WHERE id < 7001 ORDER BY created_at ASC, id ASC LOOP
                        -- Insert copy with new ID
                        INSERT INTO raffles (id, title, prize_description, image_url, ticket_cost, status,
                            countdown_hours, live_at, ends_at, winner_wallet, total_tickets,
                            unique_participants, total_points_committed, created_by, created_at)
                        SELECT new_id, title, prize_description, image_url, ticket_cost, status,
                            countdown_hours, live_at, ends_at, winner_wallet, total_tickets,
                            unique_participants, total_points_committed, created_by, created_at
                        FROM raffles WHERE id = r.id;
                        -- Re-point entries to new ID
                        UPDATE raffle_entries SET raffle_id = new_id WHERE raffle_id = r.id;
                        -- Remove old row (entries already re-pointed, no cascade)
                        DELETE FROM raffles WHERE id = r.id;
                        new_id := new_id + 1;
                    END LOOP;
                    -- Advance sequence past highest ID
                    PERFORM setval('raffles_id_seq', (SELECT MAX(id) FROM raffles));
                END $$;
            `);
            console.log('✅ Raffle IDs reassigned successfully.');
        }

        // Add block-hash draw columns if not yet present
        await client.query(`
            ALTER TABLE raffles
                ADD COLUMN IF NOT EXISTS close_block        BIGINT,
                ADD COLUMN IF NOT EXISTS draw_block         BIGINT,
                ADD COLUMN IF NOT EXISTS draw_block_hash    VARCHAR(66),
                ADD COLUMN IF NOT EXISTS winning_ticket     BIGINT,
                ADD COLUMN IF NOT EXISTS total_tickets_at_draw BIGINT;
        `);

        // Create raffle_entries table
        await client.query(`
            CREATE TABLE IF NOT EXISTS raffle_entries (
                id SERIAL PRIMARY KEY,
                raffle_id INTEGER REFERENCES raffles(id) ON DELETE CASCADE,
                wallet VARCHAR(42) NOT NULL,
                tickets INTEGER DEFAULT 1,
                points_spent INTEGER NOT NULL,
                purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(raffle_id, wallet)
            );
            CREATE INDEX IF NOT EXISTS idx_raffle_entries_raffle ON raffle_entries(raffle_id);
            CREATE INDEX IF NOT EXISTS idx_raffle_entries_wallet ON raffle_entries(wallet);
        `);

        // App settings (carousel config etc.)
        await client.query(`
            CREATE TABLE IF NOT EXISTS app_settings (
                key VARCHAR(100) PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('✅ Database tables created/verified');

        // Migrate from JSON files if tables are empty
        await migrateFromJSON(client);

        // Populate holders table from existing verified users (one-time migration)
        await populateHoldersFromVerifiedUsers(client);

        // Migrate existing social connections to connection quests (one-time migration)
        await migrateExistingConnectionQuests(client);

        // Ensure raffle sequence is correctly set to the maximum ID
        await client.query(`SELECT setval('raffles_id_seq', COALESCE((SELECT MAX(id) FROM raffles), 7000), true)`);

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

// Migrate existing social connections to connection quests (one-time migration)
// This ensures users who already connected socials get credit for the quests
async function migrateExistingConnectionQuests(client) {
    try {
        // Check if migration already happened by looking for any connect_x = true entries
        const alreadyMigrated = await client.query(
            `SELECT COUNT(*) FROM user_quests WHERE connect_x = TRUE OR connect_discord = TRUE OR connect_telegram = TRUE`
        );
        if (parseInt(alreadyMigrated.rows[0].count) > 0) {
            console.log('📊 Connection quests already migrated, skipping');
            return;
        }

        console.log('🔄 Migrating existing social connections to connection quests...');

        // Get all verified users with their social connections
        const users = await client.query(`
            SELECT wallet, x_username, discord_username, telegram_username
            FROM verified_users
            WHERE x_username IS NOT NULL OR discord_username IS NOT NULL OR telegram_username IS NOT NULL
        `);

        if (users.rows.length === 0) {
            console.log('📊 No users with social connections to migrate');
            return;
        }

        let migratedCount = 0;
        for (const user of users.rows) {
            // Ensure user_quests row exists
            await client.query(
                `INSERT INTO user_quests (wallet) VALUES (LOWER($1)) ON CONFLICT (wallet) DO NOTHING`,
                [user.wallet]
            );

            // Update connection quest flags based on existing connections
            const updates = [];
            const values = [];
            let paramIndex = 1;

            if (user.x_username) {
                updates.push(`connect_x = TRUE, connect_x_at = CURRENT_TIMESTAMP`);
            }
            if (user.discord_username) {
                updates.push(`connect_discord = TRUE, connect_discord_at = CURRENT_TIMESTAMP`);
            }
            if (user.telegram_username) {
                updates.push(`connect_telegram = TRUE, connect_telegram_at = CURRENT_TIMESTAMP`);
            }

            if (updates.length > 0) {
                await client.query(
                    `UPDATE user_quests SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
                     WHERE LOWER(wallet) = LOWER($1)`,
                    [user.wallet]
                );
                migratedCount++;
            }
        }

        console.log(`✅ Migrated ${migratedCount} users' connection quests`);

    } catch (error) {
        console.error('❌ Error migrating connection quests:', error);
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
            { id: 'bg_fuzzy', type: 'background', name: 'Fuzzy Hold', previewUrl: '/Fuzzy_desktop.png', costPoints: 500, isDefault: false },
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
                [data.lastUpdated || new Date().toISOString(), data.minimumAMY || 300]
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
        // Also set referral_season to current season (season2)
        await pool.query(
            `UPDATE referrals SET referred_by = $1, referral_season = 'season2' WHERE LOWER(wallet) = LOWER($2)`,
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
        // Only count referrals from the current season (season2)
        const result = await pool.query(
            `SELECT COUNT(*) as count FROM referrals
             WHERE UPPER(referred_by) = UPPER($1)
             AND last_known_balance >= $2
             AND (referral_season = 'season2' OR referral_season IS NULL)`,
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
    },

    // Archive Dawn season referral data and reset for new season
    archiveDawnSeason: async () => {
        if (!pool) return { success: false, error: 'Database not available' };

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Get all referrals with their valid counts before archiving
            const MINIMUM_AMY = parseInt(process.env.MINIMUM_AMY_BALANCE) || 300;

            // Update dawn_referral_count with current valid referral counts
            // and calculate the multiplier earned
            await client.query(`
                UPDATE referrals r
                SET dawn_referral_count = COALESCE((
                    SELECT COUNT(*) FROM referrals ref
                    WHERE UPPER(ref.referred_by) = UPPER(r.referral_code)
                    AND ref.last_known_balance >= $1
                ), 0)
                WHERE r.referral_code IS NOT NULL
            `, [MINIMUM_AMY]);

            // Set dawn_referral_multiplier based on the count
            await client.query(`
                UPDATE referrals
                SET dawn_referral_multiplier = CASE
                    WHEN dawn_referral_count >= 3 THEN 10
                    WHEN dawn_referral_count >= 2 THEN 5
                    WHEN dawn_referral_count >= 1 THEN 3
                    ELSE 0
                END
            `);

            // Reset referral_count to 0 for Season 2 (but keep the referral links)
            await client.query('UPDATE referrals SET referral_count = 0');

            // Mark all existing referrals as 'dawn' season so they won't count for Season 2
            await client.query(`UPDATE referrals SET referral_season = 'dawn' WHERE referred_by IS NOT NULL`);

            await client.query('COMMIT');

            // Get summary of archived data
            const summary = await pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE dawn_referral_count > 0) as users_with_referrals,
                    COUNT(*) FILTER (WHERE dawn_referral_multiplier = 3) as tier1_users,
                    COUNT(*) FILTER (WHERE dawn_referral_multiplier = 5) as tier2_users,
                    COUNT(*) FILTER (WHERE dawn_referral_multiplier = 10) as tier3_users,
                    SUM(dawn_referral_count) as total_referrals
                FROM referrals
            `);

            return {
                success: true,
                message: 'Dawn season archived successfully',
                summary: summary.rows[0]
            };
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error archiving Dawn season:', error);
            return { success: false, error: error.message };
        } finally {
            client.release();
        }
    },

    // Get Dawn season referral data for a wallet
    getDawnReferralData: async (wallet) => {
        if (!pool) return null;
        const result = await pool.query(
            'SELECT dawn_referral_count as "dawnReferralCount", dawn_referral_multiplier as "dawnReferralMultiplier" FROM referrals WHERE LOWER(wallet) = LOWER($1)',
            [wallet]
        );
        return result.rows[0] || { dawnReferralCount: 0, dawnReferralMultiplier: 0 };
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

        // If xUsername is null, check if holder already exists
        // If they exist, update only the balance; if not, we can't insert without a username
        if (!xUsername) {
            const existingHolder = await holders.getByWallet(wallet);
            if (existingHolder) {
                // Update only the balance for existing holder
                await pool.query(
                    `UPDATE holders SET
                     amy_balance = $1,
                     last_updated_at = CURRENT_TIMESTAMP
                     WHERE LOWER(wallet) = LOWER($2)`,
                    [amyBalance, wallet]
                );
                return { wallet: wallet.toLowerCase(), xUsername: existingHolder.xUsername, amyBalance };
            }
            // Can't insert new holder without xUsername (required field)
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
             lp_multiplier as "lpMultiplier", last_lp_check as "lastLpCheck",
             sailr_value_usd as "sailrValueUsd", sailr_multiplier as "sailrMultiplier",
             plvhedge_value_usd as "plvhedgeValueUsd", plvhedge_multiplier as "plvhedgeMultiplier",
             plsbera_value_usd as "plsberaValueUsd", plsbera_multiplier as "plsberaMultiplier",
             honeybend_value_usd as "honeybendValueUsd", honeybend_multiplier as "honeybendMultiplier",
             stakedbera_value_usd as "stakedberaValueUsd", stakedbera_multiplier as "stakedberaMultiplier",
             surfusd_value_usd as "surfusdValueUsd", surfusd_multiplier as "surfusdMultiplier",
             surfcbbtc_value_usd as "surfcbbtcValueUsd", surfcbbtc_multiplier as "surfcbbtcMultiplier",
             surfweth_value_usd as "surfwethValueUsd", surfweth_multiplier as "surfwethMultiplier",
             bgt_value_usd as "bgtValueUsd", bgt_multiplier as "bgtMultiplier",
             snrusd_value_usd as "snrusdValueUsd", snrusd_multiplier as "snrusdMultiplier",
             jnrusd_value_usd as "jnrusdValueUsd", jnrusd_multiplier as "jnrusdMultiplier",
             amyusdt0_value_usd as "amyusdt0ValueUsd", amyusdt0_multiplier as "amyusdt0Multiplier",
             plskdk_value_usd as "plskdkValueUsd", plskdk_multiplier as "plskdkMultiplier",
             bullas_count as "bullasCount", bullas_multiplier as "bullasMultiplier",
             booga_bullas_count as "boogaBullasCount", booga_bullas_multiplier as "boogaBullasMultiplier",
             raidshark_multiplier as "raidsharkMultiplier",
             onchain_conviction_multiplier as "onchainConvictionMultiplier",
             swapper_multiplier as "swapperMultiplier",
             telegram_mod_multiplier as "telegramModMultiplier",
             discord_mod_multiplier as "discordModMultiplier",
             ember_multiplier as "emberMultiplier",
             genesis_multiplier as "genesisMultiplier"
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

    // Update token holdings data for a user (SAIL.r, plvHEDGE, plsBERA, HONEY-Bend, Staked BERA)
    updateTokenData: async (wallet, sailrValueUsd, sailrMultiplier, plvhedgeValueUsd, plvhedgeMultiplier, plsberaValueUsd, plsberaMultiplier, honeybendValueUsd = 0, honeybendMultiplier = 1, stakedberaValueUsd = 0, stakedberaMultiplier = 1, surfusdValueUsd = 0, surfusdMultiplier = 1, surfcbbtcValueUsd = 0, surfcbbtcMultiplier = 1, surfwethValueUsd = 0, surfwethMultiplier = 1, bgtValueUsd = 0, bgtMultiplier = 1, snrusdValueUsd = 0, snrusdMultiplier = 1, jnrusdValueUsd = 0, jnrusdMultiplier = 1, amyusdt0ValueUsd = 0, amyusdt0Multiplier = 1, plskdkValueUsd = 0, plskdkMultiplier = 1, bullasCount = 0, bullasMultiplier = 1, boogaBullasCount = 0, boogaBullasMultiplier = 1) => {
        if (!pool) return null;
        await pool.query(
            `UPDATE amy_points SET
             sailr_value_usd = $1,
             sailr_multiplier = $2,
             plvhedge_value_usd = $3,
             plvhedge_multiplier = $4,
             plsbera_value_usd = $5,
             plsbera_multiplier = $6,
             honeybend_value_usd = $7,
             honeybend_multiplier = $8,
             stakedbera_value_usd = $9,
             stakedbera_multiplier = $10,
             surfusd_value_usd = $11,
             surfusd_multiplier = $12,
             surfcbbtc_value_usd = $13,
             surfcbbtc_multiplier = $14,
             surfweth_value_usd = $15,
             surfweth_multiplier = $16,
             bgt_value_usd = $17,
             bgt_multiplier = $18,
             snrusd_value_usd = $19,
             snrusd_multiplier = $20,
             jnrusd_value_usd = $21,
             jnrusd_multiplier = $22,
             amyusdt0_value_usd = $23,
             amyusdt0_multiplier = $24,
             plskdk_value_usd = $25,
             plskdk_multiplier = $26,
             bullas_count = $27,
             bullas_multiplier = $28,
             booga_bullas_count = $29,
             booga_bullas_multiplier = $30
             WHERE LOWER(wallet) = LOWER($31)`,
            [sailrValueUsd, sailrMultiplier, plvhedgeValueUsd, plvhedgeMultiplier, plsberaValueUsd, plsberaMultiplier, honeybendValueUsd, honeybendMultiplier, stakedberaValueUsd, stakedberaMultiplier, surfusdValueUsd, surfusdMultiplier, surfcbbtcValueUsd, surfcbbtcMultiplier, surfwethValueUsd, surfwethMultiplier, bgtValueUsd, bgtMultiplier, snrusdValueUsd, snrusdMultiplier, jnrusdValueUsd, jnrusdMultiplier, amyusdt0ValueUsd, amyusdt0Multiplier, plskdkValueUsd, plskdkMultiplier, bullasCount, bullasMultiplier, boogaBullasCount, boogaBullasMultiplier, wallet]
        );
        return { wallet };
    },

    // Update RaidShark multiplier for a user (admin only)
    updateRaidsharkMultiplier: async (wallet, multiplier) => {
        if (!pool) return null;
        // First ensure the user exists in amy_points
        await pool.query(
            `INSERT INTO amy_points (wallet, raidshark_multiplier)
             VALUES (LOWER($1), $2)
             ON CONFLICT (wallet) DO UPDATE SET
             raidshark_multiplier = $2`,
            [wallet, multiplier]
        );
        return { wallet, raidsharkMultiplier: multiplier };
    },

    // Update Onchain Conviction multiplier for a user (admin only)
    updateOnchainConvictionMultiplier: async (wallet, multiplier) => {
        if (!pool) return null;
        // First ensure the user exists in amy_points
        await pool.query(
            `INSERT INTO amy_points (wallet, onchain_conviction_multiplier)
             VALUES (LOWER($1), $2)
             ON CONFLICT (wallet) DO UPDATE SET
             onchain_conviction_multiplier = $2`,
            [wallet, multiplier]
        );
        return { wallet, onchainConvictionMultiplier: multiplier };
    },

    // Get all multiplier badges for a wallet
    getMultiplierBadges: async (wallet) => {
        if (!pool) return null;
        const result = await pool.query(
            `SELECT raidshark_multiplier, onchain_conviction_multiplier, swapper_multiplier, telegram_mod_multiplier, discord_mod_multiplier, ember_multiplier, genesis_multiplier
             FROM amy_points WHERE LOWER(wallet) = LOWER($1)`,
            [wallet]
        );
        const row = result.rows[0];
        return {
            raidsharkMultiplier: row?.raidshark_multiplier || 0,
            onchainConvictionMultiplier: row?.onchain_conviction_multiplier || 0,
            swapperMultiplier: row?.swapper_multiplier || 0,
            telegramModMultiplier: row?.telegram_mod_multiplier || 0,
            discordModMultiplier: row?.discord_mod_multiplier || 0,
            emberMultiplier: row?.ember_multiplier || 0,
            genesisMultiplier: row?.genesis_multiplier || 0
        };
    },

    // Update Swapper multiplier for a user (admin only)
    updateSwapperMultiplier: async (wallet, multiplier) => {
        if (!pool) return null;
        // First ensure the user exists in amy_points
        await pool.query(
            `INSERT INTO amy_points (wallet, swapper_multiplier)
             VALUES (LOWER($1), $2)
             ON CONFLICT (wallet) DO UPDATE SET
             swapper_multiplier = $2`,
            [wallet, multiplier]
        );
        return { wallet, swapperMultiplier: multiplier };
    },

    // Batch update Swapper multipliers (admin only) - resets all first, then applies new list
    batchUpdateSwapperMultipliers: async (updates) => {
        if (!pool || updates.length === 0) return { success: true, updated: 0 };
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // First reset all swapper multipliers to 0
            await client.query('UPDATE amy_points SET swapper_multiplier = 0');
            // Then apply new multipliers
            for (const { wallet, multiplier } of updates) {
                await client.query(
                    `INSERT INTO amy_points (wallet, swapper_multiplier)
                     VALUES (LOWER($1), $2)
                     ON CONFLICT (wallet) DO UPDATE SET
                     swapper_multiplier = $2`,
                    [wallet, multiplier]
                );
            }
            await client.query('COMMIT');
            return { success: true, updated: updates.length };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    // Update Ember multiplier for a user (admin only)
    updateEmberMultiplier: async (wallet, multiplier) => {
        if (!pool) return null;
        await pool.query(
            `INSERT INTO amy_points (wallet, ember_multiplier)
             VALUES (LOWER($1), $2)
             ON CONFLICT (wallet) DO UPDATE SET
             ember_multiplier = $2`,
            [wallet, multiplier]
        );
        return { wallet, emberMultiplier: multiplier };
    },

    // Update Genesis multiplier for a user (admin only)
    updateGenesisMultiplier: async (wallet, multiplier) => {
        if (!pool) return null;
        await pool.query(
            `INSERT INTO amy_points (wallet, genesis_multiplier)
             VALUES (LOWER($1), $2)
             ON CONFLICT (wallet) DO UPDATE SET
             genesis_multiplier = $2`,
            [wallet, multiplier]
        );
        return { wallet, genesisMultiplier: multiplier };
    },

    // Look up wallet address by X username
    getWalletByUsername: async (xUsername) => {
        if (!pool) return null;
        const cleanUsername = xUsername.replace(/^@/, '').trim();

        // First check amy_points table
        let result = await pool.query(
            `SELECT wallet, x_username as "xUsername" FROM amy_points
             WHERE LOWER(x_username) = LOWER($1)`,
            [cleanUsername]
        );

        if (result.rows[0]) {
            return { wallet: result.rows[0].wallet, xUsername: result.rows[0].xUsername };
        }

        // Fall back to verified_users table
        result = await pool.query(
            `SELECT wallet, x_username as "xUsername" FROM verified_users
             WHERE LOWER(x_username) = LOWER($1)`,
            [cleanUsername]
        );

        if (result.rows[0]) {
            return { wallet: result.rows[0].wallet, xUsername: result.rows[0].xUsername };
        }

        return null;
    },

    // Update RaidShark multiplier by X username
    updateRaidsharkByUsername: async (xUsername, multiplier) => {
        if (!pool) return { success: false, error: 'Database not available' };

        const cleanUsername = xUsername.replace(/^@/, '').trim();

        // Look up wallet by username
        let result = await pool.query(
            `SELECT wallet, x_username as "xUsername" FROM amy_points
             WHERE LOWER(x_username) = LOWER($1)`,
            [cleanUsername]
        );

        if (!result.rows[0]) {
            // Check verified_users
            const verified = await pool.query(
                `SELECT wallet, x_username as "xUsername" FROM verified_users
                 WHERE LOWER(x_username) = LOWER($1)`,
                [cleanUsername]
            );

            if (!verified.rows[0]) {
                return { success: false, error: `User @${cleanUsername} not found` };
            }

            // User exists in verified but not amy_points, create entry
            const user = verified.rows[0];
            await pool.query(
                `INSERT INTO amy_points (wallet, x_username, raidshark_multiplier)
                 VALUES (LOWER($1), $2, $3)
                 ON CONFLICT (wallet) DO UPDATE SET
                 x_username = $2, raidshark_multiplier = $3`,
                [user.wallet, user.xUsername, multiplier]
            );
            return { success: true, wallet: user.wallet, xUsername: user.xUsername, multiplier };
        }

        const user = result.rows[0];
        await pool.query(
            `UPDATE amy_points SET raidshark_multiplier = $1 WHERE LOWER(wallet) = LOWER($2)`,
            [multiplier, user.wallet]
        );
        return { success: true, wallet: user.wallet, xUsername: user.xUsername, multiplier };
    },

    // Bulk update RaidShark by usernames
    bulkUpdateRaidsharkByUsername: async (updates) => {
        if (!pool) return { success: false };
        const client = await pool.connect();
        const results = [];
        let successCount = 0;
        let failCount = 0;

        try {
            await client.query('BEGIN');
            // Reset all raidshark multipliers to 1 first
            await client.query('UPDATE amy_points SET raidshark_multiplier = 1');

            for (const { xUsername, multiplier } of updates) {
                const cleanUsername = xUsername.replace(/^@/, '').trim();

                // Look up wallet
                let result = await client.query(
                    `SELECT wallet, x_username as "xUsername" FROM amy_points
                     WHERE LOWER(x_username) = LOWER($1)`,
                    [cleanUsername]
                );

                if (!result.rows[0]) {
                    const verified = await client.query(
                        `SELECT wallet, x_username as "xUsername" FROM verified_users
                         WHERE LOWER(x_username) = LOWER($1)`,
                        [cleanUsername]
                    );

                    if (!verified.rows[0]) {
                        results.push({ xUsername: cleanUsername, success: false, error: 'User not found' });
                        failCount++;
                        continue;
                    }

                    const user = verified.rows[0];
                    await client.query(
                        `INSERT INTO amy_points (wallet, x_username, raidshark_multiplier)
                         VALUES (LOWER($1), $2, $3)
                         ON CONFLICT (wallet) DO UPDATE SET
                         x_username = $2, raidshark_multiplier = $3`,
                        [user.wallet, user.xUsername, multiplier]
                    );
                    results.push({ xUsername: user.xUsername, wallet: user.wallet, multiplier, success: true });
                    successCount++;
                } else {
                    const user = result.rows[0];
                    await client.query(
                        `UPDATE amy_points SET raidshark_multiplier = $1 WHERE LOWER(wallet) = LOWER($2)`,
                        [multiplier, user.wallet]
                    );
                    results.push({ xUsername: user.xUsername, wallet: user.wallet, multiplier, success: true });
                    successCount++;
                }
            }

            await client.query('COMMIT');
            return { success: true, updated: successCount, failed: failCount, results };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    // Bulk update RaidShark multipliers by Telegram username (resets all first)
    bulkUpdateRaidsharkByTelegram: async (updates) => {
        if (!pool) return { success: false };
        const client = await pool.connect();
        const results = [];
        let successCount = 0;
        let failCount = 0;

        try {
            await client.query('BEGIN');
            // Reset all raidshark multipliers to 1 first
            await client.query('UPDATE amy_points SET raidshark_multiplier = 1');

            for (const { telegramUsername, multiplier } of updates) {
                const cleanUsername = telegramUsername.replace(/^@/, '').trim();

                // Look up wallet by telegram_username in verified_users
                const verified = await client.query(
                    `SELECT wallet, telegram_username as "telegramUsername", x_username as "xUsername" FROM verified_users
                     WHERE LOWER(telegram_username) = LOWER($1)`,
                    [cleanUsername]
                );

                if (!verified.rows[0]) {
                    results.push({ telegramUsername: cleanUsername, success: false, error: 'User not found' });
                    failCount++;
                    continue;
                }

                const user = verified.rows[0];
                await client.query(
                    `INSERT INTO amy_points (wallet, x_username, raidshark_multiplier)
                     VALUES (LOWER($1), $2, $3)
                     ON CONFLICT (wallet) DO UPDATE SET
                     raidshark_multiplier = $3`,
                    [user.wallet, user.xUsername, multiplier]
                );
                results.push({ telegramUsername: user.telegramUsername, wallet: user.wallet, multiplier, success: true });
                successCount++;
            }

            await client.query('COMMIT');
            return { success: true, updated: successCount, failed: failCount, results };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    // Bulk update RaidShark multipliers (for monthly CSV import)
    bulkUpdateRaidshark: async (updates) => {
        if (!pool) return { success: false };
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // First reset all raidshark multipliers to 1
            await client.query('UPDATE amy_points SET raidshark_multiplier = 1');
            // Then apply new multipliers
            for (const { wallet, multiplier } of updates) {
                await client.query(
                    `INSERT INTO amy_points (wallet, raidshark_multiplier)
                     VALUES (LOWER($1), $2)
                     ON CONFLICT (wallet) DO UPDATE SET
                     raidshark_multiplier = $2`,
                    [wallet, multiplier]
                );
            }
            await client.query('COMMIT');
            return { success: true, updated: updates.length };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    // Bulk update Onchain Conviction multipliers (resets all first, then applies new list)
    bulkUpdateOnchainConviction: async (updates) => {
        if (!pool) return { success: false };
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // First reset all onchain conviction multipliers to 1
            await client.query('UPDATE amy_points SET onchain_conviction_multiplier = 1');
            // Then apply new multipliers
            for (const { wallet, multiplier } of updates) {
                await client.query(
                    `INSERT INTO amy_points (wallet, onchain_conviction_multiplier)
                     VALUES (LOWER($1), $2)
                     ON CONFLICT (wallet) DO UPDATE SET
                     onchain_conviction_multiplier = $2`,
                    [wallet, multiplier]
                );
            }
            await client.query('COMMIT');
            return { success: true, updated: updates.length };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    // Bulk update Telegram Mod multipliers by username (resets all first)
    bulkUpdateTelegramModByUsername: async (updates) => {
        if (!pool) return { success: false };
        const client = await pool.connect();
        const results = [];
        let successCount = 0;
        let failCount = 0;

        try {
            await client.query('BEGIN');
            // Reset all telegram mod multipliers to 0 first
            await client.query('UPDATE amy_points SET telegram_mod_multiplier = 0');

            for (const { telegramUsername, multiplier } of updates) {
                const cleanUsername = telegramUsername.replace(/^@/, '').trim();

                // Look up wallet by telegram_username in verified_users
                const verified = await client.query(
                    `SELECT wallet, telegram_username as "telegramUsername", x_username as "xUsername" FROM verified_users
                     WHERE LOWER(telegram_username) = LOWER($1)`,
                    [cleanUsername]
                );

                if (!verified.rows[0]) {
                    results.push({ telegramUsername: cleanUsername, success: false, error: 'User not found' });
                    failCount++;
                    continue;
                }

                const user = verified.rows[0];
                await client.query(
                    `INSERT INTO amy_points (wallet, x_username, telegram_mod_multiplier)
                     VALUES (LOWER($1), $2, $3)
                     ON CONFLICT (wallet) DO UPDATE SET
                     telegram_mod_multiplier = $3`,
                    [user.wallet, user.xUsername, multiplier]
                );
                results.push({ telegramUsername: user.telegramUsername, wallet: user.wallet, multiplier, success: true });
                successCount++;
            }

            await client.query('COMMIT');
            return { success: true, updated: successCount, failed: failCount, results };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    // Bulk update Discord Mod multipliers by username (resets all first)
    bulkUpdateDiscordModByUsername: async (updates) => {
        if (!pool) return { success: false };
        const client = await pool.connect();
        const results = [];
        let successCount = 0;
        let failCount = 0;

        try {
            await client.query('BEGIN');
            // Reset all discord mod multipliers to 0 first
            await client.query('UPDATE amy_points SET discord_mod_multiplier = 0');

            for (const { discordUsername, multiplier } of updates) {
                const cleanUsername = discordUsername.replace(/^@/, '').trim();

                // Look up wallet by discord_username in verified_users
                const verified = await client.query(
                    `SELECT wallet, discord_username as "discordUsername", x_username as "xUsername" FROM verified_users
                     WHERE LOWER(discord_username) = LOWER($1)`,
                    [cleanUsername]
                );

                if (!verified.rows[0]) {
                    results.push({ discordUsername: cleanUsername, success: false, error: 'User not found' });
                    failCount++;
                    continue;
                }

                const user = verified.rows[0];
                await client.query(
                    `INSERT INTO amy_points (wallet, x_username, discord_mod_multiplier)
                     VALUES (LOWER($1), $2, $3)
                     ON CONFLICT (wallet) DO UPDATE SET
                     discord_mod_multiplier = $3`,
                    [user.wallet, user.xUsername, multiplier]
                );
                results.push({ discordUsername: user.discordUsername, wallet: user.wallet, multiplier, success: true });
                successCount++;
            }

            await client.query('COMMIT');
            return { success: true, updated: successCount, failed: failCount, results };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
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
    },

    // Add bonus points by wallet address (for quests, check-ins, etc.)
    addBonus: async (wallet, pointsToAdd, category = 'BONUS', description = 'Bonus points') => {
        if (!pool) return { success: false, error: 'Database not available' };
        if (!wallet || pointsToAdd <= 0) return { success: false, error: 'Invalid parameters' };

        // Get user's current data for history logging
        let userData = await pool.query(
            `SELECT wallet, total_points as "totalPoints", last_amy_balance as "lastAmyBalance",
             current_tier as "currentTier"
             FROM amy_points WHERE LOWER(wallet) = LOWER($1)`,
            [wallet]
        );

        // If user doesn't exist in amy_points, create entry
        if (!userData.rows[0]) {
            await pool.query(
                `INSERT INTO amy_points (wallet, total_points, current_tier, points_per_hour)
                 VALUES (LOWER($1), 0, 'none', 0)
                 ON CONFLICT (wallet) DO NOTHING`,
                [wallet]
            );
            userData = await pool.query(
                `SELECT wallet, total_points as "totalPoints", last_amy_balance as "lastAmyBalance",
                 current_tier as "currentTier"
                 FROM amy_points WHERE LOWER(wallet) = LOWER($1)`,
                [wallet]
            );
        }

        const user = userData.rows[0];
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Update total points
            await client.query(
                `UPDATE amy_points SET
                 total_points = total_points + $1,
                 last_points_update = CURRENT_TIMESTAMP
                 WHERE LOWER(wallet) = LOWER($2)`,
                [pointsToAdd, wallet]
            );

            // Log to history
            await client.query(
                `INSERT INTO points_history (wallet, points_earned, reason, amy_balance_at_time, tier_at_time, category, description)
                 VALUES (LOWER($1), $2, $3, $4, $5, $6, $7)`,
                [wallet, pointsToAdd, category, user?.lastAmyBalance || 0, user?.currentTier || 'none', category, description]
            );

            await client.query('COMMIT');

            return {
                success: true,
                wallet: wallet.toLowerCase(),
                pointsAdded: pointsToAdd,
                category,
                description
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
    points_10k: { id: 'points_10k', name: 'Point Master', description: '10,000+ points', icon: '💫' },
    // RaidShark badges
    raidshark_x3: { id: 'raidshark_x3', name: 'Raid Enthusiast', description: 'RaidShark x3 multiplier', icon: '🦈' },
    raidshark_x7: { id: 'raidshark_x7', name: 'Raid Master', description: 'RaidShark x7 multiplier', icon: '🦈' },
    raidshark_x15: { id: 'raidshark_x15', name: 'Raid Legend', description: 'RaidShark x15 multiplier', icon: '🦈' },
    // Onchain Conviction badges
    conviction_x3: { id: 'conviction_x3', name: 'Conviction Level 1', description: 'Onchain Conviction x3', icon: '⛓️' },
    conviction_x5: { id: 'conviction_x5', name: 'Conviction Level 2', description: 'Onchain Conviction x5', icon: '⛓️' },
    conviction_x10: { id: 'conviction_x10', name: 'Conviction Level 3', description: 'Onchain Conviction x10', icon: '⛓️' },
    // Referral badges (new tier system)
    referral_x3: { id: 'referral_x3', name: 'Dawn Referrer', description: '1 referral', icon: '👥' },
    referral_x5: { id: 'referral_x5', name: 'Dawn Ambassador', description: '2 referrals', icon: '👥' },
    referral_x10: { id: 'referral_x10', name: 'Dawn Champion', description: '3+ referrals', icon: '👥' },
    // Seasoned Swapper badges
    swapper_x3: { id: 'swapper_x3', name: 'Engaged Swapper', description: '$250+ monthly swap volume', icon: '🔄' },
    swapper_x5: { id: 'swapper_x5', name: 'Committed Swapper', description: '$1,000+ monthly swap volume', icon: '🔄' },
    swapper_x10: { id: 'swapper_x10', name: 'Elite Swapper', description: '$3,000+ monthly swap volume', icon: '🔄' },
    // HONEY Bend badges
    honeybend_x3: { id: 'honeybend_x3', name: 'HONEY Bend Bronze', description: '$10+ HONEY deposited', icon: '🍯' },
    honeybend_x5: { id: 'honeybend_x5', name: 'HONEY Bend Silver', description: '$100+ HONEY deposited', icon: '🍯' },
    honeybend_x10: { id: 'honeybend_x10', name: 'HONEY Bend Gold', description: '$500+ HONEY deposited', icon: '🍯' },
    // Staked BERA badges
    stakedbera_x3: { id: 'stakedbera_x3', name: 'Staked BERA Bronze', description: '$10+ sWBERA', icon: '🐻' },
    stakedbera_x5: { id: 'stakedbera_x5', name: 'Staked BERA Silver', description: '$100+ sWBERA', icon: '🐻' },
    stakedbera_x10: { id: 'stakedbera_x10', name: 'Staked BERA Gold', description: '$500+ sWBERA', icon: '🐻' },
    // SurfLiquid badges
    surfusd_x3: { id: 'surfusd_x3', name: 'SurfUSD Bronze', description: '$10+ surfUSD', icon: '🏄' },
    surfusd_x5: { id: 'surfusd_x5', name: 'SurfUSD Silver', description: '$100+ surfUSD', icon: '🏄' },
    surfusd_x10: { id: 'surfusd_x10', name: 'SurfUSD Gold', description: '$500+ surfUSD', icon: '🏄' },
    surfcbbtc_x3: { id: 'surfcbbtc_x3', name: 'SurfcbBTC Bronze', description: '$10+ surfcbBTC', icon: '🌊' },
    surfcbbtc_x5: { id: 'surfcbbtc_x5', name: 'SurfcbBTC Silver', description: '$100+ surfcbBTC', icon: '🌊' },
    surfcbbtc_x10: { id: 'surfcbbtc_x10', name: 'SurfcbBTC Gold', description: '$500+ surfcbBTC', icon: '🌊' },
    surfweth_x3: { id: 'surfweth_x3', name: 'SurfWETH Bronze', description: '$10+ surfWETH', icon: '🏄‍♂️' },
    surfweth_x5: { id: 'surfweth_x5', name: 'SurfWETH Silver', description: '$100+ surfWETH', icon: '🏄‍♂️' },
    surfweth_x10: { id: 'surfweth_x10', name: 'SurfWETH Gold', description: '$500+ surfWETH', icon: '🏄‍♂️' },
    // BGT badges
    bgt_x3: { id: 'bgt_x3', name: 'BGT Bronze', description: '$10+ BGT held', icon: '🐻' },
    bgt_x5: { id: 'bgt_x5', name: 'BGT Silver', description: '$100+ BGT held', icon: '🐻' },
    bgt_x10: { id: 'bgt_x10', name: 'BGT Gold', description: '$500+ BGT held', icon: '🐻' },
    // snrUSD badges
    snrusd_x3: { id: 'snrusd_x3', name: 'snrUSD Bronze', description: '$10+ snrUSD held', icon: '💵' },
    snrusd_x5: { id: 'snrusd_x5', name: 'snrUSD Silver', description: '$100+ snrUSD held', icon: '💵' },
    snrusd_x10: { id: 'snrusd_x10', name: 'snrUSD Gold', description: '$500+ snrUSD held', icon: '💵' },
    // jnrUSD badges
    jnrusd_x3: { id: 'jnrusd_x3', name: 'jnrUSD Bronze', description: '$10+ jnrUSD held', icon: '💸' },
    jnrusd_x5: { id: 'jnrusd_x5', name: 'jnrUSD Silver', description: '$100+ jnrUSD held', icon: '💸' },
    jnrusd_x10: { id: 'jnrusd_x10', name: 'jnrUSD Gold', description: '$500+ jnrUSD held', icon: '💸' },
    // Bullas NFT badges
    bullas_x3: { id: 'bullas_x3', name: 'Bullas Bronze', description: '2+ Bullas NFTs held', icon: '🐂' },
    bullas_x5: { id: 'bullas_x5', name: 'Bullas Silver', description: '8+ Bullas NFTs held', icon: '🐂' },
    bullas_x15: { id: 'bullas_x15', name: 'Bullas Gold', description: '28+ Bullas NFTs held', icon: '🐂' },
    // Booga Bullas NFT badges
    booga_bullas_x3: { id: 'booga_bullas_x3', name: 'Booga Bullas Bronze', description: '3+ Booga Bullas NFTs held', icon: '🐂' },
    booga_bullas_x5: { id: 'booga_bullas_x5', name: 'Booga Bullas Silver', description: '13+ Booga Bullas NFTs held', icon: '🐂' },
    booga_bullas_x15: { id: 'booga_bullas_x15', name: 'Booga Bullas Gold', description: '42+ Booga Bullas NFTs held', icon: '🐂' },
    // Ember badges (admin-assigned, referral season)
    ember_x3: { id: 'ember_x3', name: 'Ember Level 1', description: 'Ember referral season x3', icon: '🔥' },
    ember_x5: { id: 'ember_x5', name: 'Ember Level 2', description: 'Ember referral season x5', icon: '🔥' },
    ember_x10: { id: 'ember_x10', name: 'Ember Level 3', description: 'Ember referral season x10', icon: '🔥' },
    // Genesis badges (admin-assigned, OGs)
    genesis_x3: { id: 'genesis_x3', name: 'Genesis Level 1', description: 'Genesis OG Top 50 x3', icon: '⭐' },
    genesis_x5: { id: 'genesis_x5', name: 'Genesis Level 2', description: 'Genesis OG Top 20 x5', icon: '⭐' },
    genesis_x10: { id: 'genesis_x10', name: 'Genesis Level 3', description: 'Genesis OG Top 10 x10', icon: '⭐' }
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

        // Get user data including token holdings and new badge multipliers
        const userData = await pool.query(
            `SELECT v.x_username, p.total_points, p.lp_multiplier, p.lp_value_usd,
             p.sailr_multiplier, p.sailr_value_usd, p.plvhedge_multiplier, p.plvhedge_value_usd,
             p.plsbera_multiplier, p.plsbera_value_usd, p.honeybend_value_usd, p.honeybend_multiplier,
             p.stakedbera_value_usd, p.stakedbera_multiplier, p.surfusd_value_usd, p.surfusd_multiplier,
             p.surfcbbtc_value_usd, p.surfcbbtc_multiplier, p.surfweth_value_usd, p.surfweth_multiplier,
             p.raidshark_multiplier, p.onchain_conviction_multiplier,
             p.swapper_multiplier, p.ember_multiplier, p.genesis_multiplier,
             r.referral_code, r.referral_count,
             p.bullas_count, p.bullas_multiplier, p.booga_bullas_count, p.booga_bullas_multiplier
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

            // HONEY Bend badges
            const honeybendUsd = parseFloat(user.honeybend_value_usd) || 0;
            if (honeybendUsd >= 500) earned.push(BADGE_DEFINITIONS.honeybend_x10);
            else if (honeybendUsd >= 100) earned.push(BADGE_DEFINITIONS.honeybend_x5);
            else if (honeybendUsd >= 10) earned.push(BADGE_DEFINITIONS.honeybend_x3);

            // Staked BERA badges
            const stakedberaUsd = parseFloat(user.stakedbera_value_usd) || 0;
            if (stakedberaUsd >= 500) earned.push(BADGE_DEFINITIONS.stakedbera_x10);
            else if (stakedberaUsd >= 100) earned.push(BADGE_DEFINITIONS.stakedbera_x5);
            else if (stakedberaUsd >= 10) earned.push(BADGE_DEFINITIONS.stakedbera_x3);

            // SurfUSD badges
            const surfusdUsd = parseFloat(user.surfusd_value_usd) || 0;
            if (surfusdUsd >= 500) earned.push(BADGE_DEFINITIONS.surfusd_x10);
            else if (surfusdUsd >= 100) earned.push(BADGE_DEFINITIONS.surfusd_x5);
            else if (surfusdUsd >= 10) earned.push(BADGE_DEFINITIONS.surfusd_x3);

            // SurfcbBTC badges
            const surfcbbtcUsd = parseFloat(user.surfcbbtc_value_usd) || 0;
            if (surfcbbtcUsd >= 500) earned.push(BADGE_DEFINITIONS.surfcbbtc_x10);
            else if (surfcbbtcUsd >= 100) earned.push(BADGE_DEFINITIONS.surfcbbtc_x5);
            else if (surfcbbtcUsd >= 10) earned.push(BADGE_DEFINITIONS.surfcbbtc_x3);

            // SurfWETH badges
            const surfwethUsd = parseFloat(user.surfweth_value_usd) || 0;
            if (surfwethUsd >= 500) earned.push(BADGE_DEFINITIONS.surfweth_x10);
            else if (surfwethUsd >= 100) earned.push(BADGE_DEFINITIONS.surfweth_x5);
            else if (surfwethUsd >= 10) earned.push(BADGE_DEFINITIONS.surfweth_x3);

            // BGT badges
            const bgtUsd = parseFloat(user.bgt_value_usd) || 0;
            if (bgtUsd >= 500) earned.push(BADGE_DEFINITIONS.bgt_x10);
            else if (bgtUsd >= 100) earned.push(BADGE_DEFINITIONS.bgt_x5);
            else if (bgtUsd >= 10) earned.push(BADGE_DEFINITIONS.bgt_x3);

            // snrUSD badges
            const snrusdUsd = parseFloat(user.snrusd_value_usd) || 0;
            if (snrusdUsd >= 500) earned.push(BADGE_DEFINITIONS.snrusd_x10);
            else if (snrusdUsd >= 100) earned.push(BADGE_DEFINITIONS.snrusd_x5);
            else if (snrusdUsd >= 10) earned.push(BADGE_DEFINITIONS.snrusd_x3);

            // jnrUSD badges
            const jnrusdUsd = parseFloat(user.jnrusd_value_usd) || 0;
            if (jnrusdUsd >= 500) earned.push(BADGE_DEFINITIONS.jnrusd_x10);
            else if (jnrusdUsd >= 100) earned.push(BADGE_DEFINITIONS.jnrusd_x5);
            else if (jnrusdUsd >= 10) earned.push(BADGE_DEFINITIONS.jnrusd_x3);

            // Bullas NFT badges (count-based)
            const bullasCount = parseInt(user.bullas_count) || 0;
            if (bullasCount >= 28) earned.push(BADGE_DEFINITIONS.bullas_x15);
            else if (bullasCount >= 8) earned.push(BADGE_DEFINITIONS.bullas_x5);
            else if (bullasCount >= 2) earned.push(BADGE_DEFINITIONS.bullas_x3);

            // Booga Bullas NFT badges (count-based)
            const boogaBullasCount = parseInt(user.booga_bullas_count) || 0;
            if (boogaBullasCount >= 42) earned.push(BADGE_DEFINITIONS.booga_bullas_x15);
            else if (boogaBullasCount >= 13) earned.push(BADGE_DEFINITIONS.booga_bullas_x5);
            else if (boogaBullasCount >= 3) earned.push(BADGE_DEFINITIONS.booga_bullas_x3);

            // RaidShark badges (based on multiplier assigned by admin)
            const raidsharkMult = parseInt(user.raidshark_multiplier) || 0;
            if (raidsharkMult >= 15) earned.push(BADGE_DEFINITIONS.raidshark_x15);
            else if (raidsharkMult >= 7) earned.push(BADGE_DEFINITIONS.raidshark_x7);
            else if (raidsharkMult >= 3) earned.push(BADGE_DEFINITIONS.raidshark_x3);

            // Onchain Conviction badges (based on multiplier assigned by admin)
            const convictionMult = parseInt(user.onchain_conviction_multiplier) || 0;
            if (convictionMult >= 10) earned.push(BADGE_DEFINITIONS.conviction_x10);
            else if (convictionMult >= 5) earned.push(BADGE_DEFINITIONS.conviction_x5);
            else if (convictionMult >= 3) earned.push(BADGE_DEFINITIONS.conviction_x3);

            // Ember badges (admin-assigned)
            const emberMult = parseInt(user.ember_multiplier) || 0;
            if (emberMult >= 10) earned.push(BADGE_DEFINITIONS.ember_x10);
            else if (emberMult >= 5) earned.push(BADGE_DEFINITIONS.ember_x5);
            else if (emberMult >= 3) earned.push(BADGE_DEFINITIONS.ember_x3);

            // Genesis badges (admin-assigned)
            const genesisMult = parseInt(user.genesis_multiplier) || 0;
            if (genesisMult >= 10) earned.push(BADGE_DEFINITIONS.genesis_x10);
            else if (genesisMult >= 5) earned.push(BADGE_DEFINITIONS.genesis_x5);
            else if (genesisMult >= 3) earned.push(BADGE_DEFINITIONS.genesis_x3);

            // Seasoned Swapper badges (based on multiplier assigned by admin)
            const swapperMult = parseInt(user.swapper_multiplier) || 0;
            if (swapperMult >= 10) earned.push(BADGE_DEFINITIONS.swapper_x10);
            else if (swapperMult >= 5) earned.push(BADGE_DEFINITIONS.swapper_x5);
            else if (swapperMult >= 3) earned.push(BADGE_DEFINITIONS.swapper_x3);

            // Referral badges - calculate valid referral count dynamically
            let validRefs = 0;
            if (user.referral_code) {
                const MINIMUM_AMY = parseInt(process.env.MINIMUM_AMY_BALANCE) || 300;
                const refResult = await pool.query(
                    'SELECT COUNT(*) as count FROM referrals WHERE UPPER(referred_by) = UPPER($1) AND last_known_balance >= $2',
                    [user.referral_code, MINIMUM_AMY]
                );
                validRefs = parseInt(refResult.rows[0].count) || 0;
            }

            // Referral badges (old system - kept for backwards compatibility)
            if (validRefs >= 10) earned.push(BADGE_DEFINITIONS.referrer_10);
            else if (validRefs >= 5) earned.push(BADGE_DEFINITIONS.referrer_5);

            // Referral badges (new multiplier-based system: 1=x3, 2=x5, 3+=x10)
            if (validRefs >= 3) earned.push(BADGE_DEFINITIONS.referral_x10);
            else if (validRefs >= 2) earned.push(BADGE_DEFINITIONS.referral_x5);
            else if (validRefs >= 1) earned.push(BADGE_DEFINITIONS.referral_x3);

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

// Daily check-in helper functions
const checkin = {
    // Get check-in data for a user
    getData: async (wallet) => {
        if (!pool) return null;
        const result = await pool.query(
            `SELECT last_checkin_date, current_streak_day, streak_points_total, total_checkins
             FROM daily_checkins WHERE LOWER(wallet) = LOWER($1)`,
            [wallet]
        );

        const row = result.rows[0];
        if (!row) {
            return {
                lastCheckinDate: null,
                currentStreakDay: 0,
                streakPointsTotal: 0,
                canCheckIn: true,
                nextCheckInTime: null
            };
        }

        // Check if user can check in today
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const lastCheckin = row.last_checkin_date ? new Date(row.last_checkin_date) : null;
        if (lastCheckin) lastCheckin.setHours(0, 0, 0, 0);

        const canCheckIn = !lastCheckin || lastCheckin.getTime() < today.getTime();

        // Calculate next check-in time (next midnight)
        let nextCheckInTime = null;
        if (!canCheckIn) {
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            nextCheckInTime = tomorrow.toISOString();
        }

        return {
            lastCheckinDate: row.last_checkin_date,
            currentStreakDay: row.current_streak_day,
            streakPointsTotal: row.streak_points_total,
            canCheckIn,
            nextCheckInTime
        };
    },

    // Perform check-in for a user
    doCheckIn: async (wallet) => {
        if (!pool) return { success: false, error: 'Database not available' };

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        // Get current check-in data
        const current = await checkin.getData(wallet);
        if (!current.canCheckIn) {
            return { success: false, error: 'Already checked in today', data: current };
        }

        // Calculate new streak
        let newStreakDay = 1;
        let streakPointsTotal = 0;

        if (current.lastCheckinDate) {
            const lastCheckin = new Date(current.lastCheckinDate);
            lastCheckin.setHours(0, 0, 0, 0);

            // If last check-in was yesterday, continue streak
            if (lastCheckin.getTime() === yesterday.getTime()) {
                newStreakDay = (current.currentStreakDay % 7) + 1; // Cycle 1-7
                streakPointsTotal = current.streakPointsTotal;
            }
            // Otherwise streak resets
        }

        // Calculate points for this day
        let pointsAwarded = 50; // Days 1-4
        if (newStreakDay === 5 || newStreakDay === 6) {
            pointsAwarded = 75;
        } else if (newStreakDay === 7) {
            pointsAwarded = 150;
        }

        streakPointsTotal += pointsAwarded;

        // Update database
        await pool.query(
            `INSERT INTO daily_checkins (wallet, last_checkin_date, current_streak_day, streak_points_total, total_checkins)
             VALUES (LOWER($1), $2, $3, $4, 1)
             ON CONFLICT (wallet) DO UPDATE SET
             last_checkin_date = $2,
             current_streak_day = $3,
             streak_points_total = $4,
             total_checkins = daily_checkins.total_checkins + 1,
             updated_at = CURRENT_TIMESTAMP`,
            [wallet, today.toISOString().split('T')[0], newStreakDay, streakPointsTotal]
        );

        // Add points to user's total via the points system
        await points.addBonus(wallet, pointsAwarded, 'CHECK_IN', `Day ${newStreakDay} check-in bonus`);

        return {
            success: true,
            data: {
                lastCheckinDate: today.toISOString().split('T')[0],
                currentStreakDay: newStreakDay,
                streakPointsTotal,
                canCheckIn: false,
                nextCheckInTime: new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString(),
                pointsAwarded
            }
        };
    }
};

// Quest helper functions
const quests = {
    // Get quest data for a user
    getData: async (wallet) => {
        if (!pool) return null;
        const result = await pool.query(
            `SELECT follow_amy_x, join_amy_discord, join_amy_telegram, follow_amy_instagram,
                    connect_x, connect_discord, connect_telegram, quest_points_earned
             FROM user_quests WHERE LOWER(wallet) = LOWER($1)`,
            [wallet]
        );

        const row = result.rows[0];
        return {
            followAmyX: row?.follow_amy_x || false,
            joinAmyDiscord: row?.join_amy_discord || false,
            joinAmyTelegram: row?.join_amy_telegram || false,
            followAmyInstagram: row?.follow_amy_instagram || false,
            connectX: row?.connect_x || false,
            connectDiscord: row?.connect_discord || false,
            connectTelegram: row?.connect_telegram || false,
            questPointsEarned: row?.quest_points_earned || 0
        };
    },

    // Complete a quest
    completeQuest: async (wallet, questId) => {
        if (!pool) return { success: false, error: 'Database not available' };

        const questMap = {
            followAmyX: { column: 'follow_amy_x', atColumn: 'follow_amy_x_at', points: 150 },
            joinAmyDiscord: { column: 'join_amy_discord', atColumn: 'join_amy_discord_at', points: 150 },
            joinAmyTelegram: { column: 'join_amy_telegram', atColumn: 'join_amy_telegram_at', points: 150 },
            followAmyInstagram: { column: 'follow_amy_instagram', atColumn: 'follow_amy_instagram_at', points: 150 },
            connectX: { column: 'connect_x', atColumn: 'connect_x_at', points: 100 },
            connectDiscord: { column: 'connect_discord', atColumn: 'connect_discord_at', points: 100 },
            connectTelegram: { column: 'connect_telegram', atColumn: 'connect_telegram_at', points: 100 }
        };

        const quest = questMap[questId];
        if (!quest) {
            return { success: false, error: 'Invalid quest ID' };
        }

        // Check if already completed
        const current = await quests.getData(wallet);
        if (current[questId]) {
            return { success: false, error: 'Quest already completed' };
        }

        // Ensure row exists
        await pool.query(
            `INSERT INTO user_quests (wallet)
             VALUES (LOWER($1))
             ON CONFLICT (wallet) DO NOTHING`,
            [wallet]
        );

        // Complete quest
        await pool.query(
            `UPDATE user_quests SET
             ${quest.column} = TRUE,
             ${quest.atColumn} = CURRENT_TIMESTAMP,
             quest_points_earned = quest_points_earned + $1,
             updated_at = CURRENT_TIMESTAMP
             WHERE LOWER(wallet) = LOWER($2)`,
            [quest.points, wallet]
        );

        // Add points
        await points.addBonus(wallet, quest.points, 'QUEST', `Quest completed: ${questId}`);

        return { success: true, pointsAwarded: quest.points };
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

// Raffle helper functions
const raffles = {
    getAll: async () => {
        if (!pool) return [];
        const result = await pool.query(
            `SELECT * FROM raffles WHERE status IN ('TNM','LIVE','DRAW_PENDING') ORDER BY created_at DESC`
        );
        return result.rows;
    },

    getById: async (id) => {
        if (!pool) return null;
        const result = await pool.query(
            `SELECT * FROM raffles WHERE id = $1`,
            [id]
        );
        return result.rows[0] || null;
    },

    getHistory: async () => {
        if (!pool) return [];
        const result = await pool.query(
            `SELECT * FROM raffles WHERE status IN ('COMPLETED','CANCELLED') ORDER BY ends_at DESC LIMIT 50`
        );
        return result.rows;
    },

    clearAllRaffles: async () => {
        if (!pool) return { success: false };
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("DELETE FROM raffle_entries");
            await client.query("DELETE FROM raffles");
            await client.query("SELECT setval('raffles_id_seq', 7000, true)");
            await client.query("COMMIT");
            return { success: true };
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }
    },

    create: async (title, description, imageUrl, countdownHours, createdBy, thresholdPoints = 5000, thresholdParticipants = 10, slotId = null, noveltyName = null) => {
        if (!pool) return null;
        const result = await pool.query(
            `INSERT INTO raffles (title, prize_description, image_url, countdown_hours, created_by, threshold_points, threshold_participants, slot_id, novelty_name)
             VALUES ($1, $2, $3, $4, LOWER($5), $6, $7, $8, $9)
             RETURNING *`,
            [title, description, imageUrl, countdownHours, createdBy, thresholdPoints || 5000, thresholdParticipants || 10, slotId, noveltyName]
        );
        return result.rows[0];
    },

    getUserEntries: async (wallet) => {
        if (!pool) return [];
        const result = await pool.query(
            `SELECT re.raffle_id, re.tickets, re.points_spent, re.purchased_at,
                    r.title, r.status, r.ends_at, r.winner_wallet, r.image_url
             FROM raffle_entries re
             JOIN raffles r ON r.id = re.raffle_id
             WHERE LOWER(re.wallet) = LOWER($1)
             ORDER BY re.purchased_at DESC`,
            [wallet]
        );
        return result.rows;
    },

    buyTickets: async (wallet, raffleId, quantity, pointCost) => {
        if (!pool) return { success: false, error: 'Database not available' };
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Lock raffle row
            const raffleRes = await client.query(
                `SELECT * FROM raffles WHERE id = $1 FOR UPDATE`,
                [raffleId]
            );
            const raffle = raffleRes.rows[0];
            if (!raffle) {
                await client.query('ROLLBACK');
                return { success: false, error: 'Raffle not found' };
            }
            if (raffle.status === 'COMPLETED' || raffle.status === 'CANCELLED' || raffle.status === 'DRAW_PENDING') {
                await client.query('ROLLBACK');
                return { success: false, error: 'Raffle is no longer accepting tickets' };
            }

            // Check user points
            const pointsRes = await client.query(
                `SELECT total_points FROM amy_points WHERE LOWER(wallet) = LOWER($1)`,
                [wallet]
            );
            const userPoints = pointsRes.rows[0]?.total_points || 0;
            if (userPoints < pointCost) {
                await client.query('ROLLBACK');
                return { success: false, error: 'Insufficient points' };
            }

            // Deduct points
            await client.query(
                `UPDATE amy_points SET total_points = total_points - $1,
                 last_points_update = CURRENT_TIMESTAMP
                 WHERE LOWER(wallet) = LOWER($2)`,
                [pointCost, wallet]
            );

            // Log points history
            await client.query(
                `INSERT INTO points_history (wallet, points_earned, reason, amy_balance_at_time, tier_at_time, category, description)
                 VALUES (LOWER($1), $2, 'RAFFLE_ENTRY', 0, 'none', 'RAFFLE_ENTRY', $3)`,
                [wallet, -pointCost, `Bought ${quantity} ticket(s) for raffle #${raffleId}: ${raffle.title}`]
            );

            // Upsert raffle_entries
            await client.query(
                `INSERT INTO raffle_entries (raffle_id, wallet, tickets, points_spent)
                 VALUES ($1, LOWER($2), $3, $4)
                 ON CONFLICT (raffle_id, wallet) DO UPDATE SET
                 tickets = raffle_entries.tickets + $3,
                 points_spent = raffle_entries.points_spent + $4`,
                [raffleId, wallet, quantity, pointCost]
            );

            // Update raffle totals
            await client.query(
                `UPDATE raffles SET
                 total_tickets = total_tickets + $1,
                 total_points_committed = total_points_committed + $2,
                 unique_participants = (SELECT COUNT(DISTINCT wallet) FROM raffle_entries WHERE raffle_id = $3)
                 WHERE id = $3`,
                [quantity, pointCost, raffleId]
            );

            // Check threshold and potentially go LIVE
            const updatedRaffle = await client.query(
                `SELECT * FROM raffles WHERE id = $1`,
                [raffleId]
            );
            const r = updatedRaffle.rows[0];
            if (r.status === 'TNM' && r.total_points_committed >= (r.threshold_points || 5000) && r.unique_participants >= (r.threshold_participants || 10)) {
                await client.query(
                    `UPDATE raffles SET status = 'LIVE',
                     live_at = NOW(),
                     ends_at = NOW() + ($1 || ' hours')::interval
                     WHERE id = $2`,
                    [r.countdown_hours, raffleId]
                );
            }

            await client.query('COMMIT');
            return { success: true };
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('buyTickets error:', err);
            return { success: false, error: err.message };
        } finally {
            client.release();
        }
    },

    cancel: async (raffleId, refund) => {
        if (!pool) return { success: false, error: 'Database not available' };
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            await client.query(
                `UPDATE raffles SET status = 'CANCELLED' WHERE id = $1`,
                [raffleId]
            );

            if (refund) {
                const entries = await client.query(
                    `SELECT wallet, points_spent FROM raffle_entries WHERE raffle_id = $1`,
                    [raffleId]
                );
                for (const entry of entries.rows) {
                    await client.query(
                        `UPDATE amy_points SET total_points = total_points + $1,
                         last_points_update = CURRENT_TIMESTAMP
                         WHERE LOWER(wallet) = LOWER($2)`,
                        [entry.points_spent, entry.wallet]
                    );
                    await client.query(
                        `INSERT INTO points_history (wallet, points_earned, reason, amy_balance_at_time, tier_at_time, category, description)
                         VALUES (LOWER($1), $2, 'RAFFLE_REFUND', 0, 'none', 'RAFFLE_ENTRY', 'Raffle cancelled - points refunded')`,
                        [entry.wallet, entry.points_spent]
                    );
                }
            }

            await client.query('COMMIT');
            return { success: true };
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('cancel raffle error:', err);
            return { success: false, error: err.message };
        } finally {
            client.release();
        }
    },

    // Phase 1 — called when countdown expires: freeze entries, record closeBlock, set DRAW_PENDING
    initiateDraw: async (raffleId) => {
        if (!pool) return { success: false, error: 'Database not available' };

        const entries = await pool.query(
            `SELECT wallet, tickets FROM raffle_entries WHERE raffle_id = $1`,
            [raffleId]
        );

        // No entries → complete immediately with no winner
        if (!entries.rows.length) {
            await pool.query(
                `UPDATE raffles SET status = 'COMPLETED', ends_at = NOW() WHERE id = $1`,
                [raffleId]
            );
            return { success: true, winner: null };
        }

        // Fetch current Berachain block
        const { ethers } = require('ethers');
        const provider = new ethers.providers.JsonRpcProvider('https://rpc.berachain.com');
        const closeBlock = await provider.getBlockNumber();
        const N_BLOCKS_DELAY = 300;
        const drawBlock = closeBlock + N_BLOCKS_DELAY;

        await pool.query(
            `UPDATE raffles
             SET status = 'DRAW_PENDING', close_block = $1, draw_block = $2
             WHERE id = $3`,
            [closeBlock, drawBlock, raffleId]
        );

        console.log(`🎟️ Raffle ${raffleId} → DRAW_PENDING. closeBlock=${closeBlock}, drawBlock=${drawBlock}`);
        return { success: true, drawBlock };
    },

    // Phase 2 — called once drawBlock + CONFIRMATIONS is reached: fetch hash, select winner
    completeDraw: async (raffleId, drawBlock) => {
        if (!pool) return { success: false, error: 'Database not available' };

        const { ethers } = require('ethers');
        const provider = new ethers.providers.JsonRpcProvider('https://rpc.berachain.com');
        const CONFIRMATIONS = 5;

        const currentBlock = await provider.getBlockNumber();
        if (currentBlock < drawBlock + CONFIRMATIONS) return { success: false, notReady: true };

        // Fetch the draw block hash
        const block = await provider.getBlock(drawBlock);
        const blockHash = block.hash; // 32-byte hex string, 0x-prefixed

        // Build entrants: only purchases on/before closeTs, sorted ascending by wallet
        const raffle = await pool.query(`SELECT ends_at FROM raffles WHERE id = $1`, [raffleId]);
        const closeTs = raffle.rows[0]?.ends_at;

        const entries = await pool.query(
            `SELECT wallet, tickets FROM raffle_entries
             WHERE raffle_id = $1 AND purchased_at <= $2
             ORDER BY wallet ASC`,
            [raffleId, closeTs]
        );

        if (!entries.rows.length) {
            await pool.query(
                `UPDATE raffles SET status = 'COMPLETED', draw_block_hash = $1 WHERE id = $2`,
                [blockHash, raffleId]
            );
            return { success: true, winner: null };
        }

        // Aggregate tickets per wallet (already unique per wallet in raffle_entries, but be safe)
        const walletMap = new Map();
        for (const row of entries.rows) {
            const w = row.wallet.toLowerCase();
            walletMap.set(w, (walletMap.get(w) || 0) + parseInt(row.tickets));
        }
        const entrants = Array.from(walletMap.entries())
            .map(([wallet, ticketCount]) => ({ wallet, ticketCount }))
            .sort((a, b) => a.wallet.localeCompare(b.wallet));

        const totalTickets = entrants.reduce((s, e) => s + e.ticketCount, 0);

        // Compute seed: keccak256(keccak256(UTF8(raffleId)) || blockHash)
        const raffleIdHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(String(raffleId)));
        const payload = ethers.utils.concat([raffleIdHash, blockHash]);
        const seed = ethers.utils.keccak256(payload);

        // winning ticket in [1..totalTickets]
        const winningTicket = BigInt(1) + (BigInt(seed) % BigInt(totalTickets));

        // Range method to find winner
        let cursor = BigInt(1);
        let winner = entrants[0].wallet;
        for (const { wallet, ticketCount } of entrants) {
            const start = cursor;
            const end = cursor + BigInt(ticketCount) - BigInt(1);
            if (winningTicket >= start && winningTicket <= end) {
                winner = wallet;
                break;
            }
            cursor = end + BigInt(1);
        }

        await pool.query(
            `UPDATE raffles
             SET status = 'COMPLETED',
                 winner_wallet       = LOWER($1),
                 draw_block_hash     = $2,
                 winning_ticket      = $3,
                 total_tickets_at_draw = $4
             WHERE id = $5`,
            [winner, blockHash, winningTicket.toString(), totalTickets, raffleId]
        );

        console.log(`🏆 Raffle ${raffleId} winner: ${winner} (ticket ${winningTicket}/${totalTickets}, block ${drawBlock})`);
        return { success: true, winner };
    },

    // Legacy manual draw — kept for admin override only (uses block hash if available, falls back to initiate)
    drawWinner: async (raffleId) => {
        return raffles.initiateDraw(raffleId);
    },

    checkAndDraw: async () => {
        if (!pool) return;

        // Phase 1: expire LIVE raffles → DRAW_PENDING
        const expired = await pool.query(
            `SELECT id FROM raffles WHERE status = 'LIVE' AND ends_at <= NOW()`
        );
        for (const row of expired.rows) {
            try {
                await raffles.initiateDraw(row.id);
            } catch (err) {
                console.error(`Error initiating draw for raffle ${row.id}:`, err);
            }
        }

        // Phase 2: complete pending draws where draw_block is ready
        const pending = await pool.query(
            `SELECT id, draw_block FROM raffles WHERE status = 'DRAW_PENDING' AND draw_block IS NOT NULL`
        );
        for (const row of pending.rows) {
            try {
                const result = await raffles.completeDraw(row.id, row.draw_block);
                if (result.success && !result.notReady) {
                    console.log(`🎟️ Draw completed for raffle ${row.id}, winner: ${result.winner}`);
                }
            } catch (err) {
                console.error(`Error completing draw for raffle ${row.id}:`, err);
            }
        }
    },

    deleteRaffle: async (raffleId) => {
        if (!pool) return { success: false, error: 'Database not available' };
        // raffle_entries cascade-deletes due to ON DELETE CASCADE
        const result = await pool.query(
            `DELETE FROM raffles WHERE id = $1 RETURNING id, title`,
            [raffleId]
        );
        if (!result.rows[0]) return { success: false, error: 'Raffle not found' };
        return { success: true, deleted: result.rows[0] };
    }
};

// Default carousel settings
const DEFAULT_CAROUSEL_SETTINGS = {
    frame: '/frame.png',
    novelties: ['/novelty-1.png', '/novelty-2.png', '/novelty-3.png', '/novelty-4.png', '/novelty-5.png'],
};

const appSettings = {
    get: async (key) => {
        if (!pool) return null;
        const result = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
        if (!result.rows[0]) return null;
        try { return JSON.parse(result.rows[0].value); } catch { return result.rows[0].value; }
    },
    set: async (key, value) => {
        if (!pool) return false;
        await pool.query(
            `INSERT INTO app_settings (key, value, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
            [key, JSON.stringify(value)]
        );
        return true;
    },
    getCarouselSettings: async () => {
        if (!pool) return DEFAULT_CAROUSEL_SETTINGS;
        const result = await pool.query(`SELECT value FROM app_settings WHERE key = 'carousel_settings'`);
        if (!result.rows[0]) return DEFAULT_CAROUSEL_SETTINGS;
        try { return { ...DEFAULT_CAROUSEL_SETTINGS, ...JSON.parse(result.rows[0].value) }; }
        catch { return DEFAULT_CAROUSEL_SETTINGS; }
    },
    saveCarouselSettings: async (settings) => {
        if (!pool) return false;
        await pool.query(
            `INSERT INTO app_settings (key, value, updated_at)
             VALUES ('carousel_settings', $1, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
            [JSON.stringify(settings)]
        );
        return true;
    },
};

module.exports = {
    initDatabase,
    get pool() { return pool; },
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
    checkin,
    quests,
    raffles,
    appSettings,
    POINTS_TIERS,
    POINTS_CATEGORIES,
    CATEGORY_DESCRIPTIONS,
    BADGE_DEFINITIONS
};
