class WpModeState {
    static readonly MODES = ['runtime', 'architecture', 'impact', 'product'];
    static readonly NAMES = ['Runtime', 'Architecture', 'Impact', 'Product'];
    static readonly SUBTITLES = [
        'where the code can run',
        'servers · clients · APIs',
        'what changed',
        'which products it belongs to',
    ];
    readonly scans: ImpactJson[] = window.__WP_IMPACT__?.scans ?? [];
    kind = '';
    mode = 'runtime';

    /** @param hasProducts some box belongs to a product, so the Product mode has something to show */
    constructor(
        private readonly hasProducts: boolean,
        private readonly viewer: string,
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
            : 'No products here: tag servers, clients and apps product:<name> in their project.json, then regenerate.';
    }

    /** The active scan; null when the page has no Impact data. */
    get impact(): ImpactJson | null {
        return this.scans.find((scan: ImpactJson): boolean => scan.kind === this.kind) ?? null;
    }

    /** '' when Impact can be shown, else the one line the drawer and the Filter popover say instead. */
    impactReason(): string {
        const impact = this.impact;
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

    /** Which impact shade a box gets, from the ACTIVE scan. */
    status(id: string): 'touched' | 'affected' | 'buildInput' | 'untouched' {
        const impact = this.impact;
        if (impact?.touched.includes(id)) return 'touched';
        if (impact?.affected.includes(id)) return 'affected';
        if (impact?.buildInputs.includes(id)) return 'buildInput';
        return 'untouched';
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
