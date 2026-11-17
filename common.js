
// --- 1. MOUSE PHYSICS & ORB ---
const orb = document.getElementById('orb');
const cCircle = document.getElementById('c-circle');

let mouseX = 0, mouseY = 0;
let orbX = 0, orbY = 0;
let cX = 0, cY = 0;

document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
});

function animate() {
    if (orb) {
        // Orb follows slowly
        orbX += (mouseX - orbX) * 0.05;
        orbY += (mouseY - orbY) * 0.05;
        orb.style.transform = `translate(${orbX}px, ${orbY}px) translate(-50%, -50%)`;
    }

    if (cCircle) {
        // Cursor follows fast
        cX += (mouseX - cX) * 0.2;
        cY += (mouseY - cY) * 0.2;
        cCircle.style.transform = `translate(${cX}px, ${cY}px) translate(-50%, -50%)`;
    }

    requestAnimationFrame(animate);
}
animate();

// --- 2. MAGNETIC HOVER ---
// Re-run this if you add dynamic elements
function initMagnets() {
    const magnets = document.querySelectorAll('.magnet, .resume-item, .wall-item, .glass-pill');
    magnets.forEach(el => {
        el.addEventListener('mouseenter', () => {
            document.body.classList.add('hovering');
        });
        el.addEventListener('mouseleave', () => {
            document.body.classList.remove('hovering');
        });
    });
}
initMagnets();

// --- 3. THEME SWITCHER LOGIC ---
const themeDropdown = document.getElementById('theme-dropdown');
const themeLabel = document.getElementById('theme-label');
const themeMenu = document.getElementById('theme-menu');
const themes = {
    'default': 'DESIGNER',
    'terminal': 'HACKER',
    'acid': '???',
    'minimal': 'RESEARCHER'
};

// Try to load saved theme
const savedTheme = localStorage.getItem('theme') || 'default';
const initialTheme = themes[savedTheme] ? savedTheme : 'default';

// Apply initial theme
document.body.setAttribute('data-theme', initialTheme);
if (themeLabel) {
    themeLabel.innerText = `MODE: ${themes[initialTheme]}`;
}

// Handle dropdown menu clicks
if (themeMenu) {
    themeMenu.addEventListener('click', (e) => {
        const option = e.target.closest('[data-theme-option]');
        if (!option) return;
        
        const newTheme = option.getAttribute('data-theme-option');
        
        // Apply to body
        document.body.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        
        // Update label
        if (themeLabel) {
            themeLabel.innerText = `MODE: ${themes[newTheme]}`;
        }
    });
}

// --- 4. SCROLL REVEAL ---
const sections = document.querySelectorAll('section');
if (window.IntersectionObserver) {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
            }
        });
    }, { threshold: 0.1 });
    sections.forEach(sec => observer.observe(sec));
} else {
    sections.forEach(sec => sec.classList.add('visible'));
}

// --- 5. TIME (If element exists) ---
const timeEl = document.getElementById('time');
if (timeEl) {
    const updateTime = () => {
        const now = new Date();
        const day = now.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
        const time = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
        timeEl.innerText = `${day} ${time}`;
    };
    updateTime(); // Update immediately
    setInterval(updateTime, 1000);
}

// --- 6. PAGE TRANSITIONS ---
document.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link) return;

    const href = link.getAttribute('href');

    // Skip external links, anchors, and special links
    if (!href ||
        href.startsWith('#') ||
        href.startsWith('http') ||
        href.startsWith('mailto:') ||
        link.target === '_blank') {
        return;
    }

    // It's an internal link - intercept and fade out
    e.preventDefault();
    document.body.classList.add('fade-out');

    setTimeout(() => {
        window.location.href = href;
    }, 300); // Match the fadeOut animation duration
});
