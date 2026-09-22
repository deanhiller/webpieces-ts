/**
 * The whole client script, as one string written to `site.js` beside the pages.
 *
 * It does THREE things, and the list is deliberately short: disclosure state, the language tabs and
 * the theme. Every URL in this site is already a file on disk, so routing, fetching and rendering
 * are not its job — with JS off the page still reads, only the tabs stop switching and every sample
 * is visible at once, which is a worse page rather than a blank one.
 */
export class SiteScript {
    static readonly JS = `
(function () {
    var KEY = 'webpieces-docs-theme';
    var LANG = 'webpieces-docs-language';

    function readStored(key) {
        // Reading storage THROWS in a private window, so every access is guarded at the boundary.
        // webpieces-disable no-unmanaged-exceptions -- this IS the boundary; the page must read with storage unavailable
        try {
            return window.localStorage.getItem(key);
        } catch (err) {
            return null;
        }
    }

    function store(key, value) {
        // webpieces-disable no-unmanaged-exceptions -- same boundary, writing; a refused write is not an error here
        try {
            window.localStorage.setItem(key, value);
        } catch (err) {
            /* a private window refuses storage; the page works without it */
        }
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        store(KEY, theme);
    }

    function selectLanguage(id) {
        var tabs = document.querySelectorAll('.tab');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].setAttribute('aria-selected', tabs[i].getAttribute('data-language') === id ? 'true' : 'false');
        }
        var samples = document.querySelectorAll('.sample');
        for (var j = 0; j < samples.length; j++) {
            samples[j].hidden = samples[j].getAttribute('data-language') !== id;
        }
        store(LANG, id);
    }

    document.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.getAttribute) {
            return;
        }
        if (target.classList.contains('tab')) {
            selectLanguage(target.getAttribute('data-language'));
        }
        if (target.classList.contains('collapse-all')) {
            var open = document.querySelectorAll('.pane-body details[open]');
            for (var i = 0; i < open.length; i++) {
                open[i].open = false;
            }
        }
        if (target.classList.contains('theme-toggle')) {
            applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
        }
    });

    var storedTheme = readStored(KEY);
    if (storedTheme) {
        applyTheme(storedTheme);
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        applyTheme('dark');
    }

    var storedLanguage = readStored(LANG);
    if (storedLanguage && document.querySelector('.tab[data-language="' + storedLanguage + '"]')) {
        selectLanguage(storedLanguage);
    }
})();
`;
}
