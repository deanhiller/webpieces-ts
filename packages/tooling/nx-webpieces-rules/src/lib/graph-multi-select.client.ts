/*
 * The multi-select pulldown with search behind the drawer's "Keep connected to" and "Focus" (#1385).
 *
 * Prepended to graph-visualizer.client.js like graph-mode-state.client.ts, so both viewers (the
 * architecture page and the runtime page) run the ONE implementation. It knows nothing about graphs:
 * each instance reads and changes its picks through a WpMultiSource the page supplies.
 */

/**
 * What one multi-select pulldown reads and changes on the page: its picks, which options it may offer
 * right now, and how a toggle or Clear all lands. Behaviour, so an interface.
 */
interface WpMultiSource {
    selected(): ReadonlySet<string>;
    /** Whether `id` is drawn right now: an unavailable option is not offered, and its chip says "hidden". */
    available(id: string): boolean;
    toggle(id: string): void;
    clear(): void;
}

/**
 * One multi-select pulldown with search (#1385) — ONE implementation, two instances: "Keep connected
 * to" and "Focus". Its markup is graph-page-shell.ts `multiSelect()`; this owns the behaviour:
 *  - one checkbox row per option, alphabetical (the shell's order);
 *  - the search matches ANYWHERE in the name, case-insensitively, and highlights the match;
 *  - ↑/↓ move, Enter toggles (Space too while the query is empty), and the query stays after a toggle
 *    so several matches can be picked in a row;
 *  - the closed field shows the picks as removable chips, or "None (off)";
 *  - the footer says "N selected", and Clear all turns the pulldown off.
 * It holds no picks of its own: every change goes to the page, and `sync()` repaints from it.
 */
class WpMultiSelect {
    private activeId: string | null = null;

    constructor(
        private readonly key: string,
        private readonly source: WpMultiSource,
    ) {}

    wire(): void {
        // No stopPropagation: the page's outside-click handler closes every OTHER open pulldown.
        this.byId('field')?.addEventListener('click', () => {
            if (this.isOpen()) this.close(false);
            else this.open();
        });
        this.byId('clear')?.addEventListener('click', () => {
            this.source.clear();
            this.search()?.focus({ preventScroll: true });
        });
        const search = this.search();
        search?.addEventListener('input', () => {
            this.activeId = null;
            this.paint();
        });
        search?.addEventListener('keydown', (ev: KeyboardEvent) => this.onKey(ev));
        for (const row of this.rows()) {
            // Keep keyboard focus in the search box, so a click pick works like an Enter pick.
            row.addEventListener('mousedown', (ev: MouseEvent) => ev.preventDefault());
            row.addEventListener('click', () => {
                this.activeId = this.idOf(row);
                this.source.toggle(this.activeId);
            });
        }
    }

    isOpen(): boolean {
        return this.pop()?.hidden === false;
    }

    /** Open with the cursor in an EMPTY search box: the query lasts while it is open, not across opens. */
    open(): void {
        const pop = this.pop();
        if (pop === null) return;
        const search = this.search();
        if (search !== null) search.value = '';
        this.activeId = null;
        pop.hidden = false;
        this.byId('trigger')?.setAttribute('aria-expanded', 'true');
        this.paint();
        this.search()?.focus({ preventScroll: true });
    }

    /** Close; `returnFocus` puts the keyboard back on the pulldown's own button. */
    close(returnFocus: boolean): void {
        const pop = this.pop();
        if (pop === null || pop.hidden) return;
        pop.hidden = true;
        const trigger = this.byId('trigger');
        trigger?.setAttribute('aria-expanded', 'false');
        if (returnFocus) trigger?.focus({ preventScroll: true });
    }

    /**
     * Whether a click happened inside this pulldown: an outside click closes it. Read from the event's
     * PATH, not from the target's ancestors — a pick repaints the row it was clicked on, so by the time
     * the click reaches the document its target (the old `<mark>`) is no longer in the page.
     */
    clicked(ev: Event): boolean {
        const root = document.getElementById(`wp-${this.key}`);
        return root !== null && ev.composedPath().includes(root);
    }

    /** Repaint the chips, the footer and (while open) the rows from the page's picks. */
    sync(): void {
        this.chips();
        const count = this.byId('count');
        if (count !== null) count.textContent = `${this.source.selected().size} selected`;
        if (this.isOpen()) this.paint();
    }

    private onKey(ev: KeyboardEvent): void {
        const query = this.search()?.value ?? '';
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
            ev.preventDefault();
            this.move(ev.key === 'ArrowDown' ? 1 : -1);
            return;
        }
        const toggles = ev.key === 'Enter' || (ev.key === ' ' && query === '');
        if (!toggles) return;
        ev.preventDefault();
        const shown = this.shownRows();
        const active = shown.find((row: HTMLElement): boolean => this.idOf(row) === this.activeId) ?? shown[0];
        if (active === undefined) return;
        this.activeId = this.idOf(active);
        this.source.toggle(this.activeId);
    }

    private move(step: number): void {
        const shown = this.shownRows();
        if (shown.length === 0) return;
        const index = shown.findIndex((row: HTMLElement): boolean => this.idOf(row) === this.activeId);
        const next = index < 0 ? (step > 0 ? 0 : shown.length - 1) : Math.min(shown.length - 1, Math.max(0, index + step));
        this.activeId = this.idOf(shown[next]);
        this.paint();
        shown[next].scrollIntoView({ block: 'nearest' });
    }

    /** Show the rows the query and the page allow, highlight the match, and tick the picks. */
    private paint(): void {
        const query = (this.search()?.value ?? '').trim().toLowerCase();
        const selected = this.source.selected();
        let shown = 0;
        for (const row of this.rows()) {
            const id = this.idOf(row);
            const at = id.toLowerCase().indexOf(query);
            row.hidden = at < 0 || !this.source.available(id);
            const picked = selected.has(id);
            row.setAttribute('aria-selected', String(picked));
            const box = row.querySelector('input');
            if (box !== null) box.checked = picked;
            row.classList.toggle('wp-multi-active', !row.hidden && id === this.activeId);
            if (row.hidden) continue;
            shown++;
            this.highlight(row, id, at, query.length);
        }
        const empty = this.byId('empty');
        if (empty !== null) empty.hidden = shown > 0;
    }

    /** The name with its matched part in a `<mark>`, built from text nodes so no name is parsed as HTML. */
    private highlight(row: HTMLElement, id: string, at: number, length: number): void {
        const name = row.querySelector('.wp-multi-name');
        if (name === null) return;
        if (length === 0) {
            name.replaceChildren(id);
            return;
        }
        const mark = document.createElement('mark');
        mark.textContent = id.slice(at, at + length);
        name.replaceChildren(id.slice(0, at), mark, id.slice(at + length));
    }

    /** One removable chip per pick, alphabetical; a pick that is not drawn right now says "hidden". */
    private chips(): void {
        const host = this.byId('chips');
        if (host === null) return;
        const picks = [...this.source.selected()].sort((a: string, b: string): number => a.toLowerCase().localeCompare(b.toLowerCase()));
        if (picks.length === 0) {
            const none = document.createElement('span');
            none.className = 'wp-multi-none';
            none.textContent = 'None (off)';
            host.replaceChildren(none);
            return;
        }
        host.replaceChildren(...picks.map((id: string): HTMLElement => this.chip(id)));
    }

    private chip(id: string): HTMLElement {
        const chip = document.createElement('span');
        chip.className = 'wp-multi-chip';
        chip.dataset['wpPick'] = id;
        chip.append(id);
        if (!this.source.available(id)) {
            chip.classList.add('wp-multi-chip-hidden');
            const note = document.createElement('small');
            note.textContent = 'hidden';
            chip.append(' ', note);
        }
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '✕';
        remove.setAttribute('aria-label', `Remove ${id}`);
        remove.addEventListener('click', (ev: MouseEvent) => {
            ev.stopPropagation();
            this.source.toggle(id);
        });
        chip.append(remove);
        return chip;
    }

    private shownRows(): HTMLElement[] {
        return this.rows().filter((row: HTMLElement): boolean => !row.hidden);
    }

    private rows(): HTMLElement[] {
        return Array.from(document.querySelectorAll<HTMLElement>(`#wp-${this.key}-list .wp-multi-option`));
    }

    private idOf(row: HTMLElement): string {
        return row.dataset['wpOption'] ?? '';
    }

    private search(): HTMLInputElement | null {
        return this.byId('search') as HTMLInputElement | null;
    }

    private pop(): HTMLElement | null {
        return this.byId('pop');
    }

    private byId(part: string): HTMLElement | null {
        return document.getElementById(`wp-${this.key}-${part}`);
    }
}
