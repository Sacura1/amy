const axios = require('axios');
const { ethers } = require('ethers');

// CONFIG - Exact addresses from customer scripts & Railway .env
const RPC_URL = process.env.BERACHAIN_RPC || 'https://rpc.berachain.com';
const AMY_TOKEN = '0x098a75bAedDEc78f9A8D0830d6B86eAc5cC8894e';

// Pool IDs - EXACT matching the Python script Gecko URLs
const AMY_HONEY_POOL = '0xff716930eefb37b5b4ac55b1901dc5704b098d84'; 
const AMY_USDT0_POOL = '0xed1bb27281a8bbf296270ed5bb08acf7ecab5c17';

// Subgraph URLs
const ALGEBRA_SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_clxh7f8o72v7x01w133p5162a/subgraphs/algebra-integral-berachain/1.0.0/gn';
const KODIAK_SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_clpx84oel0al201r78jsl0r3i/subgraphs/kodiak-v3-berachain-mainnet/latest/gn';

// snrUSD specific addresses
const REWARD_VAULT_ADDRESS = '0x18e310dD4A6179D9600E95D18926AB7819B2A071';
const SNRUSD_TOKEN_ADDRESS = '0xC38421E5577250EBa177Bc5bC832E747bea13Ee0';

// ABIs
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const VAULT_ABI = ['function balanceOf(address) view returns (uint256)'];

class StrategyService {
    constructor(db) {
        this.db = db;
        this.provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    }

    calculateAmounts(tickCurrent, tickLower, tickUpper, liquidity, sqrtPriceX96) {
        try {
            const Q96 = BigInt(2) ** BigInt(96);
            const liq = BigInt(liquidity);
            const getAmount0 = (sqrtA, sqrtB) => {
                if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
                return (liq * (sqrtB - sqrtA) * Q96) / (sqrtA * sqrtB);
            };
            const getAmount1 = (sqrtA, sqrtB) => {
                if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
                return (liq * (sqrtB - sqrtA)) / Q96;
            };
            const sqrtPrice = BigInt(sqrtPriceX96);
            const sqrtLower = BigInt(Math.floor(Math.pow(1.0001, tickLower / 2) * Math.pow(2, 96)));
            const sqrtUpper = BigInt(Math.floor(Math.pow(1.0001, tickUpper / 2) * Math.pow(2, 96)));
            let a0 = BigInt(0), a1 = BigInt(0);
            if (tickCurrent < tickLower) a0 = getAmount0(sqrtLower, sqrtUpper);
            else if (tickCurrent < tickUpper) { a0 = getAmount0(sqrtPrice, sqrtUpper); a1 = getAmount1(sqrtLower, sqrtPrice); }
            else a1 = getAmount1(sqrtLower, sqrtUpper);
            return { amount0: a0, amount1: a1 };
        } catch (e) { return { amount0: BigInt(0), amount1: BigInt(0) }; }
    }

    async runBaseBuild() {
        console.log('🔄 [Base Build] Refreshing AMY balances...');
        try {
            const usersRes = await this.db.pool.query('SELECT wallet FROM verified_users');
            const contract = new ethers.Contract(AMY_TOKEN, ERC20_ABI, this.provider);
            for (const row of usersRes.rows) {
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
            console.log(`✅ [Base Build] Done (${usersRes.rows.length} wallets)`);
        } catch (err) { console.error('❌ [Base Build] Error:', err.message); }
    }

    async runFullStrategySnapshot() {
        console.log('🧠 [Full Strategy] Generating snapshots...');
        try {
            const holders = await this.db.pool.query('SELECT wallet FROM user_base_build WHERE amy_balance >= 300');
            if (holders.rows.length === 0) return;
            const amyPrice = await this.getAmyPrice();
            for (const row of holders.rows) {
                const wallet = row.wallet.toLowerCase();
                const snapshot = {
                    wallet,
                    timestamp: new Date().toISOString(),
                    positions: {
                        lp_amy_honey: await this.fetchGoldskyPositions(wallet, AMY_HONEY_POOL, ALGEBRA_SUBGRAPH_URL, amyPrice),
                        lp_amy_usdt0: await this.fetchGoldskyPositions(wallet, AMY_USDT0_POOL, KODIAK_SUBGRAPH_URL, amyPrice),
                        snrusd: await this.fetchSnrUsd(wallet)
                    }
                };
                await this.db.pool.query(
                    `INSERT INTO strategy_snapshots (wallet, snapshot_data, last_updated)
                     VALUES ($1, $2, CURRENT_TIMESTAMP)
                     ON CONFLICT (wallet) DO UPDATE SET snapshot_data = EXCLUDED.snapshot_data, last_updated = CURRENT_TIMESTAMP`,
                    [wallet, JSON.stringify(snapshot)]
                );
            }
            console.log(`✅ [Full Strategy] Updated ${holders.rows.length} holders`);
        } catch (err) { console.error('❌ [Full Strategy] Error:', err.message); }
    }

    async fetchSnrUsd(wallet) {
        try {
            const vault = new ethers.Contract(REWARD_VAULT_ADDRESS, VAULT_ABI, this.provider);
            const token = new ethers.Contract(SNRUSD_TOKEN_ADDRESS, ERC20_ABI, this.provider);
            const [v, t] = await Promise.all([vault.balanceOf(wallet), token.balanceOf(wallet)]);
            return { value_usd: parseFloat(ethers.utils.formatUnits(v.add(t), 18)), source: 'vault' };
        } catch (e) { return { value_usd: 0 }; }
    }

    async getAmyPrice() {
        try {
            const res = await axios.get(`https://api.geckoterminal.com/api/v2/networks/berachain/pools/${AMY_HONEY_POOL}`);
            return parseFloat(res.data.data.attributes.base_token_price_usd) || 0.05;
        } catch (e) { return 0.05; }
    }

    async fetchGoldskyPositions(wallet, poolId, url, amyPrice) {
        const query = {
            query: `{
              positions(where: { owner: "${wallet}", pool: "${poolId.toLowerCase()}", liquidity_gt: "0" }) {
                liquidity tickLower tickUpper
                pool { tick sqrtPrice }
              }
            }`
        };
        try {
            const res = await axios.post(url, query);
            const pos = res.data.data.positions;
            if (!pos || pos.length === 0) return { value_usd: 0, count: 0 };
            let total = 0;
            for (const p of pos) {
                const { amount0, amount1 } = this.calculateAmounts(parseInt(p.pool.tick), parseInt(p.tickLower), parseInt(p.tickUpper), p.liquidity, p.pool.sqrtPrice);
                total += (parseFloat(ethers.utils.formatUnits(amount0.toString(), 18)) * amyPrice) + parseFloat(ethers.utils.formatUnits(amount1.toString(), 18));
            }
            return { value_usd: total, count: pos.length };
        } catch (e) { return { value_usd: 0, count: 0 }; }
    }

    async runEarnDataUpdate() {
        console.log('📊 [Earn Update] Syncing Goldsky stats...');
        try {
            const pools = [
                { id: 'amy-honey', pool: AMY_HONEY_POOL, url: ALGEBRA_SUBGRAPH_URL },
                { id: 'amy-usdt0', pool: AMY_USDT0_POOL, url: KODIAK_SUBGRAPH_URL }
            ];
            for (const p of pools) {
                const stats = await this.fetchPoolStats(p.pool, p.url);
                await this.db.pool.query('INSERT INTO earn_data_history (position_id, tvl, apr) VALUES ($1, $2, $3)', [p.id, stats.tvl, stats.apr]);
                console.log(`✅ [Tracking] ${p.id} - TVL: ${stats.tvl} | APR: ${stats.apr}`);
            }
        } catch (err) { console.error('❌ [Earn Update] Error:', err.message); }
    }

    async fetchPoolStats(poolId, url) {
        const query = {
            query: `{ pool(id: "${poolId.toLowerCase()}") { totalValueLockedUSD apr } }`
        };
        try {
            const res = await axios.post(url, query);
            const p = res.data.data.pool;
            if (!p) return { tvl: 'TBC', apr: '0%' };
            const tvl = parseFloat(p.totalValueLockedUSD);
            return { 
                tvl: tvl > 1000000 ? `$${(tvl/1000000).toFixed(1)}M` : `$${(tvl/1000).toFixed(1)}k`, 
                apr: `${parseFloat(p.apr || 0).toFixed(1)}%` 
            };
        } catch (e) { return { tvl: 'TBC', apr: '0%' }; }
    }
}

module.exports = StrategyService;
