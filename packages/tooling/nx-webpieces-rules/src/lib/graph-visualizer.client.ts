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

    protected override captureBinding(_svg: SVGSVGElement | null): () => void {
        const previous = this.highlighter;
        return (): void => { this.highlighter = previous; this.filterCards(); };
    }

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
