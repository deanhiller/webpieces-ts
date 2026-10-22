class WpModeState {
    /** `goal` (Goal vs Current, #1239) exists on runtime pages only; the shell renders it nowhere else. */
    static readonly MODES = ['runtime', 'architecture', 'impact', 'product', 'goal'];
    static readonly NAMES = ['Runtime', 'Architecture', 'Impact', 'Product', 'Goal vs Current'];
    static readonly SUBTITLES = [
        'where the code can run',
        'servers · clients · APIs',
        'what changed',
        'which products it belongs to',
        'Current → Goal proposal',
    ];
    readonly scans: ImpactJson[] = window.__WP_IMPACT__?.scans ?? [];
    kind = '';
    mode = 'runtime';

    /**
     * @param hasProducts some box belongs to a product, so the Product mode has something to show
     * @param goalUnavailable '' when Goal vs Current can be shown, else why not (#1239)
     * @param goalNote the line shown under the dimmed Goal vs Current item, e.g.
     *        "runtime-dependencies-goal.json does not exist" (#1373); '' when it can be shown
     */
    constructor(
        private readonly hasProducts: boolean,
        private readonly viewer: string,
        private readonly goalUnavailable: string,
        private readonly goalNote: string = goalUnavailable,
    ) {
        this.kind = this.initialKind();
        this.mode = this.initial();
    }

    private storageKey(kind: string): string {
        return `wp-${this.viewer}-graph-${kind}`;
    }

    /** '' when Product can be shown, else why not. */
    productReason(): string {
        return this.hasProducts
            ? ''
            : 'No products here: tag each project product:<name> in its project.json, then regenerate.';
    }

    /** '' when Goal vs Current can be shown, else why not (a missing or unusable input, never "no differences"). */
    goalReason(): string {
        return this.goalUnavailable;
    }

    /** The Goal vs Current item's second line: its subtitle, or the short reason it is dimmed (#1373). */
    goalSubtitle(): string {
        return this.goalUnavailable === '' ? this.subtitle('goal') : this.goalNote;
    }

    /** The active scan; null when the page has no Impact data. */
    get impact(): ImpactJson | null {
        return this.scans.find((scan: ImpactJson): boolean => scan.kind === this.kind) ?? null;
    }

    /** '' when Impact can be shown, else the one line the drawer and the Filter popover say instead. */
    impactReason(): string {
        const impact = this.impact;
        if (
            impact === null &&
            this.viewer === 'runtime' &&
            document.body.dataset['wpProjectFacts'] === 'false'
        )
            return 'No saved project facts for Impact. Run pnpm nx run architecture:generate, then pnpm arch:visualize-runtime.';
        if (impact === null)
            return `No impact data here. Run pnpm arch:visualize${this.viewer === 'runtime' ? '-runtime' : ''} to compute it — no full regenerate needed.`;
        return impact.available ? '' : `Impact unavailable (${impact.label}): ${impact.reason}.`;
    }

    /** Switch the active scan; false (and nothing changes) for a missing or unavailable one. */
    setKind(kind: string): boolean {
        if (!this.kindAvailable(kind)) return false;
        this.kind = kind;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- storage is a per-viewer convenience; a blocked store must not break the page
        try {
            localStorage.setItem(this.storageKey('impact-kind'), kind);
            // webpieces-disable no-any-unknown -- browsers may throw any value from blocked storage
        } catch (err: unknown) {
            //const error = toError(err);
            void err;
        }
        return true;
    }

    kindAvailable(kind: string): boolean {
        return this.scans.some((scan: ImpactJson): boolean => scan.kind === kind && scan.available);
    }

    private initialKind(): string {
        const stored = this.read(this.storageKey('impact-kind'));
        if (stored !== null && this.kindAvailable(stored)) return stored;
        const preferred = window.__WP_IMPACT__?.defaultKind ?? '';
        if (this.scans.some((scan: ImpactJson): boolean => scan.kind === preferred))
            return preferred;
        return this.scans[0]?.kind ?? '';
    }

    available(mode: string): boolean {
        if (!WpModeState.MODES.includes(mode)) return false;
        if (mode === 'impact') return this.impactReason() === '';
        if (mode === 'product') return this.productReason() === '';
        if (mode === 'goal') return this.goalReason() === '';
        return true;
    }

    name(mode: string): string {
        return WpModeState.NAMES[WpModeState.MODES.indexOf(mode)] ?? mode;
    }

    subtitle(mode: string): string {
        return WpModeState.SUBTITLES[WpModeState.MODES.indexOf(mode)] ?? '';
    }

    /** False (and nothing changes) for an unknown or unavailable mode. */
    set(mode: string): boolean {
        if (!this.available(mode)) return false;
        this.mode = mode;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- storage is a per-viewer convenience; a blocked store must not break the page
        try {
            localStorage.setItem(this.storageKey('mode'), mode);
            if (location.hash !== `#${mode}`) history.replaceState(null, '', `#${mode}`);
            // webpieces-disable no-any-unknown -- browsers may throw any value from blocked storage
        } catch (err: unknown) {
            //const error = toError(err);
            void err;
        }
        return true;
    }

    /** Which impact shade a box gets, from the ACTIVE scan: WHY nx included it (#1264). */
    status(id: string): 'touched' | 'dependent' | 'implicit' | 'rootFile' | 'unexplained' | 'buildInput' | 'untouched' {
        const impact = this.impact;
        if (impact?.touched.includes(id)) return 'touched';
        if (impact?.dependents.includes(id)) return 'dependent';
        if (impact?.implicit.includes(id)) return 'implicit';
        if (impact?.rootFile.includes(id)) return 'rootFile';
        if (impact?.unexplained.includes(id)) return 'unexplained';
        if (impact?.buildInputs.includes(id)) return 'buildInput';
        return 'untouched';
    }

    /** Every affected node id of the active scan, whatever its reason. */
    affected(): string[] {
        const impact = this.impact;
        if (impact === null) return [];
        return [...impact.touched, ...impact.dependents, ...impact.implicit, ...impact.rootFile, ...impact.unexplained];
    }

    /** The edges gained and lost since the fork point that THIS page draws: build deps or runtime calls. */
    edgeChanges(): EdgeChangeJson[] {
        const edges = window.__WP_IMPACT__?.edges;
        if (edges === undefined) return [];
        return this.viewer === 'runtime' ? edges.runtime : edges.dependency;
    }

    /** '' when this page's edge changes were computed (even if none), else why the page shows none. */
    edgeReason(): string {
        const edges = window.__WP_IMPACT__?.edges;
        if (edges === undefined) return 'No edge changes here. Run pnpm arch:visualize to compute them.';
        return this.viewer === 'runtime' ? edges.runtimeReason : edges.dependencyReason;
    }

    /** Every box at either end of a changed edge: the Filter's "Edge changes only". */
    edgeEnds(): Set<string> {
        const ends = new Set<string>();
        for (const change of this.edgeChanges()) {
            ends.add(change.from);
            ends.add(change.to);
        }
        return ends;
    }

    /** "Edges since abc1234: 1 gained · 1 lost." — or why there are none to show. */
    edgeNote(): string {
        const reason = this.edgeReason();
        if (reason !== '') return `${reason}.`;
        const changes = this.edgeChanges();
        const gained = changes.filter((change: EdgeChangeJson): boolean => change.change === 'gained').length;
        return `Edges since ${window.__WP_IMPACT__?.edges.base ?? ''}: ${gained} gained · ${changes.length - gained} lost.`;
    }

    /** Why `id` is in the active scan's build; null when it is not affected. */
    reason(id: string): AffectedReasonJson | null {
        return this.impact?.reasons.find((reason: AffectedReasonJson): boolean => reason.project === id) ?? null;
    }

    private initial(): string {
        const hashed = location.hash.slice(1);
        if (this.available(hashed)) return hashed;
        const stored = this.read(this.storageKey('mode'));
        if (stored !== null && this.available(stored)) return stored;
        return 'runtime';
    }

    private read(key: string): string | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- storage is a per-viewer convenience; a blocked store reads as "nothing stored"
        try {
            return localStorage.getItem(key);
            // webpieces-disable no-any-unknown -- browsers may throw any value from blocked storage
        } catch (err: unknown) {
            //const error = toError(err);
            void err;
            return null;
        }
    }
}

/**
 * What the "why" panel says about one affected project (#1264): never a reason the graph cannot show.
 * Pure text, so a spec reads it without a browser; GraphPage puts it in a panel.
 */
class WpImpactWhy {
    static readonly TITLES: Record<string, string> = {
        touched: 'Changed',
        dependent: 'Dependent',
        implicit: 'Implicitly touched',
        rootFile: 'Root-file touched',
        unexplained: 'Unexplained',
    };

    /**
     * `8 changed · 3 dependents · 22 implicitly touched (runtime-wiring-check inputs) · 47 dependencies`
     * — the same split ImpactCounts (graph-impact.ts) prints on the console.
     */
    counts(impact: ImpactJson): string {
        const parts = [`${impact.touched.length} changed`, `${impact.dependents.length} dependents`];
        if (impact.implicit.length > 0) {
            const targets = [
                ...new Set(
                    impact.reasons
                        .filter((reason: AffectedReasonJson): boolean => reason.kind === 'implicit' && reason.target !== '')
                        .map((reason: AffectedReasonJson): string => reason.target),
                ),
            ].sort();
            parts.push(`${impact.implicit.length} implicitly touched${targets.length === 0 ? '' : ` (${targets.join(', ')} inputs)`}`);
        }
        if (impact.rootFile.length > 0) parts.push(`${impact.rootFile.length} root-file touched`);
        if (impact.unexplained.length > 0) parts.push(`${impact.unexplained.length} unexplained`);
        parts.push(`${impact.buildInputs.length} dependencies`);
        return parts.join(' · ');
    }

    title(reason: AffectedReasonJson): string {
        return `${WpImpactWhy.TITLES[reason.kind] ?? reason.kind}: ${reason.project}`;
    }

    lines(reason: AffectedReasonJson): string[] {
        if (reason.kind === 'touched') {
            const owns = reason.files.length === 1 ? 'this changed file' : `these ${reason.files.length} changed files`;
            return [`It owns ${owns}:`, ...reason.files];
        }
        if (reason.kind === 'dependent')
            return [
                'It uses a changed or touched project through these dependency edges, so its tests and build re-run:',
                reason.path.join(' -> '),
            ];
        if (reason.kind === 'implicit')
            return [
                reason.target === '' ? reason.detail : `${reason.target} input ${reason.input} matched ${reason.files.join(', ')}`,
                'nx marks every project whose target input glob matches a changed file. It uses no changed project.',
            ];
        if (reason.kind === 'rootFile')
            return [
                reason.detail,
                ...(reason.path.length > 0 ? [reason.path.join(' -> ')] : []),
                'nx marked it for a workspace root file; it uses no changed project.',
            ];
        return [reason.detail];
    }
}

/**
 * The "why is this in the build?" panel (#1264): opened from an affected box's menu in Impact mode.
 * Text nodes only, so no project name is parsed as HTML.
 */
class ImpactWhyPanel {
    private readonly panel = document.createElement('div');
    private readonly text = new WpImpactWhy();
    private anchor: SVGElement | null = null;

    constructor() {
        this.panel.className = 'wp-impact-why';
        this.panel.hidden = true;
        this.panel.setAttribute('role', 'dialog');
        this.panel.setAttribute('aria-label', 'Why this project is in the build');
        document.body.append(this.panel);
        document.addEventListener('keydown', (ev: KeyboardEvent) => {
            if (ev.key !== 'Escape' || this.panel.hidden) return;
            ev.stopPropagation();
            this.close();
        }, true);
        document.addEventListener('click', (ev: MouseEvent) => {
            const target = ev.target;
            if (target instanceof Node && !this.panel.contains(target) && !this.anchor?.contains(target)) this.close();
        });
    }

    open(node: SVGGElement, reason: AffectedReasonJson): void {
        this.show(node, this.text.title(reason), this.text.lines(reason));
    }

    /** Any heading and lines, anchored under `node` (a box, or a changed edge). */
    show(node: SVGElement, title: string, lines: string[]): void {
        this.anchor = node;
        const heading = document.createElement('strong');
        heading.textContent = title;
        const list = document.createElement('ul');
        for (const line of lines) {
            const item = document.createElement('li');
            item.textContent = line;
            list.append(item);
        }
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'Close';
        close.addEventListener('click', () => this.close());
        this.panel.replaceChildren(heading, list, close);
        this.panel.hidden = false;
        const box = node.getBoundingClientRect();
        this.panel.style.left = `${Math.max(12, Math.min(box.left, innerWidth - this.panel.offsetWidth - 12))}px`;
        this.panel.style.top = `${Math.max(12, Math.min(box.bottom + 6, innerHeight - this.panel.offsetHeight - 12))}px`;
        close.focus({ preventScroll: true });
    }

    close(): void {
        if (this.panel.hidden) return;
        this.panel.hidden = true;
        const anchor = this.anchor;
        this.anchor = null;
        if (anchor?.isConnected) anchor.focus({ preventScroll: true });
    }
}

/** A changed edge the saved page does not draw: added to the Impact overlay. */
class WpOverlayEdge implements RenderEdgeJson {
    readonly crossesInto: string[] = [];

    constructor(
        readonly id: string,
        readonly from: string,
        readonly to: string,
        readonly dot: string,
    ) {}
}

/** The page's own model with the overlay's edges: same boxes, levels and frame. */
class WpOverlayModel implements RenderModelJson {
    readonly viewer: 'architecture' | 'runtime';
    readonly nodes: RenderNodeJson[];
    readonly bands: RenderBandJson[];
    readonly fullDot: string;
    readonly header: string;
    readonly footer: string;
    readonly comparison: RuntimeComparisonJson | null;
    readonly legend: LegendJson;

    constructor(
        base: RenderModelJson,
        readonly edges: RenderEdgeJson[],
    ) {
        this.legend = base.legend;
        this.viewer = base.viewer;
        this.nodes = base.nodes;
        this.bands = base.bands;
        this.fullDot = base.fullDot;
        this.header = base.header;
        this.footer = base.footer;
        this.comparison = base.comparison ?? null;
    }
}

/**
 * The edges this branch gained or lost since its fork point, drawn over the page in Impact mode
 * (#1264). A changed edge the page already draws is restyled; one it does not (the page is the saved
 * snapshot, the diff is against the LIVE graph) is added: a gained edge solid red and bold, a lost one
 * a red dashed ghost. Every changed edge is clickable, and a box whose only change is an edge gets a
 * red badge.
 */
class WpEdgeOverlay {
    static readonly RED = '#d32f2f';
    static readonly PREFIX = 'wp-edge-change-';
    /** pair key → that pair's changes; null until first asked. */
    private pairs: Map<string, EdgeChangeJson[]> | null = null;
    /** Rendered edge id → the changes it stands for. */
    private readonly byEdgeId = new Map<string, EdgeChangeJson[]>();
    private overlay: RenderModelJson | null = null;

    constructor(private readonly modes: WpModeState) {}

    private key(from: string, to: string): string {
        return `${from}\u0000${to}`;
    }

    private grouped(): Map<string, EdgeChangeJson[]> {
        if (this.pairs !== null) return this.pairs;
        this.pairs = new Map<string, EdgeChangeJson[]>();
        for (const change of this.modes.edgeChanges()) {
            const key = this.key(change.from, change.to);
            this.pairs.set(key, [...(this.pairs.get(key) ?? []), change]);
        }
        return this.pairs;
    }

    any(): boolean {
        return this.modes.edgeChanges().length > 0;
    }

    /** `base` plus a ghost statement for every changed edge it does not draw (both ends must be boxes). */
    model(base: RenderModelJson): RenderModelJson {
        if (this.overlay !== null) return this.overlay;
        const ids = new Set(base.nodes.map((node: RenderNodeJson): string => node.id));
        const drawn = new Set(base.edges.map((edge: RenderEdgeJson): string => this.key(edge.from, edge.to)));
        const extra: RenderEdgeJson[] = [];
        for (const key of this.grouped().keys()) {
            const changes = this.grouped().get(key) as EdgeChangeJson[];
            const from = changes[0].from;
            const to = changes[0].to;
            if (drawn.has(key) || !ids.has(from) || !ids.has(to)) continue;
            const id = `${WpEdgeOverlay.PREFIX}${extra.length}`;
            const dot = `  "${this.esc(from)}" -> "${this.esc(to)}" [id="${id}", constraint=false${this.attrs(changes)}];\n`;
            this.byEdgeId.set(id, changes);
            extra.push(new WpOverlayEdge(id, from, to, dot));
        }
        this.overlay = new WpOverlayModel(base, [...base.edges, ...extra]);
        return this.overlay;
    }

    /** A drawn edge's statement restyled when it changed; null when it did not. */
    edgeDot(edge: RenderEdgeJson): string | null {
        if (edge.id.startsWith(WpEdgeOverlay.PREFIX)) return edge.dot;
        const changes = this.grouped().get(this.key(edge.from, edge.to));
        if (changes === undefined) return null;
        this.byEdgeId.set(edge.id, changes);
        return `${edge.dot.slice(0, -2)} [${this.attrs(changes).slice(2)}];\n`;
    }

    /** Gained (any API new) is solid, bold red; otherwise a lost edge is a red dashed ghost. */
    private attrs(changes: EdgeChangeJson[]): string {
        const gained = changes.some((change: EdgeChangeJson): boolean => change.change === 'gained');
        const tooltip = this.esc(changes.map((change: EdgeChangeJson): string => change.text).join('; '));
        return `, color="${WpEdgeOverlay.RED}", fontcolor="${WpEdgeOverlay.RED}", penwidth=${gained ? '3' : '2'}, style="${gained ? 'bold' : 'dashed'}", tooltip="${tooltip}"`;
    }

    private esc(text: string): string {
        return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    /** The lines for one box's edge changes ("new on this branch: …", "… no longer calls …"). */
    nodeLines(id: string): string[] {
        return this.modes
            .edgeChanges()
            .filter((change: EdgeChangeJson): boolean => change.from === id || change.to === id)
            .map((change: EdgeChangeJson): string => change.text);
    }

    /** Every changed edge clickable; a red badge on each box whose ONLY change is an edge. */
    decorate(svg: SVGSVGElement, panel: ImpactWhyPanel): void {
        for (const id of this.byEdgeId.keys()) {
            const edge = svg.querySelector<SVGGElement>(`g.edge[id="${id}"]`);
            const changes = this.byEdgeId.get(id) as EdgeChangeJson[];
            if (edge === null) continue;
            edge.classList.add('wp-edge-change');
            edge.setAttribute('tabindex', '0');
            edge.setAttribute('role', 'button');
            const title = changes.some((change: EdgeChangeJson): boolean => change.change === 'gained') ? 'Gained edge' : 'Lost edge';
            const show = (ev: Event): void => {
                ev.stopPropagation();
                panel.show(edge, title, changes.map((change: EdgeChangeJson): string => change.text));
            };
            edge.addEventListener('click', show);
            edge.addEventListener('keydown', (ev: KeyboardEvent) => {
                if (ev.key === 'Enter' || ev.key === ' ') show(ev);
            });
        }
        const affected = new Set(this.modes.affected());
        const ends = this.modes.edgeEnds();
        svg.querySelectorAll<SVGGElement>('g.node').forEach((node: SVGGElement) => {
            const id = node.querySelector('title')?.textContent ?? '';
            if (!ends.has(id) || affected.has(id)) return;
            node.append(this.badge(node));
        });
    }

    private badge(node: SVGGElement): SVGGElement {
        const ns = 'http://www.w3.org/2000/svg';
        const box = node.getBBox();
        const group = document.createElementNS(ns, 'g');
        group.setAttribute('class', 'wp-edge-badge');
        const circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('cx', String(box.x + box.width - 2));
        circle.setAttribute('cy', String(box.y + 2));
        circle.setAttribute('r', '8');
        circle.setAttribute('fill', WpEdgeOverlay.RED);
        const text = document.createElementNS(ns, 'text');
        text.setAttribute('x', String(box.x + box.width - 2));
        text.setAttribute('y', String(box.y + 6));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', '12');
        text.setAttribute('fill', '#ffffff');
        text.textContent = '±';
        const hint = document.createElementNS(ns, 'title');
        hint.textContent = 'Only its edges changed on this branch';
        group.append(circle, text, hint);
        return group;
    }
}
