/**
 * One state of the Filter popover: a change scope plus the selected Runtime, Role and Product chips.
 * The page holds the APPLIED one; the popover edits a copy until "Show N projects".
 */
class WpFilterChoice {
    scope = 'everything';
    readonly runtimes = new Set<string>();
    readonly roles = new Set<string>();
    readonly products = new Set<string>();

    copy(): WpFilterChoice {
        const copy = new WpFilterChoice();
        copy.scope = this.scope;
        for (const runtime of this.runtimes) copy.runtimes.add(runtime);
        for (const role of this.roles) copy.roles.add(role);
        for (const product of this.products) copy.products.add(product);
        return copy;
    }

    /** How many filters are active: the drawer button's badge. */
    count(): number {
        return (this.scope === 'everything' ? 0 : 1) + this.runtimes.size + this.roles.size + this.products.size;
    }

    /** The chip set a `data-wp-chip-group` (or a pill's group) names. */
    group(name: string): Set<string> {
        if (name === 'role') return this.roles;
        if (name === 'product') return this.products;
        return this.runtimes;
    }
}

/**
 * The Filter popover's four groups, INTERSECTED: a box stays when it is in the change scope, AND has
 * any selected runtime chip (when one is selected), AND has any selected role chip (likewise), AND
 * belongs to any selected product (likewise — several products are the UNION of their closures).
 */
class WpProjectFilter {
    constructor(
        private readonly model: RenderModelJson,
        private readonly modes: WpModeState,
    ) {}

    /** The node ids a change scope keeps; null for "everything" (and whenever Impact is unavailable). */
    scopeSet(scope: string): Set<string> | null {
        const impact = this.modes.impact;
        if (scope === 'everything' || impact === null || this.modes.impactReason() !== '') return null;
        const ids: string[] = [...impact.touched];
        if (scope === 'dependents' || scope === 'build') ids.push(...impact.affected);
        if (scope === 'dependencies') ids.push(...impact.dependencies);
        if (scope === 'build') ids.push(...impact.buildInputs);
        return new Set(ids);
    }

    /** How many drawn projects a scope keeps on its own: the count beside each option. */
    scopeCount(scope: string): number {
        const set = this.scopeSet(scope);
        return this.model.nodes.filter((node: RenderNodeJson): boolean => this.isService(node) && (set === null || set.has(node.id))).length;
    }

    /** `base` (everything, or the Hide-unconnected chain) narrowed by `choice`. */
    apply(base: Set<string>, choice: WpFilterChoice): Set<string> {
        const scope = this.scopeSet(choice.scope);
        const kept = new Set<string>();
        for (const node of this.model.nodes) {
            if (!base.has(node.id) || !this.isService(node)) continue;
            if (scope !== null && !scope.has(node.id)) continue;
            if (!this.anyOf(choice.runtimes, node.tags?.frameworks ?? [])) continue;
            if (!this.anyOf(choice.roles, node.tags === null ? [] : [node.tags.role])) continue;
            if (!this.anyOf(choice.products, node.products)) continue;
            kept.add(node.id);
        }
        if (this.model.viewer === 'runtime') {
            for (const node of this.model.nodes) {
                if (node.tags !== null || !base.has(node.id)) continue;
                if (this.model.edges.some(edge => (edge.from === node.id && kept.has(edge.to)) || (edge.to === node.id && kept.has(edge.from)))) kept.add(node.id);
            }
        }
        return kept;
    }

    isService(node: RenderNodeJson): boolean { return this.model.viewer !== 'runtime' || node.tags !== null; }

    /** An empty chip group matches every box; otherwise the box must carry one of the chips. */
    private anyOf(selected: Set<string>, carried: string[]): boolean {
        return selected.size === 0 || carried.some((value: string): boolean => selected.has(value));
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
        WpNodeMenu.wire(this.svg, (name: string, node: SVGGElement): WpNodeMenuItem[] => {
            const items: WpNodeMenuItem[] = [];
            const href = designs.get(name);
            if (href !== undefined)
                items.push(new WpNodeMenuItem('View Design', () => window.open(href, '_blank')));
            const locked = this.page.lockSelection() === name;
            items.push(
                new WpNodeMenuItem(locked ? 'Unlock' : 'Lock', () =>
                    locked ? this.page.clearSelection() : this.page.setLock(name),
                ),
            );
            items.push(this.page.filterItem(name));
            const implemented = window.__WP_RUNTIME__?.implementsItem(name, node);
            if (implemented) items.push(implemented);
            return items;
        });
    }
}

/**
 * The Filter popover: edits a COPY of the page's applied filter, shows what each choice would keep,
 * and hands the copy to the page on "Show N projects". Closing it any other way discards the edit.
 */
class GraphFilterPopover {
    private draft = new WpFilterChoice();

    constructor(private readonly page: GraphPage) {}

    wire(): void {
        this.byId('wp-filter-open')?.addEventListener('click', (ev: MouseEvent) => {
            ev.stopPropagation();
            if (this.isOpen()) this.close();
            else this.open();
        });
        this.byId('wp-filter-close')?.addEventListener('click', () => this.close());
        this.byId('wp-filter-clear')?.addEventListener('click', () => {
            this.draft = new WpFilterChoice();
            this.paint();
        });
        this.byId('wp-filter-apply')?.addEventListener('click', () => {
            this.page.applyFilter(this.draft.copy());
            this.close();
        });
        document.querySelectorAll<HTMLInputElement>('input[name="wp-scope"]').forEach((radio: HTMLInputElement) => {
            radio.addEventListener('change', () => {
                if (!radio.checked) return;
                this.draft.scope = radio.value;
                this.paint();
            });
        });
        document.querySelectorAll<HTMLButtonElement>('.wp-chip[data-wp-chip]').forEach((chip: HTMLButtonElement) => {
            chip.addEventListener('click', () => {
                const set = this.draft.group(chip.dataset['wpChipGroup'] ?? '');
                const value = chip.dataset['wpChip'] ?? '';
                if (set.has(value)) set.delete(value);
                else set.add(value);
                this.paint();
            });
        });
    }

    isOpen(): boolean {
        return this.byId('wp-filter-pop')?.hidden === false;
    }

    /** The active Impact scan changed: an open popover's counts and labels follow it. */
    refresh(): void {
        if (this.isOpen()) this.paint();
    }

    open(): void {
        const pop = this.byId('wp-filter-pop');
        if (pop === null) return;
        this.draft = this.page.appliedFilter().copy();
        this.paint();
        pop.hidden = false;
        this.byId('wp-filter-open')?.setAttribute('aria-expanded', 'true');
    }

    close(): void {
        const pop = this.byId('wp-filter-pop');
        if (pop === null || pop.hidden) return;
        pop.hidden = true;
        this.byId('wp-filter-open')?.setAttribute('aria-expanded', 'false');
    }

    /** Repaint the controls from the draft: checked scope, pressed chips, counts and the footer. */
    private paint(): void {
        const reason = this.page.scopeReason();
        const group = this.byId('wp-scope-group') as HTMLFieldSetElement | null;
        if (group !== null) group.disabled = reason !== '';
        const reasonEl = this.byId('wp-scope-reason');
        if (reasonEl !== null) {
            reasonEl.textContent = reason;
            reasonEl.hidden = reason === '';
        }
        document.querySelectorAll<HTMLInputElement>('input[name="wp-scope"]').forEach((radio: HTMLInputElement) => {
            radio.checked = radio.value === this.draft.scope;
        });
        document.querySelectorAll<HTMLElement>('[data-wp-scope-count]').forEach((count: HTMLElement) => {
            count.textContent = reason === '' ? String(this.page.scopeCount(count.dataset['wpScopeCount'] ?? '')) : '';
        });
        document.querySelectorAll<HTMLButtonElement>('.wp-chip[data-wp-chip]').forEach((chip: HTMLButtonElement) => {
            const set = this.draft.group(chip.dataset['wpChipGroup'] ?? '');
            chip.setAttribute('aria-pressed', String(set.has(chip.dataset['wpChip'] ?? '')));
        });
        const apply = this.byId('wp-filter-apply');
        if (apply !== null) {
            const shown = this.page.preview(this.draft);
            apply.textContent = `Show ${shown} ${this.page.noun()}${shown === 1 ? '' : 's'}`;
        }
    }

    private byId(id: string): HTMLElement | null {
        return document.getElementById(id);
    }
}

/**
 * The drawer and its floating panels: every control outside the graph itself. Holds no graph state —
 * each control calls back into the page, and `sync()` repaints the controls from the page's state.
 */
class GraphDrawer {
    readonly popover: GraphFilterPopover;
    private readonly openers = new Map<string, HTMLElement>();

    constructor(private readonly page: GraphPage) {
        this.popover = new GraphFilterPopover(page);
    }

    wire(): void {
        this.wireModeMenu();
        this.popover.wire();
        this.wireImpactKinds();
        this.wireLock();
        this.byId('wp-lock-toggle')?.addEventListener('click', () => this.page.toggleLock());
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
        document.addEventListener('click', (ev: MouseEvent) => {
            const target = ev.target;
            if (target instanceof Node && this.byId('wp-mode-menu')?.parentElement?.contains(target)) return;
            this.closeModeMenu(false);
            this.dismissOutside(target);
        });
    }

    /** "Color by": the pill trigger opens the menu of four; picking one switches and closes it. */
    private wireModeMenu(): void {
        this.byId('wp-mode-trigger')?.addEventListener('click', (ev: MouseEvent) => {
            ev.stopPropagation();
            const menu = this.byId('wp-mode-menu');
            if (menu === null) return;
            if (!menu.hidden) {
                this.closeModeMenu(false);
                return;
            }
            menu.hidden = false;
            this.byId('wp-mode-trigger')?.setAttribute('aria-expanded', 'true');
            menu.querySelector<HTMLButtonElement>('.wp-mode[aria-checked="true"]')?.focus({ preventScroll: true });
        });
        document.querySelectorAll<HTMLButtonElement>('.wp-mode[data-wp-mode]').forEach((button: HTMLButtonElement) => {
            button.addEventListener('click', (ev: MouseEvent) => {
                ev.stopPropagation();
                this.closeModeMenu(true);
                this.page.setMode(button.dataset['wpMode'] ?? 'runtime');
            });
        });
    }

    /** The "Changed on this branch" / "Last commit" toggle, in the drawer and in the Filter popover. */
    private wireImpactKinds(): void {
        document.querySelectorAll<HTMLButtonElement>('[data-wp-impact-kind]').forEach((button: HTMLButtonElement) => {
            button.addEventListener('click', (ev: MouseEvent) => {
                ev.stopPropagation();
                this.page.setImpactKind(button.dataset['wpImpactKind'] ?? '');
                this.popover.refresh();
            });
        });
    }

    /** Shown only when two scans exist; the drawer's copy only while Impact colors the graph. */
    private syncImpactKinds(modes: WpModeState): void {
        document.querySelectorAll<HTMLElement>('[data-wp-impact-kinds]').forEach((group: HTMLElement) => {
            const inDrawer = group.dataset['wpImpactKinds'] === 'drawer';
            group.hidden = modes.scans.length < 2 || (inDrawer && modes.mode !== 'impact');
        });
        document.querySelectorAll<HTMLButtonElement>('[data-wp-impact-kind]').forEach((button: HTMLButtonElement) => {
            const kind = button.dataset['wpImpactKind'] ?? '';
            button.setAttribute('aria-pressed', String(kind === modes.kind));
            button.disabled = !modes.kindAvailable(kind);
            const scan = modes.scans.find((candidate: ImpactJson): boolean => candidate.kind === kind);
            button.title = scan === undefined ? '' : scan.available ? scan.label : scan.reason;
        });
        const legend = this.byId('wp-scope-legend');
        if (legend !== null) legend.textContent = modes.impact?.label ?? 'Changes on this branch';
    }

    private closeModeMenu(returnFocus: boolean): void {
        const menu = this.byId('wp-mode-menu');
        if (menu === null || menu.hidden) return;
        menu.hidden = true;
        const trigger = this.byId('wp-mode-trigger');
        trigger?.setAttribute('aria-expanded', 'false');
        if (returnFocus) trigger?.focus({ preventScroll: true });
    }

    /** Type-to-search lock: an exact project id (or a unique short name) locks, empty or Esc unlocks. */
    private wireLock(): void {
        const input = this.lockInput();
        if (input === null) return;
        input.addEventListener('input', () => {
            const value = input.value.trim();
            if (value === '') this.page.clearSelection();
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
            this.page.clearSelection();
            input.blur();
        });
    }

    /**
     * Page keys, in the CAPTURE phase so the open/closed state of the node menu is read before the
     * menu's own Escape handler closes it: Esc with a menu open only closes the menu. Esc closes an
     * open Color-by menu or Filter popover first, too.
     */
    private onKey(ev: KeyboardEvent): void {
        if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
        if (ev.key === 'Escape' && this.byId('wp-mode-menu')?.hidden === false) {
            this.closeModeMenu(true);
            return;
        }
        if (ev.key === 'Escape' && this.popover.isOpen()) {
            this.popover.close();
            return;
        }
        if (ev.key === 'Escape' && this.dismissOverlay()) return;
        const target = ev.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
        const menuOpen = document.getElementById('wp-node-menu') !== null || document.querySelector('.wp-graph-details:not([hidden])') !== null;
        if (ev.key === '/') {
            this.byId('wp-shell')?.classList.remove('wp-collapsed');
            this.byId('wp-collapse')?.setAttribute('aria-expanded', 'true');
            ev.preventDefault();
            this.lockInput()?.focus();
            return;
        }
        const index = ['1', '2', '3', '4'].indexOf(ev.key);
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
                if (expanded) this.openers.set(targetId, button);
                else this.openers.get(targetId)?.focus({ preventScroll: true });
            }
            document.querySelectorAll(`[aria-controls="${targetId}"], #${buttonId}[aria-expanded]`).forEach(
                (el: Element) => el.setAttribute('aria-expanded', String(expanded)),
            );
        });
    }

    private dismissOverlay(): boolean {
        for (const id of ['wp-help', 'wp-legend-popout', 'wp-snapshot', 'wp-resp-panel']) {
            const panel = this.byId(id);
            if (!panel || panel.hidden) continue;
            panel.hidden = true;
            this.openers.get(id)?.focus({ preventScroll: true });
            this.openers.get(id)?.setAttribute('aria-expanded', 'false');
            return true;
        }
        return false;
    }

    private dismissOutside(target: EventTarget | null): void {
        if (!(target instanceof Node)) return;
        const filter = this.byId('wp-filter-pop');
        if (this.popover.isOpen() && !filter?.contains(target) && !this.byId('wp-filter-open')?.contains(target)) this.popover.close();
        for (const [id, opener] of this.openers) {
            const panel = this.byId(id);
            if (panel && !panel.hidden && !panel.contains(target) && !opener.contains(target)) {
                panel.hidden = true;
                opener.setAttribute('aria-expanded', 'false');
            }
        }
    }

    /** Repaint every control from the page's state. */
    sync(modes: WpModeState, locked: string | null, filtering: boolean, filter: WpFilterChoice): void {
        const reason = modes.impactReason();
        document.querySelectorAll<HTMLButtonElement>('.wp-mode[data-wp-mode]').forEach((button: HTMLButtonElement) => {
            const mode = button.dataset['wpMode'] ?? '';
            button.setAttribute('aria-checked', String(mode === modes.mode));
            button.disabled = !modes.available(mode);
            if (mode === 'impact') button.title = reason === '' ? 'Key 3' : reason;
            if (mode === 'product') button.title = modes.productReason() === '' ? 'Key 4' : modes.productReason();
        });
        this.text('wp-mode-current', modes.name(modes.mode));
        this.text('wp-mode-current-sub', modes.subtitle(modes.mode));
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
        this.syncImpactKinds(modes);
        const title = this.byId('wp-legend-pop-title');
        if (title !== null) title.textContent = `Legend · ${modes.name(modes.mode)}`;
        const input = this.lockInput();
        if (input !== null && document.activeElement !== input) input.value = this.page.focusSelection() ?? '';
        const lockToggle = this.byId('wp-lock-toggle') as HTMLButtonElement | null;
        if (lockToggle !== null) {
            lockToggle.setAttribute('aria-pressed', String(locked !== null));
            lockToggle.disabled = locked === null && this.page.focusSelection() === null;
            lockToggle.title = lockToggle.disabled ? 'Select a node in Focus first' : '';
        }
        this.syncFilterToggle(locked, filtering);
        this.syncFilter(filter);
        this.crumb(modes.name(modes.mode), locked);
    }

    private syncFilterToggle(locked: string | null, filtering: boolean): void {
        const toggle = this.byId('wp-filter-toggle') as HTMLButtonElement | null;
        if (toggle === null) return;
        toggle.setAttribute('aria-pressed', String(filtering));
        toggle.disabled = !filtering && locked === null;
        toggle.title = toggle.disabled ? 'Lock a project first' : '';
    }

    /** The drawer button's count badge, and one removable pill per active filter in the top bar. */
    private syncFilter(filter: WpFilterChoice): void {
        const badge = this.byId('wp-filter-badge');
        if (badge !== null) {
            badge.textContent = String(filter.count());
            badge.hidden = filter.count() === 0;
        }
        const pills = this.byId('wp-filter-pills');
        if (pills === null) return;
        const items: HTMLElement[] = [];
        if (filter.scope !== 'everything') items.push(this.pill(this.scopeLabel(filter.scope), 'scope', filter.scope));
        for (const runtime of filter.runtimes) items.push(this.pill(runtime, 'runtime', runtime));
        for (const role of filter.roles) items.push(this.pill(role, 'role', role));
        for (const product of filter.products) items.push(this.pill(`product: ${product}`, 'product', product));
        pills.replaceChildren(...items);
    }

    /** A change scope's name, read from the Filter popover's markup: the shell owns the ONE copy. */
    private scopeLabel(scope: string): string {
        return document.querySelector(`[data-wp-scope-label="${scope}"]`)?.textContent ?? scope;
    }

    /** A pill, built with text nodes so no value is parsed as HTML. */
    private pill(label: string, group: string, value: string): HTMLElement {
        const pill = document.createElement('span');
        pill.className = 'wp-pill';
        pill.dataset['wpPill'] = `${group}:${value}`;
        pill.append(label);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '✕';
        remove.setAttribute('aria-label', `Remove filter ${label}`);
        remove.addEventListener('click', (ev: MouseEvent) => {
            ev.stopPropagation();
            this.page.removeFilter(group, value);
        });
        pill.append(remove);
        return pill;
    }

    private impactNote(modes: WpModeState): string {
        const impact = modes.impact;
        if (impact === null || !impact.available) return '';
        // An available scan with a note is an EMPTY one, e.g. "Nothing changed on this branch yet".
        if (impact.reason !== '') return `${impact.label}: ${impact.reason}.`;
        const stats =
            `${impact.label}: ${impact.touched.length} changed · ${impact.affected.length} dependents · ` +
            `${impact.buildInputs.length} dependencies — nx affected, ${impact.changedFiles} changed files.`;
        const cause = this.globalCause(impact);
        return cause === '' ? stats : `${cause}. ${stats}`;
    }

    /**
     * When files changed but no project owns one, everything nx affected is affected by a
     * workspace-global input (a lockfile, the workspace manifest). That is correct for CI, and
     * baffling on a graph, so the note names the cause.
     */
    private globalCause(impact: ImpactJson): string {
        if (impact.touched.length > 0 || impact.changedFiles === 0) return '';
        const affected = impact.affected.length;
        const who = affected >= this.page.projectCount() ? 'Every project affected' : `${affected} projects affected`;
        const files = impact.globalFiles;
        if (files.length === 0)
            return `${who}: ${impact.changedFiles} changed files that no project owns (workspace-global input)`;
        const named = files.slice(0, 2).join(', ') + (files.length > 2 ? ` and ${files.length - 2} more` : '');
        return `${who}: ${named} changed (workspace-global input${files.length > 1 ? 's' : ''})`;
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

    private text(id: string, value: string): void {
        const el = this.byId(id);
        if (el !== null) el.textContent = value;
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
    private selected: string | null = null;
    private readonly modes = new WpModeState(
        this.model.nodes.some((node: RenderNodeJson): boolean => node.products.length > 0),
        this.model.viewer ?? 'architecture',
    );
    private readonly projects = new WpProjectFilter(this.model, this.modes);
    private applied = new WpFilterChoice();
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
        if (this.modes.mode === 'product') return modes.product;
        return modes.runtime;
    }

    protected override usesFullDot(): boolean {
        return this.modes.mode === 'runtime' && this.applied.count() === 0;
    }

    protected override narrow(retained: Set<string>): Set<string> {
        return this.projects.apply(retained, this.applied);
    }

    /** Filtering keeps every box in its own L-row: an emptied level stays as a thin labeled band. */
    protected override keepsEmptyLevels(): boolean {
        return true;
    }

    protected override prepareSvg(svg: SVGSVGElement): void { window.__WP_RUNTIME__?.prepare(svg); }

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

    noun(): string { return this.model.viewer === 'runtime' ? 'service' : 'project'; }

    projectCount(): number { return this.model.nodes.filter(node => this.projects.isService(node)).length; }

    focusSelection(): string | null { return this.selected; }

    toggleLock(): void {
        if (this.locked !== null) this.setLock(null);
        else if (this.selected !== null) this.setLock(this.selected);
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
        if (name !== null) this.selected = name;
        this.highlighter?.relight();
        this.filterCards();
        this.syncControls();
    }

    clearSelection(): void { this.selected = null; this.setLock(null); }

    setMode(mode: string): void {
        if (mode === this.modes.mode || !this.modes.set(mode)) return;
        this.syncControls();
        this.redraw();
    }

    /** Switch the active Impact scan: Impact recolours and an active change-scope filter re-applies. */
    setImpactKind(kind: string): void {
        if (kind === this.modes.kind || !this.modes.setKind(kind)) return;
        this.syncControls();
        this.redraw();
    }

    /** The drawer's "Hide unconnected": filter to the locked box's chain, or turn the filter off. */
    toggleFilter(): void {
        if (this.anchor !== null) this.filter(null);
        else if (this.locked !== null) this.filter(this.locked);
    }

    appliedFilter(): WpFilterChoice {
        return this.applied;
    }

    /** '' when the change-scope group can be used, else Impact's reason (the group is disabled). */
    scopeReason(): string {
        return this.modes.impactReason();
    }

    scopeCount(scope: string): number {
        if (this.model.viewer !== 'runtime') return this.projects.scopeCount(scope);
        const choice = new WpFilterChoice(); choice.scope = scope;
        return this.preview(choice);
    }

    /** How many boxes `choice` would show, with the current Hide-unconnected chain. */
    preview(choice: WpFilterChoice): number {
        const base =
            this.anchor === null
                ? new Set(this.model.nodes.map((node: RenderNodeJson): string => node.id))
                : this.chain.nodes(this.anchor);
        const kept = this.projects.apply(base, choice);
        return this.model.nodes.filter(node => kept.has(node.id) && this.projects.isService(node)).length;
    }

    applyFilter(choice: WpFilterChoice): void {
        if (this.scopeReason() !== '') choice.scope = 'everything';
        this.applied = choice;
        this.syncControls();
        this.redraw();
    }

    /** A top-bar pill's ✕. */
    removeFilter(group: string, value: string): void {
        const next = this.applied.copy();
        if (group === 'scope') next.scope = 'everything';
        else next.group(group).delete(value);
        this.applyFilter(next);
    }

    private syncControls(): void {
        this.drawer.sync(this.modes, this.locked, this.anchor !== null, this.applied);
        const count = this.model.nodes.filter(node => this.retained.has(node.id) && this.projects.isService(node)).length;
        const empty = document.getElementById('wp-empty');
        if (empty !== null) empty.hidden = count !== 0;
        const context = document.getElementById('wp-context-count');
        if (context !== null) context.textContent = `${count} services · ${this.retained.size - count} contextual nodes`;
        this.syncLegend();
    }

    private syncLegend(): void {
        document.querySelectorAll<HTMLElement>('[data-wp-legend-value]').forEach(row => {
            const group = row.dataset['wpLegendGroup'];
            const value = row.dataset['wpLegendValue'] ?? '';
            row.hidden = !this.model.nodes.some(node => this.retained.has(node.id) &&
                (group === 'runtime' ? (value === 'unknown' ? node.tags !== null && node.tags.frameworks.length === 0 : node.tags?.frameworks.includes(value)) : group === 'role' ? node.tags?.role === value : node.products.includes(value)));
        });
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
