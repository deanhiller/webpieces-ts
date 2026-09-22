import { Html } from './Html';
import { NavGroup, NavLink, NavModel } from './NavModel';
import { SiteUrls } from './SiteUrls';

/**
 * The three-pane shell every page shares: the collapsible nav tree, the operation body, and the
 * sticky card column.
 *
 * Every link is RELATIVE and ends in `index.html`; {@link SiteUrls} carries that reasoning.
 */
export class Layout {
    private readonly html = new Html();

    constructor(
        private readonly nav: NavModel,
        private readonly urls: SiteUrls,
        private readonly siteTitle: string,
        private readonly siteVersion: string,
    ) {}

    /** One complete HTML document. `body` and `cards` are markup this package already rendered. */
    render(url: string, pageTitle: string, body: string, cards: string): string {
        const prefix = this.urls.prefixFor(url);
        return [
            '<!doctype html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="utf-8" />',
            '<meta name="viewport" content="width=device-width, initial-scale=1" />',
            `<title>${this.html.escape(pageTitle)} · ${this.html.escape(this.siteTitle)}</title>`,
            `<link rel="stylesheet" href="${prefix}styles.css" />`,
            '</head>',
            '<body>',
            '<div class="site">',
            this.navPane(prefix, url),
            `<main class="pane-body">${body}</main>`,
            `<aside class="pane-cards"><div class="pane-cards-inner">${cards}</div></aside>`,
            '</div>',
            `<script src="${prefix}site.js"></script>`,
            '</body>',
            '</html>',
            '',
        ].join('\n');
    }

    private navPane(prefix: string, current: string): string {
        const parts = [
            '<nav class="pane-nav">',
            `<a class="site-title" href="${prefix}${this.urls.home()}">${this.html.escape(this.siteTitle)}</a>`,
            `<div class="site-version">${this.html.escape(this.siteVersion)}</div>`,
            '<button class="theme-toggle" type="button">Theme</button>',
        ];
        for (const group of this.nav.groups) {
            parts.push(this.navGroup(group, prefix, current));
        }
        parts.push('</nav>');
        return parts.join('\n');
    }

    private navGroup(group: NavGroup, prefix: string, current: string): string {
        const open = group.links.some((link: NavLink): boolean => link.url === current);
        const items = group.links
            .map((link: NavLink): string => this.navLink(link, prefix, current))
            .join('');
        return `<details class="nav-group"${open ? ' open' : ''}><summary>${this.html.escape(group.title)}</summary><ul>${items}</ul></details>`;
    }

    private navLink(link: NavLink, prefix: string, current: string): string {
        const badge =
            link.badge === '' ? '' : `<span class="badge">${this.html.escape(link.badge)}</span>`;
        const marker = link.url === current ? ' class="current"' : '';
        return `<li><a href="${prefix}${link.url}"${marker}>${badge}<span>${this.html.escape(link.title)}</span></a></li>`;
    }
}
