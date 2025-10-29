// Backend API Configuration
const API_BASE_URL = 'https://amy-production-fd10.up.railway.app'; // Change to your backend URL in production

// Berachain Network Configuration (MAINNET)
const BERACHAIN_CONFIG = {
    chainId: '0x138de', // 80094 in hex (Berachain Mainnet)
    chainName: 'Berachain',
    nativeCurrency: {
        name: 'BERA',
        symbol: 'BERA',
        decimals: 18
    },
    rpcUrls: [
        'https://rpc.berachain.com/',
        'https://berachain-rpc.publicnode.com',
        'https://rpc.berachain-apis.com'
    ],
    blockExplorerUrls: ['https://beratrail.io/']
};

// AMY Token Configuration
const AMY_TOKEN_ADDRESS = '0x098a75bAedDEc78f9A8D0830d6B86eAc5cC8894e';
let MINIMUM_AMY_BALANCE = 300; // Default value, will be updated from backend

// ERC20 ABI (only the functions we need)
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
];

// Global state
let userWallet = null;
let userXAccount = null;
let amyBalance = 0;
let isUserAdmin = false;
let web3Modal = null;
let provider = null;

// Fetch minimum AMY balance from backend
async function fetchMinimumBalance() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/leaderboard`);
        const result = await response.json();
        if (result.success && result.data.minimumAMY !== undefined) {
            MINIMUM_AMY_BALANCE = result.data.minimumAMY;
            console.log('💎 Minimum AMY balance:', MINIMUM_AMY_BALANCE);
        }
    } catch (error) {
        console.error('Error fetching minimum balance:', error);
        // Keep default value of 300
    }
}

// Initialize Web3Modal
function initWeb3Modal() {
    const providerOptions = {
        walletconnect: {
            package: WalletConnectProvider.default,
            options: {
                rpc: {
                    80084: 'https://rpc.berachain.com/',
                },
                chainId: 80084,
                network: 'berachain'
            }
        }
    };

    web3Modal = new Web3Modal.default({
        cacheProvider: true,
        providerOptions,
        disableInjectedProvider: false,
        theme: {
            background: "rgb(17, 24, 39)",
            main: "rgb(255, 255, 255)",
            secondary: "rgb(156, 163, 175)",
            border: "rgba(255, 215, 0, 0.4)",
            hover: "rgb(31, 41, 55)"
        }
    });
}

// Initialize on page load
window.addEventListener('load', async () => {
    // Initialize status indicators to disconnected
    const walletIndicator = document.getElementById('wallet-status-indicator');
    const xIndicator = document.getElementById('x-status-indicator');
    if (walletIndicator) walletIndicator.className = 'connection-status status-disconnected';
    if (xIndicator) xIndicator.className = 'connection-status status-disconnected';

    // Initialize Web3Modal
    initWeb3Modal();

    // Fetch minimum balance from backend
    await fetchMinimumBalance();

    // Restore X account from session storage
    const savedXUsername = sessionStorage.getItem('xUsername');
    if (savedXUsername) {
        userXAccount = savedXUsername;
        updateXAccountUI(true);
    }

    await checkExistingConnection();
    checkOAuthCallback();
    await loadVerificationStatus();

    // Check verification eligibility after everything loads
    checkVerificationEligibility();
});

// Check for OAuth callback parameters
async function checkOAuthCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const xConnected = urlParams.get('x_connected');
    const username = urlParams.get('username');
    const walletFromUrl = urlParams.get('wallet');
    const error = urlParams.get('error');

    if (error === 'oauth_failed') {
        alert('❌ X authentication failed. Please try again.');
        window.history.replaceState({}, document.title, window.location.pathname);
        return;
    }

    if (xConnected && username) {
        userXAccount = username;

        // Save X account to session storage
        sessionStorage.setItem('xAccountConnected', 'true');
        sessionStorage.setItem('xUsername', username);

        updateXAccountUI(true);

        // Reconnect wallet if it was connected before OAuth
        if (walletFromUrl && typeof window.ethereum !== 'undefined') {
            try {
                const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
                if (accounts.length > 0) {
                    userWallet = accounts[0];
                    sessionStorage.setItem('walletConnected', 'true');
                    sessionStorage.setItem('walletAddress', userWallet);
                    await updateWalletUI(true);
                    await checkTokenBalance();
                    await checkIfAdmin();
                }
            } catch (error) {
                console.error('Error reconnecting wallet:', error);
            }
        }

        checkVerificationEligibility();

        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);

    }
}

// Check if wallet is already connected
async function checkExistingConnection() {
    try {
        // Check if Web3Modal has cached provider
        if (web3Modal && web3Modal.cachedProvider) {
            await connectWallet();
        }
    } catch (error) {
        console.error('Error checking existing connection:', error);
        // Clear cache if connection fails
        if (web3Modal) {
            web3Modal.clearCachedProvider();
        }
        sessionStorage.removeItem('walletConnected');
        sessionStorage.removeItem('walletAddress');
    }
}

// Connect Wallet Function (with Web3Modal + WalletConnect support)
async function connectWallet() {
    try {
        console.log('🔌 Opening wallet selection...');

        // Open Web3Modal
        provider = await web3Modal.connect();

        console.log('✅ Provider connected');

        // Create ethers provider
        const ethersProvider = new ethers.providers.Web3Provider(provider);
        const signer = ethersProvider.getSigner();
        const address = await signer.getAddress();
        const network = await ethersProvider.getNetwork();

        console.log('Wallet address:', address);
        console.log('Current network:', network.chainId);

        // Check if on Berachain
        if (network.chainId !== 80084) {
            console.log('🔄 Requesting network switch to Berachain...');

            try {
                // Try to switch network
                await provider.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: BERACHAIN_CONFIG.chainId }],
                });
                console.log('✅ Switched to Berachain');
            } catch (switchError) {
                console.error('Switch error:', switchError);

                // User rejected
                if (switchError.code === 4001) {
                    alert('You need to switch to Berachain network to use this app.');
                    await disconnectWallet();
                    return;
                }

                // Network not added
                if (switchError.code === 4902 || switchError.message?.includes('Unrecognized chain')) {
                    console.log('📝 Adding Berachain network...');
                    try {
                        await provider.request({
                            method: 'wallet_addEthereumChain',
                            params: [BERACHAIN_CONFIG],
                        });
                        console.log('✅ Berachain network added');
                    } catch (addError) {
                        console.error('Error adding network:', addError);
                        if (addError.code === 4001) {
                            alert('You need to add Berachain network to continue.');
                        } else {
                            alert('Failed to add Berachain network. Please add it manually.');
                        }
                        await disconnectWallet();
                        return;
                    }
                } else {
                    alert('Failed to switch network. Please switch to Berachain manually.');
                    await disconnectWallet();
                    return;
                }
            }
        }

        userWallet = address;

        // Save connection state
        sessionStorage.setItem('walletConnected', 'true');
        sessionStorage.setItem('walletAddress', userWallet);

        console.log('💾 Wallet saved to session');

        // Subscribe to provider events
        subscribeToProviderEvents(provider);

        await updateWalletUI(true);
        await checkTokenBalance();
        await checkIfAdmin();
        checkVerificationEligibility();

        console.log('✅ Wallet connection complete');

    } catch (error) {
        console.error('❌ Error connecting wallet:', error);

        // Handle errors
        if (error === 'Modal closed by user') {
            console.log('User closed modal');
            return;
        }

        if (error.code === 4001) {
            alert('Connection rejected. Please approve the connection request.');
        } else if (error.code === -32002) {
            alert('Connection request already pending. Please check your wallet.');
        } else {
            alert('Failed to connect wallet: ' + (error.message || 'Unknown error') + '\n\nPlease try again.');
        }
    }
}

// Subscribe to provider events
function subscribeToProviderEvents(provider) {
    if (!provider.on) return;

    provider.on('accountsChanged', async (accounts) => {
        console.log('Accounts changed:', accounts);
        if (accounts.length === 0) {
            await disconnectWallet();
        } else {
            userWallet = accounts[0];
            sessionStorage.setItem('walletAddress', userWallet);
            await updateWalletUI(true);
            await checkTokenBalance();
            await checkIfAdmin();
            await loadVerificationStatus();
        }
    });

    provider.on('chainChanged', (chainId) => {
        console.log('Chain changed:', chainId);
        window.location.reload();
    });

    provider.on('disconnect', () => {
        console.log('Provider disconnected');
        disconnectWallet();
    });
}

// Update wallet UI
async function updateWalletUI(connected) {
    const displayEl = document.getElementById('wallet-display');
    const btnEl = document.getElementById('wallet-btn');
    const indicatorEl = document.getElementById('wallet-status-indicator');

    if (connected && userWallet) {
        const shortAddress = `${userWallet.substring(0, 4)}...${userWallet.substring(38)}`;
        displayEl.textContent = shortAddress;
        btnEl.onclick = disconnectWallet;
        indicatorEl.className = 'connection-status status-connected';
    } else {
        displayEl.textContent = 'Connect Wallet';
        btnEl.onclick = connectWallet;
        indicatorEl.className = 'connection-status status-disconnected';
        document.getElementById('balance-info').classList.add('hidden');
    }
}

// Disconnect wallet
async function disconnectWallet() {
    // Disconnect provider
    if (provider && provider.disconnect) {
        await provider.disconnect();
    }

    // Clear Web3Modal cache
    if (web3Modal) {
        web3Modal.clearCachedProvider();
    }

    userWallet = null;
    amyBalance = 0;
    isUserAdmin = false;
    provider = null;

    // Clear session storage
    sessionStorage.removeItem('walletConnected');
    sessionStorage.removeItem('walletAddress');

    updateWalletUI(false);
    updateAdminSection();
    checkVerificationEligibility();

    // Hide eligibility section
    document.getElementById('eligibility-section').classList.add('hidden');
}

// Check AMY token balance
async function checkTokenBalance() {
    if (!userWallet || !provider) return;

    try {
        const ethersProvider = new ethers.providers.Web3Provider(provider);
        const tokenContract = new ethers.Contract(AMY_TOKEN_ADDRESS, ERC20_ABI, ethersProvider);

        const balance = await tokenContract.balanceOf(userWallet);
        const decimals = await tokenContract.decimals();

        amyBalance = parseFloat(ethers.utils.formatUnits(balance, decimals));

        // Update UI
        document.getElementById('amy-balance').textContent = amyBalance.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
        document.getElementById('balance-info').classList.remove('hidden');

        checkVerificationEligibility();

        // Update eligibility status if both wallet and X are connected
        if (userWallet && userXAccount) {
            updateEligibilityStatus();
        }

    } catch (error) {
        console.error('Error checking token balance:', error);
        alert('Failed to check token balance. Please ensure you are on Berachain network.');
    }
}

// Check if current wallet is admin
async function checkIfAdmin() {
    if (!userWallet) {
        isUserAdmin = false;
        updateAdminSection();
        return;
    }

    try {
        // Try to access admin endpoint to check if wallet is admin
        const response = await fetch(`${API_BASE_URL}/api/users?wallet=${userWallet}`);

        if (response.ok) {
            isUserAdmin = true;
            console.log('✅ Admin wallet detected');
        } else {
            isUserAdmin = false;
        }

        updateAdminSection();

    } catch (error) {
        console.error('Error checking admin status:', error);
        isUserAdmin = false;
        updateAdminSection();
    }
}

// Update admin section visibility
function updateAdminSection() {
    const adminSection = document.getElementById('admin-section');
    const adminLeaderboardSection = document.getElementById('admin-leaderboard-section');

    if (isUserAdmin) {
        adminSection.classList.remove('hidden');
        adminLeaderboardSection.classList.remove('hidden');
        loadAdminLeaderboard();
    } else {
        adminSection.classList.add('hidden');
        adminLeaderboardSection.classList.add('hidden');
    }
}

// Connect X Account - Real OAuth Flow
async function connectX() {
    if (!userWallet) {
        alert('Please connect your wallet first!');
        return;
    }

    console.log('🔐 Starting X OAuth flow...');
    console.log('Wallet:', userWallet);
    console.log('Redirecting to:', `${API_BASE_URL}/auth/x?wallet=${userWallet}`);

    window.location.href = `${API_BASE_URL}/auth/x?wallet=${userWallet}`;
}

// Update X account UI
function updateXAccountUI(connected) {
    const statusEl = document.getElementById('x-status');
    const usernameEl = document.getElementById('x-username');
    const btnEl = document.getElementById('x-btn');
    const indicatorEl = document.getElementById('x-status-indicator');

    if (connected && userXAccount) {
        statusEl.textContent = 'Connected';
        statusEl.className = 'text-xs md:text-sm text-green-400 font-bold';
        usernameEl.textContent = `@${userXAccount}`;
        btnEl.textContent = 'CHANGE';
        btnEl.onclick = connectX;
        indicatorEl.className = 'connection-status status-connected';
    } else {
        statusEl.textContent = 'Not connected';
        statusEl.className = 'text-xs md:text-sm text-gray-300';
        usernameEl.textContent = '';
        btnEl.textContent = 'CONNECT';
        btnEl.onclick = connectX;
        indicatorEl.className = 'connection-status status-disconnected';
    }
}

// Check if user is eligible for verification and auto-verify
async function checkVerificationEligibility() {
    // Auto-verify when both wallet and X account are connected
    if (userWallet && userXAccount) {
        // Check if already verified to avoid duplicate verifications
        const alreadyVerified = await isAlreadyVerified();
        if (!alreadyVerified) {
            // Automatically trigger verification
            await verifyHoldings();
        }

        // Show eligibility status to the user
        updateEligibilityStatus();
    } else {
        // Hide eligibility section if not fully connected
        document.getElementById('eligibility-section').classList.add('hidden');
    }
}

// Update eligibility status display
function updateEligibilityStatus() {
    const eligibilitySection = document.getElementById('eligibility-section');
    const eligibilityIcon = document.getElementById('eligibility-icon');
    const eligibilityTitle = document.getElementById('eligibility-title');
    const eligibilityMessage = document.getElementById('eligibility-message');

    if (!userWallet || !userXAccount) {
        eligibilitySection.classList.add('hidden');
        return;
    }

    // Show the section
    eligibilitySection.classList.remove('hidden');

    // Check if user meets minimum balance requirement
    const isEligible = amyBalance >= MINIMUM_AMY_BALANCE;

    if (isEligible) {
        eligibilityIcon.textContent = '✅';
        eligibilityTitle.textContent = 'Eligible';
        eligibilityTitle.className = 'text-xl md:text-2xl font-bold mb-2 text-green-400';
        eligibilityMessage.textContent = `You have at least ${MINIMUM_AMY_BALANCE} $AMY and you are on the AMY cookie leaderboard.`;
    } else {
        eligibilityIcon.textContent = '❌';
        eligibilityTitle.textContent = 'Ineligible';
        eligibilityTitle.className = 'text-xl md:text-2xl font-bold mb-2 text-red-400';
        eligibilityMessage.textContent = `You need at least ${MINIMUM_AMY_BALANCE} $AMY and be on the cookie leaderboard to be eligible. You currently have ${amyBalance.toFixed(2)} $AMY.`;
    }
}

// Check if user is already verified
async function isAlreadyVerified() {
    if (!userWallet) return false;

    try {
        const response = await fetch(`${API_BASE_URL}/api/status/${userWallet}`);
        const data = await response.json();
        return data.verified || false;
    } catch (error) {
        console.error('Error checking verification status:', error);
        return false;
    }
}

// Verify holdings and save user to backend (silently)
async function verifyHoldings() {
    if (!userWallet || !userXAccount) {
        return;
    }

    // Check token balance
    await checkTokenBalance();

    // Only save if user has minimum balance
    if (amyBalance >= MINIMUM_AMY_BALANCE) {
        try {
            // Send verification to backend silently
            const response = await fetch(`${API_BASE_URL}/api/verify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    wallet: userWallet,
                    xUsername: userXAccount,
                    amyBalance: amyBalance
                })
            });

            const data = await response.json();

            if (response.ok && data.success) {
                console.log('✅ User verified and saved to spreadsheet');
            } else {
                console.error('Verification failed:', data.error);
            }

        } catch (error) {
            console.error('Error verifying holdings:', error);
        }
    } else {
        console.log(`User balance (${amyBalance.toFixed(2)} AMY) below minimum (${MINIMUM_AMY_BALANCE} AMY)`);
    }
}

// Load verification status from backend (silently)
async function loadVerificationStatus() {
    if (!userWallet) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/status/${userWallet}`);
        const data = await response.json();

        if (data.verified && data.data) {
            // Silently restore X account if verified
            if (data.data.xUsername) {
                userXAccount = data.data.xUsername;
                updateXAccountUI(true);
            }
            console.log('User already verified');
        }

    } catch (error) {
        console.error('Error loading verification status:', error);
    }
}

// Download spreadsheet (admin only)
async function downloadSpreadsheet() {
    if (!isUserAdmin) {
        alert('❌ Unauthorized: You are not an admin wallet.');
        return;
    }

    try {
        // Trigger download from backend
        const url = `${API_BASE_URL}/api/download?wallet=${userWallet}`;
        const link = document.createElement('a');
        link.href = url;
        link.download = `AMY_Verified_Holders_${Date.now()}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        alert('✅ Downloading spreadsheet...');

    } catch (error) {
        console.error('Error downloading spreadsheet:', error);
        alert('❌ Failed to download spreadsheet. Please try again.');
    }
}

// Event listeners are now handled in subscribeToProviderEvents()

// ============================================
// LEADERBOARD
// ============================================

// Load and display leaderboard
async function loadLeaderboard() {
    try {
        // Fetch leaderboard data from backend API
        const leaderboardResponse = await fetch(`${API_BASE_URL}/api/leaderboard`);
        const leaderboardResult = await leaderboardResponse.json();

        if (!leaderboardResult.success) {
            throw new Error('Failed to fetch leaderboard');
        }

        const leaderboardData = leaderboardResult.data;

        // For each X username in the leaderboard, check if they've verified on the website
        const enrichedLeaderboard = await Promise.all(
            leaderboardData.leaderboard.map(async (entry) => {
                try {
                    // Fetch user data from backend by X username
                    const userResponse = await fetch(`${API_BASE_URL}/api/user/${entry.xUsername}`);
                    const userData = await userResponse.json();

                    if (userData.success && userData.verified && userData.data) {
                        // User has verified on the website
                        return {
                            originalPosition: entry.position,
                            xUsername: userData.data.xUsername,
                            walletAddress: userData.data.walletAddress,
                            amyBalance: userData.data.amyBalance,
                            eligible: userData.data.eligible,
                            verified: true,
                            mindshare: entry.mindshare || 0
                        };
                    } else {
                        // User hasn't verified yet
                        return {
                            originalPosition: entry.position,
                            xUsername: entry.xUsername,
                            verified: false,
                            eligible: false,
                            mindshare: entry.mindshare || 0
                        };
                    }
                } catch (error) {
                    console.error(`Error fetching data for ${entry.xUsername}:`, error);
                    return {
                        originalPosition: entry.position,
                        xUsername: entry.xUsername,
                        verified: false,
                        eligible: false,
                        mindshare: entry.mindshare || 0
                    };
                }
            })
        );

        // Sort by mindshare (descending) - highest mindshare first
        enrichedLeaderboard.sort((a, b) => b.mindshare - a.mindshare);

        // Display the enriched leaderboard
        displayLeaderboard({
            leaderboard: enrichedLeaderboard,
            lastUpdated: leaderboardData.lastUpdated,
            minimumAMY: leaderboardData.minimumAMY
        });

    } catch (error) {
        console.error('Error loading leaderboard:', error);
        showLeaderboardError();
    }
}

// Display leaderboard data
function displayLeaderboard(data) {
    const container = document.getElementById('leaderboard-container');
    const emptyState = document.getElementById('empty-state');
    const minimumElement = document.getElementById('minimum-amy');
    const lastUpdatedElement = document.getElementById('last-updated');

    // Update minimum AMY requirement
    if (minimumElement) {
        minimumElement.textContent = data.minimumAMY || 300;
    }

    // Update last updated time
    if (lastUpdatedElement && data.lastUpdated) {
        const date = new Date(data.lastUpdated);
        lastUpdatedElement.textContent = `Updated: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    }

    // Filter to only show verified AND eligible users
    const eligibleUsers = data.leaderboard.filter(user => user.verified && user.eligible);

    if (eligibleUsers.length === 0) {
        container.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');

    // Generate leaderboard HTML with dynamic positions
    const leaderboardHTML = eligibleUsers.map((user, index) => {
        // Dynamic position based on filtered and sorted list
        const position = index + 1;

        const positionClass = position === 1 ? 'position-1' :
                             position === 2 ? 'position-2' :
                             position === 3 ? 'position-3' : '';

        const statusClass = user.eligible ? 'status-eligible' : 'status-ineligible';
        const statusText = user.eligible ? '✅ Eligible' : '❌ Ineligible';

        // Medal for top 3
        const medal = position === 1 ? '🥇' :
                     position === 2 ? '🥈' :
                     position === 3 ? '🥉' : '';

        return `
            <div class="leaderboard-row">
                <div class="flex items-center gap-3 md:gap-4">
                    <div class="position-badge ${positionClass}">
                        ${medal || position}
                    </div>
                    <div class="flex-1">
                        <div class="flex items-center gap-2">
                            <span class="text-lg md:text-xl font-bold text-white">@${user.xUsername}</span>
                            ${user.mindshare > 0 ? `<span class="text-xs text-green-400 font-semibold">${user.mindshare}% MS</span>` : ''}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = leaderboardHTML;
}

// Show error state
function showLeaderboardError() {
    const container = document.getElementById('leaderboard-container');
    container.innerHTML = `
        <div class="text-center py-12">
            <p class="text-2xl mb-2">⚠️</p>
            <p class="text-gray-400">Failed to load leaderboard</p>
            <p class="text-sm text-gray-500 mt-2">Please try again later</p>
        </div>
    `;
}

// Load leaderboard on page load
loadLeaderboard();

// Refresh leaderboard every 30 seconds
setInterval(loadLeaderboard, 30000);

// ============================================
// ADMIN LEADERBOARD MANAGEMENT
// ============================================

// Load leaderboard entries for admin editing
async function loadAdminLeaderboard() {
    if (!isUserAdmin) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/leaderboard`);
        const result = await response.json();

        if (!result.success) {
            throw new Error('Failed to fetch leaderboard');
        }

        const container = document.getElementById('admin-leaderboard-list');
        const entries = result.data.leaderboard;

        if (entries.length === 0) {
            container.innerHTML = '<p class="text-gray-400 text-sm">No entries yet</p>';
            return;
        }

        // Sort by position
        entries.sort((a, b) => a.position - b.position);

        const entriesHTML = entries.map(entry => `
            <div class="bg-gray-800 p-3 rounded-lg mb-2 flex items-center justify-between">
                <div class="flex-1">
                    <span class="text-white font-bold">#${entry.position}</span>
                    <span class="text-yellow-400 ml-3">@${entry.xUsername}</span>
                    <span class="text-green-400 ml-3">${entry.mindshare}% MS</span>
                </div>
                <div class="flex gap-2">
                    <button onclick="editLeaderboardEntry(${entry.position})" class="bg-blue-500 text-white px-3 py-1 rounded text-xs font-bold hover:bg-blue-600">
                        ✏️ EDIT
                    </button>
                    <button onclick="deleteLeaderboardEntry(${entry.position})" class="bg-red-500 text-white px-3 py-1 rounded text-xs font-bold hover:bg-red-600">
                        🗑️ DELETE
                    </button>
                </div>
            </div>
        `).join('');

        container.innerHTML = entriesHTML;

    } catch (error) {
        console.error('Error loading admin leaderboard:', error);
        document.getElementById('admin-leaderboard-list').innerHTML = '<p class="text-red-400 text-sm">Failed to load entries</p>';
    }
}

// Add new leaderboard entry
async function addLeaderboardEntry() {
    if (!isUserAdmin) {
        alert('❌ Unauthorized: You are not an admin wallet.');
        return;
    }

    const position = document.getElementById('new-position').value;
    const username = document.getElementById('new-username').value;
    const mindshare = document.getElementById('new-mindshare').value;

    if (!position || !username) {
        alert('❌ Position and X Username are required!');
        return;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/api/leaderboard/entry?wallet=${userWallet}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                position: parseInt(position),
                xUsername: username,
                mindshare: parseFloat(mindshare) || 0
            })
        });

        const result = await response.json();

        if (response.ok && result.success) {
            alert('✅ Entry added successfully!');
            document.getElementById('new-position').value = '';
            document.getElementById('new-username').value = '';
            document.getElementById('new-mindshare').value = '';
            loadAdminLeaderboard();
            loadLeaderboard(); // Refresh public leaderboard
        } else {
            alert('❌ Failed to add entry: ' + (result.error || 'Unknown error'));
        }

    } catch (error) {
        console.error('Error adding entry:', error);
        alert('❌ Failed to add entry. Please try again.');
    }
}

// Edit leaderboard entry
async function editLeaderboardEntry(position) {
    if (!isUserAdmin) {
        alert('❌ Unauthorized: You are not an admin wallet.');
        return;
    }

    const username = prompt('Enter new X Username (without @):');
    const mindshare = prompt('Enter new Mindshare %:');

    if (username === null) return; // User cancelled

    try {
        const body = { position: position };
        if (username) body.xUsername = username;
        if (mindshare !== null && mindshare !== '') body.mindshare = parseFloat(mindshare);

        const response = await fetch(`${API_BASE_URL}/api/leaderboard/${position}?wallet=${userWallet}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body)
        });

        const result = await response.json();

        if (response.ok && result.success) {
            alert('✅ Entry updated successfully!');
            loadAdminLeaderboard();
            loadLeaderboard(); // Refresh public leaderboard
        } else {
            alert('❌ Failed to update entry: ' + (result.error || 'Unknown error'));
        }

    } catch (error) {
        console.error('Error updating entry:', error);
        alert('❌ Failed to update entry. Please try again.');
    }
}

// Delete leaderboard entry
async function deleteLeaderboardEntry(position) {
    if (!isUserAdmin) {
        alert('❌ Unauthorized: You are not an admin wallet.');
        return;
    }

    if (!confirm(`Are you sure you want to delete position #${position}?`)) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/api/leaderboard/${position}?wallet=${userWallet}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (response.ok && result.success) {
            alert('✅ Entry deleted successfully!');
            loadAdminLeaderboard();
            loadLeaderboard(); // Refresh public leaderboard
        } else {
            alert('❌ Failed to delete entry: ' + (result.error || 'Unknown error'));
        }

    } catch (error) {
        console.error('Error deleting entry:', error);
        alert('❌ Failed to delete entry. Please try again.');
    }
}

console.log('🚀 $AMY Profile & Verification loaded!');
console.log('📡 Backend API:', API_BASE_URL);
console.log('🏆 Leaderboard auto-refresh enabled');
