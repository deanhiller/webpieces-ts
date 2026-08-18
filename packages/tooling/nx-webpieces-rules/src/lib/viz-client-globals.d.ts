/*
 * Ambient globals shared by the two browser-side visualizer scripts (graph-visualizer.client.ts and
 * runtime-visualizer.client.ts).
 *
 * They live HERE, in one .d.ts, rather than in each script, because both scripts are global SCRIPTS —
 * they have no import or export, which is precisely what makes tsc emit them as plain browser code with
 * no CommonJS wrapper. Two scripts in one program share a global scope, so declaring `__DOT__` in both
 * is a redeclaration error. One shared declaration file is the fix, and it costs nothing at runtime:
 * a .d.ts emits no JavaScript.
 */

/**
 * The Graphviz DOT for the page, as a JSON-encoded string.
 *
 * It is a PLACEHOLDER, not a real binding: graph-visualizer.ts / runtime-visualizer.ts read the
 * compiled script and `split('__DOT__').join(JSON.stringify(dot))` before inlining it into the HTML, so
 * by the time a browser sees this identifier it has been replaced by a string literal.
 */
declare const __DOT__: string;

/**
 * The design pages that EXIST, as JSON — substituted the same way `__DOT__` is. A node absent from
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
}

declare class WpNodeMenu {
    /** Give every `g.node` of `svg` a click that opens the menu with the items the callback builds. */
    static wire(svg: SVGSVGElement, itemsFor: (name: string, node: SVGGElement) => WpNodeMenuItem[]): void;
    static close(): void;
}

/**
 * The dropdown-less lock, also from graph-node-menu.ts: dim every other box in one rendered graph and
 * light the locked one. Used by the runtime page (and, from its own emitted script, by design.html);
 * the architecture page does NOT use it — its lock is GraphHighlighter.setLock(), which also has a
 * dropdown and a responsibilities list to keep in step.
 */
declare class WpNodeLock {
    constructor(svg: SVGSVGElement);
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
