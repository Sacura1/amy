const axios = require('axios');
const { ethers } = require('ethers');

const ZERION_API_BASE = 'https://api.zerion.io/v1';
const BERACHAIN_ID = 80094;
const CACHE_MS = 15 * 60 * 1000;
const WALLET_DAILY_CAP = 50;
const GLOBAL_HOURLY_CAP = 75;
const PORTFOLIO_NORMALIZER_VERSION = 15;
const DUST_DISPLAY_USD = 1;

const RPC_URLS = (process.env.BERACHAIN_RPC_URLS || [
    process.env.BERACHAIN_RPC,
    'https://rpc.berachain.com',
    'https://berachain-rpc.publicnode.com',
    'https://berachain.drpc.org',
    'https://rpc.berachain-apis.com',
].filter(Boolean).join(','))
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function name() view returns (string)',
];
const ERC721_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function contractURI() view returns (string)',
];
const VAULT_ABI = [
    ...ERC20_ABI,
    'function convertToAssets(uint256 shares) view returns (uint256)',
];
const LP_NFPM_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
    'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256 amount0,uint256 amount1)',
];
const KODIAK_NFPM_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function positions(uint256 tokenId) view returns (uint88 nonce, address operator, address token0, address token1, address deployer, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
    'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256 amount0,uint256 amount1)',
];
const LP_POOL_ABI = [
    'function globalState() view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked)',
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
    'function totalFeeGrowth0Token() view returns (uint256)',
    'function totalFeeGrowth1Token() view returns (uint256)',
    'function ticks(int24 tick) view returns (uint128 liquidityTotal, int128 liquidityDelta, uint256 outerFeeGrowth0Token, uint256 outerFeeGrowth1Token, int56 outerTickCumulative, uint160 outerSecondsPerLiquidity)',
];
const FARMING_CENTER_ABI = [
    'function deposits(uint256 tokenId) view returns (uint256 L2TokenId, uint32 numberOfFarms, bool inLimitFarming, address owner)',
    'event Deposit(uint256 indexed tokenId, address indexed owner)',
];

const AMY = {
    address: '0x098a75bAedDEc78f9A8D0830d6B86eAc5cC8894e',
    symbol: 'AMY',
    name: 'Amy',
    geckoPool: 'https://api.geckoterminal.com/api/v2/networks/berachain/pools/0xff716930eefb37b5b4ac55b1901dc5704b098d84',
};
const HONEY = {
    address: '0xfcbd14dc51f0a4d49d5e53c2e0950e0bc26d0dce',
    symbol: 'HONEY',
};
const USDT0 = {
    address: '0x779ded0c9e1022225f8e0630b35a9b54be713736',
    symbol: 'USDT0',
};
const BULLA_AMY_HONEY = {
    pool: '0xff716930eefb37b5b4ac55b1901dc5704b098d84',
    nfpm: '0xc228fbF18864B6e91d15abfcc2039f87a5F66741',
    farmingCenter: '0x8dE1e590bdcBb65864e69dC2B5B020d9855E99A2',
};
const KODIAK_AMY_USDT0 = {
    pool: '0xed1bb27281a8bbf296270ed5bb08acf7ecab5c17',
    nfpm: '0xFE5E8C83FFE4d9627A75EaA7Fee864768dB989bD',
};

const TOKEN_PRICE_POOLS = {
    '0x59a61b8d3064a51a95a5d6393c03e2152b1a2770': 'https://api.geckoterminal.com/api/v2/networks/berachain/pools/0x704d1c9dddeb2ccd4bf999f3426c755917f0d00c',
    '0x28602b1ae8ca0ff5cd01b96a36f88f72febe727a': 'https://api.geckoterminal.com/api/v2/networks/berachain/pools/0xbb27edace822f244a91c2417b07c617e7a691be6',
    '0x656b95e550c07a9ffe548bd4085c72418ceb1dba': 'https://api.geckoterminal.com/api/v2/networks/berachain/pools/0x1127f801cb3ab7bdf8923272949aa7dba94b5805',
    '0x118d2ceee9785eaf70c15cd74cd84c9f8c3eec9a': 'https://api.geckoterminal.com/api/v2/networks/berachain/pools/0x2608b7c8eb17e22cb95b7cd6f872993cf33a4ca1',
    '0xc66d1a2460de7b96631f4ac37ce906acfa6a3c30': 'https://api.geckoterminal.com/api/v2/networks/berachain/pools/0x225915329b032b3385ac28b0dc53d989e8446fd1',
    '0xc6173a3405fdb1f5c42004d2d71cba9bf1cfa522': 'https://api.geckoterminal.com/api/v2/networks/berachain/pools/0x83053366827b288058115212221bd1fef4f16728',
};

const KNOWN_CHAIN_SLUGS = [
    'abstract',
    'arbitrum-one',
    'arbitrum',
    'avalanche',
    'base',
    'berachain',
    'binance-smart-chain',
    'ethereum',
    'linea',
    'monad',
    'optimism',
    'polygon-pos',
    'polygon',
    'zora',
    '0g',
];

const KNOWN_TOKEN_METADATA = {
    'berachain:base': { symbol: 'BERA', name: 'BERA' },
    'berachain:0x6969696969696969696969696969696969696969': { symbol: 'WBERA', name: 'Wrapped Bera' },
    'berachain:0xfcbd14dc51f0a4d49d5e53c2e0950e0bc26d0dce': { symbol: 'HONEY', name: 'Honey' },
    'berachain:0x59a61b8d3064a51a95a5d6393c03e2152b1a2770': { symbol: 'SAIL.r', name: 'SailOut Royalty' },
    'berachain:0x118d2ceee9785eaf70c15cd74cd84c9f8c3eec9a': { symbol: 'sWBERA', name: 'POL Staked WBERA' },
    'berachain:0x2206182a4264bce0663681448b24fc6781fc8e40': { symbol: 'BULLA', name: 'BULLA' },
    'berachain:0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34': { symbol: 'USDe', name: 'USDe' },
    'berachain:0x779ded0c9e1022225f8e0630b35a9b54be713736': { symbol: 'USDT0', name: 'USDt0' },
    'berachain:0xc6173a3405fdb1f5c42004d2d71cba9bf1cfa522': { symbol: 'plsKDK', name: 'plsKDK' },
    'berachain:0xc0d1ac00a30fa4e30e44afc7313d6312c87e21df': { symbol: 'KDK', name: 'Kodiak' },
    'berachain:0x656b95e550c07a9ffe548bd4085c72418ceb1dba': { symbol: 'BGT', name: 'Bera Governance Token' },
    'berachain:0x28602b1ae8ca0ff5cd01b96a36f88f72febe727a': { symbol: 'plvHEDGE', name: 'Plutus HEDGE Vault' },
    'base:eth': { symbol: 'ETH', name: 'Ethereum' },
    'base:0x548d3b444da39686d1a6f1544781d154e7cd1ef7': { symbol: 'sKAITO', name: 'Staked KAITO' },
    'base:0x98d0baa52b2d063e780de12f615f963fe8537553': { symbol: 'KAITO', name: 'KAITO' },
    'base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', name: 'USD Coin' },
    'ethereum:eth': { symbol: 'ETH', name: 'Ethereum' },
    'linea:eth': { symbol: 'ETH', name: 'Ethereum' },
    'optimism:eth': { symbol: 'ETH', name: 'Ethereum' },
    'zora:eth': { symbol: 'ETH', name: 'Ethereum' },
    'binance-smart-chain:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { symbol: 'WBNB', name: 'Wrapped BNB' },
    'binance-smart-chain:0xb8c77482e45f1f44de1745f52c74426c631bdd52': { symbol: 'BNB', name: 'BNB' },
    'binance-smart-chain:0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', name: 'Tether USD' },
};

const AMY_OVERLAY_TOKENS = [
    { key: 'plsbera_wallet', address: '0xc66d1a2460de7b96631f4ac37ce906acfa6a3c30', label: 'plsBERA' },
    { key: 'plsbera_staked', address: '0xe8bEB147a93BB757DB15e468FaBD119CA087EfAE', label: 'plsBERA - Staked', priceAddress: '0xc66d1a2460de7b96631f4ac37ce906acfa6a3c30' },
    { key: 'plskdk_wallet', address: '0xC6173A3405Fdb1f5c42004D2d71Cba9Bf1Cfa522', label: 'plsKDK' },
    { key: 'plskdk_staked', address: '0x9e6B748d25Ed2600Aa0ce7Cbb42267adCF21Fd9B', label: 'plsKDK - Staked', priceAddress: '0xC6173A3405Fdb1f5c42004D2d71Cba9Bf1Cfa522' },
    { key: 'plvhedge', address: '0x28602B1ae8cA0ff5CD01B96A36f88F72FeBE727A', label: 'plvHEDGE' },
];

const NFT_CONTRACTS = [
    '0x333814f5e16eee61d0c0b03a5b6abbd424b381c2',
    '0x5a30c392714a9a9a8177c7998d9d59c3dd120917',
];

const VAULTS = [
    {
        key: 'snrusd',
        address: '0x18e310dD4A6179D9600E95D18926AB7819B2A071',
        tokenAddress: '0xC38421E5577250EBa177Bc5bC832E747bea13Ee0',
        label: 'snrUSD - Vault',
        unitPrice: 1,
        includeWalletToken: true,
    },
    { key: 'jnrusd', address: '0x5f6eE0cc57862EAfAD1a572819B6Dc1485B95E46', label: 'jnrUSD - Vault', unitPrice: 1, convertToAssets: true },
];

function isWallet(value) {
    return /^0x[a-fA-F0-9]{40}$/.test(value || '');
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function nestedValue(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    if (Array.isArray(obj)) {
        for (const item of obj) {
            const found = nestedValue(item, keys);
            if (found !== undefined && found !== null && found !== '') return found;
        }
        return undefined;
    }
    for (const key of keys) {
        if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
    }
    for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') {
            const found = nestedValue(value, keys);
            if (found !== undefined && found !== null && found !== '') return found;
        }
    }
    return undefined;
}

function quantityNumber(value) {
    if (value && typeof value === 'object') {
        if (value.numeric !== undefined) return num(value.numeric);
        if (value.float !== undefined) return num(value.float);
        if (value.int !== undefined && value.decimals !== undefined) {
            return Number(ethers.utils.formatUnits(value.int, Number(value.decimals || 0)));
        }
    }
    return num(value);
}

function cleanText(value) {
    return value === undefined || value === null ? '' : String(value).trim();
}

function canonicalProtocolName(name) {
    return cleanText(name)
        .replace(/USD₮0/g, 'USDT0')
        .replace(/USDâ‚®0/g, 'USDT0')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractPositionIdFromText(value) {
    const match = cleanText(value).match(/#(\d+)/);
    return match ? match[1] : '';
}

function getLiquidityAmounts(liquidity, tickLower, tickUpper, currentTick) {
    const sqrtPriceLower = Math.sqrt(1.0001 ** tickLower);
    const sqrtPriceUpper = Math.sqrt(1.0001 ** tickUpper);
    const sqrtPriceCurrent = Math.sqrt(1.0001 ** currentTick);
    let amount0 = 0;
    let amount1 = 0;

    if (currentTick < tickLower) {
        amount0 = liquidity * (1 / sqrtPriceLower - 1 / sqrtPriceUpper);
    } else if (currentTick >= tickUpper) {
        amount1 = liquidity * (sqrtPriceUpper - sqrtPriceLower);
    } else {
        amount0 = liquidity * (1 / sqrtPriceCurrent - 1 / sqrtPriceUpper);
        amount1 = liquidity * (sqrtPriceCurrent - sqrtPriceLower);
    }

    return { amount0, amount1 };
}

function subIn256(a, b) {
    const two256 = ethers.BigNumber.from(2).pow(256);
    return a.gte(b) ? a.sub(b) : two256.sub(b.sub(a));
}

function feeGrowthInside(globalGrowth, lowerOuter, upperOuter, currentTick, tickLower, tickUpper) {
    const below = currentTick >= tickLower ? lowerOuter : subIn256(globalGrowth, lowerOuter);
    const above = currentTick < tickUpper ? upperOuter : subIn256(globalGrowth, upperOuter);
    return subIn256(subIn256(globalGrowth, below), above);
}

function feeAmountFromGrowth(liquidity, currentInside, lastInside, tokensOwed) {
    const q128 = ethers.BigNumber.from(2).pow(128);
    const delta = subIn256(currentInside, lastInside);
    return ethers.BigNumber.from(liquidity).mul(delta).div(q128).add(tokensOwed || 0);
}

function parseZerionPositionId(positionId) {
    const id = cleanText(positionId);
    const parts = id.split('-');
    if (parts.length < 3) return { tokenOrBase: '', chain: '', type: '' };

    const tokenOrBase = parts[0].toLowerCase();
    const afterToken = id.slice(tokenOrBase.length + 1);
    let chain = '';
    let remainder = '';

    for (const slug of [...KNOWN_CHAIN_SLUGS].sort((a, b) => b.length - a.length)) {
        const prefix = `${slug}-`;
        if (afterToken.startsWith(prefix)) {
            chain = slug;
            remainder = afterToken.slice(prefix.length);
            break;
        }
    }

    if (!chain) {
        chain = parts[1] || '';
        remainder = parts.slice(2).join('-');
    }

    const remainderParts = remainder.split('-');
    return {
        tokenOrBase,
        chain,
        type: remainderParts[remainderParts.length - 1] || '',
    };
}

function pickChainImplementation(fungibleInfo, chain) {
    const implementations = Array.isArray(fungibleInfo?.implementations) ? fungibleInfo.implementations : [];
    return implementations.find(item => cleanText(item.chain_id).toLowerCase() === chain)
        || implementations.find(item => item?.address)
        || {};
}

function nftImageFromAttrs(attrs = {}) {
    return attrs.collection_info?.content?.icon?.url
        || attrs.collection_info?.content?.banner?.url
        || attrs.nft_info?.content?.preview?.url
        || attrs.nft_info?.content?.detail?.url
        || '';
}

function iso(date) {
    return date ? new Date(date).toISOString() : null;
}

function ipfsToHttps(uri = '') {
    if (!uri) return '';
    if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
    return uri;
}

class PortfolioService {
    constructor(db) {
        this.db = db;
        this.providers = RPC_URLS.map(url => new ethers.providers.JsonRpcProvider(url));
        this.priceCache = new Map();
    }

    async withProvider(fn) {
        let lastError;
        for (const provider of this.providers) {
            try {
                return await fn(provider);
            } catch (e) {
                lastError = e;
            }
        }
        throw lastError || new Error('No RPC provider available');
    }

    async getCached(wallet) {
        const { rows } = await this.db.pool.query(
            'SELECT snapshot_data, last_refreshed FROM portfolio_snapshots WHERE LOWER(wallet) = LOWER($1)',
            [wallet]
        );
        if (!rows[0]) return null;
        const data = rows[0].snapshot_data;
        if (!data || data.normalizerVersion !== PORTFOLIO_NORMALIZER_VERSION) return null;
        const lastRefreshed = new Date(rows[0].last_refreshed);
        return {
            data,
            lastRefreshed,
            ageMs: Date.now() - lastRefreshed.getTime(),
        };
    }

    async rateStatus(wallet) {
        const [walletDay, globalHour] = await Promise.all([
            this.db.pool.query(
                `SELECT COUNT(*)::int AS count FROM portfolio_scan_events
                 WHERE LOWER(wallet) = LOWER($1) AND status = 'success' AND created_at > NOW() - INTERVAL '24 hours'`,
                [wallet]
            ),
            this.db.pool.query(
                `SELECT COUNT(*)::int AS count FROM portfolio_scan_events
                 WHERE status = 'success' AND created_at > NOW() - INTERVAL '1 hour'`
            ),
        ]);
        return {
            walletFreshScans24h: walletDay.rows[0]?.count || 0,
            globalFreshScans1h: globalHour.rows[0]?.count || 0,
            walletDailyCap: WALLET_DAILY_CAP,
            globalHourlyCap: GLOBAL_HOURLY_CAP,
        };
    }

    async getPortfolio(wallet, { force = false, source = 'user' } = {}) {
        if (!isWallet(wallet)) throw new Error('Invalid wallet address');
        const cached = await this.getCached(wallet);
        const rate = await this.rateStatus(wallet);
        const nextRefreshAt = cached ? new Date(cached.lastRefreshed.getTime() + CACHE_MS) : null;

        if (cached && !force && cached.ageMs < CACHE_MS) {
            return { ...cached.data, cache: this.cacheMeta(cached, rate, false, nextRefreshAt) };
        }

        if (force && cached && cached.ageMs < CACHE_MS) {
            return { ...cached.data, cache: this.cacheMeta(cached, rate, false, nextRefreshAt, 'Refresh available every 15 minutes.') };
        }

        if (rate.walletFreshScans24h >= WALLET_DAILY_CAP || rate.globalFreshScans1h >= GLOBAL_HOURLY_CAP) {
            if (cached) {
                const message = rate.walletFreshScans24h >= WALLET_DAILY_CAP
                    ? 'Daily refresh limit reached. Showing cached portfolio.'
                    : 'Portfolio refresh traffic is high. Try again shortly.';
                return { ...cached.data, cache: this.cacheMeta(cached, rate, false, nextRefreshAt, message) };
            }
            throw new Error('Portfolio refresh is temporarily unavailable. Try again shortly.');
        }

        try {
            const data = await this.buildPortfolio(wallet);
            await this.db.pool.query(
                `INSERT INTO portfolio_snapshots (wallet, snapshot_data, last_refreshed, updated_at)
                 VALUES ($1, $2, NOW(), NOW())
                 ON CONFLICT (wallet) DO UPDATE
                 SET snapshot_data = EXCLUDED.snapshot_data, last_refreshed = NOW(), updated_at = NOW()`,
                [wallet.toLowerCase(), JSON.stringify(data)]
            );
            await this.logScan(wallet, source, 'success');
            const freshCached = await this.getCached(wallet);
            const freshRate = await this.rateStatus(wallet);
            return { ...data, cache: this.cacheMeta(freshCached, freshRate, true, new Date(Date.now() + CACHE_MS)) };
        } catch (e) {
            await this.logScan(wallet, source, 'failed');
            if (cached) {
                return { ...cached.data, cache: this.cacheMeta(cached, rate, false, nextRefreshAt, 'Fresh scan failed. Showing cached portfolio.') };
            }
            throw e;
        }
    }

    cacheMeta(cached, rate, fresh, nextRefreshAt, message = '') {
        return {
            status: fresh ? 'fresh' : 'cached',
            lastRefreshedAt: iso(cached?.lastRefreshed || new Date()),
            nextRefreshAvailableAt: iso(nextRefreshAt),
            message,
            rate,
        };
    }

    async logScan(wallet, source, status) {
        await this.db.pool.query(
            'INSERT INTO portfolio_scan_events (wallet, trigger_source, status) VALUES ($1, $2, $3)',
            [wallet.toLowerCase(), source, status]
        );
    }

    async buildPortfolio(wallet) {
        const [zerion, fallbackPrices] = await Promise.all([
            this.fetchZerion(wallet).catch(e => ({ walletTokens: [], protocolPositions: [], warning: e.message })),
            this.getFallbackPrices(),
        ]);
        let walletTokens = this.dedupeExactRows(this.applyFallbackPrices(zerion.walletTokens, fallbackPrices));
        let protocolPositions = this.dedupeExactRows(this.applyFallbackPrices(zerion.protocolPositions, fallbackPrices));
        this.applyDuplicateRules(walletTokens, protocolPositions);
        const [rawAmyPositions, collections, plutusClaimables] = await Promise.all([
            this.fetchAmyOverlays(wallet),
            this.fetchNftCollections(wallet),
            this.fetchPlutusClaimables(wallet).catch(() => new Map()),
        ]);
        const amyPositions = this.normalizeAmyOverlaySections(rawAmyPositions, plutusClaimables);
        walletTokens = this.removeAmyProtocolWalletRows(walletTokens);
        protocolPositions = this.removeConfusingAmyProtocolRows(protocolPositions);
        walletTokens = this.mergeAmyWalletRows(walletTokens, amyPositions.filter(row => row.portfolioSection === 'wallet'));
        protocolPositions = [
            ...protocolPositions,
            ...amyPositions.filter(row => row.portfolioSection === 'protocol'),
        ];
        walletTokens = this.filterPortfolioRows(walletTokens).sort((a, b) => num(b.valueUsd) - num(a.valueUsd));
        protocolPositions = this.groupProtocolPositions(protocolPositions);
        protocolPositions = await this.enrichProtocolDetails(wallet, protocolPositions, fallbackPrices);
        protocolPositions = this.filterPortfolioRows(protocolPositions).sort((a, b) => num(b.valueUsd) - num(a.valueUsd));

        const visibleWallet = walletTokens.filter(row => row.includeInTotal !== false);
        const walletValue = visibleWallet.reduce((sum, row) => sum + num(row.valueUsd), 0);
        const protocolValue = protocolPositions.reduce((sum, row) => sum + num(row.valueUsd), 0);
        const totalValue = walletValue + protocolValue;

        return {
            normalizerVersion: PORTFOLIO_NORMALIZER_VERSION,
            wallet: wallet.toLowerCase(),
            summary: {
                totalValueUsd: totalValue,
                walletValueUsd: walletValue,
                protocolValueUsd: protocolValue,
                amyOverlayValueUsd: 0,
                nftValuePolicy: 'NFT quantities are tracked, but NFT USD values are not included.',
            },
            tokens: walletTokens,
            protocols: protocolPositions,
            amyPositions: [],
            collections,
            warnings: [zerion.warning].filter(Boolean),
        };
    }

    zerionHeaders() {
        const key = process.env.ZERION_API_KEY;
        if (!key) throw new Error('ZERION_API_KEY is not configured');
        const token = Buffer.from(`${key}:`).toString('base64');
        return { Authorization: `Basic ${token}`, accept: 'application/json' };
    }

    async fetchZerion(wallet) {
        const rows = [];
        let cursor = null;
        for (let i = 0; i < 8; i++) {
            const params = new URLSearchParams({
                currency: 'usd',
                sort: '-value',
                'filter[positions]': 'no_filter',
                'filter[trash]': 'only_non_trash',
                'page[size]': '100',
            });
            if (cursor) params.set('page[after]', cursor);
            const url = `${ZERION_API_BASE}/wallets/${wallet}/positions/?${params}`;
            const res = await axios.get(url, { headers: this.zerionHeaders(), timeout: 120000 });
            rows.push(...(res.data?.data || []).map(item => this.normalizeZerionPosition(item)));
            const next = res.data?.links?.next;
            if (!next) break;
            cursor = new URL(next).searchParams.get('page[after]');
            if (!cursor) break;
        }

        const walletTokens = rows.filter(r => r.type === 'wallet');
        const protocolPositions = rows.filter(r => r.type !== 'wallet');
        return { walletTokens, protocolPositions };
    }

    normalizeZerionPosition(item) {
        const a = item.attributes || {};
        const rel = item.relationships || {};
        const fungible = rel.fungible?.data || {};
        const app = rel.dapp?.data || {};
        const idParts = parseZerionPositionId(item.id);
        const chain = cleanText(a.chain_id || a.chain || a.protocol?.chain || idParts.chain).toLowerCase();
        const implementation = pickChainImplementation(a.fungible_info, chain);
        const tokenAddress = cleanText(implementation.address || idParts.tokenOrBase || fungible.id).toLowerCase();
        const known = KNOWN_TOKEN_METADATA[`${chain}:${tokenAddress}`] || {};
        const quantity = quantityNumber(a.quantity || a.balance || a.amount);
        const price = num(a.price || a.price_usd || nestedValue(a, ['price', 'price_usd']));
        const value = num(a.value || a.value_usd || a.market_value || (quantity * price));
        const rawName = cleanText(a.name || a.display_name);
        const symbol = cleanText(a.fungible_info?.symbol || a.symbol || a.token_symbol || a.asset_symbol || nestedValue(a, ['symbol', 'ticker']) || known.symbol || '').replace('USD₮0', 'USDT0') || 'Asset';
        const tokenName = cleanText(a.fungible_info?.name || a.token_name || a.asset_name || known.name || symbol);
        const name = !rawName || rawName.toLowerCase() === 'asset' ? tokenName : rawName;
        const type = a.position_type === 'wallet' || a.type === 'wallet' || idParts.type === 'wallet' ? 'wallet' : 'protocol';
        return {
            id: item.id,
            type,
            name,
            symbol,
            chain,
            quantity,
            priceUsd: price,
            valueUsd: value,
            tokenAddress,
            imageUrl: a.fungible_info?.icon?.url || a.fungible_info?.icon_url || a.fungible_info?.image_url || nestedValue(a.fungible_info, ['url', 'icon_url', 'image_url']) || '',
            appName: a.protocol?.name || app.id || '',
            positionType: idParts.type,
            includeInTotal: true,
            source: 'zerion',
        };
    }

    async getFallbackPrices() {
        const sources = new Map([[AMY.address.toLowerCase(), AMY.geckoPool]]);
        for (const [address, pool] of Object.entries(TOKEN_PRICE_POOLS)) {
            sources.set(address.toLowerCase(), pool);
        }

        const entries = await Promise.all([...sources.entries()].map(async ([address, pool]) => {
            const price = await this.getGeckoPrice(pool, address).catch(() => 0);
            return [address, price];
        }));

        return new Map(entries.filter(([, price]) => price > 0));
    }

    applyFallbackPrices(rows, fallbackPrices) {
        return rows.map(row => {
            const tokenAddress = String(row.tokenAddress || '').toLowerCase();
            const isAmy = row.symbol?.toUpperCase() === 'AMY' || tokenAddress === AMY.address.toLowerCase();
            const price = fallbackPrices.get(tokenAddress) || (isAmy ? fallbackPrices.get(AMY.address.toLowerCase()) : 0);
            if (row.valueUsd > 0 || row.priceUsd > 0 || !(price > 0) || !(num(row.quantity) > 0)) return row;
            return {
                ...row,
                priceUsd: price,
                valueUsd: num(row.quantity) * price,
                pricingNote: `${row.symbol || 'Token'} fallback price applied`,
            };
        });
    }

    filterPortfolioRows(rows) {
        return rows.filter(row => {
            if (row.includeInTotal === false) return false;
            if (num(row.valueUsd) > 0) return true;
            if (num(row.priceUsd) > 0 && num(row.quantity) > 0) return true;
            return false;
        });
    }

    dedupeExactRows(rows) {
        const seen = new Set();
        return rows.filter(row => {
            const key = [
                row.id,
                row.type,
                row.chain,
                row.appName,
                row.tokenAddress,
                row.symbol,
                Number(num(row.quantity).toPrecision(15)),
                Number(num(row.priceUsd).toPrecision(15)),
                Number(num(row.valueUsd).toPrecision(15)),
            ].map(value => String(value || '').toLowerCase()).join('|');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    groupProtocolPositions(rows) {
        const groups = new Map();
        for (const row of rows) {
            const groupName = canonicalProtocolName(row.name || row.id);
            const key = [
                String(row.chain || '').toLowerCase(),
                String(row.appName || '').toLowerCase(),
                String(groupName || row.id || '').toLowerCase(),
            ].join('|');

            if (!groups.has(key)) {
                groups.set(key, {
                    ...row,
                    id: `protocol:${key}`,
                    name: groupName || row.name,
                    quantity: 0,
                    priceUsd: 0,
                    valueUsd: 0,
                    symbol: '',
                    tokenAddress: '',
                    imageUrl: '',
                    imageUrls: [],
                    components: [],
                });
            }

            const group = groups.get(key);
            group.valueUsd += num(row.valueUsd);
            group.quantity += num(row.quantity);
            group.priceUsd = group.quantity > 0 ? group.valueUsd / group.quantity : 0;

            const symbol = String(row.symbol || '').trim();
            const imageUrl = String(row.imageUrl || '').trim();
            const component = {
                symbol,
                name: row.name,
                quantity: num(row.quantity),
                priceUsd: num(row.priceUsd),
                valueUsd: num(row.valueUsd),
                imageUrl,
                tokenAddress: row.tokenAddress,
                positionType: row.positionType,
                id: row.id,
            };
            group.components.push(component);

            const symbols = new Set(String(group.symbol || '').split('/').filter(Boolean));
            if (symbol) symbols.add(symbol.replace('USD₮0', 'USDT0'));
            group.symbol = [...symbols].join('/');

            if (imageUrl && !group.imageUrls.includes(imageUrl)) group.imageUrls.push(imageUrl);
            group.imageUrl = group.imageUrls[0] || '';
        }

        return [...groups.values()].map(group => this.applyGenericProtocolDetails(group));
    }

    applyGenericProtocolDetails(group) {
        const rewardComponents = (group.components || []).filter(component => {
            const positionType = String(component.positionType || '').toLowerCase();
            return ['reward', 'rewards', 'claimable', 'fee', 'fees'].includes(positionType)
                || String(component.id || '').toLowerCase().endsWith('-reward');
        });
        if (!rewardComponents.length) return group;

        const claimableFeesUsd = rewardComponents.reduce((sum, component) => sum + num(component.valueUsd), 0);
        const claimableFees = rewardComponents
            .filter(component => num(component.valueUsd) > 0 || num(component.quantity) > 0)
            .map(component => ({
                symbol: component.symbol,
                name: component.name,
                quantity: num(component.quantity),
                priceUsd: num(component.priceUsd),
                valueUsd: num(component.valueUsd),
                imageUrl: component.imageUrl,
                tokenAddress: component.tokenAddress,
            }));
        const nonRewardComponents = (group.components || []).filter(component => !rewardComponents.includes(component));

        return {
            ...group,
            components: nonRewardComponents.length ? nonRewardComponents : group.components,
            details: {
                ...(group.details || {}),
                type: group.details?.type || 'protocol',
                claimableFeesUsd,
                claimableFees,
                claimableSource: 'zerion',
            },
        };
    }

    applyDuplicateRules(walletTokens, protocolRows) {
        for (const row of walletTokens) {
            const chain = String(row.chain || '').toLowerCase();
            const tokenAddress = String(row.tokenAddress || '').toLowerCase();
            const quantity = num(row.quantity);
            const exactDuplicate = protocolRows.some(p =>
                chain
                && tokenAddress
                && chain === String(p.chain || '').toLowerCase()
                && tokenAddress === String(p.tokenAddress || '').toLowerCase()
                && quantity > 0
                && Math.abs(quantity - num(p.quantity)) < 0.00000001
            );
            if (exactDuplicate) {
                row.includeInTotal = false;
                row.duplicateReason = 'Exact wallet/protocol duplicate';
                continue;
            }

            const symbol = String(row.symbol || '').toLowerCase();
            const symbolCore = symbol.replace(/^s/, '');
            const looksLikeReceipt = symbol === 'skaito'
                || symbol.includes('receipt')
                || symbol.includes('vault')
                || symbol.includes('share')
                || symbol.includes('staked')
                || (symbol.startsWith('s') && symbol.length >= 4);
            if (!looksLikeReceipt) continue;
            const matched = protocolRows.some(p => {
                const haystack = `${p.name} ${p.symbol} ${p.appName}`.toLowerCase();
                return haystack.includes(`(${symbol})`)
                    || haystack.includes(`[${symbol}]`)
                    || haystack.includes(symbolCore);
            });
            if (matched) {
                row.includeInTotal = false;
                row.duplicateReason = 'Receipt token represented by protocol position';
            }
        }
    }

    amyAssetKey(row) {
        const haystack = `${row?.id || ''} ${row?.name || ''} ${row?.symbol || ''} ${row?.tokenAddress || ''}`.toLowerCase();
        if (haystack.includes('plvhedge') || haystack.includes('plutus hedge')) return 'plvhedge';
        if (haystack.includes('plsbera')) return 'plsbera';
        if (haystack.includes('plskdk')) return 'plskdk';
        if (haystack.includes('snrusd')) return 'snrusd';
        if (haystack.includes('jnrusd')) return 'jnrusd';
        return '';
    }

    removeAmyProtocolWalletRows(walletTokens) {
        return walletTokens.filter(row => {
            const key = this.amyAssetKey(row);
            return !['plsbera', 'plskdk', 'snrusd', 'jnrusd'].includes(key);
        });
    }

    removeConfusingAmyProtocolRows(protocolRows) {
        return protocolRows.filter(row => {
            const haystack = `${row?.name || ''} ${row?.symbol || ''} ${row?.appName || ''} ${row?.tokenAddress || ''}`.toLowerCase();
            return !(haystack.includes('plutus hedge') || haystack.includes('plvhedge'));
        });
    }

    mergeAmyWalletRows(walletTokens, amyWalletRows) {
        const existingKeys = new Set(walletTokens.map(row => this.amyAssetKey(row)).filter(Boolean));
        const additions = amyWalletRows.filter(row => !existingKeys.has(this.amyAssetKey(row)));
        return [...walletTokens, ...additions];
    }

    normalizeAmyOverlaySections(rows, plutusClaimables = new Map()) {
        const grouped = new Map();
        const singles = [];

        for (const row of rows || []) {
            const key = this.amyAssetKey(row);
            if (key === 'plvhedge') {
                singles.push({
                    ...row,
                    type: 'wallet',
                    name: 'plvHEDGE',
                    symbol: 'plvHEDGE',
                    portfolioSection: 'wallet',
                    source: 'amy_edge_case',
                });
                continue;
            }
            if (!['plsbera', 'plskdk'].includes(key)) {
                singles.push({
                    ...row,
                    type: 'protocol',
                    portfolioSection: 'protocol',
                    source: 'amy_edge_case',
                });
                continue;
            }

            const label = key === 'plsbera' ? 'plsBERA' : 'plsKDK';
            const claimableDetails = plutusClaimables.get(key);
            const current = grouped.get(key) || {
                ...row,
                id: key,
                type: 'protocol',
                name: label,
                symbol: label,
                quantity: 0,
                valueUsd: 0,
                priceUsd: 0,
                imageUrl: this.localTokenImage(label),
                tokenAddress: row.tokenAddress,
                portfolioSection: 'protocol',
                source: 'amy_edge_case',
                details: claimableDetails || row.details,
            };
            current.quantity += num(row.quantity);
            current.valueUsd += num(row.valueUsd);
            current.priceUsd = current.quantity > 0 ? current.valueUsd / current.quantity : num(row.priceUsd);
            grouped.set(key, current);
        }

        return [...singles, ...grouped.values()];
    }

    async enrichProtocolDetails(wallet, protocolRows, fallbackPrices) {
        const [bullaDetails, kodiakDetails] = await Promise.all([
            this.fetchBullaAmyHoneyDetails(wallet, fallbackPrices).catch(() => null),
            this.fetchKodiakAmyUsdt0Details(wallet, fallbackPrices).catch(() => null),
        ]);
        let addedBullaAmyHoney = false;
        const enrichedRows = [];

        for (const row of protocolRows) {
            const haystack = `${row.name || ''} ${row.symbol || ''} ${row.appName || ''}`.toLowerCase();
            const isBullaAmyHoney = haystack.includes('amy') && haystack.includes('honey') && (haystack.includes('bulla') || haystack.includes('pool'));
            if (isBullaAmyHoney && bullaDetails) {
                if (addedBullaAmyHoney) continue;
                addedBullaAmyHoney = true;
                enrichedRows.push({
                    ...row,
                    name: 'Bulla AMY/HONEY Pool',
                    symbol: 'AMY/HONEY',
                    valueUsd: bullaDetails.valueUsd || row.valueUsd,
                    components: bullaDetails.components,
                    imageUrls: bullaDetails.imageUrls,
                    imageUrl: bullaDetails.imageUrl,
                    details: bullaDetails.details,
                });
                continue;
            }

            const normalized = haystack.replace(/usd₮0/g, 'usdt0').replace(/usdto/g, 'usdt0');
            const isKodiakAmyUsdt0 = normalized.includes('amy') && (normalized.includes('usdt0') || normalized.includes('usd')) && (normalized.includes('kodiak') || normalized.includes('pool'));
            if (isKodiakAmyUsdt0 && kodiakDetails) {
                const positionId = this.rowPositionId(row);
                const rowDetails = positionId && kodiakDetails.positionsById ? kodiakDetails.positionsById[positionId] : null;
                const details = rowDetails || kodiakDetails;
                enrichedRows.push({
                    ...row,
                    name: positionId ? `Kodiak AMY/USDT0 Pool (#${positionId})` : 'Kodiak AMY/USDT0 Pool',
                    symbol: 'AMY/USDT0',
                    valueUsd: details.valueUsd || row.valueUsd,
                    components: details.components,
                    imageUrls: details.imageUrls,
                    imageUrl: details.imageUrl,
                    details: details.details,
                });
                continue;
            }

            enrichedRows.push(row);
        }

        return enrichedRows;
    }

    rowPositionId(row) {
        const direct = extractPositionIdFromText(row?.name);
        if (direct) return direct;
        for (const component of row?.components || []) {
            const fromName = extractPositionIdFromText(component?.name);
            if (fromName) return fromName;
            const fromId = extractPositionIdFromText(component?.id);
            if (fromId) return fromId;
        }
        return '';
    }

    async fetchBullaAmyHoneyDetails(wallet, fallbackPrices) {
        return this.withProvider(async provider => {
            const nfpm = new ethers.Contract(BULLA_AMY_HONEY.nfpm, LP_NFPM_ABI, provider);
            const pool = new ethers.Contract(BULLA_AMY_HONEY.pool, LP_POOL_ABI, provider);
            const farmingCenter = new ethers.Contract(BULLA_AMY_HONEY.farmingCenter, FARMING_CENTER_ABI, provider);
            const currentTick = await this.getPoolTick(pool);
            const amyPrice = fallbackPrices.get(AMY.address.toLowerCase()) || 0;

            const tokenIds = new Set();
            const nftBalance = await nfpm.balanceOf(wallet);
            for (let i = 0; i < nftBalance.toNumber(); i++) {
                const tokenId = await nfpm.tokenOfOwnerByIndex(wallet, i).catch(() => null);
                if (tokenId) tokenIds.add(tokenId.toString());
            }

            const currentBlock = await provider.getBlockNumber();
            const fromBlock = Math.max(0, currentBlock - 9900);
            const events = await farmingCenter.queryFilter(farmingCenter.filters.Deposit(null, wallet), fromBlock, currentBlock).catch(() => []);
            for (const event of events) {
                const tokenId = event.args?.tokenId;
                if (!tokenId) continue;
                const deposit = await farmingCenter.deposits(tokenId).catch(() => null);
                if (deposit?.owner?.toLowerCase() === wallet.toLowerCase()) tokenIds.add(tokenId.toString());
            }

            let amyAmount = 0;
            let honeyAmount = 0;
            let amyFees = 0;
            let honeyFees = 0;
            let valueUsd = 0;
            let inRangePositions = 0;
            let outOfRangePositions = 0;
            const positionIds = [];

            for (const tokenId of tokenIds) {
                const position = await nfpm.positions(tokenId).catch(() => null);
                if (!position || !position.token0 || !position.token1 || position.liquidity.isZero()) continue;
                const token0 = position.token0.toLowerCase();
                const token1 = position.token1.toLowerCase();
                const isAmyHoney = (token0 === AMY.address.toLowerCase() && token1 === HONEY.address.toLowerCase())
                    || (token0 === HONEY.address.toLowerCase() && token1 === AMY.address.toLowerCase());
                if (!isAmyHoney) continue;

                positionIds.push(tokenId);
                const inRange = currentTick >= Number(position.tickLower) && currentTick < Number(position.tickUpper);
                if (inRange) inRangePositions += 1;
                else outOfRangePositions += 1;

                const amounts = getLiquidityAmounts(Number(position.liquidity.toString()), Number(position.tickLower), Number(position.tickUpper), currentTick);
                const amount0 = amounts.amount0 / 1e18;
                const amount1 = amounts.amount1 / 1e18;
                const fees = await this.getBullaPositionFees(nfpm, position, tokenId, wallet).catch(() => ({
                    fee0: position.tokensOwed0 || ethers.BigNumber.from(0),
                    fee1: position.tokensOwed1 || ethers.BigNumber.from(0),
                }));
                const owed0 = Number(ethers.utils.formatUnits(fees.fee0 || 0, 18));
                const owed1 = Number(ethers.utils.formatUnits(fees.fee1 || 0, 18));

                if (token0 === AMY.address.toLowerCase()) {
                    amyAmount += amount0;
                    honeyAmount += amount1;
                    amyFees += owed0;
                    honeyFees += owed1;
                } else {
                    honeyAmount += amount0;
                    amyAmount += amount1;
                    honeyFees += owed0;
                    amyFees += owed1;
                }
            }

            valueUsd = (amyAmount * amyPrice) + honeyAmount;
            if (!(valueUsd > 0)) return null;

            const amyValue = amyAmount * amyPrice;
            const honeyValue = honeyAmount;
            const claimableFeesUsd = (amyFees * amyPrice) + honeyFees;
            return {
                valueUsd,
                imageUrl: '/image/amy_honey.png',
                imageUrls: ['/pro.jpg', '/honey.png'],
                components: [
                    { symbol: 'AMY', name: 'AMY', quantity: amyAmount, priceUsd: amyPrice, valueUsd: amyValue, imageUrl: '/pro.jpg' },
                    { symbol: 'HONEY', name: 'HONEY', quantity: honeyAmount, priceUsd: 1, valueUsd: honeyValue, imageUrl: '/honey.png' },
                ],
                details: {
                    type: 'lp',
                    claimableFeesUsd,
                    claimableFees: [
                        { symbol: 'AMY', quantity: amyFees, priceUsd: amyPrice, valueUsd: amyFees * amyPrice },
                        { symbol: 'HONEY', quantity: honeyFees, priceUsd: 1, valueUsd: honeyFees },
                    ],
                    rangeStatus: inRangePositions > 0 ? 'In Range' : 'Out of Range',
                    positionsFound: inRangePositions + outOfRangePositions,
                    inRangePositions,
                    outOfRangePositions,
                    manageUrl: positionIds[0] ? `https://www.bulla.exchange/positions/${positionIds[0]}` : 'https://www.bulla.exchange/pools',
                    positionIds,
                },
            };
        });
    }

    async fetchKodiakAmyUsdt0Details(wallet, fallbackPrices) {
        return this.withProvider(async provider => {
            const nfpm = new ethers.Contract(KODIAK_AMY_USDT0.nfpm, KODIAK_NFPM_ABI, provider);
            const pool = new ethers.Contract(KODIAK_AMY_USDT0.pool, LP_POOL_ABI, provider);
            const currentTick = await this.getPoolTick(pool);
            const amyPrice = fallbackPrices.get(AMY.address.toLowerCase()) || 0;

            const tokenIds = new Set();
            const nftBalance = await nfpm.balanceOf(wallet);
            for (let i = 0; i < nftBalance.toNumber(); i++) {
                const tokenId = await nfpm.tokenOfOwnerByIndex(wallet, i).catch(() => null);
                if (tokenId) tokenIds.add(tokenId.toString());
            }

            let amyAmount = 0;
            let usdt0Amount = 0;
            let amyFees = 0;
            let usdt0Fees = 0;
            let inRangePositions = 0;
            let outOfRangePositions = 0;
            const positionIds = [];
            const positionsById = {};

            for (const tokenId of tokenIds) {
                const position = await nfpm.positions(tokenId).catch(() => null);
                if (!position || !position.token0 || !position.token1) continue;
                const token0 = position.token0.toLowerCase();
                const token1 = position.token1.toLowerCase();
                const isAmyUsdt0 = (token0 === AMY.address.toLowerCase() && token1 === USDT0.address.toLowerCase())
                    || (token0 === USDT0.address.toLowerCase() && token1 === AMY.address.toLowerCase());
                if (!isAmyUsdt0) continue;

                const fees = await this.getBullaPositionFees(nfpm, position, tokenId, wallet).catch(() => ({
                    fee0: position.tokensOwed0 || ethers.BigNumber.from(0),
                    fee1: position.tokensOwed1 || ethers.BigNumber.from(0),
                }));
                const hasLiquidity = !position.liquidity.isZero();
                const hasFees = !(fees.fee0 || ethers.BigNumber.from(0)).isZero() || !(fees.fee1 || ethers.BigNumber.from(0)).isZero();
                if (!hasLiquidity && !hasFees) continue;

                positionIds.push(tokenId);
                let positionAmyAmount = 0;
                let positionUsdt0Amount = 0;
                let positionInRange = false;
                if (hasLiquidity) {
                    positionInRange = currentTick >= Number(position.tickLower) && currentTick < Number(position.tickUpper);
                    if (positionInRange) inRangePositions += 1;
                    else outOfRangePositions += 1;
                }

                if (hasLiquidity) {
                    const amounts = getLiquidityAmounts(Number(position.liquidity.toString()), Number(position.tickLower), Number(position.tickUpper), currentTick);
                    const amount0 = amounts.amount0 / (token0 === USDT0.address.toLowerCase() ? 1e6 : 1e18);
                    const amount1 = amounts.amount1 / (token1 === USDT0.address.toLowerCase() ? 1e6 : 1e18);
                    if (token0 === AMY.address.toLowerCase()) {
                        amyAmount += amount0;
                        usdt0Amount += amount1;
                        positionAmyAmount += amount0;
                        positionUsdt0Amount += amount1;
                    } else {
                        usdt0Amount += amount0;
                        amyAmount += amount1;
                        positionUsdt0Amount += amount0;
                        positionAmyAmount += amount1;
                    }
                }

                const owed0 = Number(ethers.utils.formatUnits(fees.fee0 || 0, token0 === USDT0.address.toLowerCase() ? 6 : 18));
                const owed1 = Number(ethers.utils.formatUnits(fees.fee1 || 0, token1 === USDT0.address.toLowerCase() ? 6 : 18));
                let positionAmyFees = 0;
                let positionUsdt0Fees = 0;
                if (token0 === AMY.address.toLowerCase()) {
                    amyFees += owed0;
                    usdt0Fees += owed1;
                    positionAmyFees += owed0;
                    positionUsdt0Fees += owed1;
                } else {
                    usdt0Fees += owed0;
                    amyFees += owed1;
                    positionUsdt0Fees += owed0;
                    positionAmyFees += owed1;
                }
                const positionAmyValue = positionAmyAmount * amyPrice;
                const positionUsdt0Value = positionUsdt0Amount;
                const positionValueUsd = positionAmyValue + positionUsdt0Value;
                const positionClaimableFeesUsd = (positionAmyFees * amyPrice) + positionUsdt0Fees;
                positionsById[tokenId] = {
                    valueUsd: positionValueUsd,
                    imageUrl: '/image/amy_usdto.png',
                    imageUrls: ['/pro.jpg', '/usdt0.png'],
                    components: [
                        { symbol: 'AMY', name: 'AMY', quantity: positionAmyAmount, priceUsd: amyPrice, valueUsd: positionAmyValue, imageUrl: '/pro.jpg' },
                        { symbol: 'USDT0', name: 'USDT0', quantity: positionUsdt0Amount, priceUsd: 1, valueUsd: positionUsdt0Value, imageUrl: '/usdt0.png' },
                    ],
                    details: {
                        type: 'lp',
                        claimableFeesUsd: positionClaimableFeesUsd,
                        claimableFees: [
                            { symbol: 'AMY', quantity: positionAmyFees, priceUsd: amyPrice, valueUsd: positionAmyFees * amyPrice },
                            { symbol: 'USDT0', quantity: positionUsdt0Fees, priceUsd: 1, valueUsd: positionUsdt0Fees },
                        ],
                        rangeStatus: hasLiquidity ? (positionInRange ? 'In Range' : 'Out of Range') : 'Out of Range',
                        positionsFound: 1,
                        inRangePositions: positionInRange ? 1 : 0,
                        outOfRangePositions: positionInRange ? 0 : 1,
                        manageUrl: 'https://app.kodiak.finance/#/explore/v3/pools/0xed1bb27281a8bbf296270ed5bb08acf7ecab5c17?chain=berachain_mainnet',
                        positionIds: [tokenId],
                    },
                };
            }

            const valueUsd = (amyAmount * amyPrice) + usdt0Amount;
            if (!(valueUsd > 0) && positionIds.length === 0) return null;

            const amyValue = amyAmount * amyPrice;
            const usdt0Value = usdt0Amount;
            const claimableFeesUsd = (amyFees * amyPrice) + usdt0Fees;
            return {
                valueUsd,
                imageUrl: '/image/amy_usdto.png',
                imageUrls: ['/pro.jpg', '/usdt0.png'],
                components: [
                    { symbol: 'AMY', name: 'AMY', quantity: amyAmount, priceUsd: amyPrice, valueUsd: amyValue, imageUrl: '/pro.jpg' },
                    { symbol: 'USDT0', name: 'USDT0', quantity: usdt0Amount, priceUsd: 1, valueUsd: usdt0Value, imageUrl: '/usdt0.png' },
                ],
                details: {
                    type: 'lp',
                    claimableFeesUsd,
                    claimableFees: [
                        { symbol: 'AMY', quantity: amyFees, priceUsd: amyPrice, valueUsd: amyFees * amyPrice },
                        { symbol: 'USDT0', quantity: usdt0Fees, priceUsd: 1, valueUsd: usdt0Fees },
                    ],
                    rangeStatus: inRangePositions > 0 ? 'In Range' : 'Out of Range',
                    positionsFound: inRangePositions + outOfRangePositions,
                    inRangePositions,
                    outOfRangePositions,
                    manageUrl: 'https://app.kodiak.finance/#/explore/v3/pools/0xed1bb27281a8bbf296270ed5bb08acf7ecab5c17?chain=berachain_mainnet',
                    positionIds,
                },
                positionsById,
            };
        });
    }

    async getBullaPositionFees(nfpm, position, tokenId, wallet) {
        const maxUint128 = ethers.BigNumber.from(2).pow(128).sub(1);
        const collectParams = {
            tokenId,
            recipient: wallet,
            amount0Max: maxUint128,
            amount1Max: maxUint128,
        };
        const collected = await nfpm.callStatic.collect(collectParams, { from: wallet });
        return {
            fee0: collected.amount0 || collected[0] || position.tokensOwed0 || ethers.BigNumber.from(0),
            fee1: collected.amount1 || collected[1] || position.tokensOwed1 || ethers.BigNumber.from(0),
        };
    }

    async getPoolTick(pool) {
        try {
            const state = await pool.globalState();
            return Number(state.tick);
        } catch {
            const slot0 = await pool.slot0();
            return Number(slot0.tick);
        }
    }

    async getGeckoPrice(poolUrl, tokenAddress) {
        const key = `${poolUrl}:${tokenAddress.toLowerCase()}`;
        const cached = this.priceCache.get(key);
        if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached.price;

        try {
            const res = await axios.get(poolUrl, { timeout: 20000, headers: { accept: 'application/json' } });
            const data = res.data?.data;
            const base = data?.relationships?.base_token?.data?.id || '';
            const quote = data?.relationships?.quote_token?.data?.id || '';
            const attrs = data?.attributes || {};
            const clean = v => String(v).split('_').pop().toLowerCase();
            let price = 0;
            if (clean(base) === tokenAddress.toLowerCase()) price = num(attrs.base_token_price_usd);
            if (clean(quote) === tokenAddress.toLowerCase()) price = num(attrs.quote_token_price_usd);
            if (price > 0) await this.savePriceCache(key, poolUrl, tokenAddress, price);
            this.priceCache.set(key, { price, ts: Date.now() });
            return price;
        } catch (e) {
            const stale = await this.getCachedPrice(key);
            if (stale > 0) {
                this.priceCache.set(key, { price: stale, ts: Date.now() });
                return stale;
            }
            throw e;
        }
    }

    async getCachedPrice(key) {
        if (!this.db?.pool) return 0;
        const { rows } = await this.db.pool.query(
            'SELECT price_usd FROM portfolio_price_cache WHERE cache_key = $1',
            [key]
        );
        return num(rows[0]?.price_usd);
    }

    async savePriceCache(key, poolUrl, tokenAddress, price) {
        if (!this.db?.pool || !(price > 0)) return;
        await this.db.pool.query(
            `INSERT INTO portfolio_price_cache (cache_key, pool_url, token_address, price_usd, fetched_at, updated_at)
             VALUES ($1, $2, $3, $4, NOW(), NOW())
             ON CONFLICT (cache_key) DO UPDATE
             SET price_usd = EXCLUDED.price_usd,
                 fetched_at = NOW(),
                 updated_at = NOW()`,
            [key, poolUrl, tokenAddress.toLowerCase(), price]
        );
    }

    async fetchAmyOverlays(wallet) {
        const rows = [];
        for (const token of AMY_OVERLAY_TOKENS) {
            const row = await this.fetchTokenOverlay(wallet, token).catch(() => null);
            if (row) rows.push(row);
        }
        for (const vault of VAULTS) {
            const row = await this.fetchVaultOverlay(wallet, vault).catch(() => null);
            if (row) rows.push(row);
        }
        return rows;
    }

    async fetchPlutusClaimables(wallet) {
        const url = `https://plutus.fi/api/user/${wallet}/80094`;
        const res = await axios.get(url, { timeout: 20000, headers: { accept: 'application/json' } });
        const assets = Array.isArray(res.data?.assets) ? res.data.assets : [];
        const assetMap = new Map(assets.map(asset => [String(asset.id || '').toLowerCase(), asset]));
        const targetMap = new Map([
            ['plsbera', '0xe8beb147a93bb757db15e468fabd119ca087efae'],
            ['plskdk', '0x9e6b748d25ed2600aa0ce7cbb42267adcf21fd9b'],
        ]);
        const details = new Map();

        for (const [key, stakingAddress] of targetMap.entries()) {
            const stakingAsset = assetMap.get(stakingAddress);
            const claimables = Array.isArray(stakingAsset?.claimables) ? stakingAsset.claimables : [];
            const parsed = claimables
                .map(item => this.parsePlutusClaimable(item, assetMap))
                .filter(Boolean);
            const claimableFeesUsd = parsed.reduce((sum, item) => sum + num(item.valueUsd), 0);
            details.set(key, {
                type: 'protocol',
                claimableFeesUsd,
                claimableFees: parsed,
                claimableSource: 'plutus',
                rewardsLabel: 'Claimable rewards',
            });
        }

        return details;
    }

    parsePlutusClaimable(item, assetMap) {
        const address = String(item?.id?.asset || '').toLowerCase();
        if (!address) return null;
        const asset = assetMap.get(address) || {};
        const known = KNOWN_TOKEN_METADATA[`berachain:${address}`] || {};
        const decimals = Number(asset.decimals ?? 18);
        const quantity = Number(ethers.utils.formatUnits(String(item.amount || '0'), decimals));
        const priceUsd = num(asset.priceUSD);
        const symbol = cleanText(known.symbol || asset.displayName || 'Asset');
        return {
            symbol,
            name: cleanText(known.name || asset.displayName || symbol),
            quantity,
            priceUsd,
            valueUsd: quantity * priceUsd,
            imageUrl: this.localTokenImage(symbol),
            tokenAddress: address,
        };
    }

    async fetchTokenOverlay(wallet, token) {
        return this.withProvider(async provider => {
            const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
            const [raw, decimals, symbol, name] = await Promise.all([
                contract.balanceOf(wallet),
                contract.decimals().catch(() => 18),
                contract.symbol().catch(() => token.label),
                contract.name().catch(() => token.label),
            ]);
            const quantity = Number(ethers.utils.formatUnits(raw, decimals));
            const priceAddress = (token.priceAddress || token.address).toLowerCase();
            const price = TOKEN_PRICE_POOLS[priceAddress] ? await this.getGeckoPrice(TOKEN_PRICE_POOLS[priceAddress], priceAddress).catch(() => 0) : 0;
            return {
                id: token.key,
                type: 'amy_overlay',
                name: token.label || name,
                symbol,
                chain: 'Berachain',
                quantity,
                priceUsd: price,
                valueUsd: quantity * price,
                tokenAddress: token.address.toLowerCase(),
                imageUrl: this.localTokenImage(token.label || symbol),
                includeInTotal: true,
                source: 'amy_overlay',
            };
        });
    }

    async fetchVaultOverlay(wallet, vault) {
        return this.withProvider(async provider => {
            const contract = new ethers.Contract(vault.address, VAULT_ABI, provider);
            const [raw, decimals] = await Promise.all([
                contract.balanceOf(wallet),
                contract.decimals().catch(() => 18),
            ]);

            let quantity = Number(ethers.utils.formatUnits(raw, decimals));
            let valueQuantity = quantity;
            let walletAmount = 0;
            const stakedAmount = quantity;

            if (vault.includeWalletToken && vault.tokenAddress) {
                const token = new ethers.Contract(vault.tokenAddress, ERC20_ABI, provider);
                const [tokenRaw, tokenDecimals] = await Promise.all([
                    token.balanceOf(wallet).catch(() => ethers.BigNumber.from(0)),
                    token.decimals().catch(() => decimals),
                ]);
                walletAmount = Number(ethers.utils.formatUnits(tokenRaw, tokenDecimals));
                quantity = stakedAmount + walletAmount;
                valueQuantity = quantity;
            } else if (vault.convertToAssets && !raw.isZero()) {
                const valueRaw = await contract.convertToAssets(raw);
                valueQuantity = Number(ethers.utils.formatUnits(valueRaw, decimals));
            }

            const priceUsd = vault.convertToAssets && quantity > 0 ? (valueQuantity * vault.unitPrice) / quantity : vault.unitPrice;
            return {
                id: vault.key,
                type: 'amy_overlay',
                name: vault.label,
                symbol: vault.key.toUpperCase(),
                chain: 'Berachain',
                quantity,
                priceUsd,
                valueUsd: valueQuantity * vault.unitPrice,
                tokenAddress: vault.address.toLowerCase(),
                imageUrl: this.localTokenImage(vault.label || vault.key),
                includeInTotal: true,
                source: 'amy_overlay',
                walletAmount,
                stakedAmount,
            };
        });
    }

    async fetchNftCollections(wallet) {
        const rows = [];
        const zerionCollections = await this.fetchZerionNftCollections(wallet).catch(() => new Map());
        for (const address of NFT_CONTRACTS) {
            const row = await this.withProvider(async provider => {
                const contract = new ethers.Contract(address, ERC721_ABI, provider);
                const [raw, name, symbol, contractMetadata] = await Promise.all([
                    contract.balanceOf(wallet),
                    contract.name().catch(() => `Collection ${address.slice(-6)}`),
                    contract.symbol().catch(() => ''),
                    this.fetchNftMetadataFromContract(provider, address, wallet).catch(() => null),
                ]);
                const zerion = zerionCollections.get(address.toLowerCase());
                return {
                    id: address.toLowerCase(),
                    name: zerion?.name || name,
                    symbol: zerion?.symbol || symbol,
                    contractAddress: address.toLowerCase(),
                    quantity: contractMetadata?.quantity ?? raw.toNumber(),
                    chain: 'Berachain',
                    imageUrl: zerion?.imageUrl || contractMetadata?.imageUrl || this.localNftImage(address),
                };
            }).catch(() => null);
            if (row && row.quantity > 0) rows.push(row);
        }
        return rows;
    }

    async fetchZerionNftCollections(wallet) {
        const collections = new Map();
        let cursor = null;
        for (let i = 0; i < 4; i++) {
            const params = new URLSearchParams({
                currency: 'usd',
                'page[size]': '100',
            });
            if (cursor) params.set('page[after]', cursor);
            const url = `${ZERION_API_BASE}/wallets/${wallet}/nft-positions/?${params}`;
            const res = await axios.get(url, { headers: this.zerionHeaders(), timeout: 120000 });
            for (const item of res.data?.data || []) {
                const a = item.attributes || {};
                const contractAddress = cleanText(
                    a.nft_info?.contract_address
                    || a.collection_info?.contract_address
                    || a.collection_info?.address
                    || ''
                ).toLowerCase();
                if (!contractAddress) continue;

                const existing = collections.get(contractAddress) || {};
                collections.set(contractAddress, {
                    name: existing.name || cleanText(a.collection_info?.name || a.nft_info?.collection_name || a.name),
                    symbol: existing.symbol || cleanText(a.collection_info?.symbol || a.nft_info?.collection_symbol),
                    imageUrl: existing.imageUrl || nftImageFromAttrs(a),
                });
            }

            const next = res.data?.links?.next;
            if (!next) break;
            cursor = new URL(next).searchParams.get('page[after]');
            if (!cursor) break;
        }
        return collections;
    }

    async fetchNftMetadataFromContract(provider, address, wallet) {
        const contract = new ethers.Contract(address, ERC721_ABI, provider);
        const balance = await contract.balanceOf(wallet);
        const quantity = balance.toNumber();
        if (quantity <= 0) return null;

        let imageUrl = '';
        const tokenId = await contract.tokenOfOwnerByIndex(wallet, 0).catch(() => null);
        const metadataUris = [];
        if (tokenId) metadataUris.push(await contract.tokenURI(tokenId).catch(() => ''));
        metadataUris.push(await contract.contractURI().catch(() => ''));

        for (const uri of metadataUris.filter(Boolean)) {
            const metadata = await this.fetchMetadataJson(uri).catch(() => null);
            imageUrl = ipfsToHttps(metadata?.image || metadata?.image_url || metadata?.icon || '');
            if (imageUrl) break;
        }

        return { quantity, imageUrl };
    }

    async fetchMetadataJson(uri) {
        const url = ipfsToHttps(uri);
        if (!url || !/^https?:\/\//i.test(url)) return null;
        const res = await axios.get(url, { timeout: 15000, headers: { accept: 'application/json' } });
        return res.data;
    }

    localTokenImage(label = '') {
        const key = String(label).toUpperCase();
        if (key.includes('PLSBERA')) return '/plsbera.png';
        if (key.includes('PLSKDK')) return '/plskdk.png';
        if (key.includes('PLVHEDGE')) return '/plvhedge.png';
        if (key === 'HONEY') return '/honey.png';
        if (key.includes('SNRUSD')) return '/snr.png';
        if (key.includes('JNRUSD')) return '/jnr.png';
        return '';
    }

    localNftImage(address = '') {
        const lower = String(address).toLowerCase();
        if (lower === '0x333814f5e16eee61d0c0b03a5b6abbd424b381c2') return '/image/bulla.png';
        if (lower === '0x5a30c392714a9a9a8177c7998d9d59c3dd120917') return '/image/booga_bulla.png';
        return '';
    }

    async runDailyQualifiedScan() {
        const { rows } = await this.db.pool.query('SELECT wallet FROM user_base_build WHERE amy_balance >= 300');
        for (const row of rows) {
            try {
                await this.getPortfolio(row.wallet, { force: true, source: 'daily' });
                await new Promise(r => setTimeout(r, 1000));
            } catch (e) {
                console.warn(`Portfolio daily scan failed for ${row.wallet}: ${e.message}`);
            }
        }
    }
}

module.exports = PortfolioService;
