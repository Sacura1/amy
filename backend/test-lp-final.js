// Final LP Test - run with a wallet address as argument
// Usage: node test-lp-final.js 0xYourWalletAddress

const ethers = require('ethers');

const BULLA_CONTRACTS = {
    nonfungiblePositionManager: '0xc228fbF18864B6e91d15abfcc2039f87a5F66741',
    amyHoneyPool: '0xff716930eefb37b5b4ac55b1901dc5704b098d84'
};

const TOKENS = {
    AMY: '0x098a75baeddec78f9a8d0830d6b86eac5cc8894e'.toLowerCase(),
    HONEY: '0xfcbd14dc51f0a4d49d5e53c2e0950e0bc26d0dce'.toLowerCase()
};

const LP_MULTIPLIER_TIERS = [
    { minUsd: 500, multiplier: 100 },
    { minUsd: 100, multiplier: 10 },
    { minUsd: 10, multiplier: 3 },
    { minUsd: 0, multiplier: 1 }
];

const NFPM_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'
];

const POOL_ABI = [
    'function globalState() view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked)',
    'function token0() view returns (address)',
    'function token1() view returns (address)'
];

function calculateLpMultiplier(usdValue) {
    for (const tier of LP_MULTIPLIER_TIERS) {
        if (usdValue >= tier.minUsd) return tier.multiplier;
    }
    return 1;
}

function getTokenAmountsFromLiquidity(liquidity, tickLower, tickUpper, currentTick) {
    const sqrtPriceLower = Math.sqrt(1.0001 ** tickLower);
    const sqrtPriceUpper = Math.sqrt(1.0001 ** tickUpper);
    const sqrtPriceCurrent = Math.sqrt(1.0001 ** currentTick);

    let amount0 = 0, amount1 = 0;

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

async function testWallet(walletAddress) {
    console.log('╔═══════════════════════════════════════════════════╗');
    console.log('║          AMY LP TRACKING TEST                     ║');
    console.log('╚═══════════════════════════════════════════════════╝');
    console.log(`\nWallet: ${walletAddress}\n`);

    const provider = new ethers.providers.JsonRpcProvider('https://rpc.berachain.com');
    const nfpm = new ethers.Contract(BULLA_CONTRACTS.nonfungiblePositionManager, NFPM_ABI, provider);
    const pool = new ethers.Contract(BULLA_CONTRACTS.amyHoneyPool, POOL_ABI, provider);

    // Pool state
    const globalState = await pool.globalState();
    const currentTick = globalState.tick;
    const token0 = (await pool.token0()).toLowerCase();

    const priceRatio = 1.0001 ** currentTick;
    const amyIsToken0 = token0 === TOKENS.AMY;
    const amyPrice = amyIsToken0 ? priceRatio : (1 / priceRatio);

    console.log('📊 Pool Info:');
    console.log(`   AMY Price: $${amyPrice.toFixed(6)}`);
    console.log(`   Current Tick: ${currentTick}`);

    // Wallet positions
    const nftBalance = await nfpm.balanceOf(walletAddress);
    const nftCount = nftBalance.toNumber();

    console.log(`\n🎫 Position NFTs owned: ${nftCount}`);

    if (nftCount === 0) {
        console.log('\n⚠️  No LP positions found in wallet.');
        console.log('   Positions might be:');
        console.log('   1. Staked in FarmingCenter (farming rewards)');
        console.log('   2. Not yet created');
        console.log('\n📋 Result:');
        console.log('   LP Value: $0.00');
        console.log('   Multiplier: 1x (no bonus)');
        return;
    }

    let totalUsd = 0;
    let amyHoneyCount = 0;

    for (let i = 0; i < nftCount; i++) {
        const tokenId = await nfpm.tokenOfOwnerByIndex(walletAddress, i);
        const position = await nfpm.positions(tokenId);

        const posToken0 = position.token0.toLowerCase();
        const posToken1 = position.token1.toLowerCase();

        const isAmyHoney =
            (posToken0 === TOKENS.AMY && posToken1 === TOKENS.HONEY) ||
            (posToken0 === TOKENS.HONEY && posToken1 === TOKENS.AMY);

        console.log(`\n   Position #${tokenId}:`);
        console.log(`      Pool: ${isAmyHoney ? 'AMY/HONEY ✅' : 'Other pool'}`);

        if (!isAmyHoney || position.liquidity.isZero()) {
            console.log(`      Liquidity: ${position.liquidity.toString()} (skipped)`);
            continue;
        }

        amyHoneyCount++;

        const liquidity = parseFloat(position.liquidity.toString());
        const { amount0, amount1 } = getTokenAmountsFromLiquidity(
            liquidity, position.tickLower, position.tickUpper, currentTick
        );

        const amount0Decimal = amount0 / 1e18;
        const amount1Decimal = amount1 / 1e18;

        let usd;
        if (posToken0 === TOKENS.AMY) {
            usd = (amount0Decimal * amyPrice) + amount1Decimal;
            console.log(`      AMY: ${amount0Decimal.toFixed(4)}`);
            console.log(`      HONEY: ${amount1Decimal.toFixed(4)}`);
        } else {
            usd = amount0Decimal + (amount1Decimal * amyPrice);
            console.log(`      HONEY: ${amount0Decimal.toFixed(4)}`);
            console.log(`      AMY: ${amount1Decimal.toFixed(4)}`);
        }

        console.log(`      USD Value: $${usd.toFixed(4)}`);
        totalUsd += usd;
    }

    const multiplier = calculateLpMultiplier(totalUsd);

    console.log('\n' + '─'.repeat(50));
    console.log('📋 FINAL RESULT:');
    console.log('─'.repeat(50));
    console.log(`   AMY/HONEY Positions: ${amyHoneyCount}`);
    console.log(`   Total LP Value: $${totalUsd.toFixed(4)}`);
    console.log(`   Multiplier: ${multiplier}x`);
    console.log('─'.repeat(50));

    if (multiplier === 1) {
        console.log('\n💡 To earn a multiplier:');
        console.log('   • $10+ LP  →  3x points');
        console.log('   • $100+ LP → 10x points');
        console.log('   • $500+ LP → 100x points');
    } else {
        console.log(`\n🎉 You're earning ${multiplier}x points!`);
    }
}

// Get wallet from command line or use default
const wallet = process.argv[2];

if (!wallet) {
    console.log('Usage: node test-lp-final.js <wallet_address>');
    console.log('Example: node test-lp-final.js 0x1234...abcd');
    console.log('\nRunning with test address...\n');
    testWallet('0x0000000000000000000000000000000000000001').catch(console.error);
} else {
    testWallet(wallet).catch(console.error);
}
