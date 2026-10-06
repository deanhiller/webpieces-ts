/**
 * The architecture page's shell (#1155): a collapsible dark drawer on the left holding every control,
 * and the graph filling the rest of the viewport.
 *
 * Before this, two hint paragraphs, a ~650px three-column legend, a lock dropdown and a zoom bar all
 * sat ABOVE the graph, so a laptop's first screen showed no graph at all. Now the hints are a "?"
 * popover, the legend lives in the drawer (and can pop out over the graph), zoom floats bottom-right
 * (graph-navigation.ts) and the responsibilities open in a right-hand panel.
 *
 * Markup only. Behaviour is graph-visualizer.client.ts; styling is graph-page-styles.ts. No element
 * carries a `style=` attribute — every look is a class.
 */

import { GRAPH_MODES, GraphMode, ModeInfo } from './graph-color-modes';

/** Everything the shell frames, already rendered by its owner. */
export class ShellParts {
    constructor(
        public readonly title: string,
        public readonly lockControl: string,
        public readonly legend: string,
        public readonly edgeKey: string,
        public readonly filterStatus: string,
        public readonly snapshot: string,
        public readonly responsibilities: string,
    ) {}
}

export class GraphPageShell {
    body(parts: ShellParts): string {
        return `<div class="wp-shell" id="wp-shell">
    ${this.drawer(parts)}
    <main class="wp-main">
        ${this.topbar(parts)}
        <div id="graph"></div>
        ${this.overlays(parts)}
    </main>
</div>`;
    }

    private drawer(parts: ShellParts): string {
        return `<aside class="wp-side" id="wp-side" aria-label="Graph controls">
        <div class="wp-brand">${this.brandIcon()}<span>${parts.title}</span></div>
        <div class="wp-group" role="group" aria-label="Color mode">
            <div class="wp-label">Color by</div>
            <div class="wp-modes">${GRAPH_MODES.map((info: ModeInfo, index: number): string => this.modeItem(info, index)).join('')}</div>
            <p class="wp-mode-reason" id="wp-impact-reason" hidden></p>
        </div>
        <div class="wp-group">
            <label class="wp-label" for="wp-lock">Focus</label>
            ${parts.lockControl}
            <button type="button" class="wp-toggle" id="wp-filter-toggle" aria-pressed="false">Hide unconnected <span class="wp-sw" aria-hidden="true"></span></button>
        </div>
        <div class="wp-group">
            <div class="wp-label wp-label-row">Legend <button type="button" class="wp-icon wp-icon-mini wp-icon-dark" id="wp-legend-pop" title="Pop the legend out over the graph" aria-label="Pop the legend out over the graph">⇱</button></div>
            ${parts.legend}
        </div>
        <div class="wp-group">
            <div class="wp-label">Edges</div>
            ${parts.edgeKey}
        </div>
        <div class="wp-foot">
            <button type="button" class="wp-link" id="wp-resp-open" aria-expanded="false">Responsibilities</button>
            <button type="button" class="wp-link" id="wp-snapshot-open" aria-expanded="false">Saved snapshot</button>
        </div>
    </aside>`;
    }

    /** A stacked two-line item: the mode's name, then its grey subtitle. Keys 1/2/3 select them. */
    private modeItem(info: ModeInfo, index: number): string {
        const pressed = info.mode === GraphMode.RUNTIME ? 'true' : 'false';
        return (
            `<button type="button" class="wp-mode" data-wp-mode="${info.mode}" aria-pressed="${pressed}" title="Key ${index + 1}">` +
            `<span class="wp-mode-name">${info.name}</span><span class="wp-mode-sub">${info.subtitle}</span></button>`
        );
    }

    private topbar(parts: ShellParts): string {
        return `<div class="wp-topbar">
            <button type="button" class="wp-icon" id="wp-collapse" aria-label="Toggle the controls drawer" aria-controls="wp-side" aria-expanded="true">☰</button>
            <div class="wp-crumb" id="wp-crumb">Mode: <b>Runtime</b></div>
            ${parts.filterStatus}
            <button type="button" class="wp-icon" id="wp-help-btn" aria-label="How to read this graph" aria-controls="wp-help" aria-expanded="false">?</button>
        </div>`;
    }

    private overlays(parts: ShellParts): string {
        return `<div class="wp-pop wp-legend-popout" id="wp-legend-popout" hidden>
            <header><span id="wp-legend-pop-title">Legend · Runtime</span><button type="button" class="wp-icon wp-icon-mini" id="wp-legend-close" aria-label="Close the legend">✕</button></header>
            ${parts.legend}
        </div>
        ${this.help()}
        <div class="wp-pop wp-snapshot" id="wp-snapshot" hidden>${parts.snapshot}</div>
        <aside class="wp-panel" id="wp-resp-panel" aria-label="Responsibilities" hidden>
            <header><span>Responsibilities</span><button type="button" class="wp-icon wp-icon-mini" id="wp-resp-close" aria-label="Close responsibilities">✕</button></header>
            ${parts.responsibilities}
        </aside>`;
    }

    /** The two hint paragraphs that used to sit above the graph, plus the keyboard shortcuts. */
    private help(): string {
        return `<div class="wp-pop wp-help" id="wp-help" role="dialog" aria-label="How to read this graph" hidden>
            <header><span>Reading the graph</span><button type="button" class="wp-icon wp-icon-mini" id="wp-help-close" aria-label="Close help">✕</button></header>
            <p>Every row is one dependency level: the HIGHEST level is the top row and L0, the foundation libraries, is always the bottom row. Transitive dependencies are allowed but not drawn.</p>
            <p>💡 <strong>Click any box</strong> for its menu: <strong>View Design</strong> (only where the project has a generated <strong>design.html</strong>, i.e. what the AI sees inside it), <strong>Lock/Unlock</strong> (the same lock as the Focus field), <strong>Filter Unconnected</strong> (removes unrelated boxes, keeping each L-number row) and <strong>Mode ▸</strong>.</p>
            <p>🔦 <strong>Hover any box</strong> to trace its <em>entire</em> dependency chain — every ancestor above it and every dependency below it, with the lines between — while the rest of the graph dims.</p>
            <p><strong>Runtime</strong>: a box may depend on a box carrying every color it has. <strong>Architecture</strong>: what each box is in the system. <strong>Impact</strong>: what this branch changed (amber) and what depends on it (amber outline).</p>
            <p><kbd>/</kbd> focus the lock search · <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> switch mode · <kbd>Esc</kbd> unlock</p>
        </div>`;
    }

    private brandIcon(): string {
        return (
            '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">' +
            '<rect x="1" y="1" width="8" height="6" rx="1.5" fill="none" stroke="#e9eaf0" stroke-width="1.6"/>' +
            '<rect x="13" y="1" width="8" height="6" rx="1.5" fill="none" stroke="#e9eaf0" stroke-width="1.6"/>' +
            '<rect x="7" y="15" width="8" height="6" rx="1.5" fill="none" stroke="#e9eaf0" stroke-width="1.6"/>' +
            '<path d="M5 7v4h12V7M11 11v4" fill="none" stroke="#e9eaf0" stroke-width="1.6"/></svg>'
        );
    }
}
