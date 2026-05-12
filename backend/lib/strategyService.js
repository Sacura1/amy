const axios = require('axios');
const { google } = require('googleapis');
const { ethers } = require('ethers');

// CONFIG
const RPC_URL = process.env.BERACHAIN_RPC || 'https://rpc.berachain.com';
const AMY_TOKEN = '0x098a75bAedDEc78f9A8D0830d6B86eAc5cC8894e';
const USDT0_TOKEN = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';
const AMY_HONEY_POOL = '0xff716930eefb37b5b4ac55b1901dc5704b098d84'; 
const AMY_USDT0_POOL = '0xed1bb27281a8bbf296270ed5bb08acf7ecab5c17';
const KODIAK_NFPM = '0xFE5E8C83FFE4d9627A75EaA7Fee864768dB989bD';

// URLs
const ALGEBRA_SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_clols2c0p7fby2nww199i4pdx/subgraphs/algebra-berachain-mainnet/0.0.3/gn';
const KODIAK_SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_clpx84oel0al201r78jsl0r3i/subgraphs/kodiak-v3-berachain-mainnet/latest/gn';
const LR_CHARTS_API = 'https://lr-api-production.up.railway.app/api/v1/charts/vaults?days=all';
const APR_TVL_SHEET_ID = process.env.APR_TVL_SHEET_ID || '1FDsR0LmKIF63gcMsJ-sZQ-eAR-ssTK6Zqlq0DR8RiJo';
const APR_TVL_SHEET_RANGE = process.env.APR_TVL_SHEET_RANGE || 'Sheet1!A2:C';
const PLSKDK_FALLBACK_PRICE = parseFloat(process.env.PLSKDK_FALLBACK_PRICE || '0.097');

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
    JNRUSD_VAULT: '0x5f6eE0cc57862EAfAD1a572819B6Dc1485B95E46', // jnrUSD vault — use balanceOf+convertToAssets like his script
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
const KODIAK_NFPM_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function positions(uint256 tokenId) view returns (uint88 nonce, address operator, address token0, address token1, address deployer, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'
];
const KODIAK_POOL_ABI = [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
    'function token0() view returns (address)',
    'function token1() view returns (address)'
];
const VAULT_ABI = [
    'function totalSupply() view returns (uint256)',
    'function rewardRate() view returns (uint256)',
    'function totalAssets() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function convertToAssets(uint256 shares) view returns (uint256)'
];

class StrategyService {
    constructor(db) {
        this.db = db;
        this.provider = new ethers.providers.JsonRpcProvider(RPC_URL);
        this.sheetsClient = null;
        // Cache last known good prices so 429s never fall back to stale hardcoded values
        this._priceCache = {
            amy:      { price: 0,     ts: 0 },
            bera:     { price: 0.60,  ts: 0 },
            sailr:    { price: 0,     ts: 0 },
            plsbera:  { price: 0,     ts: 0 },
            plvhedge: { price: 0,     ts: 0 },
            plskdk:   { price: PLSKDK_FALLBACK_PRICE, ts: 0 },
        };
    }

    async _getDbCachedPrice(key) {
        try {
            const result = await this.db.pool.query('SELECT value FROM app_config WHERE key = $1', [`price_${key}`]);
            const raw = result.rows?.[0]?.value;
            if (!raw) return 0;
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const price = typeof parsed === 'number' ? parsed : parsed?.price;
            return Number(price) > 0 ? Number(price) : 0;
        } catch (e) {
            return 0;
        }
    }

    async _setDbCachedPrice(key, price, source) {
        if (!(price > 0)) return;
        try {
            await this.db.pool.query(
                `INSERT INTO app_config (key, value, updated_at)
                 VALUES ($1, $2, CURRENT_TIMESTAMP)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
                [`price_${key}`, JSON.stringify({ price, source, updatedAt: new Date().toISOString() })]
            );
        } catch (e) {
            console.log(`price cache save failed for ${key}: ${e.message}`);
        }
    }

    async _cachedPrice(key, freshPrice, source = 'fresh') {
        if (freshPrice > 0) {
            this._priceCache[key] = { price: freshPrice, ts: Date.now() };
            await this._setDbCachedPrice(key, freshPrice, source);
            return freshPrice;
        }

        const dbPrice = await this._getDbCachedPrice(key);
        if (dbPrice > 0) {
            this._priceCache[key] = { price: dbPrice, ts: Date.now() };
            console.log(`price fallback ${key}: using saved price $${dbPrice.toFixed(6)}`);
            return dbPrice;
        }

        const memoryPrice = this._priceCache[key]?.price || 0;
        if (memoryPrice > 0) console.log(`price fallback ${key}: using memory/default price $${memoryPrice.toFixed(6)}`);
        return memoryPrice;
    }

    async _getGeckoPoolPrice(label, poolAddress, attr = 'base_token_price_usd') {
        try {
            const res = await axios.get(`https://api.geckoterminal.com/api/v2/networks/berachain/pools/${poolAddress}`, { timeout: 10000 });
            const price = parseFloat(res.data?.data?.attributes?.[attr] || 0);
            if (price > 0) {
                console.log(`price source ${label}=GeckoPool $${price.toFixed(6)}`);
                return price;
            }
            console.log(`price source ${label}=GeckoPool returned 0`);
        } catch (e) {
            console.log(`price source ${label}=GeckoPool failed status=${e?.response?.status || 'n/a'} msg=${e.message}`);
        }
        return 0;
    }

    async _getGeckoTokenPrice(label, tokenAddress) {
        const addr = tokenAddress.toLowerCase();
        try {
            const res = await axios.get(`https://api.geckoterminal.com/api/v2/simple/networks/berachain/token_price/${addr}`, { timeout: 10000 });
            const price = parseFloat(res.data?.data?.attributes?.token_prices?.[addr] || 0);
            if (price > 0) {
                console.log(`price source ${label}=GeckoToken $${price.toFixed(6)}`);
                return price;
            }
            console.log(`price source ${label}=GeckoToken returned 0`);
        } catch (e) {
            console.log(`price source ${label}=GeckoToken failed status=${e?.response?.status || 'n/a'} msg=${e.message}`);
        }
        return 0;
    }

    async _getDexScreenerTokenPrice(label, tokenAddress) {
        try {
            const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 10000 });
            const pairs = (res.data?.pairs || [])
                .filter(pair => pair.chainId === 'berachain' && parseFloat(pair.priceUsd || 0) > 0)
                .sort((a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0));
            if (pairs.length) {
                const price = parseFloat(pairs[0].priceUsd);
                console.log(`price source ${label}=DexScreener $${price.toFixed(6)}`);
                return price;
            }
            console.log(`price source ${label}=DexScreener returned no priced berachain pair`);
        } catch (e) {
            console.log(`price source ${label}=DexScreener failed status=${e?.response?.status || 'n/a'} msg=${e.message}`);
        }
        return 0;
    }

    _withPreviousValue(walletTag, key, position, prevPos) {
        if (position.value_usd > 0 || position.balance <= 0) return position;
        const previous = prevPos?.[key];
        if (previous?.value_usd > 0) {
            console.log(`strategy fallback ${walletTag} ${key}: using previous value_usd=$${previous.value_usd}`);
            return { ...position, value_usd: previous.value_usd };
        }
        return position;
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
            // Sequential with 1s gaps to avoid GeckoTerminal 429 rate limiting.
            // _cachedPrice() returns the last known good value if the fresh fetch returns 0.
            const delay = (ms) => new Promise(r => setTimeout(r, ms));
            const amyPrice      = await this._cachedPrice('amy',      await this.getAmyPrice(),      'strategy'); await delay(1000);
            const beraPrice     = await this._cachedPrice('bera',     await this.getBeraPrice(),     'strategy'); await delay(1000);
            const sailrPrice    = await this._cachedPrice('sailr',    await this.getSailrPrice(),    'strategy'); await delay(1000);
            const plsBeraPrice  = await this._cachedPrice('plsbera',  await this.getPlsBeraPrice(),  'strategy'); await delay(1500);
            const plvHedgePrice = await this._cachedPrice('plvhedge', await this.getPlvHedgePrice(), 'strategy'); await delay(1500);
            const plsKdkPrice   = await this._cachedPrice('plskdk',   await this.getPlsKdkPrice(),   'strategy');
            console.log(`💰 [Full Strategy] Prices: AMY=$${amyPrice.toFixed(4)}, BERA=$${beraPrice.toFixed(4)}, BGT=$${beraPrice.toFixed(4)} (=BERA), SAILR=$${sailrPrice.toFixed(4)}, plsBERA=$${plsBeraPrice.toFixed(4)}, plvHEDGE=$${plvHedgePrice.toFixed(4)}, plsKDK=$${plsKdkPrice.toFixed(4)}`);

            for (const row of holders.rows) {
                const wallet = row.wallet.toLowerCase();

                const prevRes = await this.db.pool.query(
                    'SELECT snapshot_data FROM strategy_snapshots WHERE wallet = $1',
                    [wallet]
                );
                const prevPos = prevRes.rows[0]?.snapshot_data?.positions || {};

                const lpAmyHoney = await this.fetchGoldskyPositions(wallet, AMY_HONEY_POOL, ALGEBRA_SUBGRAPH_URL, amyPrice);
                const lpAmyUsdt0 = await this.fetchGoldskyPositionsUsdt0(wallet, AMY_USDT0_POOL, KODIAK_SUBGRAPH_URL, amyPrice);
                const snrusd = await this.fetchStakedBalance(wallet, TOKENS.SNRUSD_VAULT);
                const jnrusd = await this.fetchJnrusdBalance(wallet);
                const honeyBend = await this.fetchStakedBalance(wallet, TOKENS.HONEY_BEND_VAULT);
                const swbera = await this.fetchTokenBalance(wallet, TOKENS.SWBERA, beraPrice);
                const bgt = await this.fetchTokenBalance(wallet, TOKENS.BGT, beraPrice);
                let sailr = await this.fetchTokenBalance(wallet, TOKENS.SAILR, sailrPrice);
                let plsbera = await this.fetchTokenBalance(wallet, TOKENS.PLSBERA, plsBeraPrice);
                let plvhedge = await this.fetchTokenBalance(wallet, TOKENS.PLVHEDGE, plvHedgePrice);
                let plskdk = await this.fetchTokenBalance(wallet, TOKENS.PLSKDK, plsKdkPrice);
                let bullas = await this.fetchNftCount(wallet, TOKENS.BULLAS_NFT);
                let boogaBullas = await this.fetchNftCount(wallet, TOKENS.BOOGA_NFT);

                const walletTag = `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;

                sailr = this._withPreviousValue(walletTag, 'sailr', sailr, prevPos);
                plsbera = this._withPreviousValue(walletTag, 'plsbera', plsbera, prevPos);
                plvhedge = this._withPreviousValue(walletTag, 'plvhedge', plvhedge, prevPos);
                plskdk = this._withPreviousValue(walletTag, 'plskdk', plskdk, prevPos);

                if (bullas === null) {
                    bullas = prevPos.bullas || 0;
                    console.log(`🛟 [Full Strategy] ${wallet.slice(0, 6)}... Bullas read failed, using previous count=${bullas}`);
                }
                if (boogaBullas === null) {
                    boogaBullas = prevPos.boogaBullas || 0;
                    console.log(`🛟 [Full Strategy] ${wallet.slice(0, 6)}... BoogaBullas read failed, using previous count=${boogaBullas}`);
                }

                if (bullas > 0 || boogaBullas > 0) {
                    console.log(`🧩 [NFT Track] ${walletTag} bullas=${bullas} boogaBullas=${boogaBullas}`);
                }

                const snapshot = {
                    wallet, timestamp: new Date().toISOString(),
                    positions: {
                        lp_amy_honey: lpAmyHoney,
                        lp_amy_usdt0: lpAmyUsdt0,
                        snrusd,
                        jnrusd,
                        honey_bend: honeyBend,
                        swbera,
                        bgt,
                        sailr,
                        plsbera,
                        plvhedge,
                        plskdk,
                        bullas,
                        boogaBullas
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
        } catch (e) {
            console.log(`⚠️ [NFT Track] balanceOf failed wallet=${wallet.slice(0, 6)}...${wallet.slice(-4)} contract=${nftAddress} msg=${e.message}`);
            return null;
        }
    }

    calculateOnchainLpAmounts(liquidity, tickLower, tickUpper, currentTick) {
        const sqrtPriceLower = Math.sqrt(1.0001 ** tickLower);
        const sqrtPriceUpper = Math.sqrt(1.0001 ** tickUpper);
        const sqrtPriceCurrent = Math.sqrt(1.0001 ** currentTick);

        let amount0 = 0;
        let amount1 = 0;

        if (currentTick < tickLower) {
            amount0 = liquidity * (1 / sqrtPriceLower - 1 / sqrtPriceUpper);
        } else if (currentTick < tickUpper) {
            amount0 = liquidity * (1 / sqrtPriceCurrent - 1 / sqrtPriceUpper);
            amount1 = liquidity * (sqrtPriceCurrent - sqrtPriceLower);
        } else {
            amount1 = liquidity * (sqrtPriceUpper - sqrtPriceLower);
        }

        return { amount0, amount1 };
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

    // jnrUSD: calls convertToAssets(balance) to get accurate USDe value (1 USDe = $1)
    async fetchJnrusdBalance(wallet) {
        try {
            const vault = new ethers.Contract(TOKENS.JNRUSD_VAULT, VAULT_ABI, this.provider);
            const sharesBN = await vault.balanceOf(wallet);
            if (sharesBN.isZero()) return { value_usd: 0, balance: 0 };
            const assetsBN = await vault.convertToAssets(sharesBN);
            const balance = parseFloat(ethers.utils.formatUnits(sharesBN, 18));
            const value_usd = parseFloat(ethers.utils.formatUnits(assetsBN, 18)); // USDe ≈ $1
            return { value_usd, balance };
        } catch (e) { return { value_usd: 0, balance: 0 }; }
    }

    async getAmyPrice() {
        return await this._getGeckoPoolPrice('AMY', AMY_HONEY_POOL);
    }

    async getBeraPrice() {
        return await this._getGeckoPoolPrice('BERA', '0x2608b7c8eb17e22cb95b7cd6f872993cf33a4ca1') || 0.60;
    }

    async getSailrPrice() {
        return await this._getGeckoPoolPrice('SAILR', TOKENS.SAILR_POOL)
            || await this._getDexScreenerTokenPrice('SAILR', TOKENS.SAILR)
            || await this._getGeckoTokenPrice('SAILR', TOKENS.SAILR);
    }

    async getPlsBeraPrice() {
        return await this._getGeckoPoolPrice('plsBERA', '0x225915329b032b3385ac28b0dc53d989e8446fd1')
            || await this._getDexScreenerTokenPrice('plsBERA', TOKENS.PLSBERA)
            || await this._getGeckoTokenPrice('plsBERA', TOKENS.PLSBERA);
    }

    async getPlvHedgePrice() {
        return await this._getGeckoPoolPrice('plvHEDGE', '0xbb27edace822f244a91c2417b07c617e7a691be6')
            || await this._getDexScreenerTokenPrice('plvHEDGE', TOKENS.PLVHEDGE)
            || await this._getGeckoTokenPrice('plvHEDGE', TOKENS.PLVHEDGE);
    }

    async getPlsKdkPrice() {
        const addr = '0xc6173a3405fdb1f5c42004d2d71cba9bf1cfa522';
        return await this._getDexScreenerTokenPrice('plsKDK', addr)
            || await this._getGeckoTokenPrice('plsKDK', addr);
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
        } catch (e) {
            console.warn(`[Full Strategy] Goldsky AMY/USDT0 unavailable (${e.response?.status || e.message}); using on-chain Kodiak fallback.`);
            return await this.fetchKodiakPositionsUsdt0Onchain(wallet, amyPrice);
        }
    }

    async fetchKodiakPositionsUsdt0Onchain(wallet, amyPrice) {
        try {
            const nfpm = new ethers.Contract(KODIAK_NFPM, KODIAK_NFPM_ABI, this.provider);
            const pool = new ethers.Contract(AMY_USDT0_POOL, KODIAK_POOL_ABI, this.provider);
            const slot0 = await pool.slot0();
            const currentTick = Number(slot0.tick);
            const poolToken0 = (await pool.token0()).toLowerCase();
            const poolToken1 = (await pool.token1()).toLowerCase();
            const amy = AMY_TOKEN.toLowerCase();
            const usdt0 = USDT0_TOKEN.toLowerCase();

            if (!((poolToken0 === amy && poolToken1 === usdt0) || (poolToken0 === usdt0 && poolToken1 === amy))) {
                console.warn(`[Full Strategy] AMY/USDT0 pool token mismatch token0=${poolToken0} token1=${poolToken1}`);
                return { value_usd: 0, count: 0, in_range_count: 0 };
            }

            const nftCount = (await nfpm.balanceOf(wallet)).toNumber();
            let inRangeValue = 0;
            let inRangeCount = 0;
            let activeCount = 0;

            for (let i = 0; i < nftCount; i++) {
                try {
                    const tokenId = await nfpm.tokenOfOwnerByIndex(wallet, i);
                    const position = await nfpm.positions(tokenId);
                    const posToken0 = position.token0.toLowerCase();
                    const posToken1 = position.token1.toLowerCase();
                    const isAmyUsdt0 = (posToken0 === amy && posToken1 === usdt0) || (posToken0 === usdt0 && posToken1 === amy);

                    if (!isAmyUsdt0 || position.liquidity.isZero()) continue;

                    activeCount++;
                    const tickLower = Number(position.tickLower);
                    const tickUpper = Number(position.tickUpper);
                    const isInRange = currentTick >= tickLower && currentTick < tickUpper;
                    if (!isInRange) continue;

                    const { amount0, amount1 } = this.calculateOnchainLpAmounts(
                        parseFloat(position.liquidity.toString()),
                        tickLower,
                        tickUpper,
                        currentTick
                    );
                    const amount0Decimal = amount0 / (posToken0 === usdt0 ? 1e6 : 1e18);
                    const amount1Decimal = amount1 / (posToken1 === usdt0 ? 1e6 : 1e18);
                    const valueUsd = posToken0 === amy
                        ? (amount0Decimal * amyPrice) + amount1Decimal
                        : amount0Decimal + (amount1Decimal * amyPrice);

                    inRangeValue += valueUsd;
                    inRangeCount++;
                } catch (e) {}
            }

            return { value_usd: inRangeValue, count: activeCount, in_range_count: inRangeCount };
        } catch (e) {
            console.warn(`[Full Strategy] On-chain AMY/USDT0 fallback failed: ${e.message}`);
            return { value_usd: 0, count: 0, in_range_count: 0 };
        }
    }

    async runEarnDataUpdate() {
        console.log('📊 [Earn Update] Syncing APR/TVL from sheet...');
        try {
            const sheetData = await this.fetchAprTvlSheet();

            if (sheetData) {
                await this.applySheetMetrics(sheetData);
            } else {
                console.warn('⚠️ [Earn Update] Sheet unavailable after retries — skipping update, existing DB values preserved.');
            }

            console.log('✅ [Earn Update] All ground truth stats synced.');
        } catch (err) { console.error('❌ [Earn Update] Master Error:', err.message); }
    }


    async fetchAprTvlSheet(retries = 3, delayMs = 5000) {
        if (!APR_TVL_SHEET_ID) {
            console.warn('⚠️ [Earn Update] APR/TVL sheet ID is not configured.');
            return null;
        }
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const sheets = await this.getSheetsClient();
                const res = await sheets.spreadsheets.values.get({
                    spreadsheetId: APR_TVL_SHEET_ID,
                    range: APR_TVL_SHEET_RANGE,
                });
                const rows = res.data.values || [];
                if (rows.length === 0) {
                    console.warn(`⚠️ [Earn Update] APR/TVL sheet returned no rows (attempt ${attempt}/${retries}).`);
                    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs));
                    continue;
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
                    console.warn(`⚠️ [Earn Update] APR/TVL sheet returned no valid entries (attempt ${attempt}/${retries}).`);
                    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs));
                    continue;
                }
                console.log(`📈 [Earn Update] Loaded APR/TVL sheet with ${Object.keys(map).length} entries.`);
                return map;
            } catch (err) {
                console.error(`❌ [Earn Update] Failed to fetch APR/TVL sheet (attempt ${attempt}/${retries}): ${err.message}`);
                if (attempt < retries) await new Promise(r => setTimeout(r, delayMs));
            }
        }
        console.error('❌ [Earn Update] All sheet fetch attempts failed — skipping update to preserve existing DB values.');
        return null;
    }

    async applySheetMetrics(sheetData) {
        let applied = 0;
        for (const [strategyKey, positionId] of Object.entries(SHEET_STRATEGY_MAP)) {
            const row = sheetData[strategyKey];
            if (!row) {
                console.warn(`⚠️ [Earn Update] APR/TVL sheet missing entry for "${strategyKey}".`);
                continue;
            }

            // Format TVL: if the sheet contains a raw number (e.g. "25070353.07"), format it properly
            let displayTvl;
            if (row.tvlValue !== null && Number.isFinite(row.tvlValue) && row.tvlValue > 0) {
                if (row.tvlValue >= 1_000_000) {
                    displayTvl = `$${parseFloat((row.tvlValue / 1_000_000).toFixed(2))}M`;
                } else if (row.tvlValue >= 1_000) {
                    displayTvl = `$${parseFloat((row.tvlValue / 1_000).toFixed(2))}K`;
                } else {
                    displayTvl = `$${parseFloat(row.tvlValue.toFixed(2))}`;
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
            `INSERT INTO earn_data_history (position_id, tvl, apr, timestamp)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (position_id) DO UPDATE SET tvl = EXCLUDED.tvl, apr = EXCLUDED.apr, timestamp = EXCLUDED.timestamp`,
            [id, tvl, apr]
        );
    }

}

module.exports = StrategyService;
