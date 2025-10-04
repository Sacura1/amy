// Animated counter function
function animateCounter(elementId, target, duration = 2000) {
    const element = document.getElementById(elementId);
    const startValue = 0;
    const increment = target / (duration / 16);
    let currentValue = startValue;

    const timer = setInterval(() => {
        currentValue += increment;
        if (currentValue >= target) {
            currentValue = target;
            clearInterval(timer);
        }
        element.textContent = Math.floor(currentValue).toLocaleString() + '+';
    }, 16);
}

// Floating animation for emojis
function createFloatingEmoji() {
    const emojis = ['🚀', '💎', '🌙', '⭐', '✨', '🔥', '💰', '🎉'];
    const emoji = document.createElement('div');
    emoji.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    emoji.style.position = 'fixed';
    emoji.style.left = Math.random() * 100 + 'vw';
    emoji.style.top = '100vh';
    emoji.style.fontSize = '2rem';
    emoji.style.opacity = '0.7';
    emoji.style.pointerEvents = 'none';
    emoji.style.zIndex = '1000';
    emoji.style.transition = 'all 4s ease-in';

    document.body.appendChild(emoji);

    setTimeout(() => {
        emoji.style.top = '-10vh';
        emoji.style.opacity = '0';
    }, 100);

    setTimeout(() => {
        emoji.remove();
    }, 4100);
}

// Smooth scroll for navigation
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

// Random stats updater (simulated live data)
function updateStats() {
    const holders = document.getElementById('holders');
    const marketcap = document.getElementById('marketcap');
    const volume = document.getElementById('volume');

    if (holders) {
        const baseHolders = 10000;
        const variance = Math.floor(Math.random() * 100);
        holders.textContent = (baseHolders + variance).toLocaleString() + '+';
    }

    if (marketcap) {
        const baseMC = 1000000;
        const variance = Math.floor(Math.random() * 50000);
        marketcap.textContent = '$' + ((baseMC + variance) / 1000000).toFixed(2) + 'M+';
    }

    if (volume) {
        const baseVol = 500000;
        const variance = Math.floor(Math.random() * 30000);
        volume.textContent = '$' + ((baseVol + variance) / 1000).toFixed(0) + 'K+';
    }
}

// Particle effect on button clicks
function createParticles(x, y) {
    for (let i = 0; i < 8; i++) {
        const particle = document.createElement('div');
        particle.textContent = '✨';
        particle.style.position = 'fixed';
        particle.style.left = x + 'px';
        particle.style.top = y + 'px';
        particle.style.pointerEvents = 'none';
        particle.style.zIndex = '1000';
        particle.style.fontSize = '1rem';

        const angle = (Math.PI * 2 * i) / 8;
        const velocity = 100;
        const vx = Math.cos(angle) * velocity;
        const vy = Math.sin(angle) * velocity;

        document.body.appendChild(particle);

        particle.style.transition = 'all 1s ease-out';
        setTimeout(() => {
            particle.style.transform = `translate(${vx}px, ${vy}px)`;
            particle.style.opacity = '0';
        }, 10);

        setTimeout(() => particle.remove(), 1000);
    }
}

// Add click effects to buttons
document.querySelectorAll('button').forEach(button => {
    button.addEventListener('click', function(e) {
        createParticles(e.clientX, e.clientY);
    });
});

// Initialize animations on page load
window.addEventListener('load', () => {
    // Update stats periodically
    updateStats();
    setInterval(updateStats, 5000);

    // Create floating emojis periodically
    setInterval(createFloatingEmoji, 2000);

    // Initial burst of emojis
    for (let i = 0; i < 5; i++) {
        setTimeout(createFloatingEmoji, i * 400);
    }
});

// Add scroll reveal animation
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -100px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
        }
    });
}, observerOptions);

// Observe all sections
document.querySelectorAll('section').forEach(section => {
    section.style.opacity = '0';
    section.style.transform = 'translateY(50px)';
    section.style.transition = 'all 0.6s ease-out';
    observer.observe(section);
});

// Copy contract address function
function copyCA() {
    const ca = '0x098a75bAedDEc78f9A8D0830d6B86eAc5cC8894e';
    navigator.clipboard.writeText(ca).then(() => {
        const btn = event.target;
        const originalText = btn.textContent;
        btn.textContent = 'COPIED!';
        btn.style.background = '#10B981';
        setTimeout(() => {
            btn.textContent = originalText;
            btn.style.background = '#EAB308';
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy:', err);
    });
}

console.log('🚀 $AMY website loaded! To the moon! 🌙');
