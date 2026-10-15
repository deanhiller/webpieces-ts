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
     */
    constructor(
        private readonly hasProducts: boolean,
        private readonly viewer: string,
        private readonly goalUnavailable: string,
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
    private anchor: SVGGElement | null = null;

    constructor() {
        this.panel.className = 'wp-graph-details wp-impact-why';
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
        this.anchor = node;
        const heading = document.createElement('strong');
        heading.textContent = this.text.title(reason);
        const list = document.createElement('ul');
        for (const line of this.text.lines(reason)) {
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
