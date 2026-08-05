/*
 * Browser-side script for architecture/dependencies.html.
 *
 * graph-visualizer.ts reads this file's COMPILED output with readFileSync, substitutes the DOT
 * placeholder (see viz-client-globals.d.ts) with the JSON-encoded Graphviz DOT, and inlines the result into a <script> tag. So it
 * runs in a browser, never in node — but it is ordinary TypeScript, compiled in place by tsc exactly
 * like the package's bin entry points, and linted like every other file here.
 *
 * IT USED TO BE A COMMITTED .js ASSET, exempted from `no-js-files`, and its own header said why: so the
 * dim/highlight/lock logic "can define ordinary browser functions without tripping the TypeScript lint
 * rules". That is a file existing to dodge the rules — the same anti-pattern as the bin shims this repo
 * deleted, and the same cure applies. The logic is a CLASS now, which is what `no-function-outside-class`
 * was asking for all along; nothing needed a disable.
 *
 * Behaviour, unchanged: after Viz renders the SVG, hovering a box dims the rest and lights its full
 * ancestor+descendant chain; the #wp-lock dropdown PINS one box's chain (the dim survives mouse-leave)
 * and filters the responsibilities cards below the graph to just that chain. "All" clears the lock.
 */

// The DOT placeholder and the `Viz` global are declared once in viz-client-globals.d.ts — both
// scripts share a global scope, so they cannot each declare them. Do NOT spell the placeholder token
// in a comment: the inliner is a blind split/join, so every literal occurrence gets the whole DOT.

/** One traversal direction: the edges to light, and the nodes to walk on to. */
class Direction {
    constructor(
        readonly nodes: Map<string, Set<string>>,
        readonly edges: Map<string, Set<Element>>,
    ) {}
}

/**
 * Indexes the rendered SVG and drives the dim/highlight/lock interaction.
 *
 * The adjacency is DIRECTED and kept as two maps per axis: `in*` is what points AT a node (ancestors,
 * walked upward) and `out*` is what it points to (dependencies, walked downward). Highlighting walks
 * both, so a hovered box lights its entire chain in both directions rather than just its neighbours.
 */
class GraphHighlighter {
    private readonly nodeByName = new Map<string, SVGGElement>();
    private readonly inEdges = new Map<string, Set<Element>>();
    private readonly outEdges = new Map<string, Set<Element>>();
    private readonly inNodes = new Map<string, Set<string>>();
    private readonly outNodes = new Map<string, Set<string>>();

    /**
     * The box the dropdown pinned, or null. Hover still works on top of a lock — leaving a box
     * restores the LOCKED view instead of clearing, so the pinned subgraph stays visible while you
     * scroll down to its responsibility cards.
     */
    private locked: string | null = null;

    constructor(private readonly svg: SVGSVGElement) {}

    /** Index the SVG, then wire hover and the lock dropdown. */
    wire(): void {
        this.indexNodes();
        this.indexEdges();
        this.wireHover();
        this.wireLock();
    }

    private indexNodes(): void {
        this.svg.querySelectorAll('g.node').forEach((g: Element): void => {
            const title = g.querySelector('title');
            if (title !== null && title.textContent !== null) {
                this.nodeByName.set(title.textContent.trim(), g as SVGGElement);
            }
        });
    }

    private indexEdges(): void {
        this.svg.querySelectorAll('g.edge').forEach((edge: Element): void => {
            const title = edge.querySelector('title');
            const text = title === null ? null : title.textContent;
            if (text === null) return;
            const idx = text.indexOf('->');
            if (idx < 0) return;
            const from = text.slice(0, idx).trim();
            const to = text.slice(idx + 2).trim();
            this.ensureEdges(this.outEdges, from).add(edge);
            this.ensureEdges(this.inEdges, to).add(edge);
            this.ensureNodes(this.outNodes, from).add(to);
            this.ensureNodes(this.inNodes, to).add(from);
        });
    }

    private ensureEdges(map: Map<string, Set<Element>>, key: string): Set<Element> {
        const existing = map.get(key);
        if (existing !== undefined) return existing;
        const created = new Set<Element>();
        map.set(key, created);
        return created;
    }

    private ensureNodes(map: Map<string, Set<string>>, key: string): Set<string> {
        const existing = map.get(key);
        if (existing !== undefined) return existing;
        const created = new Set<string>();
        map.set(key, created);
        return created;
    }

    private clear(): void {
        this.svg.classList.remove('wp-dim');
        this.svg.querySelectorAll('.wp-focus, .wp-neighbor, .wp-hl').forEach((el: Element): void => {
            el.classList.remove('wp-focus', 'wp-neighbor', 'wp-hl');
        });
    }

    /**
     * Dim everything, then transitively light ancestors and descendants of `name`: edges reached get
     * `wp-hl`, boxes get `wp-neighbor`. The `visited` set is what makes a cyclic graph terminate.
     */
    private highlight(name: string, focusEl: SVGGElement): void {
        this.clear();
        this.svg.classList.add('wp-dim');
        focusEl.classList.add('wp-focus');
        const directions = [
            new Direction(this.inNodes, this.inEdges),
            new Direction(this.outNodes, this.outEdges),
        ];
        for (const dir of directions) this.walk(name, dir);
    }

    private walk(start: string, dir: Direction): void {
        const visited = new Set<string>();
        const stack = [start];
        while (stack.length > 0) {
            const cur = stack.pop() as string;
            const edges = dir.edges.get(cur);
            if (edges !== undefined) {
                edges.forEach((e: Element): void => { e.classList.add('wp-hl'); });
            }
            const next = dir.nodes.get(cur);
            if (next === undefined) continue;
            next.forEach((name: string): void => {
                if (visited.has(name)) return;
                visited.add(name);
                stack.push(name);
                const g = this.nodeByName.get(name);
                if (g !== undefined) g.classList.add('wp-neighbor');
            });
        }
    }

    /** Leaving a box restores the locked view rather than clearing it outright. */
    private relight(): void {
        if (this.locked === null) {
            this.clear();
            return;
        }
        const g = this.nodeByName.get(this.locked);
        if (g !== undefined) this.highlight(this.locked, g);
    }

    private wireHover(): void {
        this.nodeByName.forEach((g: SVGGElement, name: string): void => {
            g.addEventListener('mouseenter', (): void => { this.highlight(name, g); });
            g.addEventListener('mouseleave', (): void => { this.relight(); });
        });
    }

    private wireLock(): void {
        const lockSelect = document.getElementById('wp-lock') as HTMLSelectElement | null;
        if (lockSelect === null) return;
        lockSelect.addEventListener('change', (): void => {
            this.locked = lockSelect.value === '' ? null : lockSelect.value;
            if (this.locked === null) {
                this.clear();
            } else {
                const g = this.nodeByName.get(this.locked);
                if (g !== undefined) this.highlight(this.locked, g);
            }
            this.filterCards();
        });
    }

    /**
     * Filter the responsibility cards to the locked box's chain by READING BACK the
     * `.wp-focus`/`.wp-neighbor` classes highlight() just set — so there is no second graph walk and
     * the cards can never disagree with the picture.
     */
    private filterCards(): void {
        const lit = new Set<string>();
        if (this.locked !== null) {
            this.svg.querySelectorAll('.wp-focus, .wp-neighbor').forEach((el: Element): void => {
                const title = el.querySelector('title');
                if (title !== null && title.textContent !== null) lit.add(title.textContent.trim());
            });
        }
        document.querySelectorAll('.wp-resp-card').forEach((card: Element): void => {
            const name = card.getAttribute('data-node');
            const visible = this.locked === null || (name !== null && lit.has(name));
            card.classList.toggle('wp-hidden', !visible);
        });
    }
}

/** Renders the DOT and hands the SVG to the highlighter. Reports a failure into the page, not just the console. */
class GraphPage {
    render(): void {
        Viz.instance()
            .then((viz: VizInstance): void => {
                const element = viz.renderSVGElement(__DOT__);
                const host = document.getElementById('graph');
                if (host === null) return;
                host.appendChild(element);
                new GraphHighlighter(element).wire();
            })
            // webpieces-disable no-any-unknown -- a promise rejection reason is untyped BY THE LANGUAGE (any value can be thrown), and this browser script cannot import the repo's toError helper; it is stringified, never dereferenced
            .catch((err: unknown): void => {
                console.error(err);
                const host = document.getElementById('graph');
                if (host !== null) host.innerHTML = '<pre>' + String(err) + '</pre>';
            });
    }
}

new GraphPage().render();
