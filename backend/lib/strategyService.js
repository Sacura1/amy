const axios = require('axios');
const { google } = require('googleapis');
const { ethers } = require('ethers');

// CONFIG
const RPC_URL = process.env.BERACHAIN_RPC || 'https://rpc.berachain.com';
const AMY_TOKEN = '0x098a75bAedDEc78f9A8D0830d6B86eAc5cC8894e';
const AMY_HONEY_POOL = '0xff716930eefb37b5b4ac55b1901dc5704b098d84'; 
const AMY_USDT0_POOL = '0xed1bb27281a8bbf296270ed5bb08acf7ecab5c17';

// URLs
const ALGEBRA_SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_clols2c0p7fby2nww199i4pdx/subgraphs/algebra-berachain-mainnet/0.0.3/gn';
const KODIAK_SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_clpx84oel0al201r78jsl0r3i/subgraphs/kodiak-v3-berachain-mainnet/latest/gn';
const LR_CHARTS_API = 'https://lr-api-production.up.railway.app/api/v1/charts/vaults?days=all';
const APR_TVL_SHEET_ID = process.env.APR_TVL_SHEET_ID || '1FDsR0LmKIF63gcMsJ-sZQ-eAR-ssTK6Zqlq0DR8RiJo';
const APR_TVL_SHEET_RANGE = process.env.APR_TVL_SHEET_RANGE || 'Sheet1!A2:C';

const SHEET_STRATEGY_MAP = {
    'honey - lent': 'honeybend',
    'bera - staked': 'stakedbera',
    'plsbera - staked': 'plsbera',
    'plskdk - staked': 'plskdk',
    'plvhedge - vault': 'plvhedge',
    'sail.r - royalty': 'sailr',
    'snrusd - vault': 'snrusd',
    'jnrusd - vault': 'jnrusd',
    // LP pools: APR comes from sheet, TVL is computed from subgraph
    'amy/honey - lp': 'amy-honey',
    'amy/usdt0 - lp': 'amy-usdt0',
};

const STRATEGY_KEYS = Object.keys(SHEET_STRATEGY_MAP);

// These positions use computed TVL (subgraph) but sheet APR — applySheetMetrics skips them
const LP_APR_ONLY = new Set(['amy-honey', 'amy-usdt0']);

function normalizeStrategyKey(rawName) {
    if (!rawName) return null;
    const normalized = rawName.toString().trim().toLowerCase();
    if (!normalized) return null;
    if (SHEET_STRATEGY_MAP[normalized]) return normalized;
    return STRATEGY_KEYS.find(key => normalized.includes(key) || key.includes(normalized)) || null;
}

function parseSheetCellValue(cell) {
    const raw = (cell ?? '').toString().trim();
    if (!raw) return { raw: '', number: null };
    const parts = raw.split(/[\r\n]+/).map(p => p.trim()).filter(Boolean);
    const part = parts.length ? parts[parts.length - 1] : raw;
    const sanitized = part.replace(/[$,:%]/g, '').trim();
    const match = sanitized.match(/(-?\d+(\.\d+)?)([kmbKMB])?/);
    if (!match) return { raw: part, number: null };
    let value = parseFloat(match[1]);
    const suffix = match[3]?.toLowerCase();
    if (suffix === 'k') value *= 1_000;
    else if (suffix === 'm') value *= 1_000_000;
    else if (suffix === 'b') value *= 1_000_000_000;
    return { raw: part, number: value };
}

// Addresses
const TOKENS = {
    SNRUSD_VAULT: '0x18e310dD4A6179D9600E95D18926AB7819B2A071',
    JNRUSD: '0x3a0A97DcA5e6CaCC258490d5ece453412f8E1883',
    SWBERA: '0x118D2cEeE9785eaf70C15Cd74CD84c9f8c3EeC9a', // sWBERA staking vault
    BGT: '0x656b95e550c07a9ffe548bd4085c72418ceb1dba',
    SAILR: '0x59a61B8d3064A51a95a5D6393c03e2152b1a2770',
    PLSBERA: '0xe8bEB147a93BB757DB15e468FaBD119CA087EfAE', // plsBERA staking contract
    PLVHEDGE: '0x28602B1ae8cA0ff5CD01B96A36f88F72FeBE727A', // plvHEDGE token
    PLSKDK: '0x9e6B748d25Ed2600Aa0ce7Cbb42267adCF21Fd9B', // plsKDK staking contract
    HONEY_BEND_VAULT: '0xDb6e93Cd7BddC45EbC411619792fc5f977316c38',
    SWBERA_VAULT: '0x118d2ceee9785eaf70c15cd74cd84c9f8c3eec9a',
    SAILR_POOL: '0x704d1c9dddeb2ccd4bf999f3426c755917f0d00c',
    BULLAS_NFT: '0x333814f5e16eee61d0c0b03a5b6abbd424b381c2',
    BOOGA_NFT: '0x5a30c392714a9a9a8177c7998d9d59c3dd120917'
};

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const NFT_ABI = ['function balanceOf(address) view returns (uint256)'];
const VAULT_ABI = [
    'function totalSupply() view returns (uint256)',
    'function rewardRate() view returns (uint256)',
    'function totalAssets() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)'
];

class StrategyService {
    constructor(db) {
        this.db = db;
        this.provider = new ethers.providers.JsonRpcProvider(RPC_URL);
        this.sheetsClient = null;
    }

    async getSheetsClient() {
        if (this.sheetsClient) return this.sheetsClient;
        const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
        if (!key) {
            throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not configured for APR/TVL sheet sync');
        }
        try {
            const credentials = JSON.parse(key);
            const auth = new google.auth.GoogleAuth({
                credentials,
                scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
            });
            this.sheetsClient = google.sheets({ version: 'v4', auth });
            return this.sheetsClient;
        } catch (err) {
            throw new Error(`Failed to initialize Google Sheets client: ${err.message}`);
        }
    }

    // Precise math for AMY/HONEY pool value calculation (both tokens 18dp)
    // Detects token ordering via pool.token0.id — works whether AMY is token0 or token1
    calculateValue(p, amyPrice) {
        try {
            const Q96 = Math.pow(2, 96);
            const liq = parseFloat(p.liquidity);
            const sqrtP = parseFloat(p.pool.sqrtPrice) / Q96;
            const tickLower = parseInt(p.tickLower?.tickIdx || 0);
            const tickUpper = parseInt(p.tickUpper?.tickIdx || 0);
            const sqrtL = Math.sqrt(Math.pow(1.0001, tickLower));
            const sqrtU = Math.sqrt(Math.pow(1.0001, tickUpper));
            let a0 = 0, a1 = 0;
            const tickCurrent = parseInt(p.pool.tick);
            if (tickCurrent < tickLower) a0 = liq * (sqrtU - sqrtL) / (sqrtL * sqrtU);
            else if (tickCurrent < tickUpper) { a0 = liq * (sqrtU - sqrtP) / (sqrtP * sqrtU); a1 = liq * (sqrtP - sqrtL); }
            else a1 = liq * (sqrtU - sqrtL);
            const token0Id = (p.pool.token0?.id || '').toLowerCase();
            const amyIsToken0 = token0Id === AMY_TOKEN.toLowerCase();
            if (amyIsToken0) {
                // token0=AMY, token1=HONEY (both 18dp, HONEY ~$1)
                return ((a0 / 1e18) * amyPrice) + (a1 / 1e18);
            } else {
                // token0=HONEY, token1=AMY (both 18dp, HONEY ~$1)
                return (a0 / 1e18) + ((a1 / 1e18) * amyPrice);
            }
        } catch (e) { return 0; }
    }

    // Value calculation for AMY/USDT0 pool — detects token ordering via pool.token0.id
    // and uses correct decimals (USDT0 = 6dp, AMY = 18dp)
    calculateValueUsdt0(p, amyPrice) {
        try {
            const Q96 = Math.pow(2, 96);
            const liq = parseFloat(p.liquidity);
            const sqrtP = parseFloat(p.pool.sqrtPrice) / Q96;
            const tickLower = parseInt(p.tickLower?.tickIdx || 0);
            const tickUpper = parseInt(p.tickUpper?.tickIdx || 0);
            const sqrtL = Math.sqrt(Math.pow(1.0001, tickLower));
            const sqrtU = Math.sqrt(Math.pow(1.0001, tickUpper));
            let a0 = 0, a1 = 0;
            const tickCurrent = parseInt(p.pool.tick);
            if (tickCurrent < tickLower) a0 = liq * (sqrtU - sqrtL) / (sqrtL * sqrtU);
            else if (tickCurrent < tickUpper) { a0 = liq * (sqrtU - sqrtP) / (sqrtP * sqrtU); a1 = liq * (sqrtP - sqrtL); }
            else a1 = liq * (sqrtU - sqrtL);

            const token0Id = (p.pool.token0?.id || '').toLowerCase();
            const dec0 = parseInt(p.pool.token0?.decimals || 18);
            const dec1 = parseInt(p.pool.token1?.decimals || 18);
            const amyIsToken0 = token0Id === AMY_TOKEN.toLowerCase();
            if (amyIsToken0) {
                // token0=AMY(18dp), token1=USDT0(6dp,$1)
                return ((a0 / Math.pow(10, dec0)) * amyPrice) + (a1 / Math.pow(10, dec1));
            } else {
                // token0=USDT0(6dp,$1), token1=AMY(18dp)
                return (a0 / Math.pow(10, dec0)) + ((a1 / Math.pow(10, dec1)) * amyPrice);
            }
        } catch (e) { return 0; }
    }

    async runBaseBuild() {
        console.log('🔄 [Base Build] Refreshing AMY balances...');
        try {
            const result = await this.db.pool.query('SELECT wallet FROM verified_users');
            const contract = new ethers.Contract(AMY_TOKEN, ERC20_ABI, this.provider);
            for (const row of result.rows) {
                try {
                    const bal = await contract.balanceOf(row.wallet);
                    await this.db.pool.query(
                        `INSERT INTO user_base_build (wallet, amy_balance, last_checked)
                         VALUES ($1, $2, CURRENT_TIMESTAMP)
                         ON CONFLICT (wallet) DO UPDATE SET amy_balance = EXCLUDED.amy_balance, last_checked = CURRENT_TIMESTAMP`,
                        [row.wallet.toLowerCase(), parseFloat(ethers.utils.formatUnits(bal, 18))]
                    );
                } catch (e) {}
            }
            console.log(`✅ [Base Build] Done (${result.rows.length} wallets)`);
        } catch (err) { console.error('❌ [Base Build] Error:', err.message); }
    }

    async runFullStrategySnapshot() {
        console.log('🧠 [Full Strategy] Generating snapshots for >300 AMY holders (including NFTs)...');
        try {
            const holders = await this.db.pool.query('SELECT wallet FROM user_base_build WHERE amy_balance >= 300');
            if (holders.rows.length === 0) return;
            const [amyPrice, beraPrice, sailrPrice, plsBeraPrice, plvHedgePrice, plsKdkPrice] = await Promise.all([
                this.getAmyPrice(),
                this.getBeraPrice(),
                this.getSailrPrice(),
                this.getPlsBeraPrice(),
                this.getPlvHedgePrice(),
                this.getPlsKdkPrice(),
            ]);
            console.log(`💰 [Full Strategy] Prices: AMY=$${amyPrice.toFixed(4)}, BERA=$${beraPrice.toFixed(4)}, SAILR=$${sailrPrice.toFixed(4)}, plsBERA=$${plsBeraPrice.toFixed(4)}, plvHEDGE=$${plvHedgePrice.toFixed(4)}, plsKDK=$${plsKdkPrice.toFixed(4)}`);

            for (const row of holders.rows) {
                const wallet = row.wallet.toLowerCase();
                const snapshot = {
                    wallet, timestamp: new Date().toISOString(),
                    positions: {
                        lp_amy_honey: await this.fetchGoldskyPositions(wallet, AMY_HONEY_POOL, ALGEBRA_SUBGRAPH_URL, amyPrice),
                        lp_amy_usdt0: await this.fetchGoldskyPositionsUsdt0(wallet, AMY_USDT0_POOL, KODIAK_SUBGRAPH_URL, amyPrice),
                        snrusd: await this.fetchStakedBalance(wallet, TOKENS.SNRUSD_VAULT),
                        jnrusd: await this.fetchTokenBalance(wallet, TOKENS.JNRUSD),
                        honey_bend: await this.fetchStakedBalance(wallet, TOKENS.HONEY_BEND_VAULT),
                        swbera: await this.fetchTokenBalance(wallet, TOKENS.SWBERA, beraPrice),
                        bgt: await this.fetchTokenBalance(wallet, TOKENS.BGT, 1.0),
                        sailr: await this.fetchTokenBalance(wallet, TOKENS.SAILR, sailrPrice),
                        plsbera: await this.fetchTokenBalance(wallet, TOKENS.PLSBERA, plsBeraPrice),
                        plvhedge: await this.fetchTokenBalance(wallet, TOKENS.PLVHEDGE, plvHedgePrice),
                        plskdk: await this.fetchTokenBalance(wallet, TOKENS.PLSKDK, plsKdkPrice),
                        bullas: await this.fetchNftCount(wallet, TOKENS.BULLAS_NFT),
                        boogaBullas: await this.fetchNftCount(wallet, TOKENS.BOOGA_NFT)
                    }
                };
                await this.db.pool.query(
                    `INSERT INTO strategy_snapshots (wallet, snapshot_data, last_updated)
                     VALUES ($1, $2, CURRENT_TIMESTAMP)
                     ON CONFLICT (wallet) DO UPDATE SET snapshot_data = EXCLUDED.snapshot_data, last_updated = CURRENT_TIMESTAMP`,
                    [wallet, JSON.stringify(snapshot)]
                );
            }
            console.log(`✅ [Full Strategy] Snapshots updated.`);
        } catch (err) { console.error('❌ [Full Strategy] Error:', err.message); }
    }

    async fetchNftCount(wallet, nftAddress) {
        try {
            const contract = new ethers.Contract(nftAddress, NFT_ABI, this.provider);
            const bal = await contract.balanceOf(wallet);
            return parseInt(bal.toString());
        } catch (e) { return 0; }
    }

    async fetchTokenBalance(wallet, tokenAddress, customPrice = null) {
        try {
            const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
            const bal = await contract.balanceOf(wallet);
            const balance = parseFloat(ethers.utils.formatUnits(bal, 18));
            // Only apply price if explicitly provided and > 0; don't default to $1 for unknown prices
            const price = (customPrice != null && customPrice > 0) ? customPrice : 0;
            return { value_usd: balance * price, balance };
        } catch (e) { return { value_usd: 0, balance: 0 }; }
    }

    async fetchStakedBalance(wallet, vaultAddress) {
        try {
            const vault = new ethers.Contract(vaultAddress, VAULT_ABI, this.provider);
            const bal = await vault.balanceOf(wallet);
            const balance = parseFloat(ethers.utils.formatUnits(bal, 18));
            return { value_usd: balance, balance };
        } catch (e) { return { value_usd: 0, balance: 0 }; }
    }

    async getAmyPrice() {
        try {
            const res = await axios.get(`https://api.geckoterminal.com/api/v2/networks/berachain/pools/${AMY_HONEY_POOL}`);
            return parseFloat(res.data.data.attributes.base_token_price_usd) || 0.05;
        } catch (e) { return 0.05; }
    }

    async getBeraPrice() {
        try {
            const res = await axios.get('https://api.geckoterminal.com/api/v2/networks/berachain/pools/0x2608b7c8eb17e22cb95b7cd6f872993cf33a4ca1');
            return parseFloat(res.data.data.attributes.base_token_price_usd) || 0.60;
        } catch (e) { return 0.60; }
    }

    async getSailrPrice() {
        // Primary: use pool endpoint (more reliable than token_price for SAIL.r)
        try {
            const res = await axios.get(`https://api.geckoterminal.com/api/v2/networks/berachain/pools/${TOKENS.SAILR_POOL}`);
            const price = parseFloat(res.data?.data?.attributes?.base_token_price_usd || 0);
            if (price > 0) return price;
        } catch (e) {}
        // Fallback: token_price endpoint
        try {
            const addr = '0x59a61b8d3064a51a95a5d6393c03e2152b1a2770';
            const res = await axios.get(`https://api.geckoterminal.com/api/v2/simple/networks/berachain/token_price/${addr}`);
            return parseFloat(res.data?.data?.attributes?.token_prices?.[addr] || 0) || 0;
        } catch (e) { return 0; }
    }

    async getPlsBeraPrice() {
        try {
            const res = await axios.get('https://api.geckoterminal.com/api/v2/networks/berachain/pools/0x225915329b032b3385ac28b0dc53d989e8446fd1');
            return parseFloat(res.data?.data?.attributes?.base_token_price_usd || 0) || 0;
        } catch (e) { return 0; }
    }

    async getPlvHedgePrice() {
        // Use the most liquid plvHEDGE/HONEY pool on Kodiak V3 — pool endpoint is accurate (~$1.17)
        // GeckoTerminal token_price and Plutus TVL/supply both return ~$23 (wrong)
        try {
            const res = await axios.get('https://api.geckoterminal.com/api/v2/networks/berachain/pools/0xbb27edace822f244a91c2417b07c617e7a691be6');
            const price = parseFloat(res.data?.data?.attributes?.base_token_price_usd || 0);
            if (price > 0) return price;
        } catch (e) {}
        return 0;
    }

    async getPlsKdkPrice() {
        const addr = '0xc6173a3405fdb1f5c42004d2d71cba9bf1cfa522';
        // Primary: GeckoTerminal token_price
        try {
            const res = await axios.get(`https://api.geckoterminal.com/api/v2/simple/networks/berachain/token_price/${addr}`);
            const price = parseFloat(res.data?.data?.attributes?.token_prices?.[addr] || 0);
            if (price > 0) return price;
        } catch (e) {}
        // Fallback: Plutus API (same source used for APR sync)
        try {
            const res = await axios.get(`https://plutus.fi/api/assets/80094/${addr}`);
            const price = parseFloat(res.data?.price || res.data?.tokenPrice || 0);
            if (price > 0) return price;
        } catch (e) {}
        return 0;
    }

    async fetchGoldskyPositions(wallet, poolId, url, amyPrice) {
        // Fetch token0.id so calculateValue can detect whether AMY is token0 or token1
        const query = { query: `{ positions(where: { owner: "${wallet.toLowerCase()}", pool: "${poolId.toLowerCase()}", liquidity_gt: "0" }) { liquidity tickLower { tickIdx } tickUpper { tickIdx } pool { tick sqrtPrice token0 { id } } } }` };
        try {
            const res = await axios.post(url, query);
            const pos = res.data.data.positions;
            if (!pos || pos.length === 0) return { value_usd: 0, count: 0, in_range_count: 0 };
            let inRangeValue = 0;
            let inRangeCount = 0;
            for (const p of pos) {
                const currentTick = parseInt(p.pool.tick);
                const tickLower = parseInt(p.tickLower?.tickIdx || 0);
                const tickUpper = parseInt(p.tickUpper?.tickIdx || 0);
                const isInRange = currentTick >= tickLower && currentTick < tickUpper;
                if (isInRange) {
                    inRangeValue += this.calculateValue(p, amyPrice);
                    inRangeCount++;
                }
            }
            return { value_usd: inRangeValue, count: pos.length, in_range_count: inRangeCount };
        } catch (e) { return { value_usd: 0, count: 0, in_range_count: 0 }; }
    }

    // Like fetchGoldskyPositions but fetches token0/token1 info so calculateValueUsdt0
    // can detect ordering and apply correct decimals (USDT0=6dp vs AMY=18dp)
    async fetchGoldskyPositionsUsdt0(wallet, poolId, url, amyPrice) {
        const query = { query: `{ positions(where: { owner: "${wallet.toLowerCase()}", pool: "${poolId.toLowerCase()}", liquidity_gt: "0" }) { liquidity tickLower { tickIdx } tickUpper { tickIdx } pool { tick sqrtPrice token0 { id decimals } token1 { id decimals } } } }` };
        try {
            const res = await axios.post(url, query);
            const pos = res.data.data.positions;
            if (!pos || pos.length === 0) return { value_usd: 0, count: 0, in_range_count: 0 };
            let inRangeValue = 0;
            let inRangeCount = 0;
            for (const p of pos) {
                const currentTick = parseInt(p.pool.tick);
                const tickLower = parseInt(p.tickLower?.tickIdx || 0);
                const tickUpper = parseInt(p.tickUpper?.tickIdx || 0);
                const isInRange = currentTick >= tickLower && currentTick < tickUpper;
                if (isInRange) {
                    inRangeValue += this.calculateValueUsdt0(p, amyPrice);
                    inRangeCount++;
                }
            }
            return { value_usd: inRangeValue, count: pos.length, in_range_count: inRangeCount };
        } catch (e) { return { value_usd: 0, count: 0, in_range_count: 0 }; }
    }

    async runEarnDataUpdate() {
        console.log('📊 [Earn Update] Syncing Ground Truth APR/TVL...');
        try {
            const amyPrice = await this.getAmyPrice();
            const beraPrice = await this.getBeraPrice();
            const charts = await axios.get(LR_CHARTS_API);
            const chartsData = charts.data.data;
            const sheetData = await this.fetchAprTvlSheet();

            const amyHoneySheetApr = sheetData?.['amy/honey - lp']?.aprValue ?? null;
            const amyUsdt0SheetApr = sheetData?.['amy/usdt0 - lp']?.aprValue ?? null;

            await this.syncAlgebraApr('amy-honey', AMY_HONEY_POOL, ALGEBRA_SUBGRAPH_URL, amyPrice, amyHoneySheetApr);
            await this.syncKodiakUsdt0Apr(amyPrice, amyUsdt0SheetApr);

            let sheetApplied = false;
            if (sheetData) {
                const applied = await this.applySheetMetrics(sheetData);
                sheetApplied = applied > 0;
            }

            if (!sheetApplied) {
                console.warn('⚠️ [Earn Update] APR/TVL sheet missing, falling back to live metrics.');
                await this.syncSnrusdApr(beraPrice, chartsData.senior);
                await this.syncJnrusdApr(chartsData.junior);
                await this.syncSwberaApr(beraPrice);
                await this.syncPlutusApr('plsbera', '0xe8bEB147a93BB757DB15e468FaBD119CA087EfAE');
                await this.syncPlutusApr('plskdk', '0x9e6B748d25Ed2600Aa0ce7Cbb42267adCF21Fd9B');
                await this.syncPlutusApr('plvhedge', '0x28602B1ae8cA0ff5CD01B96A36f88F72FeBE727A');
                await this.syncSailrApr();
            }

            console.log('✅ [Earn Update] All ground truth stats synced.');
        } catch (err) { console.error('❌ [Earn Update] Master Error:', err.message); }
    }

    async syncAlgebraApr(id, poolId, url, amyPrice, aprOverride = null) {
        try {
            const query = { query: `{ pool(id: "${poolId.toLowerCase()}") { token0 { id } totalValueLockedToken0 totalValueLockedToken1 } poolDayDatas(first: 7, orderBy: date, orderDirection: desc, where: { pool: "${poolId.toLowerCase()}" }) { feesUSD tvlUSD } }`};
            const res = await axios.post(url, query);
            const p = res.data.data.pool;
            const days = res.data.data.poolDayDatas;
            const token0Id = (p.token0?.id || '').toLowerCase();
            const amyIsToken0 = token0Id === AMY_TOKEN.toLowerCase();
            const tvl0 = parseFloat(p.totalValueLockedToken0);
            const tvl1 = parseFloat(p.totalValueLockedToken1);
            const tvl = amyIsToken0
                ? (tvl0 * amyPrice) + tvl1
                : tvl0 + (tvl1 * amyPrice);
            const sumFees = days.reduce((a, b) => a + parseFloat(b.feesUSD), 0);
            const avgTvl = days.reduce((a, b) => a + parseFloat(b.tvlUSD), 0) / (days.length || 1);
            const computedApr = (avgTvl > 0) ? (sumFees / avgTvl) * (365 / 7) * 100 : 0;
            const apr = (aprOverride !== null && Number.isFinite(aprOverride)) ? aprOverride : computedApr;
            await this.saveMetric(id, tvl, apr);
        } catch (e) {}
    }

    // TVL for the Kodiak AMY/USDT0 pool — queries token0/token1 info to detect ordering,
    // then applies correct decimals (USDT0=6dp vs AMY=18dp) for TVL calculation
    async syncKodiakUsdt0Apr(amyPrice, aprOverride = null) {
        try {
            const poolId = AMY_USDT0_POOL.toLowerCase();
            const query = { query: `{ pool(id: "${poolId}") { token0 { id decimals } token1 { id decimals } totalValueLockedToken0 totalValueLockedToken1 } poolDayDatas(first: 7, orderBy: date, orderDirection: desc, where: { pool: "${poolId}" }) { feesUSD tvlUSD } }` };
            const res = await axios.post(KODIAK_SUBGRAPH_URL, query);
            const p = res.data.data.pool;
            const days = res.data.data.poolDayDatas;

            const token0Id = (p.token0?.id || '').toLowerCase();
            const dec0 = parseInt(p.token0?.decimals || 18);
            const dec1 = parseInt(p.token1?.decimals || 18);
            const tvl0 = parseFloat(p.totalValueLockedToken0);
            const tvl1 = parseFloat(p.totalValueLockedToken1);

            let tvl;
            if (token0Id === AMY_TOKEN.toLowerCase()) {
                // token0=AMY, token1=USDT0
                tvl = (tvl0 * amyPrice) + tvl1;
            } else {
                // token0=USDT0 (~$1, subgraph already in token units), token1=AMY
                tvl = tvl0 + (tvl1 * amyPrice);
            }

            const sumFees = days.reduce((a, b) => a + parseFloat(b.feesUSD), 0);
            const avgTvl = days.reduce((a, b) => a + parseFloat(b.tvlUSD), 0) / (days.length || 1);
            const computedApr = (avgTvl > 0) ? (sumFees / avgTvl) * (365 / 7) * 100 : 0;
            const apr = (aprOverride !== null && Number.isFinite(aprOverride)) ? aprOverride : computedApr;
            await this.saveMetric('amy-usdt0', tvl, apr);
        } catch (e) {}
    }

    async syncSnrusdApr(beraPrice, seniorData) {
        try {
            const vault = new ethers.Contract(TOKENS.SNRUSD_VAULT, VAULT_ABI, this.provider);
            const [rewardRate, totalSupply] = await Promise.all([vault.rewardRate(), vault.totalSupply()]);
            const rewardRateBgt = parseFloat(rewardRate.toString()) / 1e36;
            const annualBgtValue = rewardRateBgt * 31536000 * beraPrice;
            const stakedValue = parseFloat(ethers.utils.formatUnits(totalSupply, 18));
            let apr = (stakedValue > 100) ? (annualBgtValue / stakedValue) * 100 : 10.3;
            if (apr > 500) apr = 10.3;
            const tvl = parseFloat(seniorData.tvl.slice(-1)[0].value);
            await this.saveMetric('snrusd', tvl, apr);
        } catch (e) {}
    }

    async syncJnrusdApr(juniorData) {
        try {
            const tvl = parseFloat(juniorData.tvl.slice(-1)[0].value);
            const apy = parseFloat(juniorData.apy.slice(-1)[0].value);
            const apr = 365 * (Math.pow(1 + (apy / 100), 1/365) - 1) * 100;
            await this.saveMetric('jnrusd', tvl, apr);
        } catch (e) {}
    }

    async syncSwberaApr(beraPrice) {
        try {
            const vault = new ethers.Contract(TOKENS.SWBERA_VAULT, VAULT_ABI, this.provider);
            const assets = await vault.totalAssets();
            const tvl = parseFloat(ethers.utils.formatUnits(assets, 18)) * beraPrice;
            await this.saveMetric('stakedbera', tvl, 12.5);
        } catch (e) {}
    }

    async syncPlutusApr(id, address) {
        try {
            const res = await axios.get(`https://plutus.fi/api/assets/80094/${address}`);
            await this.saveMetric(id, parseFloat(res.data.TVL) || 0, parseFloat(res.data.APR) || 0);
        } catch (e) {}
    }

    async syncSailrApr() {
        try {
            const res = await axios.get(`https://api.geckoterminal.com/api/v2/networks/berachain/pools/${TOKENS.SAILR_POOL}`);
            const tvl = parseFloat(res.data.data.attributes.base_token_price_usd) * 1500000;
            await this.saveMetric('sailr', tvl, 8.5);
        } catch (e) {}
    }

    async fetchAprTvlSheet() {
        if (!APR_TVL_SHEET_ID) {
            console.warn('⚠️ [Earn Update] APR/TVL sheet ID is not configured.');
            return null;
        }
        try {
            const sheets = await this.getSheetsClient();
            const res = await sheets.spreadsheets.values.get({
                spreadsheetId: APR_TVL_SHEET_ID,
                range: APR_TVL_SHEET_RANGE,
            });
            const rows = res.data.values || [];
            if (rows.length === 0) {
                console.warn('⚠️ [Earn Update] APR/TVL sheet returned no rows.');
                return null;
            }
            const map = {};
            for (const row of rows) {
                const nameKey = normalizeStrategyKey(row[0]);
                if (!nameKey) continue;
                const aprParsed = parseSheetCellValue(row[1]);
                const tvlParsed = parseSheetCellValue(row[2]);
                map[nameKey] = {
                    aprValue: Number.isFinite(aprParsed.number) ? aprParsed.number : null,
                    tvlValue: Number.isFinite(tvlParsed.number) ? tvlParsed.number : null,
                    rawApr: aprParsed.raw,
                    rawTvl: tvlParsed.raw
                };
            }
            if (Object.keys(map).length === 0) {
                console.warn('⚠️ [Earn Update] APR/TVL sheet returned no valid entries.');
                return null;
            }
            console.log(`📈 [Earn Update] Loaded APR/TVL sheet with ${Object.keys(map).length} entries.`);
            return map;
        } catch (err) {
            console.error('❌ [Earn Update] Failed to fetch APR/TVL sheet:', err.message);
            return null;
        }
    }

    async applySheetMetrics(sheetData) {
        let applied = 0;
        for (const [strategyKey, positionId] of Object.entries(SHEET_STRATEGY_MAP)) {
            // LP positions use computed TVL from subgraph — APR is injected via syncAlgebraApr/syncKodiakUsdt0Apr
            if (LP_APR_ONLY.has(positionId)) continue;

            const row = sheetData[strategyKey];
            if (!row) {
                console.warn(`⚠️ [Earn Update] APR/TVL sheet missing entry for "${strategyKey}".`);
                continue;
            }

            // Format TVL: if the sheet contains a raw number (e.g. "25070353.07"), format it properly
            let displayTvl;
            if (row.tvlValue !== null && Number.isFinite(row.tvlValue) && row.tvlValue > 0) {
                if (row.tvlValue >= 1_000_000) {
                    displayTvl = `$${(row.tvlValue / 1_000_000).toFixed(2)}M`;
                } else if (row.tvlValue >= 1_000) {
                    displayTvl = `$${(row.tvlValue / 1_000).toFixed(1)}K`;
                } else {
                    displayTvl = `$${row.tvlValue.toFixed(2)}`;
                }
            } else {
                displayTvl = (row.rawTvl && row.rawTvl.trim()) ? row.rawTvl.trim() : 'TBC';
            }

            let displayApr = row.rawApr && row.rawApr.trim() ? row.rawApr.trim() : '';
            if (displayApr && !displayApr.endsWith('%')) displayApr = `${displayApr}%`;
            if (!displayApr) displayApr = '0%';
            await this.saveMetricFromSheet(positionId, displayTvl, displayApr);
            console.log(`📈 [Earn Update] Sheet metric saved for ${strategyKey} -> ${positionId}: TVL=${displayTvl}, APR=${displayApr}`);
            applied++;
        }
        console.log(`📈 [Earn Update] Sheet metrics applied for ${applied}/${Object.keys(SHEET_STRATEGY_MAP).length} strategies.`);
        return applied;
    }

    async saveMetricFromSheet(id, tvl, apr) {
        await this.db.pool.query(
            'INSERT INTO earn_data_history (position_id, tvl, apr) VALUES ($1, $2, $3)',
            [id, tvl, apr]
        );
    }

    async saveMetric(id, tvl, apr) {
        const tvlStr = (tvl <= 0 || !tvl) ? 'TBC' : (tvl > 1000000) ? `$${(tvl/1000000).toFixed(2)}M` : `$${(tvl/1000).toFixed(1)}k`;
        await this.db.pool.query('INSERT INTO earn_data_history (position_id, tvl, apr) VALUES ($1, $2, $3)', [id, tvlStr, `${apr.toFixed(1)}%`]);
    }
}

module.exports = StrategyService;
