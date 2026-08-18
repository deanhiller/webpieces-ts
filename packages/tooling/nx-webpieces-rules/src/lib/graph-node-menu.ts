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
 *  - the architecture page already has a `#wp-lock` dropdown backed by GraphHighlighter (chain
 *    highlight + responsibilities filter), and its menu item drives that, so the two stay in sync;
 *  - a design page and the runtime page have neither dropdown nor responsibilities, so they use
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
        g.wp-node-clickable { cursor: pointer; }
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
    private menuScript(): string {
        return `
        class WpNodeMenuItem {
            constructor(label, onSelect) { this.label = label; this.onSelect = onSelect; }
        }
        class WpNodeMenu {
            static close() {
                const open = document.getElementById('wp-node-menu');
                if (open !== null) open.remove();
            }
            static open(nodeEl, name, items) {
                WpNodeMenu.close();
                const menu = document.createElement('div');
                menu.id = 'wp-node-menu';
                menu.className = 'wp-node-menu';
                menu.addEventListener('click', function (ev) { ev.stopPropagation(); });
                const heading = document.createElement('div');
                heading.className = 'wp-node-menu-title';
                heading.textContent = name;
                menu.appendChild(heading);
                for (const item of items) menu.appendChild(WpNodeMenu.button(item));
                document.body.appendChild(menu);
                WpNodeMenu.place(menu, nodeEl);
            }
            static button(item) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'wp-node-menu-item';
                button.textContent = item.label;
                button.addEventListener('click', function (ev) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    WpNodeMenu.close();
                    item.onSelect();
                });
                return button;
            }
            static place(menu, nodeEl) {
                const box = nodeEl.getBoundingClientRect();
                const own = menu.getBoundingClientRect();
                const maxLeft = window.scrollX + document.documentElement.clientWidth - own.width - 8;
                let left = box.left + window.scrollX;
                if (left > maxLeft) left = Math.max(window.scrollX + 8, maxLeft);
                menu.style.left = left + 'px';
                menu.style.top = (box.bottom + window.scrollY + 4) + 'px';
            }
            static wire(svg, itemsFor) {
                svg.querySelectorAll('g.node').forEach(function (node) {
                    const title = node.querySelector('title');
                    const name = title === null || title.textContent === null
                        ? '' : title.textContent.trim();
                    if (name === '') return;
                    node.classList.add('wp-node-clickable');
                    node.addEventListener('click', function (ev) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        WpNodeMenu.open(node, name, itemsFor(name, node));
                    });
                });
            }
        }`;
    }

    /**
     * The lock the DESIGN pages and the RUNTIME page use: neither has a dropdown or a responsibilities
     * list, so locking a box dims every other box in that graph and lights the locked one.
     */
    private lockScript(): string {
        return `
        class WpNodeLock {
            constructor(svg) { this.svg = svg; this.locked = null; }
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
        document.addEventListener('click', function () { WpNodeMenu.close(); });
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') WpNodeMenu.close();
        });`;
    }
}
