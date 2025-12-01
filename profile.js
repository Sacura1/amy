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
let walletSignature = null;
let signatureMessage = null;
let signatureTimestamp = null;

// Fetch minimum AMY balance from backend
async function fetchMinimumBalance() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/leaderboard`);
        const result = await response.json();
        if (result.success && result.data.minimumAMY !== undefined) {
            MINIMUM_AMY_BALANCE = result.data.minimumAMY;
        }
    } catch (error) {
        // Keep default value of 300
    }
}

// Generate signature to prove wallet ownership
async function requestWalletSignature() {
    if (!provider || !userWallet) {
        return false;
    }

    try {

        // Generate nonce and timestamp
        const nonce = Math.floor(Math.random() * 1000000000);
        const timestamp = Date.now();

        // Create message to sign
        const message = `Welcome to $AMY Token!\n\nSign this message to verify you own this wallet address.\n\nThis request will not trigger a blockchain transaction or cost any gas fees.\n\nWallet: ${userWallet}\nNonce: ${nonce}\nTimestamp: ${timestamp}`;

        // Get signer
        const ethersProvider = new ethers.providers.Web3Provider(provider);
        const signer = ethersProvider.getSigner();

        // Request signature
        const signature = await signer.signMessage(message);

        // Store signature data
        walletSignature = signature;
        signatureMessage = message;
        signatureTimestamp = timestamp;

        // Save to session storage
        sessionStorage.setItem('walletSignature', signature);
        sessionStorage.setItem('signatureMessage', message);
        sessionStorage.setItem('signatureTimestamp', timestamp.toString());

        return true;

    } catch (error) {
        if (error.code === 4001) {
            alert('⚠️ Signature rejected. You must sign the message to verify wallet ownership and use this application.');
        } else {
            alert('Failed to sign message: ' + (error.message || 'Unknown error'));
        }

        // Disconnect if signature is rejected
        await disconnectWallet();
        return false;
    }
}

// Verify signature is still valid (not expired)
function isSignatureValid() {
    if (!walletSignature || !signatureTimestamp) {
        return false;
    }

    // Check if signature is less than 24 hours old
    const MAX_SIGNATURE_AGE = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    const age = Date.now() - signatureTimestamp;

    if (age > MAX_SIGNATURE_AGE) {
        return false;
    }

    return true;
}

// Initialize Web3Modal
function initWeb3Modal() {
    try {
        // Check if Web3Modal and WalletConnect are loaded
        if (typeof Web3Modal === 'undefined') {
            return;
        }

        if (typeof WalletConnectProvider === 'undefined') {
            return;
        }

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
            disableInjectedProvider: true, // We handle MetaMask directly
            theme: {
                background: "rgb(17, 24, 39)",
                main: "rgb(255, 255, 255)",
                secondary: "rgb(156, 163, 175)",
                border: "rgba(255, 215, 0, 0.4)",
                hover: "rgb(31, 41, 55)"
            }
        });

    } catch (error) {
    }
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
        // Restore signature from session storage if exists
        const savedSignature = sessionStorage.getItem('walletSignature');
        const savedMessage = sessionStorage.getItem('signatureMessage');
        const savedTimestamp = sessionStorage.getItem('signatureTimestamp');

        if (savedSignature && savedMessage && savedTimestamp) {
            walletSignature = savedSignature;
            signatureMessage = savedMessage;
            signatureTimestamp = parseInt(savedTimestamp);

            // Check if signature is still valid
            if (!isSignatureValid()) {
                sessionStorage.removeItem('walletSignature');
                sessionStorage.removeItem('signatureMessage');
                sessionStorage.removeItem('signatureTimestamp');
                walletSignature = null;
                signatureMessage = null;
                signatureTimestamp = null;
            }
        }

        // First check if MetaMask/wallet is available
        if (typeof window.ethereum !== 'undefined') {
            const accounts = await window.ethereum.request({ method: 'eth_accounts' });
            if (accounts && accounts.length > 0) {
                await connectMetaMaskDirect();
                return;
            }
        }

        // Check if Web3Modal has cached provider (WalletConnect)
        if (web3Modal && web3Modal.cachedProvider) {
            await connectWallet();
        }
    } catch (error) {
        // Clear cache if connection fails
        if (web3Modal) {
            web3Modal.clearCachedProvider();
        }
        sessionStorage.removeItem('walletConnected');
        sessionStorage.removeItem('walletAddress');
        sessionStorage.removeItem('walletSignature');
        sessionStorage.removeItem('signatureMessage');
        sessionStorage.removeItem('signatureTimestamp');
    }
}

// Direct MetaMask connection (fallback)
async function connectMetaMaskDirect() {
    if (typeof window.ethereum === 'undefined') {
        alert('Please install MetaMask or another Web3 wallet to continue!');
        window.open('https://metamask.io/download/', '_blank');
        return;
    }

    try {

        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });

        if (!accounts || accounts.length === 0) {
            throw new Error('No accounts returned');
        }


        // Check network
        const chainId = await window.ethereum.request({ method: 'eth_chainId' });

        if (chainId !== BERACHAIN_CONFIG.chainId) {
            try {
                await window.ethereum.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: BERACHAIN_CONFIG.chainId }],
                });
            } catch (switchError) {
                if (switchError.code === 4902) {
                    await window.ethereum.request({
                        method: 'wallet_addEthereumChain',
                        params: [BERACHAIN_CONFIG],
                    });
                } else if (switchError.code === 4001) {
                    alert('Please switch to Berachain network to continue.');
                    return;
                } else {
                    throw switchError;
                }
            }
        }

        userWallet = accounts[0];
        provider = window.ethereum;

        sessionStorage.setItem('walletConnected', 'true');
        sessionStorage.setItem('walletAddress', userWallet);

        // Request signature if we don't have a valid one
        if (!isSignatureValid()) {
            const signatureObtained = await requestWalletSignature();
            if (!signatureObtained) {
                // User rejected signature, already disconnected in requestWalletSignature
                return;
            }
        }

        await updateWalletUI(true);
        await checkTokenBalance();
        await checkIfAdmin();
        checkVerificationEligibility();


    } catch (error) {
        if (error.code === 4001) {
            alert('Connection rejected.');
        } else {
            alert('Failed to connect: ' + (error.message || 'Unknown error'));
        }
    }
}

// Connect Wallet Function (with Web3Modal + WalletConnect support)
async function connectWallet() {
    // Check if MetaMask (or any wallet) is already available
    if (typeof window.ethereum !== 'undefined') {
        return await connectMetaMaskDirect();
    }

    // No wallet detected - show WalletConnect for mobile users
    if (!web3Modal) {
        alert('Please install MetaMask or use a wallet app to continue!');
        window.open('https://metamask.io/download/', '_blank');
        return;
    }

    try {

        // Open Web3Modal (will show WalletConnect only)
        provider = await web3Modal.connect();


        // Create ethers provider
        const ethersProvider = new ethers.providers.Web3Provider(provider);
        const signer = ethersProvider.getSigner();
        const address = await signer.getAddress();
        const network = await ethersProvider.getNetwork();


        // Check if on Berachain
        if (network.chainId !== 80084) {

            try {
                // Try to switch network
                await provider.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: BERACHAIN_CONFIG.chainId }],
                });
            } catch (switchError) {

                // User rejected
                if (switchError.code === 4001) {
                    alert('You need to switch to Berachain network to use this app.');
                    await disconnectWallet();
                    return;
                }

                // Network not added
                if (switchError.code === 4902 || switchError.message?.includes('Unrecognized chain')) {
                    try {
                        await provider.request({
                            method: 'wallet_addEthereumChain',
                            params: [BERACHAIN_CONFIG],
                        });
                    } catch (addError) {
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


        // Request signature if we don't have a valid one
        if (!isSignatureValid()) {
            const signatureObtained = await requestWalletSignature();
            if (!signatureObtained) {
                // User rejected signature, already disconnected in requestWalletSignature
                return;
            }
        }

        // Subscribe to provider events
        subscribeToProviderEvents(provider);

        await updateWalletUI(true);
        await checkTokenBalance();
        await checkIfAdmin();
        checkVerificationEligibility();


    } catch (error) {

        // Handle errors
        if (error === 'Modal closed by user') {
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
        window.location.reload();
    });

    provider.on('disconnect', () => {
        disconnectWallet();
    });
}

// Update wallet UI
async function updateWalletUI(connected) {
    const displayEl = document.getElementById('wallet-display');
    const btnEl = document.getElementById('wallet-btn');
    const indicatorEl = document.getElementById('wallet-status-indicator');

    // Check if elements exist (they may not exist on all pages)
    if (!displayEl || !btnEl || !indicatorEl) {
        return;
    }

    if (connected && userWallet) {
        const shortAddress = `${userWallet.substring(0, 4)}...${userWallet.substring(38)}`;
        displayEl.textContent = shortAddress;
        btnEl.onclick = disconnectWallet;
        indicatorEl.className = 'connection-status status-connected';
    } else {
        displayEl.textContent = 'Connect Wallet';
        btnEl.onclick = connectWallet;
        indicatorEl.className = 'connection-status status-disconnected';
        const balanceInfo = document.getElementById('balance-info');
        if (balanceInfo) {
            balanceInfo.classList.add('hidden');
        }
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
    walletSignature = null;
    signatureMessage = null;
    signatureTimestamp = null;

    // Clear session storage
    sessionStorage.removeItem('walletConnected');
    sessionStorage.removeItem('walletAddress');
    sessionStorage.removeItem('walletSignature');
    sessionStorage.removeItem('signatureMessage');
    sessionStorage.removeItem('signatureTimestamp');

    updateWalletUI(false);
    updateAdminSection();
    checkVerificationEligibility();

    // Hide eligibility section
    const eligibilitySection = document.getElementById('eligibility-section');
    if (eligibilitySection) {
        eligibilitySection.classList.add('hidden');
    }
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
        const amyBalanceEl = document.getElementById('amy-balance');
        if (amyBalanceEl) {
            amyBalanceEl.textContent = amyBalance.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            });
        }
        const balanceInfo = document.getElementById('balance-info');
        if (balanceInfo) {
            balanceInfo.classList.remove('hidden');
        }

        checkVerificationEligibility();

        // Update eligibility status if both wallet and X are connected
        if (userWallet && userXAccount) {
            await updateEligibilityStatus();
        }

    } catch (error) {
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
        } else {
            isUserAdmin = false;
        }

        updateAdminSection();

    } catch (error) {
        isUserAdmin = false;
        updateAdminSection();
    }
}

// Update admin section visibility
function updateAdminSection() {
    const adminSection = document.getElementById('admin-section');
    const adminLeaderboardSection = document.getElementById('admin-leaderboard-section');

    // Check if elements exist (they may not exist on all pages)
    if (!adminSection || !adminLeaderboardSection) {
        return;
    }

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


    window.location.href = `${API_BASE_URL}/auth/x?wallet=${userWallet}`;
}

// Update X account UI
function updateXAccountUI(connected) {
    const statusEl = document.getElementById('x-status');
    const usernameEl = document.getElementById('x-username');
    const btnEl = document.getElementById('x-btn');
    const indicatorEl = document.getElementById('x-status-indicator');

    // Check if elements exist (they may not exist on all pages)
    if (!statusEl || !usernameEl || !btnEl || !indicatorEl) {
        return;
    }

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
        await updateEligibilityStatus();

        // Load referral data for the user
        await loadReferralData();
    } else {
        // Hide eligibility section if not fully connected
        const eligibilitySection = document.getElementById('eligibility-section');
        if (eligibilitySection) {
            eligibilitySection.classList.add('hidden');
        }

        // Hide referral section if not fully connected
        hideReferralSection();
    }
}

// Update eligibility status display
async function updateEligibilityStatus() {
    const eligibilitySection = document.getElementById('eligibility-section');
    const eligibilityIcon = document.getElementById('eligibility-icon');
    const eligibilityTitle = document.getElementById('eligibility-title');
    const eligibilityMessage = document.getElementById('eligibility-message');

    // Check if elements exist (they may not exist on all pages)
    if (!eligibilitySection || !eligibilityIcon || !eligibilityTitle || !eligibilityMessage) {
        return;
    }

    if (!userWallet || !userXAccount) {
        eligibilitySection.classList.add('hidden');
        return;
    }

    // Show the section
    eligibilitySection.classList.remove('hidden');

    // Check if user meets minimum balance requirement
    const hasEnoughBalance = amyBalance >= MINIMUM_AMY_BALANCE;

    // Check if user is on the leaderboard
    let isOnLeaderboard = false;
    try {
        const response = await fetch(`${API_BASE_URL}/api/leaderboard`);
        const result = await response.json();
        if (result.success && result.data.leaderboard) {
            isOnLeaderboard = result.data.leaderboard.some(
                entry => entry.xUsername.toLowerCase() === userXAccount.toLowerCase()
            );
        }
    } catch (error) {
        console.error('Failed to check leaderboard status:', error);
    }

    // User is eligible ONLY if they have balance AND are on the leaderboard
    const isEligible = hasEnoughBalance && isOnLeaderboard;

    if (isEligible) {
        // 300+ AMY AND on leaderboard = shown on leaderboard
        eligibilityIcon.textContent = '✅';
        eligibilityTitle.textContent = 'Leaderboard Eligible';
        eligibilityTitle.className = 'text-xl md:text-2xl font-bold mb-2 text-green-400';
        eligibilityMessage.textContent = `You have ${amyBalance.toFixed(2)} $AMY and you are on the AMY leaderboard. You will appear on the public leaderboard.`;
    } else if (!hasEnoughBalance && isOnLeaderboard) {
        // On leaderboard but < 300 AMY = ineligible
        eligibilityIcon.textContent = '❌';
        eligibilityTitle.textContent = 'Leaderboard Ineligible';
        eligibilityTitle.className = 'text-xl md:text-2xl font-bold mb-2 text-red-400';
        eligibilityMessage.textContent = `You are on the leaderboard data, but you need at least ${MINIMUM_AMY_BALANCE} $AMY to be shown. You currently have ${amyBalance.toFixed(2)} $AMY.`;
    } else if (hasEnoughBalance && !isOnLeaderboard) {
        // 300+ AMY but NOT on leaderboard = ineligible for leaderboard
        eligibilityIcon.textContent = '❌';
        eligibilityTitle.textContent = 'Leaderboard Ineligible';
        eligibilityTitle.className = 'text-xl md:text-2xl font-bold mb-2 text-red-400';
        eligibilityMessage.textContent = `You have ${amyBalance.toFixed(2)} $AMY, but you are not on the leaderboard data. Contact admin to be added.`;
    } else {
        // < 300 AMY and not on leaderboard
        eligibilityIcon.textContent = '❌';
        eligibilityTitle.textContent = 'Leaderboard Ineligible';
        eligibilityTitle.className = 'text-xl md:text-2xl font-bold mb-2 text-red-400';
        eligibilityMessage.textContent = `You need at least ${MINIMUM_AMY_BALANCE} $AMY and be on the leaderboard data to be eligible. You currently have ${amyBalance.toFixed(2)} $AMY.`;
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
        // Check if we have a valid signature
        if (!isSignatureValid()) {
            const signatureObtained = await requestWalletSignature();
            if (!signatureObtained) {
                return;
            }
        }

        try {
            // Send verification to backend with signature proof
            const response = await fetch(`${API_BASE_URL}/api/verify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    wallet: userWallet,
                    xUsername: userXAccount,
                    amyBalance: amyBalance,
                    signature: walletSignature,
                    message: signatureMessage,
                    timestamp: signatureTimestamp
                })
            });

            const data = await response.json();

            if (response.ok && data.success) {
            } else {
            }

        } catch (error) {
        }
    } else {
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
        }

    } catch (error) {
    }
}

// Download spreadsheet (admin only)
async function downloadSpreadsheet() {
    if (!isUserAdmin) {
        alert('❌ Unauthorized: You are not an admin wallet.');
        return;
    }

    try {
        // Fetch data from backend
        const url = `${API_BASE_URL}/api/download?wallet=${userWallet}`;
        const response = await fetch(url);

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Failed to download');
        }

        // Get the JSON data
        const jsonData = await response.json();

        // Create blob and download
        const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json' });
        const downloadUrl = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = `AMY_Verified_Holders_${Date.now()}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(downloadUrl);

        alert(`✅ Downloaded ${jsonData.length} verified users!`);

    } catch (error) {
        console.error('Download error:', error);
        alert('❌ Failed to download: ' + error.message);
    }
}

// Event listeners are now handled in subscribeToProviderEvents()

// ============================================
// LEADERBOARD
// ============================================

// Helper function to fetch live AMY balance from blockchain for any wallet
async function fetchLiveAmyBalance(walletAddress) {
    try {
        // Create a read-only provider (no wallet needed)
        const readOnlyProvider = new ethers.providers.JsonRpcProvider(BERACHAIN_CONFIG.rpcUrls[0]);
        const tokenContract = new ethers.Contract(AMY_TOKEN_ADDRESS, ERC20_ABI, readOnlyProvider);

        const balance = await tokenContract.balanceOf(walletAddress);
        const decimals = await tokenContract.decimals();

        return parseFloat(ethers.utils.formatUnits(balance, decimals));
    } catch (error) {
        console.error('Failed to fetch live balance for', walletAddress, error);
        return 0; // Return 0 if balance fetch fails (will make user ineligible)
    }
}

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
                        // User has verified on the website - now fetch their LIVE balance
                        const liveBalance = await fetchLiveAmyBalance(userData.data.walletAddress);
                        const isEligible = liveBalance >= MINIMUM_AMY_BALANCE;

                        return {
                            xUsername: userData.data.xUsername,
                            walletAddress: userData.data.walletAddress,
                            amyBalance: liveBalance, // Use LIVE balance from blockchain
                            eligible: isEligible, // Check against CURRENT balance
                            verified: true,
                            originalRank: entry.position || null
                        };
                    } else {
                        // User hasn't verified yet
                        return {
                            xUsername: entry.xUsername,
                            verified: false,
                            eligible: false,
                            originalRank: entry.position || null
                        };
                    }
                } catch (error) {
                    console.error(`Error checking ${entry.xUsername}:`, error);
                    return {
                        xUsername: entry.xUsername,
                        verified: false,
                        eligible: false,
                        originalRank: entry.position || null
                    };
                }
            })
        );

        // Display the enriched leaderboard
        displayLeaderboard({
            leaderboard: enrichedLeaderboard,
            lastUpdated: leaderboardData.lastUpdated,
            minimumAMY: leaderboardData.minimumAMY
        });

    } catch (error) {
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

    // Sort eligible users by their original rank position (lowest rank number = best = first)
    eligibleUsers.sort((a, b) => {
        const rankA = a.originalRank || 999999;
        const rankB = b.originalRank || 999999;
        return rankA - rankB;
    });

    // Generate leaderboard HTML - display sequential positions based on sorted order
    const leaderboardHTML = eligibleUsers.map((user, index) => {
        const displayPosition = index + 1; // Sequential position: 1, 2, 3, 4, 5... (no gaps)

        // Determine badge class based on display position
        let positionBadgeClass = 'position-badge';
        if (displayPosition === 1) {
            positionBadgeClass += ' position-1';
        } else if (displayPosition === 2) {
            positionBadgeClass += ' position-2';
        } else if (displayPosition === 3) {
            positionBadgeClass += ' position-3';
        }

        return `
            <div class="leaderboard-row">
                <div class="flex items-center gap-3 md:gap-4">
                    <!-- Position Badge (sequential, no gaps) -->
                    <div class="${positionBadgeClass}">
                        ${displayPosition}
                    </div>

                    <div class="flex-1">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="text-lg md:text-xl font-bold text-white">@${user.xUsername}</span>
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

        const entriesHTML = entries.map(entry => `
            <div class="bg-gradient-to-r from-gray-800 to-gray-900 p-3 rounded-lg mb-3 border border-yellow-400/20 hover:border-yellow-400/40 transition-all">
                <div class="flex items-center gap-2">
                    ${entry.position ? `<span class="text-yellow-400 font-bold text-sm">#${entry.position}</span>` : ''}
                    <span class="text-white font-semibold text-sm">@${entry.xUsername}</span>
                </div>
            </div>
        `).join('');

        container.innerHTML = entriesHTML;

    } catch (error) {
        document.getElementById('admin-leaderboard-list').innerHTML = '<p class="text-red-400 text-sm">Failed to load entries</p>';
    }
}

// Bulk update leaderboard from pasted data
async function bulkUpdateLeaderboard() {
    if (!isUserAdmin) {
        alert('❌ Unauthorized: You are not an admin wallet.');
        return;
    }

    const pasteArea = document.getElementById('leaderboard-paste-area');
    const pastedData = pasteArea.value.trim();

    if (!pastedData) {
        alert('❌ Please paste leaderboard data first!');
        return;
    }

    try {
        const lines = pastedData.split('\n').filter(line => line.trim());
        const entries = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Match format: "Position Name - @username" or just "@username"
            const match = line.match(/@([a-zA-Z0-9_]+)/);
            if (match) {
                const xUsername = match[1].trim();
                // Assign sequential position (1, 2, 3, ...) regardless of original numbering
                const position = i + 1;
                entries.push({ xUsername, position });
            }
        }

        if (entries.length === 0) {
            alert('❌ No valid X usernames found. Please check the format.');
            return;
        }

        const response = await fetch(`${API_BASE_URL}/api/leaderboard/bulk?wallet=${userWallet}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ entries })
        });

        const result = await response.json();

        if (response.ok && result.success) {
            alert(`✅ Successfully updated ${entries.length} X usernames!`);
            pasteArea.value = '';
            loadAdminLeaderboard();
            loadLeaderboard();
        } else {
            alert('❌ Failed to update: ' + (result.error || 'Unknown error'));
        }

    } catch (error) {
        alert('❌ Failed to update. Please try again.');
    }
}

// ============================================
// REFERRAL SYSTEM
// ============================================

// Global referral state
let userReferralCode = null;
let userReferredBy = null;
let userReferralCount = 0;

// Load referral data for user
async function loadReferralData() {
    // Referral section is available to anyone with wallet + X connected
    // (no balance or leaderboard requirement)
    if (!userWallet || !userXAccount) {
        hideReferralSection();
        return;
    }

    try {
        // Register user in referrals table (creates entry if doesn't exist)
        await fetch(`${API_BASE_URL}/api/referral/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet: userWallet, xUsername: userXAccount })
        });

        // Update user's balance in referrals table (for dynamic referral counting)
        await fetch(`${API_BASE_URL}/api/referral/update-balance`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet: userWallet, balance: amyBalance })
        });

        // Get referral data
        const response = await fetch(`${API_BASE_URL}/api/referral/${userWallet}`);
        const result = await response.json();

        if (result.success && result.data) {
            userReferralCode = result.data.referralCode || null;
            userReferredBy = result.data.referredBy || null;
            userReferralCount = result.data.referralCount || 0;
        } else {
            userReferralCode = null;
            userReferredBy = null;
            userReferralCount = 0;
        }

        updateReferralUI();
        showReferralSection();

    } catch (error) {
        console.error('Failed to load referral data:', error);
        // Still show referral section even if API fails
        userReferralCode = null;
        userReferredBy = null;
        userReferralCount = 0;
        updateReferralUI();
        showReferralSection();
    }
}

// Update referral UI based on state
function updateReferralUI() {
    const referralSection = document.getElementById('referral-section');
    const enterReferralSection = document.getElementById('enter-referral-section');
    const referralUsedSection = document.getElementById('referral-used-section');
    const noReferralCode = document.getElementById('no-referral-code');
    const hasReferralCode = document.getElementById('has-referral-code');
    const yourReferralCode = document.getElementById('your-referral-code');
    const referralCount = document.getElementById('referral-count');
    const usedReferralCode = document.getElementById('used-referral-code');

    if (!referralSection) return;

    // Update referral count
    if (referralCount) {
        referralCount.textContent = userReferralCount;
    }

    // Show/hide enter referral section based on whether user already used one
    if (userReferredBy) {
        // User has already used a referral code
        if (enterReferralSection) enterReferralSection.classList.add('hidden');
        if (referralUsedSection) {
            referralUsedSection.classList.remove('hidden');
            if (usedReferralCode) usedReferralCode.textContent = userReferredBy;
        }
    } else {
        // User can still enter a referral code
        if (enterReferralSection) enterReferralSection.classList.remove('hidden');
        if (referralUsedSection) referralUsedSection.classList.add('hidden');
    }

    // Show/hide generate code section based on whether user has a code
    if (userReferralCode) {
        if (noReferralCode) noReferralCode.classList.add('hidden');
        if (hasReferralCode) hasReferralCode.classList.remove('hidden');
        if (yourReferralCode) yourReferralCode.textContent = userReferralCode;
    } else {
        if (noReferralCode) noReferralCode.classList.remove('hidden');
        if (hasReferralCode) hasReferralCode.classList.add('hidden');
    }
}

// Show referral section
function showReferralSection() {
    const referralSection = document.getElementById('referral-section');
    if (referralSection) {
        referralSection.classList.remove('hidden');
    }
}

// Hide referral section
function hideReferralSection() {
    const referralSection = document.getElementById('referral-section');
    if (referralSection) {
        referralSection.classList.add('hidden');
    }
}

// Generate referral code
async function generateReferralCode() {
    if (!userWallet) {
        alert('Please connect your wallet first!');
        return;
    }

    const generateBtn = document.getElementById('generate-referral-btn');
    if (generateBtn) {
        generateBtn.disabled = true;
        generateBtn.textContent = 'GENERATING...';
    }

    try {
        const response = await fetch(`${API_BASE_URL}/api/referral/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ wallet: userWallet, xUsername: userXAccount })
        });

        const result = await response.json();

        if (result.success) {
            userReferralCode = result.referralCode;
            updateReferralUI();
            alert(`Your referral code: ${result.referralCode}`);
        } else {
            alert('Failed to generate referral code: ' + (result.error || 'Unknown error'));
        }

    } catch (error) {
        console.error('Failed to generate referral code:', error);
        alert('Failed to generate referral code. Please try again.');
    } finally {
        if (generateBtn) {
            generateBtn.disabled = false;
            generateBtn.textContent = 'GENERATE CODE';
        }
    }
}

// Use (enter) a referral code
async function useReferralCode() {
    if (!userWallet) {
        alert('Please connect your wallet first!');
        return;
    }

    const input = document.getElementById('referral-code-input');
    const statusEl = document.getElementById('referral-input-status');
    const referralCode = input ? input.value.trim().toUpperCase() : '';

    if (!referralCode) {
        if (statusEl) {
            statusEl.textContent = 'Please enter a referral code';
            statusEl.className = 'text-xs text-red-400 mt-2';
        }
        return;
    }

    if (referralCode.length !== 8) {
        if (statusEl) {
            statusEl.textContent = 'Referral code must be 8 characters';
            statusEl.className = 'text-xs text-red-400 mt-2';
        }
        return;
    }

    const useBtn = document.getElementById('use-referral-btn');
    if (useBtn) {
        useBtn.disabled = true;
        useBtn.textContent = 'SUBMITTING...';
    }

    try {
        const response = await fetch(`${API_BASE_URL}/api/referral/use`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                wallet: userWallet,
                referralCode: referralCode
            })
        });

        const result = await response.json();

        if (result.success) {
            userReferredBy = referralCode;
            updateReferralUI();
            if (statusEl) {
                statusEl.textContent = result.message;
                statusEl.className = 'text-xs text-green-400 mt-2';
            }
            if (input) input.value = '';
        } else {
            if (statusEl) {
                statusEl.textContent = result.error || 'Failed to use referral code';
                statusEl.className = 'text-xs text-red-400 mt-2';
            }
        }

    } catch (error) {
        console.error('Failed to use referral code:', error);
        if (statusEl) {
            statusEl.textContent = 'Failed to use referral code. Please try again.';
            statusEl.className = 'text-xs text-red-400 mt-2';
        }
    } finally {
        if (useBtn) {
            useBtn.disabled = false;
            useBtn.textContent = 'SUBMIT';
        }
    }
}

// Copy referral code to clipboard
async function copyReferralCode() {
    if (!userReferralCode) return;

    try {
        await navigator.clipboard.writeText(userReferralCode);

        const copyIcon = document.getElementById('copy-icon');
        const copyText = document.getElementById('copy-text');

        if (copyIcon) copyIcon.textContent = '✅';
        if (copyText) copyText.textContent = 'COPIED!';

        setTimeout(() => {
            if (copyIcon) copyIcon.textContent = '📋';
            if (copyText) copyText.textContent = 'COPY';
        }, 2000);

    } catch (error) {
        console.error('Failed to copy:', error);
        alert('Failed to copy. Your code is: ' + userReferralCode);
    }
}

// Auto-uppercase input as user types
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('referral-code-input');
    if (input) {
        input.addEventListener('input', (e) => {
            e.target.value = e.target.value.toUpperCase();
        });
    }
});

