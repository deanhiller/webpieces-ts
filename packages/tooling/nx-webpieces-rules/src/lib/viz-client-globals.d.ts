/*
 * Ambient globals shared by the two browser-side visualizer scripts (graph-visualizer.client.ts and
 * runtime-visualizer.client.ts).
 *
 * They live HERE, in one .d.ts, rather than in each script, because both scripts are global SCRIPTS —
 * they have no import or export, which is precisely what makes tsc emit them as plain browser code with
 * no CommonJS wrapper. Two scripts in one program share a global scope, so declaring the render-model placeholder in both
 * is a redeclaration error. One shared declaration file is the fix, and it costs nothing at runtime:
 * a .d.ts emits no JavaScript.
 */

/**
 * The design pages that EXIST, as JSON — substituted the same way `__RENDER_MODEL__` is. A node absent from
 * it has no design.html, so its menu gets no "View Design" item at all.
 *
 * It is JSON, so its element type must be a structural declaration rather than one of the repo's
 * data CLASSES: nothing constructs these in the browser, the page is handed them already parsed.
 */
declare const __DESIGN_LINKS__: DesignLinkJson[];

interface DesignLinkJson {
    nodeId: string;
    href: string;
}

/**
 * The shared floating node menu, emitted by graph-node-menu.ts into a <script> ahead of this one.
 * Declared (not imported) because these are global scripts — see the header above.
 */
declare class WpNodeMenuItem {
    constructor(label: string, onSelect: () => void);
    label: string;
    onSelect: () => void;
}

declare class WpNodeMenu {
    /** Give every `g.node` of `svg` a click that opens the menu with the items the callback builds. */
    static wire(
        svg: SVGSVGElement,
        itemsFor: (name: string, node: SVGGElement) => WpNodeMenuItem[],
    ): void;
    static open(node: SVGGElement, name: string, items: WpNodeMenuItem[]): void;
    static close(returnFocus?: boolean): void;
    static focusedName(svg: SVGSVGElement | null): string | null;
    static restoreFocus(svg: SVGSVGElement, name: string | null): void;
}

/**
 * The field-less lock, also from graph-node-menu.ts: dim every other box in one rendered graph and
 * light the locked one. Used by design.html;
 * the two architecture viewers do NOT use it — its lock is GraphHighlighter.setLock(), which also has a
 * lock search field and a responsibilities list to keep in step.
 */
declare class WpNodeLock {
    constructor(svg: SVGSVGElement);
    rebind(svg: SVGSVGElement): void;
    isLocked(name: string): boolean;
    toggle(name: string, nodeEl: SVGGElement): void;
}

/** The @viz-js/viz v3 UMD global the generated page loads from a CDN before this script runs. */
declare const Viz: VizGlobal;

interface VizGlobal {
    /** v3 resolves the WASM-backed renderer here; v2's `new Viz()` no longer exists. */
    instance(): Promise<VizInstance>;
}

interface VizInstance {
    /** SYNCHRONOUS in v3 — v2's returned a promise, which is why callers use it directly in then(). */
    renderSVGElement(dot: string): SVGSVGElement;
}

/** JSON renderer records; structural types because the browser receives deserialized data. */
declare const __RENDER_MODEL__: RenderModelJson;
interface RenderModelJson {
    viewer: 'architecture' | 'runtime';
    nodes: RenderNodeJson[];
    edges: RenderEdgeJson[];
    bands: RenderBandJson[];
    fullDot: string;
    header: string;
    footer: string;
}

interface RenderNodeJson {
    id: string;
    dot: string;
    /** The architecture graph's per-mode statements (graph-color-modes.ts); present on runtime services; contextual nodes retain kind styling. */
    modes: NodeModeDotsJson | null;
    /** What the architecture page's Filter matches on; present on runtime services; contextual nodes retain kind styling. */
    tags: NodeTagsJson | null;
    /** The products the box belongs to (#1179), on BOTH graphs — what each page's product filter matches. */
    products: string[];
}
interface NodeTagsJson {
    level: number;
    role: string;
    frameworks: string[];
}
interface NodeModeDotsJson {
    runtime: string;
    architecture: string;
    touched: string;
    affected: string;
    buildInput: string;
    untouched: string;
    /** Product color mode (#1179). */
    product: string;
}

/**
 * Impact mode's data, set by the gitignored sidecar architecture/.impact/dependencies.impact.js
 * (graph-impact.ts) when one exists. Absent when the page is opened without one.
 */
interface ImpactDataJson {
    /** One scan per comparison that exists here: "branch" (fork point) and/or "commit" (HEAD^). */
    scans: ImpactJson[];
    /** The scan the page shows until the viewer picks another. */
    defaultKind: string;
}

/** One comparison's scan. */
interface ImpactJson {
    /** 'branch' (fork point → working tree) or 'commit' (HEAD^ → working tree). */
    kind: string;
    /** What the page says the scan compares, e.g. "Changed on this branch (since abc1234)". */
    label: string;
    /** Uncommitted or untracked work counted (the label already says so). */
    dirty: boolean;
    available: boolean;
    /** Why the scan is unavailable; for an available but empty scan, the note to show. */
    reason: string;
    /** The base's short sha. */
    base: string;
    /** In nx affected AND owning a changed file. */
    touched: string[];
    /** The rest of nx affected: their ci re-runs. */
    affected: string[];
    /** Transitive dependencies of the affected set that are not affected themselves. */
    buildInputs: string[];
    changedFiles: number;
    /** Transitive dependencies of the touched set that are not touched: "Changed + dependencies". */
    dependencies: string[];
    /** Changed files no project owns (workspace-global inputs such as pnpm-lock.yaml). */
    globalFiles: string[];
}
interface Window {
    __WP_IMPACT__?: ImpactDataJson;
    __WP_RUNTIME__?: RuntimeViewerBinding;
}
interface RuntimeViewerBinding {
    prepare(svg: SVGSVGElement): void;
    implementsItem(name: string, node: SVGGElement): WpNodeMenuItem | null;
}
interface RenderEdgeJson {
    from: string;
    to: string;
    dot: string;
    id: string;
}
interface RenderBandJson {
    level: number;
    nodeNames: string[];
}
