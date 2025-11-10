<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>$AMY - Amy Points</title>
    <link rel="icon" type="image/svg+xml" href="favicon.svg">
    <link rel="apple-touch-icon" href="pro.jpg">
    <link rel="preload" as="image" href="image.png">
    <link rel="stylesheet" href="tailwind-output.css">
    <link rel="stylesheet" href="style.css">
    <style>
        /* Critical CSS to prevent flash */
        body {
            background-color: #0891b2;
            margin: 0;
            padding: 0;
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

        @keyframes float {
            0%, 100% {
                transform: translateY(0px);
            }
            50% {
                transform: translateY(-20px);
            }
        }

        .float-animation {
            animation: float 3s ease-in-out infinite;
        }
    </style>
</head>
<body class="min-h-screen text-white relative">
    <div class="bg-pattern"></div>
    <div class="bg-overlay"></div>
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

            <!-- Dropdown Menu -->
            <div id="dropdown-menu" class="hidden fixed top-0 left-0 w-full h-full z-40 flex items-center justify-center md:justify-end transition-all duration-300" style="backdrop-filter: blur(10px); background-color: rgba(0, 0, 0, 0.85);">
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
        </header>

        <!-- Coming Soon Section -->
        <main class="flex-grow flex items-center justify-center px-4">
            <div class="max-w-2xl mx-auto text-center">
                <div class="info-box p-8 md:p-16">
                    <div class="text-6xl md:text-8xl mb-6 float-animation">⭐</div>
                    <h1 class="text-4xl md:text-6xl font-black mb-6 text-yellow-400">AMY POINTS</h1>
                    <p class="text-2xl md:text-3xl font-bold mb-4" style="color: #FF1493;">COMING SOON</p>
                    <!-- <p class="text-base md:text-xl text-gray-300 leading-relaxed">
                        Get ready for an innovative points system! Earn, accumulate, and redeem Amy Points for exclusive benefits and rewards.
                    </p> -->
                    <div class="mt-8">
                        <a href="index.php" class="btn-samy btn-samy-enhanced text-white px-8 py-3 rounded-full text-lg font-bold uppercase inline-block">
                            BACK TO HOME
                        </a>
                    </div>
                </div>
            </div>
        </main>

        <!-- Footer -->
        <footer class="container mx-auto px-4 py-8 md:py-12 text-center">
            <p class="text-yellow-300 text-sm md:text-lg font-medium">© 2025 $AMY Token. Built for the Berachain Community.</p>
        </footer>
    </div>

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
