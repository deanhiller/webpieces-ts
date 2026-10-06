/**
 * The floating per-node menu, shared by ALL THREE generated graphs.
 *
 * There is exactly ONE implementation of the menu — its CSS, its positioning, its dismissal and the
 * click wiring that opens it — and `architecture/dependencies.html` (graph-visualizer.ts), every
 * project's `design.html` (di-graph/design-visualizer.ts) and `tmp/webpieces/runtime-architecture.html`
 * (runtime-visualizer.ts) all inline these same bytes. Duplicating it into the three emitters is what
 * this module exists to prevent.
 *
 * Why the browser code is emitted as a STRING here rather than living in a compiled `*.client.ts`
 * beside its emitter: `generateDesignHTML` is called straight from a source checkout (by the
 * di-graph-generate executor's unit tests) and has no injection seam for the client text, so a
 * `readCompiledClient` sibling would make the design page unbuildable from source. A string keeps one
 * copy reachable by every emitter with no build-order coupling. The two pages that DO have a compiled
 * client (`graph-visualizer.client.ts`, `runtime-visualizer.client.ts`) call into these classes as
 * ambient globals — see viz-client-globals.d.ts.
 *
 * What the menu does NOT own is the LOCK BEHAVIOUR, because the pages genuinely differ:
 *  - the architecture page already has a `#wp-lock` search field backed by GraphHighlighter (chain
 *    highlight + responsibilities filter), and its menu item drives that, so the two stay in sync;
 *  - a design page and the runtime page have neither lock field nor responsibilities, so they use
 *    `WpNodeLock` below — dim every other box in that graph, light the locked one.
 * All three spell the dim with the SAME class names and the SAME CSS from `dimStyles()`.
 */
export class GraphNodeMenu {
    /**
     * Menu chrome + the "this box is clickable" affordance. Every node is clickable now (the menu
     * replaced direct navigation), so the cursor/glow is on every box rather than only the ones with
     * a design page.
     */
    styles(): string {
        return `
        .wp-node-menu {
            position: absolute;
            z-index: 1000;
            min-width: 150px;
            padding: 4px 0;
            background: white;
            border: 1px solid #cfcfcf;
            border-radius: 6px;
            box-shadow: 0 4px 14px rgba(0,0,0,0.22);
            font-family: Arial, sans-serif;
            font-size: 14px;
        }
        .wp-node-menu-title {
            padding: 4px 14px 6px;
            color: #777;
            font-size: 12px;
            font-family: monospace;
            border-bottom: 1px solid #eee;
            margin-bottom: 4px;
        }
        .wp-node-menu-item {
            display: block;
            width: 100%;
            padding: 7px 14px;
            border: 0;
            background: none;
            color: #1565C0;
            font: inherit;
            text-align: left;
            cursor: pointer;
        }
        .wp-node-menu-item:hover { background: #E3F2FD; }
        .wp-node-menu-item:disabled { color: #9aa0ad; cursor: not-allowed; background: none; }
        .wp-node-menu-item[aria-checked="true"]::after { content: "✓"; float: right; margin-left: 12px; }
        /* A submenu (e.g. the architecture page's "Mode ▸") opens beside its parent item, on hover,
         * on click and on ArrowRight; ArrowLeft returns to the parent. */
        .wp-node-menu-sub-host { position: relative; }
        .wp-node-menu-arrow { float: right; margin-left: 12px; color: #777; }
        .wp-node-menu .wp-node-menu-sub { display: none; left: 100%; top: -5px; }
        .wp-node-menu .wp-node-menu-sub.wp-flip { left: auto; right: 100%; }
        .wp-node-menu-sub-host.wp-open > .wp-node-menu-sub { display: block; }
        g.wp-node-clickable { cursor: pointer; outline: none; }
        /* DOM keyboard focus is independent of graph highlight/Lock and stays dim with its node. */
        g.wp-node-clickable.wp-keyboard-focus {
            outline: 2px dashed #7b1fa2;
            outline-offset: 2px;
        }
        /* Every shape Graphviz (or the runtime page's own queue-cylinder redraw) can emit for a node
         * body: box/record -> polygon, circle -> ellipse, cylinder and the redrawn queue -> path. A
         * shape left out of this list would be a box that is clickable but never looks it. */
        g.wp-node-clickable polygon,
        g.wp-node-clickable ellipse,
        g.wp-node-clickable path { transition: stroke-width 0.12s ease, filter 0.12s ease; }
        g.wp-node-clickable:hover polygon,
        g.wp-node-clickable:hover ellipse,
        g.wp-node-clickable:hover path {
            stroke: #1976d2;
            stroke-width: 5;
            filter: drop-shadow(0 0 6px rgba(25, 118, 210, 0.85));
        }`;
    }

    /**
     * The dim/undim rules a lock (or a hover) toggles, scoped to whatever element holds the rendered
     * SVG on this page (`#graph` on the architecture page, `.graph` on a design page).
     *
     * We ONLY dim: the lit subgraph keeps its exact normal look. The un-dim rules repeat
     * `svg.wp-dim` so they out-specify the dim rule, which carries an extra type selector.
     */
    dimStyles(scope: string): string {
        return `
        ${scope} .node, ${scope} .edge { transition: opacity 0.12s ease; }
        ${scope} svg.wp-dim .node,
        ${scope} svg.wp-dim .edge { opacity: 0.15; }
        ${scope} svg.wp-dim .node.wp-focus,
        ${scope} svg.wp-dim .node.wp-neighbor,
        ${scope} svg.wp-dim .edge.wp-hl { opacity: 1; }`;
    }

    /** The whole browser side: the menu, the design-page lock, and the global dismiss handlers. */
    script(): string {
        return `${this.menuScript()}\n${this.lockScript()}\n${this.dismissScript()}`;
    }

    /**
     * `WpNodeMenuItem` + `WpNodeMenu`. Anchored at the node's own bounding box (bottom-left corner,
     * 4px below it) and clamped so a box at the right edge of a very wide graph still shows its whole
     * menu. Opening a menu closes any other, so at most one is ever on screen.
     */
    private itemScript(): string {
        return `
        class WpNodeMenuItem {
            constructor(label, onSelect, children = []) {
                this.label = label;
                this.onSelect = onSelect;
                this.children = children;
                this.checked = null;
                this.disabledReason = '';
            }
        }`;
    }

    private menuScript(): string {
        return `${this.itemScript()}
        ${WpMenuButton.toString()}
        ${WpSubmenu.toString()}
        class WpNodeMenu {
            static submenu(item) { return new WpSubmenu().build(item, WpNodeMenu.button); }
            ${this.focusScript()}
            static open(nodeEl, name, items) {
                WpNodeMenu.close();
                WpNodeMenu.owner = nodeEl;
                WpNodeMenu.ownerKeyboard = WpNodeMenu.keyboard;
                const menu = document.createElement('div');
                menu.id = 'wp-node-menu';
                menu.className = 'wp-node-menu';
                menu.addEventListener('click', function (ev) { ev.stopPropagation(); });
                const heading = document.createElement('div');
                heading.className = 'wp-node-menu-title';
                heading.textContent = name;
                menu.appendChild(heading);
                for (const item of items) {
                    const hasChildren = Array.isArray(item.children) && item.children.length > 0;
                    menu.appendChild(hasChildren ? WpNodeMenu.submenu(item) : WpNodeMenu.button(item));
                }
                document.body.appendChild(menu);
                WpNodeMenu.place(menu, nodeEl);
                menu.querySelector('button')?.focus({ preventScroll: true });
            }
            static button(item) { return new WpMenuButton().build(item, WpNodeMenu.close.bind(WpNodeMenu)); }
            ${this.positionScript()}
            ${this.keyboardScript()}
            static wire(svg, itemsFor) {
                svg.querySelectorAll('g.node').forEach(function (node) {
                    const title = node.querySelector('title');
                    const name = title === null || title.textContent === null
                        ? '' : title.textContent.trim();
                    if (name === '') return;
                    if (node.classList.contains('wp-layout')) return;
                    if (WpNodeMenu.wired.has(node)) return;
                    WpNodeMenu.wired.add(node);
                    node.addEventListener('focus', function () {
                        node.classList.toggle('wp-keyboard-focus', WpNodeMenu.keyboard);
                    });
                    node.addEventListener('blur', function () {
                        node.classList.remove('wp-keyboard-focus');
                    });
                    node.classList.add('wp-node-clickable');
                    node.setAttribute('tabindex', '0');
                    node.setAttribute('role', 'button');
                    WpNodeMenu.wireKeyboard(node, name, itemsFor);
                    node.addEventListener('click', function (ev) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        WpNodeMenu.open(node, name, itemsFor(name, node));
                    });
                });
            }
        }`;
    }

    private positionScript(): string {
        return `            static place(menu, nodeEl) {
                const box = nodeEl.getBoundingClientRect();
                const own = menu.getBoundingClientRect();
                const maxLeft = window.scrollX + document.documentElement.clientWidth - own.width - 8;
                let left = box.left + window.scrollX;
                if (left > maxLeft) left = Math.max(window.scrollX + 8, maxLeft);
                menu.style.left = left + 'px';
                menu.style.top = (box.bottom + window.scrollY + 4) + 'px';
            }
`;
    }

    /** Explicit input modality avoids Chromium's pointer-focus :focus-visible heuristics. */
    private focusScript(): string {
        return `            static keyboard = false;
            static owner = null;
            static ownerKeyboard = false;
            static wired = new WeakSet();
            static close(returnFocus = false) {
                const open = document.getElementById('wp-node-menu');
                const owner = WpNodeMenu.owner;
                const keyboard = WpNodeMenu.ownerKeyboard;
                WpNodeMenu.owner = null;
                if (open === null) return;
                open.remove();
                if (returnFocus && keyboard && owner?.isConnected) {
                    WpNodeMenu.keyboard = true;
                    owner.focus({ preventScroll: true });
                }
            }
            static focusedName(svg) {
                const active = document.activeElement;
                const menu = document.getElementById('wp-node-menu');
                const node = menu?.contains(active) && WpNodeMenu.ownerKeyboard
                    ? WpNodeMenu.owner : active;
                return svg?.contains(node) && (node === WpNodeMenu.owner || node?.classList.contains('wp-keyboard-focus'))
                    ? node.querySelector('title')?.textContent.trim() : null;
            }
            static restoreFocus(svg, name) {
                if (name == null) return;
                const nodes = Array.from(svg.querySelectorAll('g.wp-node-clickable'));
                const node = nodes.find(node => node.querySelector('title')?.textContent.trim() === name);
                WpNodeMenu.keyboard = true;
                (node || nodes[0])?.focus({ preventScroll: true });
            }
`;
    }

    private keyboardScript(): string {
        return `static wireKeyboard(node, name, itemsFor) {
            node.addEventListener('keydown', function (ev) {
                if (ev.key !== 'Enter' && ev.key !== ' ') return;
                ev.preventDefault();
                ev.stopPropagation();
                WpNodeMenu.keyboard = true;
                WpNodeMenu.open(node, name, itemsFor(name, node));
            });
        }`;
    }

    /**
     * The lock the DESIGN pages and the RUNTIME page use: neither has a lock field or a responsibilities
     * list, so locking a box dims every other box in that graph and lights the locked one.
     */
    private lockScript(): string {
        return `
        class WpNodeLock {
            constructor(svg) { this.svg = svg; this.locked = null; }
            rebind(svg) {
                const name = this.locked;
                this.svg = svg;
                this.clear();
                this.locked = name;
                if (name === null) return;
                for (const node of svg.querySelectorAll('g.node')) {
                    if (node.querySelector('title')?.textContent === name) {
                        this.lock(name, node);
                        break;
                    }
                }
            }
            isLocked(name) { return this.locked === name; }
            toggle(name, nodeEl) {
                if (this.locked === name) this.clear();
                else this.lock(name, nodeEl);
            }
            lock(name, nodeEl) {
                this.clear();
                this.locked = name;
                this.svg.classList.add('wp-dim');
                nodeEl.classList.add('wp-focus');
            }
            clear() {
                this.locked = null;
                this.svg.classList.remove('wp-dim');
                this.svg.querySelectorAll('.wp-focus').forEach(function (el) {
                    el.classList.remove('wp-focus');
                });
            }
        }`;
    }

    /** Outside click and Escape both dismiss — wired once, on the document. */
    private dismissScript(): string {
        return `
        document.addEventListener('pointerdown', function () {
            WpNodeMenu.keyboard = false;
            document.querySelectorAll('.wp-keyboard-focus').forEach(function (node) {
                node.classList.remove('wp-keyboard-focus');
            });
        }, true);
        document.addEventListener('click', function () { WpNodeMenu.close(); });
        document.addEventListener('keydown', function (ev) {
            if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
            WpNodeMenu.keyboard = true;
            const active = document.activeElement;
            if (active?.classList.contains('wp-node-clickable')) active.classList.add('wp-keyboard-focus');
            if (ev.key === 'Escape') WpNodeMenu.close(true);
        }, true);`;
    }
}

/**
 * One plain menu item. Selecting it closes the menu (returning keyboard focus to the box it was
 * opened from) and then runs the item. A radio item (`checked` true/false) is announced as one, and
 * an item with a `disabledReason` is disabled with that reason as its tooltip.
 *
 * Serialized with `toString()`, like WpSubmenu below; `close` is handed in because WpNodeMenu, which
 * owns it, is declared after this class in the emitted script.
 */
class WpMenuButton {
    build(item: WpNodeMenuItem, close: (returnFocus: boolean) => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wp-node-menu-item';
        button.textContent = item.label;
        if (item.checked === true || item.checked === false) {
            button.setAttribute('role', 'menuitemradio');
            button.setAttribute('aria-checked', String(item.checked));
        }
        if (item.disabledReason) {
            button.disabled = true;
            button.title = item.disabledReason;
        }
        button.addEventListener('click', (ev: MouseEvent): void => {
            ev.preventDefault();
            ev.stopPropagation();
            close(true);
            item.onSelect();
        });
        return button;
    }
}

/**
 * A menu item that opens a nested menu beside it — the architecture page's "Mode ▸".
 *
 * Real TypeScript serialized into every page's menu script with `toString()` (the technique
 * GraphNavigation uses), so it is type-checked here and still needs no compiled sibling file: the
 * design pages render straight from a source checkout. It touches nothing but the DOM and the
 * `button` builder it is handed, because nothing else exists where it runs.
 *
 * An item without children renders exactly as before, so the runtime page and the design pages —
 * which never build one — are unaffected.
 */
class WpSubmenu {
    build(
        item: WpNodeMenuItem,
        button: (child: WpNodeMenuItem) => HTMLButtonElement,
    ): HTMLDivElement {
        const host = document.createElement('div');
        host.className = 'wp-node-menu-sub-host';
        const parent = document.createElement('button');
        parent.type = 'button';
        parent.className = 'wp-node-menu-item wp-node-menu-parent';
        parent.setAttribute('aria-haspopup', 'menu');
        parent.setAttribute('aria-expanded', 'false');
        parent.textContent = item.label;
        const arrow = document.createElement('span');
        arrow.className = 'wp-node-menu-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '▸';
        parent.append(arrow);
        const sub = document.createElement('div');
        sub.className = 'wp-node-menu wp-node-menu-sub';
        sub.setAttribute('role', 'menu');
        sub.setAttribute('aria-label', item.label);
        for (const child of item.children) sub.append(button(child));
        host.append(parent, sub);
        this.wire(host, parent, sub);
        return host;
    }

    private wire(host: HTMLDivElement, parent: HTMLButtonElement, sub: HTMLDivElement): void {
        const enter = (): void => {
            this.show(host, parent, sub, true);
            sub.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus({ preventScroll: true });
        };
        host.addEventListener('mouseenter', (): void => this.show(host, parent, sub, true));
        host.addEventListener('mouseleave', (): void => this.show(host, parent, sub, false));
        parent.addEventListener('click', (ev: MouseEvent): void => {
            ev.preventDefault();
            ev.stopPropagation();
            enter();
        });
        parent.addEventListener('keydown', (ev: KeyboardEvent): void => {
            if (ev.key !== 'ArrowRight') return;
            ev.preventDefault();
            enter();
        });
        sub.addEventListener('keydown', (ev: KeyboardEvent): void => {
            if (ev.key !== 'ArrowLeft') return;
            ev.preventDefault();
            this.show(host, parent, sub, false);
            parent.focus({ preventScroll: true });
        });
    }

    /** Opens to the right, or to the LEFT when the right would run off the viewport. */
    private show(host: HTMLDivElement, parent: HTMLButtonElement, sub: HTMLDivElement, open: boolean): void {
        host.classList.toggle('wp-open', open);
        parent.setAttribute('aria-expanded', String(open));
        if (!open) return;
        sub.classList.remove('wp-flip');
        const right = host.getBoundingClientRect().right + sub.offsetWidth + 8;
        if (right > document.documentElement.clientWidth) sub.classList.add('wp-flip');
    }
}
