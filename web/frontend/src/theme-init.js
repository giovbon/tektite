// Applies the persisted theme before styles paint, avoiding a flash of the
// wrong theme. Loaded synchronously from the document head.
(() => {
    let theme = 'dark';
    try {
        theme = localStorage.getItem('theme') === 'light' ? 'light' : 'dark';
    } catch {
        // localStorage can be unavailable in restricted browser modes.
    }
    document.documentElement.dataset.theme = theme;
    const syncThemeColor = () => {
        const meta = document.querySelector('meta[name="theme-color"]');
        const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
        if (meta && bg) meta.content = bg;
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', syncThemeColor, { once: true });
    } else {
        syncThemeColor();
    }
})();
