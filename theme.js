(function () {
    // 1. Check preference immediately to prevent flash
    const theme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    if (theme === 'dark' || (!theme && prefersDark)) {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }

    // 2. Setup toggle button when DOM is ready
    document.addEventListener('DOMContentLoaded', () => {
        const footer = document.querySelector('footer');
        if (footer) {
            // Add separator
            const sep = document.createElement('span');
            sep.className = 'sep';
            sep.textContent = '/';
            footer.appendChild(sep);

            // Add button
            const btn = document.createElement('button');
            btn.id = 'theme-toggle';
            footer.appendChild(btn);

            const updateText = () => {
                const isDark = document.documentElement.classList.contains('dark');
                btn.textContent = isDark ? 'Light' : 'Dark';
            };
            updateText();

            btn.addEventListener('click', () => {
                document.documentElement.classList.toggle('dark');
                const isDark = document.documentElement.classList.contains('dark');
                localStorage.setItem('theme', isDark ? 'dark' : 'light');
                updateText();
            });
        }
    });
})();
