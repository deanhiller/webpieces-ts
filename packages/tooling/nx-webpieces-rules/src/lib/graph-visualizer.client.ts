/**
 * The three color modes (graph-color-modes.ts), the viewer's remembered choice, and Impact's data.
 *
 * The mode is deep-linkable (`#runtime`, `#architecture`, `#impact`, which win over the remembered
 * one) and remembered per viewer in localStorage. Storage can be missing or throw (a private window,
 * blocked site data, a file:// page in some browsers), so every access is wrapped and the page works
 * without it.
 */
class WpModeState {
    static readonly MODES = ['runtime', 'architecture', 'impact'];
    static readonly NAMES = ['Runtime', 'Architecture', 'Impact'];
    static readonly STORAGE_KEY = 'wp-architecture-graph-mode';
    readonly impact: ImpactJson | null = window.__WP_IMPACT__ ?? null;
    mode = 'runtime';

    constructor() {
        this.mode = this.initial();
    }

    /** '' when Impact can be shown, else the one line the drawer and the menu say instead. */
    impactReason(): string {
        if (this.impact === null)
            return 'No impact data for this branch. Run pnpm nx run architecture:generate to compute it.';
        return this.impact.available ? '' : `Impact unavailable: ${this.impact.reason}.`;
    }

    available(mode: string): boolean {
        return WpModeState.MODES.includes(mode) && (mode !== 'impact' || this.impactReason() === '');
    }

    name(mode: string): string {
        return WpModeState.NAMES[WpModeState.MODES.indexOf(mode)] ?? mode;
    }

    /** False (and nothing changes) for an unknown or unavailable mode. */
    set(mode: string): boolean {
        if (!this.available(mode)) return false;
        this.mode = mode;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- storage is a per-viewer convenience; a blocked store must not break the page
        try {
            localStorage.setItem(WpModeState.STORAGE_KEY, mode);
            if (location.hash !== `#${mode}`) history.replaceState(null, '', `#${mode}`);
            // webpieces-disable no-any-unknown -- browsers may throw any value from blocked storage
        } catch (err: unknown) {
            //const error = toError(err);
            void err;
        }
        return true;
    }

    /** Which impact shade a box gets. */
    status(id: string): 'touched' | 'affected' | 'buildInput' | 'untouched' {
        if (this.impact?.touched.includes(id)) return 'touched';
        if (this.impact?.affected.includes(id)) return 'affected';
        if (this.impact?.buildInputs.includes(id)) return 'buildInput';
        return 'untouched';
    }

    private initial(): string {
        const hashed = location.hash.slice(1);
        if (this.available(hashed)) return hashed;
        const stored = this.stored();
        if (stored !== null && this.available(stored)) return stored;
        return 'runtime';
    }

    private stored(): string | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- storage is a per-viewer convenience; a blocked store reads as "nothing stored"
        try {
            return localStorage.getItem(WpModeState.STORAGE_KEY);
            // webpieces-disable no-any-unknown -- browsers may throw any value from blocked storage
        } catch (err: unknown) {
            //const error = toError(err);
            void err;
            return null;
        }
    }
}

/** Architecture interactions bind to each new SVG; logical Lock/Filter state belongs to the page. */
class GraphHighlighter {
    private readonly nodeByName = new Map<string, SVGGElement>();
    private hovered: string | null = null;

    constructor(
        private readonly svg: SVGSVGElement,
        private readonly chain: WpGraphChain,
        private readonly model: RenderModelJson,
        private readonly page: GraphPage,
    ) {}

    wire(): void {
        this.svg.querySelectorAll<SVGGElement>('g.node').forEach((g: SVGGElement) => {
            if (g.classList.contains('wp-layout')) return;
            const name = g.querySelector('title')?.textContent;
            if (name !== null && name !== undefined) this.nodeByName.set(name, g);
        });
        this.wireHover();
        this.wireMenu();
        this.relight();
    }

    private clear(): void {
        this.svg.classList.remove('wp-dim');
        this.svg.querySelectorAll('.wp-focus, .wp-neighbor, .wp-hl, .wp-locked').forEach((el: Element) => {
            el.classList.remove('wp-focus', 'wp-neighbor', 'wp-hl', 'wp-locked');
        });
    }

    relight(): void {
        this.clear();
        const locked = this.page.lockSelection();
        if (locked !== null) this.nodeByName.get(locked)?.classList.add('wp-locked');
        // A filtered-out Lock is suspended, including its otherwise visible relatives.
        const anchors = [locked, this.hovered].filter(
            (name: string | null): name is string => name !== null && this.nodeByName.has(name),
        );
        if (anchors.length === 0) return;
        const lit = new Set<string>();
        for (const name of anchors) {
            this.nodeByName.get(name)?.classList.add('wp-focus');
            for (const id of this.chain.nodes(name)) {
                if (this.nodeByName.has(id)) lit.add(id);
            }
        }
        this.svg.classList.add('wp-dim');
        for (const id of lit) this.nodeByName.get(id)?.classList.add('wp-neighbor');
        for (const edge of this.model.edges) {
            if (lit.has(edge.from) && lit.has(edge.to)) {
                this.svg.querySelector(`[id="${edge.id}"]`)?.classList.add('wp-hl');
            }
        }
    }

    private wireHover(): void {
        this.nodeByName.forEach((g: SVGGElement, name: string) => {
            g.addEventListener('mouseenter', () => {
                this.hovered = name;
                this.relight();
            });
            g.addEventListener('mouseleave', () => {
                this.hovered = null;
                this.relight();
            });
        });
    }

    private wireMenu(): void {
        const designs = new Map<string, string>();
        for (const link of __DESIGN_LINKS__) designs.set(link.nodeId, link.href);
        WpNodeMenu.wire(this.svg, (name: string): WpNodeMenuItem[] => {
            const items: WpNodeMenuItem[] = [];
            const href = designs.get(name);
            if (href !== undefined)
                items.push(new WpNodeMenuItem('View Design', () => window.open(href, '_blank')));
            const locked = this.page.lockSelection() === name;
            items.push(
                new WpNodeMenuItem(locked ? 'Unlock' : 'Lock', () =>
                    this.page.setLock(locked ? null : name),
                ),
            );
            items.push(this.page.filterItem(name));
            items.push(this.page.modeItem());
            return items;
        });
    }
}

/**
 * The drawer and its floating panels: every control outside the graph itself. Holds no graph state —
 * each control calls back into the page, and `sync()` repaints the controls from the page's state.
 */
class GraphDrawer {
    constructor(private readonly page: GraphPage) {}

    wire(): void {
        document.querySelectorAll<HTMLButtonElement>('.wp-mode[data-wp-mode]').forEach((button: HTMLButtonElement) => {
            button.addEventListener('click', () => this.page.setMode(button.dataset['wpMode'] ?? 'runtime'));
        });
        this.wireLock();
        this.byId('wp-filter-toggle')?.addEventListener('click', () => this.page.toggleFilter());
        this.toggles('wp-collapse', 'wp-shell', true);
        this.toggles('wp-help-btn', 'wp-help', false);
        this.toggles('wp-help-close', 'wp-help', false);
        this.toggles('wp-legend-pop', 'wp-legend-popout', false);
        this.toggles('wp-legend-close', 'wp-legend-popout', false);
        this.toggles('wp-resp-open', 'wp-resp-panel', false);
        this.toggles('wp-resp-close', 'wp-resp-panel', false);
        this.toggles('wp-snapshot-open', 'wp-snapshot', false);
        window.addEventListener('keydown', (ev: KeyboardEvent) => this.onKey(ev), true);
        window.addEventListener('hashchange', () => this.page.setMode(location.hash.slice(1)));
    }

    /** Type-to-search lock: an exact project id (or a unique short name) locks, empty or Esc unlocks. */
    private wireLock(): void {
        const input = this.lockInput();
        if (input === null) return;
        input.addEventListener('input', () => {
            const value = input.value.trim();
            if (value === '') this.page.setLock(null);
            else if (this.page.hasNode(value)) this.page.setLock(value);
        });
        input.addEventListener('change', () => {
            const match = this.page.resolveName(input.value.trim());
            if (match !== null) this.page.setLock(match);
            else input.value = this.page.lockSelection() ?? '';
        });
        input.addEventListener('keydown', (ev: KeyboardEvent) => {
            if (ev.key !== 'Escape') return;
            ev.preventDefault();
            input.value = '';
            this.page.setLock(null);
            input.blur();
        });
    }

    /**
     * Page keys, in the CAPTURE phase so the open/closed state of the node menu is read before the
     * menu's own Escape handler closes it: Esc with a menu open only closes the menu.
     */
    private onKey(ev: KeyboardEvent): void {
        if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
        const target = ev.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
        const menuOpen = document.getElementById('wp-node-menu') !== null;
        if (ev.key === '/') {
            ev.preventDefault();
            this.lockInput()?.focus();
            return;
        }
        const index = ['1', '2', '3'].indexOf(ev.key);
        if (index >= 0 && !menuOpen) {
            this.page.setMode(WpModeState.MODES[index]);
            return;
        }
        if (ev.key === 'Escape' && !menuOpen && this.page.lockSelection() !== null) this.page.setLock(null);
    }

    /** `button` shows/hides `target`; for the drawer itself it toggles the collapsed class instead. */
    private toggles(buttonId: string, targetId: string, collapse: boolean): void {
        const button = this.byId(buttonId);
        const target = this.byId(targetId);
        if (button === null || target === null) return;
        button.addEventListener('click', (ev: MouseEvent) => {
            ev.stopPropagation();
            let expanded: boolean;
            if (collapse) {
                expanded = !target.classList.toggle('wp-collapsed');
            } else {
                target.hidden = !target.hidden;
                expanded = !target.hidden;
            }
            document.querySelectorAll(`[aria-controls="${targetId}"], #${buttonId}[aria-expanded]`).forEach(
                (el: Element) => el.setAttribute('aria-expanded', String(expanded)),
            );
        });
    }

    /** Repaint every control from the page's state. */
    sync(modes: WpModeState, locked: string | null, filtering: boolean): void {
        const reason = modes.impactReason();
        document.querySelectorAll<HTMLButtonElement>('.wp-mode[data-wp-mode]').forEach((button: HTMLButtonElement) => {
            const mode = button.dataset['wpMode'] ?? '';
            button.setAttribute('aria-pressed', String(mode === modes.mode));
            button.disabled = !modes.available(mode);
            if (mode === 'impact') button.title = reason === '' ? 'Key 3' : reason;
        });
        const reasonEl = this.byId('wp-impact-reason');
        if (reasonEl !== null) {
            reasonEl.textContent = reason;
            reasonEl.hidden = reason === '';
        }
        document.querySelectorAll<HTMLElement>('[data-wp-legend-mode]').forEach((section: HTMLElement) => {
            section.hidden = section.dataset['wpLegendMode'] !== modes.mode;
        });
        document.querySelectorAll<HTMLElement>('[data-wp-impact-note]').forEach((note: HTMLElement) => {
            note.textContent = this.impactNote(modes);
        });
        const title = this.byId('wp-legend-pop-title');
        if (title !== null) title.textContent = `Legend · ${modes.name(modes.mode)}`;
        const input = this.lockInput();
        if (input !== null && document.activeElement !== input) input.value = locked ?? '';
        this.syncFilterToggle(locked, filtering);
        this.crumb(modes.name(modes.mode), locked);
    }

    private syncFilterToggle(locked: string | null, filtering: boolean): void {
        const toggle = this.byId('wp-filter-toggle') as HTMLButtonElement | null;
        if (toggle === null) return;
        toggle.setAttribute('aria-pressed', String(filtering));
        toggle.disabled = !filtering && locked === null;
        toggle.title = toggle.disabled ? 'Lock a project first' : '';
    }

    private impactNote(modes: WpModeState): string {
        const impact = modes.impact;
        if (impact === null || !impact.available) return '';
        return (
            `${impact.touched.length} touched · ${impact.affected.length} affected · ` +
            `${impact.buildInputs.length} build inputs — nx affected since fork point ${impact.base}, ` +
            `${impact.changedFiles} changed files.`
        );
    }

    /** "Mode: <b>Runtime</b> · Locked: <b>x</b>", built with text nodes so no name is parsed as HTML. */
    private crumb(mode: string, locked: string | null): void {
        const crumb = this.byId('wp-crumb');
        if (crumb === null) return;
        const bold = (text: string): HTMLElement => {
            const b = document.createElement('b');
            b.textContent = text;
            return b;
        };
        const parts: (string | Node)[] = ['Mode: ', bold(mode)];
        if (locked !== null) parts.push(' · Locked: ', bold(locked));
        crumb.replaceChildren(...parts);
    }

    private lockInput(): HTMLInputElement | null {
        return document.getElementById('wp-lock') as HTMLInputElement | null;
    }

    private byId(id: string): HTMLElement | null {
        return document.getElementById(id);
    }
}

class GraphPage extends WpFilterPage {
    private highlighter: GraphHighlighter | null = null;
    private readonly modes = new WpModeState();
    private readonly drawer = new GraphDrawer(this);

    protected override captureBinding(_svg: SVGSVGElement | null): () => void {
        const previous = this.highlighter;
        return (): void => {
            this.highlighter = previous;
            this.filterCards();
            this.syncControls();
        };
    }

    protected override wireControls(): void {
        this.drawer.wire();
        this.syncControls();
    }

    protected override nodeDot(node: RenderNodeJson): string {
        const modes = node.modes;
        if (modes === null) return node.dot;
        if (this.modes.mode === 'architecture') return modes.architecture;
        if (this.modes.mode === 'impact') return modes[this.modes.status(node.id)];
        return modes.runtime;
    }

    protected override usesFullDot(): boolean {
        return this.modes.mode === 'runtime';
    }

    protected wireSvg(svg: SVGSVGElement): void {
        this.highlighter = new GraphHighlighter(svg, this.chain, this.model, this);
        this.highlighter.wire();
        this.filterCards();
        this.syncControls();
        svg.querySelectorAll<SVGGElement>('g.node').forEach((node: SVGGElement) => {
            if (node.querySelector('title')?.textContent === this.anchor)
                node.classList.add('wp-filter-anchor');
        });
    }

    lockSelection(): string | null {
        return this.locked;
    }

    hasNode(id: string): boolean {
        return this.model.nodes.some((node: RenderNodeJson): boolean => node.id === id);
    }

    /** An exact id, else the one id whose short name (after any scope) is `text`; null if none or several. */
    resolveName(text: string): string | null {
        if (text === '') return null;
        if (this.hasNode(text)) return text;
        const matches = this.model.nodes.filter(
            (node: RenderNodeJson): boolean => node.id.split('/').pop() === text,
        );
        return matches.length === 1 ? matches[0].id : null;
    }

    setLock(name: string | null): void {
        this.locked = name;
        this.highlighter?.relight();
        this.filterCards();
        this.syncControls();
    }

    setMode(mode: string): void {
        if (mode === this.modes.mode || !this.modes.set(mode)) return;
        this.syncControls();
        this.redraw();
    }

    /** The drawer's "Hide unconnected": filter to the locked box's chain, or turn the filter off. */
    toggleFilter(): void {
        if (this.anchor !== null) this.filter(null);
        else if (this.locked !== null) this.filter(this.locked);
    }

    /** The node menu's "Mode ▸" submenu: one radio item per mode, Impact disabled with its reason. */
    modeItem(): WpNodeMenuItem {
        const children = WpModeState.MODES.map((mode: string): WpNodeMenuItem => {
            const item = new WpNodeMenuItem(this.modes.name(mode), (): void => this.setMode(mode));
            item.checked = mode === this.modes.mode;
            if (!this.modes.available(mode)) item.disabledReason = this.modes.impactReason();
            return item;
        });
        return new WpNodeMenuItem('Mode', (): void => {}, children);
    }

    private syncControls(): void {
        this.drawer.sync(this.modes, this.locked, this.anchor !== null);
    }

    private filterCards(): void {
        const lit = this.locked === null ? this.retained : this.chain.nodes(this.locked);
        document.querySelectorAll('.wp-resp-card').forEach((card: Element) => {
            const name = card.getAttribute('data-node');
            card.classList.toggle(
                'wp-hidden',
                name === null || !this.retained.has(name) || !lit.has(name),
            );
        });
    }
}

new GraphPage(__RENDER_MODEL__).render();
