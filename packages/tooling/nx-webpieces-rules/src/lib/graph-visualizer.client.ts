/** Architecture interactions bind to each new SVG; logical Lock/Filter state belongs to the page. */
class GraphHighlighter {
    private readonly nodeByName = new Map<string, SVGGElement>();

    constructor(
        private readonly svg: SVGSVGElement,
        private readonly chain: WpGraphChain,
        private readonly model: RenderModelJson,
        private readonly page: GraphPage,
    ) {}

    wire(): void {
        this.svg.querySelectorAll<SVGGElement>('g.node').forEach((g) => {
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
        this.svg.querySelectorAll('.wp-focus, .wp-neighbor, .wp-hl').forEach((el) => {
            el.classList.remove('wp-focus', 'wp-neighbor', 'wp-hl');
        });
    }

    private highlight(name: string): void {
        this.clear();
        const focus = this.nodeByName.get(name);
        if (focus === undefined) return;
        const lit = this.chain.nodes(name);
        this.svg.classList.add('wp-dim');
        focus.classList.add('wp-focus');
        for (const id of lit) this.nodeByName.get(id)?.classList.add('wp-neighbor');
        for (const edge of this.model.edges) {
            if (lit.has(edge.from) && lit.has(edge.to)) {
                this.svg.querySelector(`[id="${edge.id}"]`)?.classList.add('wp-hl');
            }
        }
    }

    relight(): void {
        const locked = this.page.lockSelection();
        if (locked === null) this.clear();
        else this.highlight(locked);
    }

    private wireHover(): void {
        this.nodeByName.forEach((g, name) => {
            g.addEventListener('mouseenter', () => this.highlight(name));
            g.addEventListener('mouseleave', () => this.relight());
        });
    }

    private wireMenu(): void {
        const designs = new Map(__DESIGN_LINKS__.map((link) => [link.nodeId, link.href]));
        WpNodeMenu.wire(this.svg, (name) => {
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
            return items;
        });
    }
}

class GraphPage extends WpFilterPage {
    private highlighter: GraphHighlighter | null = null;

    protected override wireControls(): void {
        const select = document.getElementById('wp-lock') as HTMLSelectElement | null;
        select?.addEventListener('change', () =>
            this.setLock(select.value === '' ? null : select.value),
        );
    }

    protected wireSvg(svg: SVGSVGElement): void {
        this.highlighter = new GraphHighlighter(svg, this.chain, this.model, this);
        this.highlighter.wire();
        this.filterCards();
        svg.querySelectorAll<SVGGElement>('g.node').forEach((node) => {
            if (node.querySelector('title')?.textContent === this.anchor)
                node.classList.add('wp-filter-anchor');
        });
    }

    lockSelection(): string | null {
        return this.locked;
    }

    setLock(name: string | null): void {
        this.locked = name;
        const select = document.getElementById('wp-lock') as HTMLSelectElement | null;
        if (select !== null) select.value = name ?? '';
        this.highlighter?.relight();
        this.filterCards();
    }

    private filterCards(): void {
        const lit = this.locked === null ? this.retained : this.chain.nodes(this.locked);
        document.querySelectorAll('.wp-resp-card').forEach((card) => {
            const name = card.getAttribute('data-node');
            card.classList.toggle(
                'wp-hidden',
                name === null || !this.retained.has(name) || !lit.has(name),
            );
        });
    }
}

new GraphPage(__RENDER_MODEL__).render();
