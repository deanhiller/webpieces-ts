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

import { FRAMEWORK_ORDER, GRAPH_MODES, GraphMode, ModeInfo, ROLE_STYLES, RoleStyle } from './graph-color-modes';
import { ProductColor, ProductPalette } from './graph-products';

/**
 * The Filter popover's "Changes on this branch" choices. The page computes each set from the Impact
 * sidecar (graph-impact.ts): CHANGED = touched; DEPENDENTS = touched + affected (nx affected: their
 * tests re-run); DEPENDENCIES = touched + every transitive dependency of it; BUILD = touched +
 * affected + every build input — the dependencies of the DEPENDENTS too, which is why it is more than
 * the union of the two rows above it.
 *
 * "Dependents" are what USE a project and "dependencies" what it uses (#1179). "Dependee" would mean
 * the thing depended ON — the opposite of the dependents row — so it is never used.
 */
export enum ChangeScope {
    EVERYTHING = 'everything',
    CHANGED = 'changed',
    DEPENDENTS = 'dependents',
    DEPENDENCIES = 'dependencies',
    BUILD = 'build',
}

/**
 * One change scope: its name and the grey second line under it, like the Color-by menu. These are the
 * ONE copy of the labels — the page script reads each name back from its `data-wp-scope-label` (the
 * top-bar pill), so the two cannot drift apart.
 */
export class ScopeOption {
    constructor(
        public readonly scope: ChangeScope,
        public readonly label: string,
        public readonly subtitle: string,
    ) {}
}

export const SCOPE_OPTIONS: readonly ScopeOption[] = [
    new ScopeOption(ChangeScope.EVERYTHING, 'All', 'every project'),
    new ScopeOption(ChangeScope.CHANGED, 'Changed', 'owns a changed file'),
    new ScopeOption(ChangeScope.DEPENDENTS, 'Changed + dependents', '+ everything that uses them (their tests re-run)'),
    new ScopeOption(ChangeScope.DEPENDENCIES, 'Changed + dependencies', '+ everything they use'),
    new ScopeOption(ChangeScope.BUILD, 'Changed + dependents + dependencies', 'everything CI builds for this branch'),
];

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
        /** Every declared product, sorted (#1179); empty hides the Filter's Product group. */
        public readonly products: string[],
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
            ${this.modePulldown()}
            <p class="wp-mode-reason" id="wp-impact-reason" hidden></p>
            ${this.impactKinds('drawer')}
        </div>
        <div class="wp-group">
            <button type="button" class="wp-filter-btn" id="wp-filter-open" aria-controls="wp-filter-pop" aria-expanded="false"><span>Filter</span><span class="wp-badge" id="wp-filter-badge" hidden>0</span></button>
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

    /**
     * "Color by": ONE pill-shaped trigger showing the current mode (name + subtitle) that opens a
     * menu of the four. Keys 1/2/3/4 and the #runtime / #architecture / #impact / #product links still
     * switch.
     */
    private modePulldown(): string {
        const first = GRAPH_MODES[0];
        return `<div class="wp-pulldown">
                <button type="button" class="wp-pill-trigger" id="wp-mode-trigger" aria-haspopup="menu" aria-controls="wp-mode-menu" aria-expanded="false">
                    <span class="wp-pill-text"><span class="wp-mode-name" id="wp-mode-current">${first.name}</span><span class="wp-mode-sub" id="wp-mode-current-sub">${first.subtitle}</span></span><span class="wp-caret" aria-hidden="true">▾</span>
                </button>
                <div class="wp-menu" id="wp-mode-menu" role="menu" aria-label="Color by" hidden>${GRAPH_MODES.map((info: ModeInfo, index: number): string => this.modeItem(info, index)).join('')}</div>
            </div>`;
    }

    /** One menu option, two lines: the mode's name, then its grey subtitle. */
    private modeItem(info: ModeInfo, index: number): string {
        const checked = info.mode === GraphMode.RUNTIME ? 'true' : 'false';
        return (
            `<button type="button" class="wp-mode" role="menuitemradio" data-wp-mode="${info.mode}" aria-checked="${checked}" title="Key ${index + 1}">` +
            `<span class="wp-mode-name">${info.name}</span><span class="wp-mode-sub">${info.subtitle}</span></button>`
        );
    }

    /**
     * The Filter popover. Its four groups INTERSECT: a box is shown when it is in the chosen change
     * scope AND carries any selected runtime chip (when any is selected) AND any selected role chip
     * (when any is selected) AND belongs to any selected product (when any is selected). Nothing
     * applies until "Show N projects".
     */
    private filterPopover(products: string[]): string {
        const scopes = SCOPE_OPTIONS.map(
            (option: ScopeOption): string =>
                `<label class="wp-scope"><input type="radio" name="wp-scope" value="${option.scope}"${option.scope === ChangeScope.EVERYTHING ? ' checked' : ''}>` +
                `<span class="wp-scope-text"><span class="wp-scope-name" data-wp-scope-label="${option.scope}">${option.label}</span>` +
                `<span class="wp-scope-sub">${option.subtitle}</span></span>` +
                `<span class="wp-count" data-wp-scope-count="${option.scope}"></span></label>`,
        ).join('');
        const chips = (group: string, values: readonly string[]): string =>
            values
                .map(
                    (value: string): string =>
                        `<button type="button" class="wp-chip" data-wp-chip-group="${group}" data-wp-chip="${value}" aria-pressed="false">${value}</button>`,
                )
                .join('');
        return `<div class="wp-pop wp-filter-pop" id="wp-filter-pop" role="dialog" aria-label="Filter projects" hidden>
            <header><span>Filter</span><button type="button" class="wp-icon wp-icon-mini" id="wp-filter-close" aria-label="Close the filter">✕</button></header>
            <fieldset class="wp-fgroup" id="wp-scope-group"><legend id="wp-scope-legend">Changes on this branch</legend>${this.impactKinds('filter')}${scopes}<p class="wp-scope-reason" id="wp-scope-reason" hidden></p></fieldset>
            <fieldset class="wp-fgroup"><legend>Runtime <small>any match</small></legend><div class="wp-chips">${chips('runtime', FRAMEWORK_ORDER)}</div></fieldset>
            <fieldset class="wp-fgroup"><legend>Role <small>any match</small></legend><div class="wp-chips">${chips('role', ROLE_STYLES.map((style: RoleStyle): string => style.role))}</div></fieldset>
            ${this.productGroup(products)}
            <footer><button type="button" class="wp-text-btn" id="wp-filter-clear">Clear all</button><button type="button" class="wp-primary" id="wp-filter-apply">Show all projects</button></footer>
        </div>`;
    }

    /**
     * The Product group (#1179): one chip per declared product, each with its palette swatch. Several
     * chips select the UNION of their closures; the group intersects with the others. Omitted when the
     * workspace declares no product.
     */
    private productGroup(products: string[]): string {
        if (products.length === 0) return '';
        const palette = new ProductPalette(products);
        const chips = palette.colors
            .map(
                (color: ProductColor): string =>
                    `<button type="button" class="wp-chip" data-wp-chip-group="product" data-wp-chip="${color.product}" aria-pressed="false">` +
                    `<svg class="wp-chip-swatch" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4.5" fill="${color.color}"/></svg>` +
                    `${color.product}</button>`,
            )
            .join('');
        return `<fieldset class="wp-fgroup" id="wp-product-group"><legend>Product <small>any match</small></legend><div class="wp-chips">${chips}</div></fieldset>`;
    }

    /**
     * Which Impact scan the page shows (#1163): "Changed on this branch" (fork point → working tree)
     * or "Last commit" (HEAD^ → working tree). Hidden until the page finds TWO scans in the sidecar;
     * `where` tells the drawer's copy (shown only in Impact mode) from the Filter popover's.
     */
    private impactKinds(where: string): string {
        return (
            `<div class="wp-chips wp-impact-kinds" data-wp-impact-kinds="${where}" role="group" aria-label="Compare" hidden>` +
            '<button type="button" class="wp-chip" data-wp-impact-kind="branch" aria-pressed="false">Changed on this branch</button>' +
            '<button type="button" class="wp-chip" data-wp-impact-kind="commit" aria-pressed="false">Last commit</button></div>'
        );
    }

    private topbar(parts: ShellParts): string {
        return `<div class="wp-topbar">
            <button type="button" class="wp-icon" id="wp-collapse" aria-label="Toggle the controls drawer" aria-controls="wp-side" aria-expanded="true">☰</button>
            <div class="wp-crumb" id="wp-crumb">Mode: <b>Runtime</b></div>
            <div class="wp-pills" id="wp-filter-pills" aria-label="Active filters"></div>
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
        ${this.filterPopover(parts.products)}
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
            <p>Every row is one dependency level: the HIGHEST level is the top row and L0, the foundation libraries, is always the bottom row. Servers, clients and apps always form the top row (a bundle sits above the apps it aggregates). Transitive dependencies are allowed but not drawn.</p>
            <p>💡 <strong>Click any box</strong> for its menu: <strong>View Design</strong> (only where the project has a generated <strong>design.html</strong>, i.e. what the AI sees inside it), <strong>Lock/Unlock</strong> (the same lock as the Focus field), <strong>Filter Unconnected</strong> (removes unrelated boxes, keeping each L-number row).</p>
            <p><strong>Filter</strong> narrows the graph by what changed on this branch or in the last commit, by runtime, by role and by product; the groups combine. A product keeps its servers, clients and apps plus everything they depend on, so <strong>Product</strong> + <strong>Changed + dependents + dependencies</strong> is exactly what this branch builds that can affect that product. Every box keeps its own L-row, and a level left empty shows as a thin labeled band.</p>
            <p>🔦 <strong>Hover any box</strong> to trace its <em>entire</em> dependency chain — every ancestor above it and every dependency below it, with the lines between — while the rest of the graph dims.</p>
            <p><strong>Runtime</strong>: a box may depend on a box carrying every color it has. <strong>Architecture</strong>: what each box is in the system. <strong>Impact</strong>: what changed on this branch or in the last commit (amber) and its dependents (amber outline); with both available, a toggle picks which. <strong>Product</strong>: which products each box belongs to — one color per product, stripes for several, grey for every product, a dashed white box for none.</p>
            <p><kbd>/</kbd> focus the lock search · <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> switch mode · <kbd>Esc</kbd> unlock</p>
        </div>`;
    }

    private brandIcon(): string {
        return (
            '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">' +
            '<rect x="1" y="1" width="8" height="6" rx="1.5" fill="none" stroke="#a46bf7" stroke-width="1.6"/>' +
            '<rect x="13" y="1" width="8" height="6" rx="1.5" fill="none" stroke="#e9eaf0" stroke-width="1.6"/>' +
            '<rect x="7" y="15" width="8" height="6" rx="1.5" fill="none" stroke="#e9eaf0" stroke-width="1.6"/>' +
            '<path d="M5 7v4h12V7M11 11v4" fill="none" stroke="#e9eaf0" stroke-width="1.6"/></svg>'
        );
    }
}
