/*
 * Browser-side script for tmp/webpieces/runtime-architecture.html.
 *
 * runtime-visualizer.ts reads this file's COMPILED output with readFileSync, substitutes the DOT
 * placeholder (see viz-client-globals.d.ts) with the JSON-encoded DOT, and inlines the result into a <script> tag. It runs in a
 * browser, never in node — but it is ordinary TypeScript, compiled in place by tsc like the package's
 * bin entry points, and linted like every other file here. (It used to be a committed .js asset
 * exempted from `no-js-files`; see graph-visualizer.client.ts for why that exemption is gone.)
 *
 * Three jobs:
 *   1. render the DOT with @viz-js/viz v3 (instance() resolves the WASM renderer, and
 *      renderSVGElement is then SYNCHRONOUS — v2's returned a promise);
 *   2. upgrade every queue node into a TRUE horizontal cylinder;
 *   3. make every node clickable, opening the SHARED floating menu (graph-node-menu.ts — the same one
 *      architecture/dependencies.html and every design.html use) whose only item here is Lock/Unlock.
 *
 * Why (2) is post-processing rather than a shape:
 *
 * Graphviz has exactly one `cylinder` and it is upright-only. `orientation=` is documented as rotating
 * POLYGON shapes, and `cylinder` is drawn with beziers, so it silently ignores the attribute — graphviz
 * issue #2244, open since 2022 and still reproducible on Graphviz 15, the version this page's renderer
 * carries. All 54 native shapes were compared at the real label size; none is a horizontal cylinder. So
 * the DOT emits `Mrecord` (which renders sensibly on its own for anyone running `dot` over the
 * committed .dot file) and this script redraws it in the browser, where the geometry is computed from
 * each node's actual bounding box and therefore fits any label width — which a fixed image asset never
 * can.
 */

// The DOT placeholder and the `Viz` global are declared once in viz-client-globals.d.ts — both
// scripts share a global scope, so they cannot each declare them. Do NOT spell the placeholder token
// in a comment: the inliner is a blind split/join, so every literal occurrence gets the whole DOT.

/** Cap width as a fraction of the node's half-height. Below ~0.6 it reads as a rounded box. */
const CAP_RATIO = 0.75;
/** A node narrower than this is not a queue box worth reshaping. */
const MIN_WIDTH = 40;

/** The union bounding box of a node's shape elements, in user space. Data-only → a class. */
class Bounds {
    constructor(
        readonly x0: number,
        readonly x1: number,
        readonly y0: number,
        readonly y1: number,
    ) {}

    width(): number {
        return this.x1 - this.x0;
    }

    halfHeight(): number {
        return (this.y1 - this.y0) / 2;
    }
}

/**
 * Redraws the nodes the DOT marked `wp_queue` as cylinders lying on their side.
 *
 * Selected by CLASS, not by id prefix: a queue-kind external system shares the `system__` id space with
 * databases, and a database is an UPRIGHT cylinder that must be left alone.
 */
class QueueCylinders {
    private static readonly SVG_NS = 'http://www.w3.org/2000/svg';

    applyTo(svg: SVGSVGElement): void {
        svg.querySelectorAll('g.wp_queue').forEach((node: Element): void => { this.reshape(node); });
    }

    /**
     * Replace one node's shape elements with a horizontal cylinder sized to its own bounding box.
     *
     * The bbox is measured from the shape elements BEFORE they are removed, never from getBBox() on the
     * whole group — the group includes the text, which is inset, so using it would shrink the cylinder
     * inside the very label it is meant to contain.
     */
    private reshape(node: Element): void {
        const shapes = node.querySelectorAll('polygon, path, polyline');
        if (shapes.length === 0) return;
        const box = this.boundsOf(shapes);
        if (box === null || box.width() < MIN_WIDTH) return;

        const first = shapes[0];
        const fill = first.getAttribute('fill') ?? 'none';
        const stroke = first.getAttribute('stroke') ?? 'black';
        // Measured BEFORE the shapes go: the record separator is where the label text starts.
        const separator = this.separatorX(shapes);
        shapes.forEach((shape: Element): void => { shape.remove(); });

        const ry = box.halfHeight();
        const rx = this.capRadius(box, ry, separator);
        const body =
            'M' + (box.x0 + rx) + ',' + box.y0 +
            ' L' + (box.x1 - rx) + ',' + box.y0 +
            ' A' + rx + ',' + ry + ' 0 0 1 ' + (box.x1 - rx) + ',' + box.y1 +
            ' L' + (box.x0 + rx) + ',' + box.y1 +
            ' A' + rx + ',' + ry + ' 0 0 1 ' + (box.x0 + rx) + ',' + box.y0 + ' Z';
        // Only the NEAR end cap is drawn: that single arc is what reads as "tube" rather than
        // "stadium", and a real cylinder hides the far one behind the body.
        const cap =
            'M' + (box.x0 + rx) + ',' + box.y0 +
            ' A' + rx + ',' + ry + ' 0 0 1 ' + (box.x0 + rx) + ',' + box.y1;

        const anchor = node.firstChild;
        if (anchor === null || anchor.nextSibling === null) return;
        node.insertBefore(this.pathEl(fill, stroke, body), anchor.nextSibling);
        node.insertBefore(this.pathEl('none', stroke, cap), anchor.nextSibling.nextSibling);

        // The label is deliberately NOT nudged. QUEUE_LABEL_PREFIX already gives the node an empty
        // leading record field, so Graphviz has centred the text in the space to the RIGHT of where the
        // cap lands. Shifting it again double-counts that offset and pushes the longest line out
        // through the far end of the cylinder.
    }

    /**
     * A box listing several queues is TALL, and a cap scaled off half-height alone would then reach
     * past the empty leading field and sit on top of the first characters of the label. Graphviz sizes
     * that field from the font, not from the label's height, so the separator is the only honest bound
     * on how far right the cap may go.
     */
    private capRadius(box: Bounds, ry: number, separator: number | null): number {
        const fromHeight = Math.max(6, ry * CAP_RATIO);
        if (separator === null) return fromHeight;
        return Math.max(6, Math.min(fromHeight, separator - box.x0));
    }

    /**
     * The x of the record's field separator — the VERTICAL polyline Graphviz draws between the empty
     * leading field and the label — or null if this node has none.
     */
    private separatorX(shapes: NodeListOf<Element>): number | null {
        for (const shape of Array.from(shapes)) {
            if (shape.tagName !== 'polyline') continue;
            const nums = (shape.getAttribute('points') ?? '').match(/-?[\d.]+/g);
            if (nums === null || nums.length < 4) continue;
            const x = parseFloat(nums[0]);
            if (Math.abs(x - parseFloat(nums[2])) < 0.5) return x;
        }
        return null;
    }

    /** The union bounding box of some SVG shape elements, from their raw geometry attributes. */
    private boundsOf(shapes: NodeListOf<Element>): Bounds | null {
        const xs: number[] = [];
        const ys: number[] = [];
        for (const shape of Array.from(shapes)) {
            const pts = shape.getAttribute('points');
            const source = pts ?? shape.getAttribute('d') ?? '';
            const nums = source.match(/-?[\d.]+/g);
            if (nums === null) continue;
            for (let n = 0; n + 1 < nums.length; n += 2) {
                xs.push(parseFloat(nums[n]));
                ys.push(parseFloat(nums[n + 1]));
            }
        }
        if (xs.length === 0) return null;
        return new Bounds(Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys));
    }

    private pathEl(fill: string, stroke: string, d: string): SVGPathElement {
        const el = document.createElementNS(QueueCylinders.SVG_NS, 'path');
        el.setAttribute('fill', fill);
        el.setAttribute('stroke', stroke);
        el.setAttribute('d', d);
        return el;
    }
}

/**
 * Every node of the runtime graph opens the shared floating menu.
 *
 * There is exactly ONE item, and it is the lock. NO "View Design": a node here is a running SERVICE,
 * a queue, a datastore or a third-party system, not an nx project, so there is no design.html to point
 * at and the item is ABSENT rather than present-and-dead.
 *
 * LOCK means the literal thing the box shows: dim every other node and every edge, light the locked
 * box alone. That is `WpNodeLock`, the same lock a design page uses — this page has no lock dropdown
 * and no responsibilities list, so there is no second control for it to fall out of step with, and
 * the menu label is derived from the lock's own state on every open.
 */
class RuntimeNodeMenu {
    private readonly lock: WpNodeLock;

    constructor(private readonly svg: SVGSVGElement) {
        this.lock = new WpNodeLock(svg);
    }

    wire(): void {
        WpNodeMenu.wire(this.svg, (name: string, node: SVGGElement): WpNodeMenuItem[] => {
            const label = this.lock.isLocked(name) ? 'Unlock' : 'Lock';
            return [new WpNodeMenuItem(label, (): void => { this.lock.toggle(name, node); })];
        });
    }
}

/**
 * Renders the DOT, reshapes the queues, wires the node menu, and reports a failure into the page
 * rather than only the console.
 */
class RuntimePage {
    render(): void {
        Viz.instance()
            .then((viz: VizInstance): void => {
                const element = viz.renderSVGElement(__DOT__);
                new QueueCylinders().applyTo(element);
                const host = document.getElementById('graph');
                if (host === null) return;
                host.appendChild(element);
                // AFTER the cylinders: wiring reads each node's <title>, which the redraw leaves
                // alone, but the clickable class belongs on the shape that is finally there.
                new RuntimeNodeMenu(element).wire();
            })
            // webpieces-disable no-any-unknown -- a promise rejection reason is untyped BY THE LANGUAGE (any value can be thrown), and this browser script cannot import the repo's toError helper; it is stringified, never dereferenced
            .catch((err: unknown): void => {
                console.error(err);
                const host = document.getElementById('graph');
                if (host !== null) host.innerHTML = '<pre>' + String(err) + '</pre>';
            });
    }
}

new RuntimePage().render();
