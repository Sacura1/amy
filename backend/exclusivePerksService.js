const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

// ─── Constants ────────────────────────────────────────────────────────────────
const SAILR_USER_DISCOUNT   = 0.18;
const SAILR_AMY_DISCOUNT    = 0.20;
const SAILR_QUOTE_TTL_MS    = 120 * 1000;
const JNRUSD_COOLDOWN_DAYS  = 7;

// Hardcoded allocation caps (0 = unlimited / not yet set; update via admin endpoint)
// Caps are in primary units: SAIL.r tokens and USDE respectively
const DEFAULT_SAILR_CAP  = 0;
const DEFAULT_JNRUSD_CAP = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function nextDayUtcMidnight(fromDate = new Date()) {
    const d = new Date(fromDate);
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

function addMonths(date, months) {
    const d = new Date(date);
    d.setUTCMonth(d.getUTCMonth() + months);
    return d;
}

function addDays(date, days) {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
}

function fmtUtc(date) {
    if (!date) return '';
    const d = new Date(date);
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

// ─── In-memory quote stores ───────────────────────────────────────────────────
const activeQuotes = new Map();
const activeJnrusdQuotes = new Map();

function pruneExpiredQuotes() {
    const now = Date.now();
    for (const [id, q] of activeQuotes) {
        if (q.expiresAt < now) activeQuotes.delete(id);
    }
}

function pruneExpiredJnrusdQuotes() {
    const now = Date.now();
    for (const [id, q] of activeJnrusdQuotes) {
        if (q.expiresAt < now) activeJnrusdQuotes.delete(id);
    }
}

// ─── Live jnrUSD share price from vault contract ──────────────────────────────
const JNRUSD_VAULT_ADDRESS = '0x5f6eE0cc57862EAfAD1a572819B6Dc1485B95E46';
const JNRUSD_VAULT_ABI = [
    'function decimals() view returns (uint8)',
    'function convertToAssets(uint256 shares) view returns (uint256)',
];

async function getLiveJnrusdSharePrice() {
    const { ethers } = require('ethers');
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.berachain.com');
    const vault = new ethers.Contract(JNRUSD_VAULT_ADDRESS, JNRUSD_VAULT_ABI, provider);
    const decimals = await vault.decimals();
    const oneShare = ethers.BigNumber.from(10).pow(decimals);
    const assets = await vault.convertToAssets(oneShare);
    return parseFloat(ethers.utils.formatUnits(assets, decimals));
}

// ─── Pricing logic ────────────────────────────────────────────────────────────
function buildSailrQuote(liveSailPrice, usdeAmount) {
    const discountedSailPrice = liveSailPrice * (1 - SAILR_USER_DISCOUNT);
    const actualAcqPrice      = liveSailPrice * (1 - SAILR_AMY_DISCOUNT);
    const sailAmountOutput    = usdeAmount / discountedSailPrice;
    const actualSailAcquired  = usdeAmount / actualAcqPrice;
    const sailMarginToAmy     = actualSailAcquired - sailAmountOutput;

    return {
        liveSailPrice,
        discountPercent:      SAILR_USER_DISCOUNT * 100,
        discountedSailPrice,
        usdeAmountInput:      usdeAmount,
        honeyAmountInput:     usdeAmount, // Backward compatibility for older clients
        sailAmountOutput,
        sailMarginToAmy,
    };
}

// ─── Google Sheets append ─────────────────────────────────────────────────────
class ExclusivePerksSheets {
    constructor() {
        this.sheets  = null;
        this.sailrId = process.env.SAILR_PURCHASES_SHEET_ID   || '1Dc2WpN4eSNol-zrR9cBHwDVoi7xZESuEmLOfrbhPchw';
        this.jnrId   = process.env.JNRUSD_POSITIONS_SHEET_ID  || '1p3VgeoLLz4UgouWzQCTwCdXdHpkwEmyu0RvULf9Km3w';
    }

    async _ensureSheets() {
        if (this.sheets) return true;
        const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
        if (!key) {
            console.warn('⚠️  [ExclusiveSheets] GOOGLE_SERVICE_ACCOUNT_KEY not set — sheet logging disabled');
            return false;
        }
        try {
            const creds = JSON.parse(key);
            const auth  = new google.auth.GoogleAuth({
                credentials: creds,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
            this.sheets = google.sheets({ version: 'v4', auth });
            console.log('✅ [ExclusiveSheets] Google Sheets auth initialized');
            return true;
        } catch (err) {
            console.error('❌ [ExclusiveSheets] Auth init failed:', err.message);
            return false;
        }
    }

    async _append(spreadsheetId, values) {
        if (!await this._ensureSheets()) return;
        const label = spreadsheetId === this.sailrId ? 'SAIL.r' : 'jnrUSD';
        try {
            await this.sheets.spreadsheets.values.append({
                spreadsheetId,
                range: 'Sheet1!A1',
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                requestBody: { values: [values] },
            });
            console.log(`📋 [ExclusiveSheets] Row appended to ${label} sheet (${spreadsheetId})`);
        } catch (err) {
            console.error(`❌ [ExclusiveSheets] Append failed on ${label} sheet:`, err.message);
        }
    }

    // Find existing row by positionId (col A) and update specific columns by index (0-based)
    async _updateRow(spreadsheetId, positionId, colUpdates) {
        if (!await this._ensureSheets()) return;
        const label = spreadsheetId === this.sailrId ? 'SAIL.r' : 'jnrUSD';
        try {
            const res = await this.sheets.spreadsheets.values.get({ spreadsheetId, range: 'Sheet1!A:A' });
            const rows = res.data.values || [];
            const rowIndex = rows.findIndex(r => r[0] === positionId);
            if (rowIndex < 0) {
                console.warn(`⚠️  [ExclusiveSheets] Row not found for positionId ${positionId} in ${label} sheet`);
                return false;
            }
            const sheetRow = rowIndex + 1; // 1-based
            const colLetter = col => String.fromCharCode(65 + col);
            for (const [col, value] of Object.entries(colUpdates)) {
                await this.sheets.spreadsheets.values.update({
                    spreadsheetId,
                    range: `Sheet1!${colLetter(parseInt(col))}${sheetRow}`,
                    valueInputOption: 'USER_ENTERED',
                    requestBody: { values: [[value]] },
                });
            }
            console.log(`📋 [ExclusiveSheets] Row ${sheetRow} updated for ${positionId} in ${label} sheet`);
            return true;
        } catch (err) {
            console.error(`❌ [ExclusiveSheets] Update failed on ${label} sheet:`, err.message);
            return false;
        }
    }

    async initHeaders() {
        console.log('📋 [ExclusiveSheets] Initializing sheet headers...');
        if (!await this._ensureSheets()) {
            console.warn('⚠️  [ExclusiveSheets] Skipping header init — sheets not available');
            return;
        }
        const sailrHeaders = [
            'purchase_id','quote_id','wallet','qualification_tier','live_sail_price',
            'discount_percent','discounted_sail_price','deposit_usde','sail_amount_output',
            'sail_margin_to_amy','payment_tx_hash','payment_confirmed_at_utc',
            'earning_start_date_utc','lock_end_date_utc','purchase_status',
        ];
        const jnrHeaders = [
            'position_id','wallet','qualification_tier','deposit_usde','entry_share_price',
            'unit_quantity','created_at_utc','earning_start_date_utc','status',
            'exit_requested_at_utc','exit_available_at_utc','withdrawn_at_utc',
        ];
        try {
            await this.sheets.spreadsheets.values.update({
                spreadsheetId: this.sailrId,
                range: 'Sheet1!A1',
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [sailrHeaders] },
            });
            console.log(`✅ [ExclusiveSheets] SAIL.r sheet headers written (${sailrHeaders.length} columns)`);
            await this.sheets.spreadsheets.values.update({
                spreadsheetId: this.jnrId,
                range: 'Sheet1!A1',
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [jnrHeaders] },
            });
            console.log(`✅ [ExclusiveSheets] jnrUSD sheet headers written (${jnrHeaders.length} columns)`);
        } catch (err) {
            console.error('❌ [ExclusiveSheets] Header init failed:', err.message);
        }
    }

    async logSailrPurchase(p) {
        console.log(`📋 [ExclusiveSheets] Logging SAIL.r purchase: ${p.purchase_id} | ${p.wallet} | ${p.sail_amount_output} SAIL.r`);
        await this._append(this.sailrId, [
            p.purchase_id,
            p.quote_id,
            p.wallet,
            p.qualification_tier,
            p.live_sail_price,
            p.discount_percent,
            p.discounted_sail_price,
            p.deposit_usde ?? p.honey_amount_input,
            p.sail_amount_output,
            p.sail_margin_to_amy,
            p.payment_tx_hash,
            fmtUtc(p.payment_confirmed_at_utc),
            fmtUtc(p.earning_start_date_utc),
            fmtUtc(p.lock_end_date_utc),
            p.purchase_status,
        ]);
    }

    async logJnrusdDeposit(pos) {
        console.log(`📋 [ExclusiveSheets] Logging jnrUSD deposit: ${pos.position_id} | ${pos.wallet} | ${pos.deposit_usde} USDE`);
        await this._append(this.jnrId, [
            pos.position_id,
            pos.wallet,
            pos.qualification_tier,
            pos.deposit_usde,
            pos.entry_share_price,
            pos.unit_quantity,
            fmtUtc(pos.created_at_utc),
            fmtUtc(pos.earning_start_date_utc),
            pos.status,
            '',   // exit_requested_at_utc — empty on creation
            '',   // exit_available_at_utc
            '',   // withdrawn_at_utc
        ]);
    }

    async logJnrusdExit(positionId, exitRequestedAt, exitAvailableAt, stopsEarningAt) {
        console.log(`📋 [ExclusiveSheets] Logging jnrUSD exit: ${positionId} | available ${fmtUtc(exitAvailableAt)}`);
        // col index: 8=status, 9=exit_requested_at_utc, 10=exit_available_at_utc
        const updated = await this._updateRow(this.jnrId, positionId, {
            8:  'cooling',
            9:  fmtUtc(exitRequestedAt),
            10: fmtUtc(exitAvailableAt),
        });
        if (!updated) {
            console.warn(`⚠️  [ExclusiveSheets] Could not find row for ${positionId} — skipping exit sheet update`);
        }
    }

    async logJnrusdWithdrawal(positionId, withdrawnAt) {
        console.log(`📋 [ExclusiveSheets] Logging jnrUSD withdrawal: ${positionId} | withdrawn ${fmtUtc(withdrawnAt)}`);
        // col index: 8=status, 11=withdrawn_at_utc
        const updated = await this._updateRow(this.jnrId, positionId, {
            8:  'withdrawn',
            11: fmtUtc(withdrawnAt),
        });
        if (!updated) {
            console.warn(`⚠️  [ExclusiveSheets] Could not find row for ${positionId} — skipping withdrawal sheet update`);
        }
    }
}

const sheetsService = new ExclusivePerksSheets();

// ─── Config helpers (app_config table) ───────────────────────────────────────
const appConfig = {
    get: async (pool, key) => {
        const r = await pool.query('SELECT value FROM app_config WHERE key = $1', [key]);
        return r.rows[0]?.value ?? null;
    },
    set: async (pool, key, value) => {
        await pool.query(
            `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
            [key, String(value)]
        );
    },
};

// ─── Database helpers ─────────────────────────────────────────────────────────
const exclusiveDb = {
    // ── Allocation capacity ──────────────────────────────────────────────────
    getSailrCapacity: async (pool) => {
        const capStr = await appConfig.get(pool, 'sailr_allocation_cap');
        const cap = parseFloat(capStr) || 0;
        if (cap === 0) return { cap: 0, used: 0, remaining: null, unlimited: true };

        const r = await pool.query(
            `SELECT COALESCE(SUM(sail_amount_output), 0) AS used
             FROM sailr_purchases WHERE purchase_status != 'cancelled'`
        );
        const used = parseFloat(r.rows[0].used) || 0;
        return { cap, used, remaining: Math.max(0, cap - used), unlimited: false };
    },

    getJnrusdCapacity: async (pool) => {
        const capStr = await appConfig.get(pool, 'jnrusd_allocation_cap');
        const cap = parseFloat(capStr) || 0;
        if (cap === 0) return { cap: 0, used: 0, remaining: null, unlimited: true };

        const r = await pool.query(
            `SELECT COALESCE(SUM(deposit_usde), 0) AS used
             FROM jnrusd_positions WHERE status != 'withdrawn'`
        );
        const used = parseFloat(r.rows[0].used) || 0;
        return { cap, used, remaining: Math.max(0, cap - used), unlimited: false };
    },

    // ── SAIL.r ──────────────────────────────────────────────────────────────
    createSailrPurchase: async (pool, data) => {
        const id = uuidv4();
        const now = new Date(data.paymentConfirmedAt);
        const earningStart = nextDayUtcMidnight(now);
        const lockEnd = addMonths(now, 6);

        const result = await pool.query(
            `INSERT INTO sailr_purchases
             (purchase_id, quote_id, wallet, qualification_tier, live_sail_price, discount_percent,
              discounted_sail_price, deposit_usde, honey_amount_input, sail_amount_output, sail_margin_to_amy,
              payment_tx_hash, payment_confirmed_at_utc, earning_start_date_utc, lock_end_date_utc, purchase_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'confirmed')
             RETURNING *`,
            [
                id, data.quoteId, data.wallet.toLowerCase(), data.qualificationTier,
                data.liveSailPrice, SAILR_USER_DISCOUNT * 100, data.discountedSailPrice,
                data.usdeAmountInput, data.usdeAmountInput, data.sailAmountOutput, data.sailMarginToAmy,
                data.paymentTxHash, now, earningStart, lockEnd,
            ]
        );
        return result.rows[0];
    },

    getSailrPurchasesByWallet: async (pool, wallet) => {
        const result = await pool.query(
            `SELECT * FROM sailr_purchases WHERE LOWER(wallet) = LOWER($1) ORDER BY payment_confirmed_at_utc DESC`,
            [wallet]
        );
        return result.rows;
    },

    getSailrPurchaseByTx: async (pool, txHash) => {
        const result = await pool.query(
            `SELECT purchase_id FROM sailr_purchases WHERE payment_tx_hash = $1`,
            [txHash]
        );
        return result.rows[0] || null;
    },

    getSailrTotalValueUsd: async (pool, wallet, liveSailPrice) => {
        const result = await pool.query(
            `SELECT COALESCE(SUM(sail_amount_output), 0) AS total_sail
             FROM sailr_purchases WHERE LOWER(wallet) = LOWER($1) AND purchase_status != 'cancelled'`,
            [wallet]
        );
        const totalSail = parseFloat(result.rows[0].total_sail) || 0;
        return totalSail * liveSailPrice;
    },

    // ── jnrUSDE (unit-based model) ───────────────────────────────────────────
    getCurrentSharePrice: async (pool) => {
        const val = await appConfig.get(pool, 'jnrusd_share_price');
        return parseFloat(val) || 1.0;
    },

    setSharePrice: async (pool, price) => {
        await appConfig.set(pool, 'jnrusd_share_price', price);
    },

    createJnrusdPosition: async (pool, data) => {
        const id = uuidv4();
        const now = new Date(data.confirmedAt);
        const earningStart = nextDayUtcMidnight(now);

        const sharePrice = data.entrySharePrice || 1.0;
        const unitQuantity = data.depositUsde / sharePrice;

        const result = await pool.query(
            `INSERT INTO jnrusd_positions
             (position_id, wallet, qualification_tier, deposit_usde, entry_share_price, unit_quantity,
              amount, deposit_tx_hash, created_at_utc, earning_start_date_utc, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')
             RETURNING *`,
            [id, data.wallet.toLowerCase(), data.qualificationTier,
             data.depositUsde, sharePrice, unitQuantity,
             unitQuantity, // amount = unit_quantity (the position size)
             data.depositTxHash, now, earningStart]
        );
        return result.rows[0];
    },

    getJnrusdPositionsByWallet: async (pool, wallet) => {
        const result = await pool.query(
            `SELECT * FROM jnrusd_positions WHERE LOWER(wallet) = LOWER($1) ORDER BY created_at_utc DESC`,
            [wallet]
        );
        return result.rows;
    },

    getJnrusdPosition: async (pool, positionId) => {
        const result = await pool.query(
            `SELECT * FROM jnrusd_positions WHERE position_id = $1`,
            [positionId]
        );
        return result.rows[0] || null;
    },

    requestJnrusdExit: async (pool, positionId) => {
        const now = new Date();
        const exitAvailableAt = addDays(now, JNRUSD_COOLDOWN_DAYS);
        const stopsEarningAt = nextDayUtcMidnight(now);

        const result = await pool.query(
            `UPDATE jnrusd_positions
             SET status = 'cooling',
                 exit_requested_at_utc = $2,
                 exit_available_at_utc = $3,
                 stops_earning_at_utc  = $4
             WHERE position_id = $1 AND status = 'active'
             RETURNING *`,
            [positionId, now, exitAvailableAt, stopsEarningAt]
        );
        return result.rows[0] || null;
    },

    confirmJnrusdWithdrawal: async (pool, positionId) => {
        const result = await pool.query(
            `UPDATE jnrusd_positions
             SET status = 'withdrawn', withdrawn_at_utc = NOW()
             WHERE position_id = $1 AND status = 'cooling' AND exit_available_at_utc <= NOW()
             RETURNING *`,
            [positionId]
        );
        return result.rows[0] || null;
    },

    getJnrusdPositionByTx: async (pool, txHash) => {
        const result = await pool.query(
            `SELECT position_id FROM jnrusd_positions WHERE deposit_tx_hash = $1`,
            [txHash]
        );
        return result.rows[0] || null;
    },

    getJnrusdTotalValueUsd: async (pool, wallet) => {
        const result = await pool.query(
            `SELECT COALESCE(SUM(deposit_usde), 0) AS total
             FROM jnrusd_positions WHERE LOWER(wallet) = LOWER($1) AND status IN ('active','cooling')`,
            [wallet]
        );
        return parseFloat(result.rows[0].total) || 0;
    },
};

module.exports = {
    exclusiveDb, appConfig, sheetsService,
    buildSailrQuote, activeQuotes, pruneExpiredQuotes, fmtUtc,
    activeJnrusdQuotes, pruneExpiredJnrusdQuotes, getLiveJnrusdSharePrice,
};
