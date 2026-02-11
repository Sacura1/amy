/**
 * Debug script for wallet 0x613cB5Eaf514a1A56c6F7361f2BcDa10Cd0964cB
 * Checks plsBERA staking, snrUSD, jnrUSD, and BGT balances
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { Pool } = require('pg');

const TARGET_WALLET = '0x613cB5Eaf514a1A56c6F7361f2BcDa10Cd0964cB';

// Provider setup - use same RPC as server.js
const RPC_URL = 'https://rpc.berachain.com';
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

// Database setup - make it optional if not configured
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });
}

// Token configurations
const TOKENS = {
  plsBERA: {
    address: '0xc66D1a2460De7b96631f4AC37ce906aCFa6A3c30',
    stakingContract: '0xe8bEB147a93BB757DB15e468FaBD119CA087EfAE',
    symbol: 'plsBERA',
    decimals: 18
  },
  snrUSD: {
    address: '0x49298F4314eb127041b814A2616c25687Db6b650',
    symbol: 'snrUSD',
    decimals: 18
  },
  jnrUSD: {
    address: '0x3a0A97DcA5e6CaCC258490d5ece453412f8E1883',
    symbol: 'jnrUSD',
    decimals: 18
  },
  BGT: {
    address: '0x656b95e550c07a9ffe548bd4085c72418ceb1dba',
    symbol: 'BGT',
    decimals: 18
  }
};

// ERC20 ABI
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];

// Staking contract ABI
const STAKING_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)'
];

async function checkTokenBalance(tokenConfig, wallet) {
  try {
    const contract = new ethers.Contract(tokenConfig.address, ERC20_ABI, provider);
    const balance = await contract.balanceOf(wallet);
    const formatted = ethers.utils.formatUnits(balance, tokenConfig.decimals);
    return {
      raw: balance.toString(),
      formatted: formatted,
      hasBalance: parseFloat(formatted) > 0
    };
  } catch (error) {
    console.error(`Error checking ${tokenConfig.symbol}:`, error.message);
    return { error: error.message };
  }
}

async function checkPlsBeraStaked(wallet) {
  try {
    // Check staked amount
    const stakingContract = new ethers.Contract(
      TOKENS.plsBERA.stakingContract,
      STAKING_ABI,
      provider
    );

    const stakedShares = await stakingContract.balanceOf(wallet);
    const stakedAmount = await stakingContract.convertToAssets(stakedShares);

    // Check unstaked amount
    const tokenContract = new ethers.Contract(
      TOKENS.plsBERA.address,
      ERC20_ABI,
      provider
    );
    const unstakedBalance = await tokenContract.balanceOf(wallet);

    const totalStaked = ethers.utils.formatUnits(stakedAmount, 18);
    const totalUnstaked = ethers.utils.formatUnits(unstakedBalance, 18);
    const totalBalance = parseFloat(totalStaked) + parseFloat(totalUnstaked);

    return {
      staked: totalStaked,
      unstaked: totalUnstaked,
      total: totalBalance.toString(),
      hasStaked: parseFloat(totalStaked) > 0,
      hasUnstaked: parseFloat(totalUnstaked) > 0
    };
  } catch (error) {
    console.error('Error checking plsBERA staking:', error.message);
    return { error: error.message };
  }
}

async function checkDatabaseRecord(wallet) {
  if (!pool) {
    return { error: 'Database not configured (DATABASE_URL not set)' };
  }

  try {
    const query = `
      SELECT
        wallet,
        plsbera_value_usd,
        plsbera_multiplier,
        total_multiplier,
        current_tier,
        last_points_award
      FROM amy_points
      WHERE LOWER(wallet) = LOWER($1)
    `;

    const result = await pool.query(query, [wallet]);

    if (result.rows.length === 0) {
      return { exists: false, message: 'Wallet not found in database' };
    }

    return { exists: true, data: result.rows[0] };
  } catch (error) {
    console.error('Error checking database:', error.message);
    return { error: error.message };
  }
}

async function checkUserBadges(wallet) {
  if (!pool) {
    return { error: 'Database not configured (DATABASE_URL not set)' };
  }

  try {
    const query = `
      SELECT badge_id, equipped, earned_at
      FROM user_badges
      WHERE LOWER(wallet) = LOWER($1)
      ORDER BY earned_at DESC
    `;

    const result = await pool.query(query, [wallet]);
    return result.rows;
  } catch (error) {
    console.error('Error checking badges:', error.message);
    return { error: error.message };
  }
}

async function main() {
  console.log('='.repeat(80));
  console.log(`DIAGNOSTIC REPORT FOR WALLET: ${TARGET_WALLET}`);
  console.log('='.repeat(80));
  console.log();

  // Check on-chain balances
  console.log('📊 ON-CHAIN TOKEN BALANCES:');
  console.log('-'.repeat(80));

  console.log('\n🔹 plsBERA (Staking):');
  const plsBeraData = await checkPlsBeraStaked(TARGET_WALLET);
  if (plsBeraData.error) {
    console.log(`   ❌ Error: ${plsBeraData.error}`);
  } else {
    console.log(`   Staked:   ${plsBeraData.staked} plsBERA`);
    console.log(`   Unstaked: ${plsBeraData.unstaked} plsBERA`);
    console.log(`   Total:    ${plsBeraData.total} plsBERA`);
    console.log(`   ✅ Has staked plsBERA: ${plsBeraData.hasStaked ? 'YES' : 'NO'}`);
  }

  console.log('\n🔹 snrUSD:');
  const snrUsdData = await checkTokenBalance(TOKENS.snrUSD, TARGET_WALLET);
  if (snrUsdData.error) {
    console.log(`   ❌ Error: ${snrUsdData.error}`);
  } else {
    console.log(`   Balance: ${snrUsdData.formatted} snrUSD`);
    console.log(`   ✅ Has balance: ${snrUsdData.hasBalance ? 'YES' : 'NO'}`);
  }

  console.log('\n🔹 jnrUSD:');
  const jnrUsdData = await checkTokenBalance(TOKENS.jnrUSD, TARGET_WALLET);
  if (jnrUsdData.error) {
    console.log(`   ❌ Error: ${jnrUsdData.error}`);
  } else {
    console.log(`   Balance: ${jnrUsdData.formatted} jnrUSD`);
    console.log(`   ✅ Has balance: ${jnrUsdData.hasBalance ? 'YES' : 'NO'}`);
  }

  console.log('\n🔹 BGT:');
  const bgtData = await checkTokenBalance(TOKENS.BGT, TARGET_WALLET);
  if (bgtData.error) {
    console.log(`   ❌ Error: ${bgtData.error}`);
  } else {
    console.log(`   Balance: ${bgtData.formatted} BGT`);
    console.log(`   ✅ Has balance: ${bgtData.hasBalance ? 'YES' : 'NO'}`);
  }

  // Check database record
  console.log('\n\n💾 DATABASE RECORD:');
  console.log('-'.repeat(80));
  const dbRecord = await checkDatabaseRecord(TARGET_WALLET);
  if (dbRecord.error) {
    console.log(`❌ Error: ${dbRecord.error}`);
  } else if (!dbRecord.exists) {
    console.log(`❌ ${dbRecord.message}`);
  } else {
    console.log(`✅ Wallet found in database`);
    console.log(`   plsBERA USD Value: $${dbRecord.data.plsbera_value_usd || 0}`);
    console.log(`   plsBERA Multiplier: ${dbRecord.data.plsbera_multiplier || 0}x`);
    console.log(`   Total Multiplier: ${dbRecord.data.total_multiplier || 1}x`);
    console.log(`   Current Tier: ${dbRecord.data.current_tier || 'none'}`);
    console.log(`   Last Points Award: ${dbRecord.data.last_points_award || 'Never'}`);
  }

  // Check badges
  console.log('\n\n🏅 EARNED BADGES:');
  console.log('-'.repeat(80));
  const badges = await checkUserBadges(TARGET_WALLET);
  if (badges.error) {
    console.log(`❌ Error: ${badges.error}`);
  } else if (badges.length === 0) {
    console.log('❌ No badges earned yet');
  } else {
    badges.forEach(badge => {
      console.log(`   • ${badge.badge_id} ${badge.equipped ? '(EQUIPPED)' : ''}`);
      console.log(`     Earned: ${new Date(badge.earned_at).toLocaleString()}`);
    });
  }

  // Analysis
  console.log('\n\n🔍 ANALYSIS:');
  console.log('-'.repeat(80));

  if (plsBeraData.hasStaked && dbRecord.exists && dbRecord.data.plsbera_value_usd === 0) {
    console.log('⚠️  ISSUE FOUND: Wallet has staked plsBERA on-chain, but database shows $0 USD value');
    console.log('   Possible causes:');
    console.log('   1. Price feed failed when updating this wallet');
    console.log('   2. Cron job hasn\'t run for this wallet yet');
    console.log('   3. Database update failed');
  }

  if (snrUsdData.hasBalance) {
    console.log('⚠️  ISSUE FOUND: Wallet has snrUSD balance, but this token is NOT tracked in database');
    console.log('   The backend queries it but doesn\'t persist to DB (no columns exist)');
  }

  if (jnrUsdData.hasBalance) {
    console.log('⚠️  ISSUE FOUND: Wallet has jnrUSD balance, but this token is NOT tracked in database');
    console.log('   The backend queries it but doesn\'t persist to DB (no columns exist)');
  }

  if (bgtData.hasBalance) {
    console.log('⚠️  ISSUE FOUND: Wallet has BGT balance, but this token is NOT tracked in database');
    console.log('   The backend queries it but doesn\'t persist to DB (no columns exist)');
  }

  console.log('\n' + '='.repeat(80));

  if (pool) {
    await pool.end();
  }
}

main()
  .then(() => {
    console.log('\n✅ Diagnostic complete');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  });
