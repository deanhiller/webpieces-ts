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
    /** Runtime pages (#1239): the Goal vs Current overlay, or why it is unavailable. Absent elsewhere. */
    comparison?: RuntimeComparisonJson | null;
    /** LegendFacts (graph-color-modes.ts): the page reads the ONE product palette from it (#1319). */
    legend: LegendJson;
}

/** The part of LegendFacts the page reads. */
interface LegendJson {
    palette: ProductPaletteJson;
}

/** ProductPalette (graph-products.ts), as JSON: every declared product, sorted, with its fixed color. */
interface ProductPaletteJson {
    colors: ProductColorJson[];
}

/** ProductColor (graph-products.ts), as JSON. */
interface ProductColorJson {
    product: string;
    color: string;
    fontColor: string;
}

/** ProductTemplate (graph-products.ts), as JSON: what the page paints a Product-mode node from (#1319). */
interface ProductTemplateJson {
    /** 'box' | 'context' (ProductTemplateKind). */
    kind: string;
    head: string;
    darkLabel: string;
    lightLabel: string;
}

/** RuntimeComparisonView (graph-render-model.ts), as JSON. */
interface RuntimeComparisonJson {
    available: boolean;
    reason: string;
    direction: string;
    summary: string;
    model: RenderModelJson | null;
    nodeDetails: Record<string, string[]>;
    edgeDetails: Record<string, string[]>;
    differences: string[];
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
    dependent: string;
    implicit: string;
    rootFile: string;
    unexplained: string;
    buildInput: string;
    untouched: string;
    /** Product color mode (#1179): painted by the page from the ON products (#1319). */
    product: ProductTemplateJson;
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
    /** Edges gained and lost since the fork point, live graph vs the fork point's (#1264). */
    edges: EdgeDiffJson;
}

/** EdgeDiffReport (graph-edge-diff.ts), as JSON. */
interface EdgeDiffJson {
    base: string;
    /** '' when `dependency` was computed, else why the page shows none. */
    dependencyReason: string;
    dependency: EdgeChangeJson[];
    /** '' when `runtime` was computed, else why the page shows none. */
    runtimeReason: string;
    runtime: EdgeChangeJson[];
}

/** One gained or lost edge (#1264). */
interface EdgeChangeJson {
    from: string;
    to: string;
    /** 'gained' | 'lost' */
    change: string;
    /** 'depends' | 'calls' */
    relation: string;
    apis: string[];
    text: string;
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
    /** Affected over dependency edges from a changed or touched project. */
    dependents: string[];
    /** Affected because a {workspaceRoot} target input matched a changed file. */
    implicit: string[];
    /** Affected by a lockfile / package.json / tsconfig.base.json / nx.json change. */
    rootFile: string[];
    /** Affected, and nothing could say why. */
    unexplained: string[];
    /** Why each affected project is in the build (graph-impact-reasons.ts). */
    reasons: AffectedReasonJson[];
    /** Transitive dependencies of the affected set that are not affected themselves. */
    buildInputs: string[];
    changedFiles: number;
    /** Transitive dependencies of the touched set that are not touched: "Changed + dependencies". */
    dependencies: string[];
    /** Changed files no project owns (workspace-global inputs such as pnpm-lock.yaml). */
    globalFiles: string[];
}
/** Why one affected project is in the build (#1264). */
interface AffectedReasonJson {
    project: string;
    /** 'touched' | 'dependent' | 'implicit' | 'rootFile' | 'unexplained' — the box's impact status. */
    kind: string;
    /** Changed: the files it owns. Implicit / root-file: the changed file that matched. */
    files: string[];
    /** Dependent: [project, …, nearest changed or touched project]. */
    path: string[];
    /** Implicit: the target and its input glob. */
    target: string;
    input: string;
    detail: string;
}
interface Window {
    __WP_IMPACT__?: ImpactDataJson;
    __WP_RUNTIME__?: RuntimeViewerBinding;
    __WP_GOAL__?: GoalViewerBinding;
}
/** The Goal vs Current details panel (runtime-goal-details.ts): a node menu item while that mode is on. */
interface GoalViewerBinding {
    item(name: string, node: SVGGElement): WpNodeMenuItem | null;
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
    /** The products a cross-product dependency crosses into (#1204); empty for every other edge. */
    crossesInto: string[];
}
interface RenderBandJson {
    selfQueueNames: string[];
    level: number;
    nodeNames: string[];
}
