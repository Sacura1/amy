const axios = require('axios');
const { ethers } = require('ethers');

// CONFIG - Exact addresses from customer scripts & Railway .env
const RPC_URL = process.env.BERACHAIN_RPC || 'https://rpc.berachain.com';
const AMY_TOKEN = '0x098a75bAedDEc78f9A8D0830d6B86eAc5cC8894e';
const HONEY_TOKEN = '0xfcbd14dc51f0a4d49d5e53c2e0950e0bc26d0dce';
const USDT0_TOKEN = '0xd01ae6905d48315f7be10c7330aecf8360ef5b12';

const AMY_HONEY_POOL = '0x05481d4a0342921d78f44d825c83f32483526521';
const AMY_USDT0_POOL = '0x6299f899015c7f8934526017b35f60634289895c';

const GOLDSKY_URL = 'https://api.goldsky.com/api/public/project_clxh7f8o72v7x01w133p5162a/subgraphs/algebra-integral-berachain/1.0.0/gn';
const MULTICALL_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

// snrUSD specific addresses
const REWARD_VAULT_ADDRESS = '0x18e310dD4A6179D9600E95D18926AB7819B2A071';
const SNRUSD_TOKEN_ADDRESS = '0xC38421E5577250EBa177Bc5bC832E747bea13Ee0';

// ABIs
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
const VAULT_ABI = ['function balanceOf(address) view returns (uint256)'];

class StrategyService {
    constructor(db) {
        this.db = db;
        // Use a standard provider - ensure RPC_URL is valid in .env
        this.provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    }

    /**
     * Algebra/Uniswap V3 Math: Ported from compute_position_amounts_and_value in Python
     */
    calculateAmounts(tickCurrent, tickLower, tickUpper, liquidity, sqrtPriceX96) {
        const Q96 = BigInt(2) ** BigInt(96);
        
        const getAmount0ForLiquidity = (sqrtA, sqrtB, liq) => {
            if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
            return (liq * (sqrtB - sqrtA) * Q96) / (sqrtA * sqrtB);
        };

        const getAmount1ForLiquidity = (sqrtA, sqrtB, liq) => {
            if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
            return (liq * (sqrtB - sqrtA)) / Q96;
        };

        // Convert to BigInts for precision
        const sqrtPrice = BigInt(sqrtPriceX96);
        const sqrtLower = BigInt(Math.floor(Math.pow(1.0001, tickLower / 2) * Math.pow(2, 96)));
        const sqrtUpper = BigInt(Math.floor(Math.pow(1.0001, tickUpper / 2) * Math.pow(2, 96)));

        let amount0 = BigInt(0);
        let amount1 = BigInt(0);

        if (tickCurrent < tickLower) {
            amount0 = getAmount0ForLiquidity(sqrtLower, sqrtUpper, BigInt(liquidity));
        } else if (tickCurrent < tickUpper) {
            amount0 = getAmount0ForLiquidity(sqrtPrice, sqrtUpper, BigInt(liquidity));
            amount1 = getAmount1ForLiquidity(sqrtLower, sqrtPrice, BigInt(liquidity));
        } else {
            amount1 = getAmount1ForLiquidity(sqrtLower, sqrtUpper, BigInt(liquidity));
        }

        return { amount0, amount1 };
    }

    async calculateRollingApr(positionId) {
        try {
            const result = await this.db.pool.query(`
                SELECT apr FROM earn_data_history 
                WHERE position_id = $1 
                AND timestamp > CURRENT_TIMESTAMP - INTERVAL '7 days'
            `, [positionId]);

            if (result.rows.length === 0) return 'TBC';

            const values = result.rows.map(r => parseFloat(r.apr.replace('%', ''))).filter(n => !isNaN(n));
            if (values.length === 0) return '0%';
            
            const avg = values.reduce((a, b) => a + b, 0) / values.length;
            return `${avg.toFixed(1)}%`;
        } catch (e) {
            return 'TBC';
        }
    }

    /**
     * Base Build (Every 15 mins)
     */
    async runBaseBuild() {
        console.log('🔄 [Base Build] Refreshing all user AMY balances...');
        try {
            const usersRes = await this.db.pool.query('SELECT wallet FROM verified_users');
            const AmyContract = new ethers.Contract(AMY_TOKEN, ERC20_ABI, this.provider);
            
            for (const row of usersRes.rows) {
                try {
                    const balance = await AmyContract.balanceOf(row.wallet);
                    const formatted = parseFloat(ethers.utils.formatUnits(balance, 18));
                    
                    await this.db.pool.query(
                        `INSERT INTO user_base_build (wallet, amy_balance, last_checked)
                         VALUES ($1, $2, CURRENT_TIMESTAMP)
                         ON CONFLICT (wallet) DO UPDATE SET
                         amy_balance = EXCLUDED.amy_balance,
                         last_checked = CURRENT_TIMESTAMP`,
                        [row.wallet.toLowerCase(), formatted]
                    );
                } catch (e) {
                    console.error(`❌ [Base Build] Failed for ${row.wallet}:`, e.message);
                }
            }
            console.log(`✅ [Base Build] Processed ${usersRes.rows.length} wallets`);
        } catch (err) {
            console.error('❌ [Base Build] Fatal Error:', err.message);
        }
    }

    /**
     * Hourly Job (:00): Full Strategy Snapshot
     */
    async runFullStrategySnapshot() {
        console.log('🧠 [Full Strategy] Generating snapshots for >300 AMY holders...');
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
                        lp_amy_honey: await this.fetchGoldskyPositions(wallet, AMY_HONEY_POOL, amyPrice),
                        lp_amy_usdt0: await this.fetchGoldskyPositions(wallet, AMY_USDT0_POOL, amyPrice),
                        snrusd: await this.fetchSnrUsd(wallet)
                    }
                };

                await this.db.pool.query(
                    `INSERT INTO strategy_snapshots (wallet, snapshot_data, last_updated)
                     VALUES ($1, $2, CURRENT_TIMESTAMP)
                     ON CONFLICT (wallet) DO UPDATE SET
                     snapshot_data = EXCLUDED.snapshot_data,
                     last_updated = CURRENT_TIMESTAMP`,
                    [wallet, JSON.stringify(snapshot)]
                );
            }
            console.log(`✅ [Full Strategy] Updated snapshots for ${holders.rows.length} holders`);
        } catch (err) {
            console.error('❌ [Full Strategy] Error:', err.message);
        }
    }

    async fetchSnrUsd(wallet) {
        try {
            const vault = new ethers.Contract(REWARD_VAULT_ADDRESS, VAULT_ABI, this.provider);
            const token = new ethers.Contract(SNRUSD_TOKEN_ADDRESS, ERC20_ABI, this.provider);
            
            const [vaultBal, tokenBal] = await Promise.all([
                vault.balanceOf(wallet),
                token.balanceOf(wallet)
            ]);

            const total = parseFloat(ethers.utils.formatUnits(vaultBal.add(tokenBal), 18));
            return { value_usd: total, source: 'reward_vault_staking' };
        } catch (e) {
            return { value_usd: 0 };
        }
    }

    async getAmyPrice() {
        try {
            const res = await axios.get(`https://api.geckoterminal.com/api/v2/networks/berachain/pools/${AMY_HONEY_POOL}`);
            return parseFloat(res.data.data.attributes.base_token_price_usd) || 0.05;
        } catch (e) {
            return 0.05;
        }
    }

    async fetchGoldskyPositions(wallet, poolId, amyPrice) {
        const query = `{
          positions(where: { owner: "${wallet.toLowerCase()}", pool: "${poolId.toLowerCase()}", liquidity_gt: 0 }) {
            liquidity
            tickLower
            tickUpper
            pool { tick sqrtPrice }
          }
        }`;
        try {
            const res = await axios.post(GOLDSKY_URL, { query });
            const pos = res.data.data.positions;
            if (!pos) return { value_usd: 0, count: 0 };

            let total = 0;
            for (const p of pos) {
                const { amount0, amount1 } = this.calculateAmounts(
                    parseInt(p.pool.tick),
                    parseInt(p.tickLower),
                    parseInt(p.tickUpper),
                    p.liquidity,
                    p.pool.sqrtPrice
                );
                
                const val0 = parseFloat(ethers.utils.formatUnits(amount0.toString(), 18)) * amyPrice;
                const val1 = parseFloat(ethers.utils.formatUnits(amount1.toString(), 18)) * 1.0; 
                total += (val0 + val1);
            }
            return { value_usd: total, count: pos.length };
        } catch (e) {
            return { value_usd: 0, count: 0 };
        }
    }

    async runEarnDataUpdate() {
        console.log('📊 [Earn Update] Standardizing TVL/APR with 7-day average...');
        try {
            const pools = [
                { id: 'amy-honey', pool: AMY_HONEY_POOL },
                { id: 'amy-usdt0', pool: AMY_USDT0_POOL }
            ];

            for (const p of pools) {
                const stats = await this.fetchPoolStats(p.pool);
                await this.db.pool.query(
                    'INSERT INTO earn_data_history (position_id, tvl, apr) VALUES ($1, $2, $3)',
                    [p.id, stats.tvl, stats.apr]
                );
                
                console.log(`✅ [Tracking] ${p.id} - Status: LIVE | TVL: ${stats.tvl} | Raw APR: ${stats.apr}`);
            }
        } catch (err) {
            console.error('❌ [Earn Update] Error:', err.message);
        }
    }

    async fetchPoolStats(poolId) {
        const query = `{ pool(id: "${poolId.toLowerCase()}") { totalValueLockedUSD apr } }`;
        try {
            const res = await axios.post(GOLDSKY_URL, { query });
            const p = res.data.data.pool;
            if (!p) return { tvl: 'TBC', apr: '0%' };

            return { 
                tvl: `$${(parseFloat(p.totalValueLockedUSD) / 1000).toFixed(1)}k`, 
                apr: `${parseFloat(p.apr || 0).toFixed(1)}%` 
            };
        } catch (e) {
            return { tvl: 'TBC', apr: '0%' };
        }
    }
}

module.exports = StrategyService;
