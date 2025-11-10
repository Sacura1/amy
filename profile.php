<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>$AMY - Profile & Leaderboard</title>
    <link rel="icon" type="image/svg+xml" href="favicon.svg">
    <link rel="apple-touch-icon" href="pro.jpg">
    <link rel="stylesheet" href="tailwind-output.css">
    <link rel="stylesheet" href="style.css">
    <style>
        /* Enhanced Background with Image */
        body {
            background-color: #0891b2;
            margin: 0;
            padding: 0;
            min-height: 100vh;
            position: relative;
            overflow-x: hidden;
        }

        .bg-pattern {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-image: url('image.png');
            background-size: cover;
            background-position: center top;
            background-repeat: no-repeat;
            z-index: -2;
        }

        @media (max-width: 768px) {
            .bg-pattern {
                background-position: center center;
            }
        }

        .bg-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 255, 255, 0.8);
            mix-blend-mode: multiply;
            z-index: -1;
        }

        /* Floating Meme Elements Background */
        .meme-bg {
            position: fixed;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 1;
            overflow: hidden;
        }

        .floating-meme {
            position: absolute;
            font-size: 2rem;
            animation: float 20s linear infinite;
            opacity: 0.1;
        }

        @keyframes float {
            from {
                transform: translateY(100vh) rotate(0deg);
                opacity: 0;
            }
            10% {
                opacity: 0.1;
            }
            90% {
                opacity: 0.1;
            }
            to {
                transform: translateY(-100vh) rotate(360deg);
                opacity: 0;
            }
        }

        /* Enhanced Glass Card with Neon Glow */
        .glass-card {
            background: linear-gradient(135deg, rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.2));
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 2px solid rgba(255, 215, 0, 0.4);
            border-radius: 24px;
            box-shadow:
                0 8px 32px rgba(0, 0, 0, 0.4),
                inset 0 1px 0 rgba(255, 255, 255, 0.1),
                0 0 20px rgba(255, 215, 0, 0.1);
            transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            position: relative;
            overflow: hidden;
        }

        .glass-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.05), transparent);
            transition: left 0.7s ease;
        }

        .glass-card:hover::before {
            left: 100%;
        }

        .glass-card:hover {
            border-color: rgba(255, 215, 0, 0.6);
            transform: translateY(-4px) scale(1.02);
            box-shadow:
                0 15px 45px rgba(0, 0, 0, 0.5),
                inset 0 1px 0 rgba(255, 255, 255, 0.2),
                0 0 30px rgba(255, 215, 0, 0.2);
        }

        /* Enhanced Wallet Chip with Pulse Animation */
        .wallet-chip {
            background: linear-gradient(135deg, rgba(0, 0, 0, 0.5), rgba(255, 215, 0, 0.1));
            backdrop-filter: blur(15px);
            -webkit-backdrop-filter: blur(15px);
            border: 2px solid rgba(255, 215, 0, 0.5);
            border-radius: 9999px;
            padding: 0.5rem 1rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            position: relative;
            overflow: hidden;
            box-shadow: 0 4px 15px rgba(255, 215, 0, 0.1);
        }

        .wallet-chip::after {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 100%;
            height: 100%;
            border-radius: 9999px;
            border: 1px solid rgba(255, 215, 0, 0.6);
            transform: translate(-50%, -50%);
            opacity: 0;
            transition: all 0.6s;
        }

        .wallet-chip:hover {
            border-color: rgba(255, 215, 0, 0.8);
            background: linear-gradient(135deg, rgba(0, 0, 0, 0.6), rgba(255, 215, 0, 0.2));
            transform: scale(1.05);
            box-shadow: 0 6px 20px rgba(255, 215, 0, 0.3);
        }

        .wallet-chip:hover::after {
            width: 120%;
            height: 120%;
            opacity: 1;
        }

        /* Enhanced Connection Status with Ripple Effect */
        .connection-status {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            display: inline-block;
            animation: pulse 2s infinite;
            position: relative;
        }

        .connection-status::after {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 20px;
            height: 20px;
            border-radius: 50%;
            transform: translate(-50%, -50%);
            animation: ripple 2s infinite;
        }

        .status-connected {
            background: #10b981;
            box-shadow: 0 0 15px rgba(16, 185, 129, 0.6);
        }

        .status-connected::after {
            border: 2px solid rgba(16, 185, 129, 0.3);
        }

        .status-disconnected {
            background: #6b7280;
            animation: none;
        }

        @keyframes pulse {
            0%, 100% {
                opacity: 1;
                transform: scale(1);
            }
            50% {
                opacity: 0.8;
                transform: scale(1.1);
            }
        }

        @keyframes ripple {
            0% {
                width: 10px;
                height: 10px;
                opacity: 1;
            }
            100% {
                width: 30px;
                height: 30px;
                opacity: 0;
            }
        }

        /* Enhanced Icon Badges with 3D Effect */
        .icon-badge {
            width: 56px;
            height: 56px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(145deg, rgba(255, 215, 0, 0.3), rgba(255, 165, 0, 0.1));
            border-radius: 16px;
            font-size: 28px;
            border: 2px solid rgba(255, 215, 0, 0.4);
            box-shadow:
                5px 5px 10px rgba(0, 0, 0, 0.3),
                -2px -2px 6px rgba(255, 255, 255, 0.05),
                inset 1px 1px 2px rgba(255, 255, 255, 0.1);
            transition: all 0.3s ease;
            position: relative;
        }

        .icon-badge:hover {
            transform: translateY(-2px) rotateZ(5deg);
            box-shadow:
                7px 7px 15px rgba(0, 0, 0, 0.4),
                -2px -2px 8px rgba(255, 255, 255, 0.1),
                inset 1px 1px 3px rgba(255, 255, 255, 0.2);
        }

        .icon-badge-small {
            width: 40px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(145deg, rgba(255, 215, 0, 0.3), rgba(255, 165, 0, 0.1));
            border-radius: 12px;
            font-size: 20px;
            border: 2px solid rgba(255, 215, 0, 0.4);
            box-shadow:
                3px 3px 8px rgba(0, 0, 0, 0.3),
                -1px -1px 4px rgba(255, 255, 255, 0.05);
            transition: all 0.3s ease;
        }

        .icon-badge-small:hover {
            transform: translateY(-1px) rotateZ(3deg);
        }

        @media (max-width: 768px) {
            .glass-card {
                border-radius: 16px;
            }

            .icon-badge {
                width: 48px;
                height: 48px;
                font-size: 24px;
            }

            .icon-badge-small {
                width: 36px;
                height: 36px;
                font-size: 18px;
            }

            .wallet-chip {
                padding: 0.4rem 0.8rem;
                font-size: 0.75rem;
            }
        }

        /* Enhanced Leaderboard Styles with Animations */
        .leaderboard-row {
            background: linear-gradient(135deg, rgba(0, 0, 0, 0.3), rgba(255, 215, 0, 0.05));
            border: 2px solid rgba(255, 215, 0, 0.3);
            border-radius: 16px;
            padding: 1rem;
            margin-bottom: 1rem;
            transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            position: relative;
            overflow: hidden;
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
        }

        .leaderboard-row::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 2px;
            background: linear-gradient(90deg, transparent, rgba(255, 215, 0, 0.6), transparent);
            transition: left 0.6s ease;
        }

        .leaderboard-row:hover {
            background: linear-gradient(135deg, rgba(0, 0, 0, 0.4), rgba(255, 215, 0, 0.1));
            border-color: rgba(255, 215, 0, 0.5);
            transform: translateX(8px) scale(1.02);
            box-shadow: 0 8px 25px rgba(0, 0, 0, 0.3);
        }

        .leaderboard-row:hover::before {
            left: 100%;
        }

        /* Add entrance animation for leaderboard rows */
        @keyframes slideInFromLeft {
            from {
                opacity: 0;
                transform: translateX(-30px);
            }
            to {
                opacity: 1;
                transform: translateX(0);
            }
        }

        .leaderboard-row {
            animation: slideInFromLeft 0.6s ease forwards;
            opacity: 0;
        }

        .leaderboard-row:nth-child(1) { animation-delay: 0.1s; }
        .leaderboard-row:nth-child(2) { animation-delay: 0.2s; }
        .leaderboard-row:nth-child(3) { animation-delay: 0.3s; }
        .leaderboard-row:nth-child(4) { animation-delay: 0.4s; }
        .leaderboard-row:nth-child(5) { animation-delay: 0.5s; }

        /* Enhanced Position Badges with Shine Effect */
        .position-badge {
            width: 48px;
            height: 48px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, rgba(255, 215, 0, 0.3), rgba(255, 165, 0, 0.3));
            border-radius: 12px;
            font-size: 20px;
            font-weight: bold;
            border: 2px solid rgba(255, 215, 0, 0.4);
            position: relative;
            transition: all 0.3s ease;
            box-shadow: 0 4px 10px rgba(0, 0, 0, 0.2);
        }

        .position-badge:hover {
            transform: rotateY(360deg);
            transition: transform 0.8s ease;
        }

        .position-1 {
            background: linear-gradient(135deg, #FFD700, #FFC700, #FFA500);
            border: 3px solid #FFD700;
            color: #000;
            font-size: 24px;
            animation: goldShine 3s infinite;
            box-shadow:
                0 0 20px rgba(255, 215, 0, 0.5),
                inset 0 1px 3px rgba(255, 255, 255, 0.4);
        }

        @keyframes goldShine {
            0%, 100% {
                box-shadow:
                    0 0 20px rgba(255, 215, 0, 0.5),
                    inset 0 1px 3px rgba(255, 255, 255, 0.4);
            }
            50% {
                box-shadow:
                    0 0 30px rgba(255, 215, 0, 0.8),
                    inset 0 1px 5px rgba(255, 255, 255, 0.6);
            }
        }

        .position-2 {
            background: linear-gradient(135deg, #E8E8E8, #C0C0C0, #A8A8A8);
            border: 3px solid #C0C0C0;
            color: #000;
            box-shadow:
                0 0 15px rgba(192, 192, 192, 0.5),
                inset 0 1px 2px rgba(255, 255, 255, 0.3);
        }

        .position-3 {
            background: linear-gradient(135deg, #CD7F32, #B87333, #A0522D);
            border: 3px solid #CD7F32;
            color: #fff;
            box-shadow:
                0 0 15px rgba(205, 127, 50, 0.5),
                inset 0 1px 2px rgba(255, 255, 255, 0.2);
        }

        .status-eligible {
            background: linear-gradient(135deg, rgba(16, 185, 129, 0.2), rgba(5, 150, 105, 0.2));
            border: 2px solid #10b981;
            color: #10b981;
            padding: 0.25rem 0.75rem;
            border-radius: 9999px;
            font-size: 0.75rem;
            font-weight: bold;
        }

        .status-ineligible {
            background: linear-gradient(135deg, rgba(239, 68, 68, 0.2), rgba(220, 38, 38, 0.2));
            border: 2px solid #ef4444;
            color: #ef4444;
            padding: 0.25rem 0.75rem;
            border-radius: 9999px;
            font-size: 0.75rem;
            font-weight: bold;
        }

        .hero-text {
            background: linear-gradient(135deg, #FFD700 0%, #FFA500 50%, #FFD700 100%);
            background-size: 200% auto;
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            animation: textGradient 3s ease infinite;
            text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.1);
        }

        @keyframes textGradient {
            to {
                background-position: 200% center;
            }
        }

        /* Enhanced Button Styles */
        .btn-samy-enhanced {
            background: linear-gradient(135deg, #FF1493, #FF69B4);
            border: 3px solid #FFD700;
            box-shadow:
                0 6px 0 #8B008B,
                0 8px 15px rgba(0, 0, 0, 0.4),
                inset 0 1px 2px rgba(255, 255, 255, 0.3);
            transition: all 0.15s ease;
            position: relative;
            overflow: hidden;
            text-transform: uppercase;
            font-weight: bold;
        }

        .btn-samy-enhanced::before {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 0;
            height: 0;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.3);
            transform: translate(-50%, -50%);
            transition: width 0.6s, height 0.6s;
        }

        .btn-samy-enhanced:hover::before {
            width: 300px;
            height: 300px;
        }

        .btn-samy-enhanced:hover {
            transform: translateY(3px);
            box-shadow:
                0 3px 0 #8B008B,
                0 5px 10px rgba(0, 0, 0, 0.3),
                inset 0 1px 3px rgba(255, 255, 255, 0.4);
        }

        .btn-samy-enhanced:active {
            transform: translateY(6px);
            box-shadow:
                0 0 0 #8B008B,
                0 2px 5px rgba(0, 0, 0, 0.2),
                inset 0 1px 3px rgba(0, 0, 0, 0.2);
        }

        /* Loading Spinner */
        .loading-spinner {
            border: 3px solid rgba(255, 215, 0, 0.3);
            border-top: 3px solid #FFD700;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        /* Skeleton Loading */
        .skeleton-loader {
            background: linear-gradient(90deg, rgba(255, 255, 255, 0.05) 25%, rgba(255, 255, 255, 0.1) 50%, rgba(255, 255, 255, 0.05) 75%);
            background-size: 200% 100%;
            animation: loading 1.5s infinite;
        }

        @keyframes loading {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }

        /* Mobile Touch Feedback */
        @media (hover: none) {
            .glass-card:active {
                transform: scale(0.98);
            }

            .btn-samy-enhanced:active {
                transform: scale(0.95) translateY(2px);
            }
        }

        /* Custom Scrollbar */
        .custom-scrollbar::-webkit-scrollbar {
            width: 8px;
        }

        .custom-scrollbar::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.3);
            border-radius: 10px;
        }

        .custom-scrollbar::-webkit-scrollbar-thumb {
            background: linear-gradient(135deg, rgba(255, 215, 0, 0.5), rgba(255, 165, 0, 0.5));
            border-radius: 10px;
            border: 2px solid rgba(0, 0, 0, 0.3);
        }

        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
            background: linear-gradient(135deg, rgba(255, 215, 0, 0.7), rgba(255, 165, 0, 0.7));
        }

        /* Entrance Animations */
        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        @keyframes scaleIn {
            from {
                opacity: 0;
                transform: scale(0.9);
            }
            to {
                opacity: 1;
                transform: scale(1);
            }
        }

        /* Enhanced Input Focus */
        input:focus {
            box-shadow: 0 0 0 3px rgba(255, 215, 0, 0.2);
        }

        /* Trophy Icons Animation */
        @keyframes trophyBounce {
            0%, 100% {
                transform: translateY(0);
            }
            50% {
                transform: translateY(-10px);
            }
        }

        .trophy-bounce {
            animation: trophyBounce 2s ease-in-out infinite;
        }

        @media (max-width: 768px) {
            .position-badge {
                width: 36px;
                height: 36px;
                font-size: 16px;
            }

            .position-1 {
                font-size: 18px;
            }
        }
    </style>
</head>
<body class="min-h-screen text-white relative">
    <!-- Background Image -->
    <div class="bg-pattern"></div>
    <div class="bg-overlay"></div>

    <!-- Floating Meme Background -->
    <div class="meme-bg" id="memeBg"></div>

    <div class="relative z-10 min-h-screen flex flex-col">
        <!-- Header -->
        <header class="container mx-auto px-4 py-4 md:py-6">
            <nav class="flex justify-between items-center">
                <!-- Mobile: Hamburger + Logo -->
                <div class="flex items-center gap-3 md:hidden">
                    <!-- Hamburger Menu Button (Mobile Only) -->
                    <button id="menu-toggle" class="text-white focus:outline-none z-50">
                        <div id="hamburger-lines" class="space-y-2">
                            <span class="block w-8 h-1 bg-yellow-400 transition-all duration-300"></span>
                            <span class="block w-8 h-1 bg-yellow-400 transition-all duration-300"></span>
                            <span class="block w-8 h-1 bg-yellow-400 transition-all duration-300"></span>
                        </div>
                    </button>
                    <a href="index.php" class="text-3xl font-bold text-shadow-strong">$AMY</a>
                </div>

                <!-- Desktop: Logo -->
                <a href="index.php" class="hidden md:block text-4xl font-bold text-shadow-strong">$AMY</a>

                <!-- Desktop: Nav Buttons + Menu -->
                <div class="hidden md:flex items-center gap-4">
                    <a href="index.php" class="btn-samy btn-samy-enhanced text-white px-8 py-3 rounded-full text-xl font-bold uppercase">
                        HOME
                    </a>
                    <a href="https://www.osito.finance/?token=0x098a75bAedDEc78f9A8D0830d6B86eAc5cC8894e" target="_blank" rel="noopener noreferrer" class="btn-samy btn-samy-enhanced text-white px-8 py-3 rounded-full text-xl font-bold uppercase">
                        BUY
                    </a>
                    <button id="menu-toggle-desktop" class="btn-samy btn-samy-enhanced text-white px-8 py-3 rounded-full text-xl font-bold uppercase">
                        MENU
                    </button>
                </div>

                <!-- Mobile: Home Button -->
                <a href="index.php" class="md:hidden btn-samy btn-samy-enhanced text-white px-4 py-2 rounded-full text-sm font-bold uppercase">
                    HOME
                </a>
            </nav>

            <!-- Wallet Chip -->
            <button onclick="connectWallet()" id="wallet-btn" class="wallet-chip mt-4">
                <span class="connection-status" id="wallet-status-indicator"></span>
                <span class="text-xs md:text-sm font-semibold" id="wallet-display">Connect Wallet</span>
            </button>

            <!-- Dropdown Menu -->
            <div id="dropdown-menu" class="hidden fixed top-0 left-0 w-full h-full z-40 items-center justify-center md:justify-end transition-all duration-300" style="backdrop-filter: blur(10px); background-color: rgba(0, 0, 0, 0.85);">
                <div class="md:mr-12 space-y-6">
                    <a href="profile.php" class="block btn-samy btn-samy-enhanced text-white px-12 py-4 rounded-full text-xl font-bold uppercase">
                        PROFILE
                    </a>
                    <a href="leaderboard.php" class="block btn-samy btn-samy-enhanced text-white px-12 py-4 rounded-full text-xl font-bold uppercase">
                        LEADERBOARD
                    </a>
                    <a href="earn.php" class="block btn-samy btn-samy-enhanced text-white px-12 py-4 rounded-full text-xl font-bold uppercase">
                        EARN ON BERA
                    </a>
                    <a href="points.php" class="block btn-samy btn-samy-enhanced text-white px-12 py-4 rounded-full text-xl font-bold uppercase">
                        AMY POINTS
                    </a>
                    <a href="https://www.osito.finance/?token=0x098a75bAedDEc78f9A8D0830d6B86eAc5cC8894e" target="_blank" rel="noopener noreferrer" class="block btn-samy btn-samy-enhanced text-white px-12 py-4 rounded-full text-xl font-bold uppercase">
                        BUY
                    </a>
                    <a href="contact.php" class="block btn-samy btn-samy-enhanced text-white px-12 py-4 rounded-full text-xl font-bold uppercase">
                        CONTACT
                    </a>
                </div>
            </div>

            <!-- Wallet Balance (shows when connected) - REDESIGNED -->
            <div id="balance-info" class="mt-6 hidden">
                <div class="glass-card p-4 md:p-6">
                    <div class="flex items-center justify-between gap-4">
                        <div class="flex items-center gap-3">
                            <div class="icon-badge-small">
                                💰
                            </div>
                            <div>
                                <div class="text-xs text-gray-400 uppercase tracking-wider font-semibold mb-1">Your Holdings</div>
                                <div class="text-lg md:text-xl text-yellow-300 font-bold">$AMY Balance</div>
                            </div>
                        </div>
                        <div class="text-right">
                            <div id="amy-balance" class="text-3xl md:text-4xl font-black hero-text" style="font-size: 2.5rem; line-height: 1;">
                                0.00
                            </div>
                            <div class="text-xs text-gray-400 mt-1">tokens</div>
                        </div>
                    </div>
                    <div class="mt-4 pt-4 border-t border-yellow-400/20">
                        <div class="flex items-center justify-between text-xs md:text-sm">
                            <span class="text-gray-400">Minimum Required:</span>
                            <span class="text-yellow-300 font-bold">300 $AMY</span>
                        </div>
                    </div>
                </div>
            </div>
        </header>

        <!-- Main Content -->
        <main class="flex-grow container mx-auto px-4 py-12 md:py-24">
            <div class="max-w-2xl mx-auto">

                <!-- X Account Connection Card -->
                <div class="glass-card p-4 md:p-6">
                    <div class="flex items-center justify-between gap-3 flex-wrap md:flex-nowrap">
                        <div class="flex items-center gap-3 flex-1 min-w-[200px]">
                            <div class="icon-badge-small flex-shrink-0">
                                𝕏
                            </div>
                            <div class="flex-1">
                                <div class="flex items-center gap-2 mb-1">
                                    <span class="connection-status" id="x-status-indicator"></span>
                                    <h3 class="text-lg md:text-xl font-bold text-yellow-400">X Account</h3>
                                </div>
                                <p class="text-xs text-gray-300" id="x-status">Not connected</p>
                                <p class="text-sm text-gray-200 mt-1 font-semibold" id="x-username"></p>
                            </div>
                        </div>
                        <button onclick="connectX()" id="x-btn" class="btn-samy btn-samy-enhanced text-white px-4 md:px-6 py-2 md:py-3 rounded-full text-sm md:text-base font-bold uppercase w-full md:w-auto">
                            CONNECT
                        </button>
                    </div>
                </div>

                <!-- Eligibility Status (Shows when both wallet and X are connected) -->
                <div id="eligibility-section" class="glass-card p-6 md:p-8 mt-6 hidden">
                    <div class="text-center">
                        <div class="icon-badge mx-auto mb-4" id="eligibility-icon">
                            ✅
                        </div>
                        <h3 class="text-xl md:text-2xl font-bold mb-2" id="eligibility-title">Checking Status...</h3>
                        <p class="text-xs md:text-sm text-gray-300" id="eligibility-message"></p>
                    </div>
                </div>

                <!-- Admin Download Section (Hidden by default) - REDESIGNED -->
                <div id="admin-section" class="glass-card mt-6 hidden overflow-hidden">
                    <div class="bg-gradient-to-r from-purple-900/30 to-pink-900/30 p-3 md:p-6 border-b border-yellow-400/30">
                        <div class="flex items-center gap-2 md:gap-3">
                            <div class="icon-badge-small md:w-14 md:h-14">
                                📊
                            </div>
                            <div>
                                <h3 class="text-lg md:text-3xl font-black text-yellow-400">Admin Panel</h3>
                                <p class="text-xs text-gray-300 mt-0.5 md:mt-1">🔐 Privileged Access</p>
                            </div>
                        </div>
                    </div>
                    <div class="p-3 md:p-8">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4 mb-4 md:mb-6">
                            <div class="bg-black/30 rounded-lg md:rounded-xl p-3 md:p-4 border border-yellow-400/20">
                                <div class="text-xs text-gray-400 uppercase tracking-wider mb-1">Total Verified</div>
                                <div class="text-xl md:text-2xl font-bold text-green-400">---</div>
                            </div>
                            <div class="bg-black/30 rounded-lg md:rounded-xl p-3 md:p-4 border border-yellow-400/20">
                                <div class="text-xs text-gray-400 uppercase tracking-wider mb-1">Eligible Users</div>
                                <div class="text-xl md:text-2xl font-bold text-yellow-400">---</div>
                            </div>
                        </div>
                        <button onclick="downloadSpreadsheet()" class="btn-samy btn-samy-enhanced text-white px-6 md:px-12 py-2.5 md:py-4 rounded-full text-xs md:text-lg font-bold uppercase w-full transition-all">
                            📥 DOWNLOAD SPREADSHEET
                        </button>
                    </div>
                </div>

                <!-- Admin Leaderboard Management (Hidden by default) - REDESIGNED -->
                <div id="admin-leaderboard-section" class="glass-card mt-6 hidden overflow-hidden">
                    <!-- Compact Header for Mobile -->
                    <div class="bg-gradient-to-r from-yellow-900/30 to-orange-900/30 p-3 md:p-6 border-b border-yellow-400/30">
                        <div class="flex items-center gap-2 md:gap-3">
                            <div class="icon-badge-small md:w-14 md:h-14">
                                🏆
                            </div>
                            <div>
                                <h3 class="text-lg md:text-3xl font-black text-yellow-400">Manage Leaderboard</h3>
                                <p class="text-xs text-gray-300 mt-0.5 md:mt-1">📋 Paste content to update</p>
                            </div>
                        </div>
                    </div>

                    <div class="p-3 md:p-8">
                        <!-- Paste Leaderboard Data - Compact Mobile -->
                        <div class="bg-gradient-to-br from-purple-900/20 to-blue-900/20 p-3 md:p-5 rounded-xl md:rounded-2xl mb-4 md:mb-6 border-2 border-purple-500/30 backdrop-blur-sm">
                            <div class="flex items-center gap-2 mb-3">
                                <span class="text-xl md:text-2xl">📋</span>
                                <h4 class="text-sm md:text-xl font-black text-purple-400">Paste Leaderboard Data</h4>
                            </div>
                            <p class="text-xs text-gray-300 mb-3">Paste the latest leaderboard data. Format: Name - @username</p>
                            <textarea id="leaderboard-paste-area"  rows="8" class="w-full px-3 py-2 md:px-4 md:py-3 rounded-lg md:rounded-xl bg-black/50 border-2 border-gray-600 text-white text-sm focus:border-purple-400 focus:outline-none transition-all placeholder-gray-500 font-mono"></textarea>
                            <button onclick="bulkUpdateLeaderboard()" class="mt-3 md:mt-4 bg-gradient-to-r from-purple-500 to-blue-500 text-white px-6 py-2.5 md:px-8 md:py-3 rounded-full text-xs md:text-base font-bold uppercase hover:from-purple-600 hover:to-blue-600 transition-all w-full shadow-lg hover:shadow-xl">
                                📤 UPDATE LEADERBOARD
                            </button>
                        </div>

                        <!-- Current Entries - Optimized for Mobile -->
                        <div class="bg-black/30 p-3 md:p-5 rounded-xl md:rounded-2xl border-2 border-yellow-400/30 backdrop-blur-sm">
                            <div class="flex items-center gap-2 mb-3">
                                <span class="text-lg md:text-2xl">📝</span>
                                <h4 class="text-sm md:text-xl font-black text-yellow-300">Current Entries</h4>
                            </div>
                            <div id="admin-leaderboard-list" class="max-h-64 md:max-h-96 overflow-y-auto custom-scrollbar">
                                <p class="text-gray-400 text-xs md:text-sm text-center py-4 md:py-8">Loading...</p>
                            </div>
                        </div>
                    </div>
                </div>

            </div>

        </main>

        <!-- Footer -->
        <footer class="container mx-auto px-4 py-6 md:py-8 text-center mt-auto">
            <p class="text-yellow-300 text-xs md:text-base font-medium">
                © 2025 $AMY Token. Built for the Berachain Community.
            </p>
        </footer>
    </div>

    <!-- Web3 Libraries -->
    <script src="https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.umd.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@walletconnect/web3-provider@1.8.0/dist/umd/index.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/web3modal@1.9.12/dist/index.js"></script>
    <script src="profile.js"></script>

    <!-- Enhanced Meme Animations -->
    <script>
        // Create floating meme elements
        function createFloatingMemes() {
            const memeBg = document.getElementById('memeBg');
            const memes = ['🚀', '💎', '🌙', '⭐', '✨', '🔥', '💰', '🎉', '🐻', '🍯', '🏆', '💸', '📈', '🎯', '🎮', '👾'];

            // Create 15 floating memes
            for (let i = 0; i < 15; i++) {
                const meme = document.createElement('div');
                meme.className = 'floating-meme';
                meme.textContent = memes[Math.floor(Math.random() * memes.length)];
                meme.style.left = Math.random() * 100 + '%';
                meme.style.animationDelay = Math.random() * 20 + 's';
                meme.style.animationDuration = (20 + Math.random() * 10) + 's';
                meme.style.fontSize = (1.5 + Math.random() * 1.5) + 'rem';
                memeBg.appendChild(meme);
            }
        }

        // Initialize on page load
        document.addEventListener('DOMContentLoaded', () => {
            createFloatingMemes();

            // Add entrance animation to main content
            const cards = document.querySelectorAll('.glass-card');
            cards.forEach((card, index) => {
                card.style.opacity = '0';
                card.style.transform = 'translateY(30px)';
                setTimeout(() => {
                    card.style.transition = 'all 0.8s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
                    card.style.opacity = '1';
                    card.style.transform = 'translateY(0)';
                }, index * 200);
            });

            // Add sparkle effect on button hover
            document.querySelectorAll('.btn-samy-enhanced').forEach(btn => {
                btn.addEventListener('mouseenter', (e) => {
                    createSparkle(e.target);
                });
            });

            // Add trophy bounce to header trophies
            setTimeout(() => {
                const trophies = document.querySelectorAll('.text-4xl.md\\:text-6xl');
                trophies.forEach((trophy, index) => {
                    if (trophy.textContent === '🏆') {
                        trophy.classList.add('trophy-bounce');
                        trophy.style.display = 'inline-block';
                        trophy.style.animationDelay = (index * 0.5) + 's';
                    }
                });
            }, 500);

            // Add smooth scroll behavior
            document.documentElement.style.scrollBehavior = 'smooth';
        });

        // Create sparkle effect
        function createSparkle(element) {
            const sparkle = document.createElement('span');
            sparkle.innerHTML = '✨';
            sparkle.style.position = 'absolute';
            sparkle.style.pointerEvents = 'none';
            sparkle.style.animation = 'sparkleFloat 1s ease-out forwards';
            sparkle.style.left = Math.random() * 100 + '%';
            sparkle.style.top = Math.random() * 100 + '%';
            sparkle.style.fontSize = '20px';
            element.style.position = 'relative';
            element.appendChild(sparkle);

            setTimeout(() => sparkle.remove(), 1000);
        }

        // Add sparkle animation
        const sparkleStyle = document.createElement('style');
        sparkleStyle.innerHTML = `
            @keyframes sparkleFloat {
                0% {
                    transform: translateY(0) scale(0);
                    opacity: 1;
                }
                100% {
                    transform: translateY(-50px) scale(1.5);
                    opacity: 0;
                }
            }
        `;
        document.head.appendChild(sparkleStyle);
    </script>

    <!-- Menu Toggle Script -->
    <script>
        // Menu toggle functionality
        const menuToggleMobile = document.getElementById('menu-toggle');
        const menuToggleDesktop = document.getElementById('menu-toggle-desktop');
        const dropdownMenu = document.getElementById('dropdown-menu');
        const hamburgerLines = document.getElementById('hamburger-lines');

        function toggleMenu() {
            const isHidden = dropdownMenu.classList.contains('hidden');

            if (isHidden) {
                // Open menu
                dropdownMenu.classList.remove('hidden');
                dropdownMenu.classList.add('animate-fadeIn');

                // Animate hamburger to X
                if (hamburgerLines) {
                    const spans = hamburgerLines.querySelectorAll('span');
                    spans[0].style.transform = 'rotate(45deg) translateY(12px)';
                    spans[1].style.opacity = '0';
                    spans[2].style.transform = 'rotate(-45deg) translateY(-12px)';
                }
            } else {
                // Close menu
                dropdownMenu.classList.add('hidden');
                dropdownMenu.classList.remove('animate-fadeIn');

                // Animate hamburger back to lines
                if (hamburgerLines) {
                    const spans = hamburgerLines.querySelectorAll('span');
                    spans[0].style.transform = 'none';
                    spans[1].style.opacity = '1';
                    spans[2].style.transform = 'none';
                }
            }
        }

        if (menuToggleMobile) {
            menuToggleMobile.addEventListener('click', toggleMenu);
        }

        if (menuToggleDesktop) {
            menuToggleDesktop.addEventListener('click', toggleMenu);
        }

        // Close menu when clicking outside
        dropdownMenu.addEventListener('click', (e) => {
            if (e.target === dropdownMenu) {
                toggleMenu();
            }
        });
    </script>
    <style>
        @keyframes fadeIn {
            from {
                opacity: 0;
            }
            to {
                opacity: 1;
            }
        }
        .animate-fadeIn {
            animation: fadeIn 0.3s ease-in-out;
        }
    </style>
</body>
</html>
