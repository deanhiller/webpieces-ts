/**
 * The runtime graph's VISUAL VOCABULARY, and the legend that explains it.
 *
 * Every colour, shape and fill the drawing uses lives here, next to the legend swatches that teach
 * the reader what each one means. They are one unit on purpose: the legend's job is to be a true
 * account of the picture, and the fastest way for a legend to start lying is for it to sit in a
 * different file from the constants it describes and drift as those change.
 *
 * Imported by runtime-visualizer.ts, which owns the DRAWING (which nodes and edges to emit). This
 * module knows nothing about the graph model, which is what keeps the dependency one-way and
 * cycle-free.
 */

export const LEVEL_COLORS: Record<number, string> = {
    0: '#E8F5E9',
    1: '#E3F2FD',
    2: '#FFF3E0',
    3: '#FCE4EC',
};

export const QUEUE_FILL = '#FFF3E0';

/**
 * The queue node is an `Mrecord` whose FIRST field is empty, which draws a rounded outline with a
 * vertical cap line near one end — a cylinder lying on its side, distinguishing a queue from the
 * upright cylinder that now means a database.
 *
 * Two things here are load-bearing and easy to break:
 *
 * 1. NO surrounding `{}`. Record fields lay out along the rank direction, and this graph is
 *    `rankdir=TB` (see {@link generateRuntimeDot}), where the default is horizontal — which is what
 *    we want. Adding braces TOGGLES that, turning the cap line into a band across the top.
 * 2. The leading space is the empty field. The record parser trims it to nothing, which is the
 *    point; it must survive as its own field, so the `|` cannot be dropped.
 *
 * Graphviz has no sideways cylinder and never has: `orientation=` is documented as rotating POLYGON
 * shapes, and `cylinder` is drawn with beziers, so it silently ignores the attribute (graphviz issue
 * #2244, open since 2022 and still reproducible on 13.0.0). This is the closest native shape.
 */
export const QUEUE_SHAPE = 'Mrecord';
export const QUEUE_LABEL_PREFIX = ' |';

/**
 * Marker class stamped on every queue node. Graphviz copies `class` straight into the rendered
 * `<g class="node wp_queue">`, which is how runtime-visualizer.client.js finds these nodes and
 * redraws them as true horizontal cylinders in the browser.
 *
 * A CLASS rather than an id prefix, because queue-kind EXTERNAL systems are queues too and share the
 * `system__` id space with databases — which must stay upright. Underscored, not hyphenated: DOT
 * emits a hyphen as `&#45;`, which is harmless but needlessly surprising to anyone reading the SVG.
 */
export const QUEUE_CLASS = 'wp_queue';

/** Fill for the upright cylinder standing for an external DATASTORE (firestore, postgres, ...). */
export const DATABASE_FILL = '#E1F5FE';

/** Shape per external-system kind. Anything unrecognised falls back to the generic dashed box. */
export const EXTERNAL_SHAPES: Record<string, string> = {
    database: 'cylinder',
    cache: 'cylinder',
    queue: 'Mrecord',
    storage: 'folder',
};

/** Fill per external-system kind, paired with {@link EXTERNAL_SHAPES}. */
export const EXTERNAL_FILLS: Record<string, string> = {
    database: DATABASE_FILL,
    cache: DATABASE_FILL,
    queue: QUEUE_FILL,
    storage: '#F3E5F5',
};

/** Fill + border for the dashed terminal node standing for a system outside this repo. */
export const EXTERNAL_FILL = '#FAFAFA';
export const EXTERNAL_BORDER = '#9E9E9E';

/** Fill + border for the clock node standing for a scheduler-driven endpoint. */
export const CRON_FILL = '#FFF9C4';
export const CRON_BORDER = '#F9A825';

class LegendSwatches {
    readonly service =
        '<svg width="46" height="26"><rect x="1" y="3" width="44" height="20" rx="7" fill="#E8F5E9" stroke="#333"/></svg>';
    /**
     * A cylinder on its side — the SAME geometry runtime-visualizer.client.js draws on the real
     * node, so the legend cannot drift from the picture it explains.
     */
    readonly queue =
        `<svg width="46" height="26"><path d="M9,5 H37 A8,8 0 0 1 37,21 H9 A8,8 0 0 1 9,5 Z" fill="${QUEUE_FILL}" stroke="#333"/>` +
        '<path d="M9,5 A8,8 0 0 1 9,21" fill="none" stroke="#333"/></svg>';
    readonly database =
        `<svg width="46" height="26"><path d="M8,7 a15,4 0 0 1 30,0 v12 a15,4 0 0 1 -30,0 z" fill="${DATABASE_FILL}" stroke="#333"/>` +
        '<path d="M8,7 a15,4 0 0 0 30,0" fill="none" stroke="#333"/></svg>';
    readonly storage =
        '<svg width="46" height="26"><path d="M2,22 V6 H16 l3,3 H44 V22 Z" fill="#F3E5F5" stroke="#333"/></svg>';
    readonly external =
        `<svg width="46" height="26"><rect x="1" y="3" width="44" height="20" fill="${EXTERNAL_FILL}" ` +
        `stroke="${EXTERNAL_BORDER}" stroke-dasharray="4,3"/></svg>`;
    readonly cron =
        `<svg width="46" height="26"><circle cx="23" cy="13" r="11" fill="${CRON_FILL}" stroke="${CRON_BORDER}"/>` +
        '<text x="23" y="18" font-size="12" text-anchor="middle">&#9200;</text></svg>';
    readonly solid =
        '<svg width="60" height="20"><line x1="2" y1="10" x2="48" y2="10" stroke="#333" stroke-width="1.5"/>' +
        '<path d="M48,6 L57,10 L48,14 Z" fill="#333"/></svg>';
    readonly dashed =
        '<svg width="60" height="20"><line x1="2" y1="10" x2="48" y2="10" stroke="#333" stroke-width="1.5" ' +
        'stroke-dasharray="5,4"/><path d="M48,6 L57,10 L48,14 Z" fill="#333"/></svg>';
    readonly scheduled =
        `<svg width="60" height="20"><line x1="2" y1="10" x2="48" y2="10" stroke="${CRON_BORDER}" stroke-width="1.5"/>` +
        `<path d="M48,6 L57,10 L48,14 Z" fill="${CRON_BORDER}"/></svg>`;
}

/**
 * The legend. Three columns — what a box IS, what a line MEANS, how to read a box — replacing the
 * three paragraphs of prose that used to restate the picture in words. Styled after
 * {@link GraphVisualizer}'s legend so the two graphs in this repo look like one tool.
 */
// webpieces-disable no-function-outside-class -- HTML builder, matching the sibling builders in this file
export function legendHtml(): string {
    const sw = new LegendSwatches();
    const item = (swatch: string, text: string): string =>
        `<div class="legend-item"><span class="sw">${swatch}</span><span>${text}</span></div>`;
    return `<div class="legend">
        <h2>Legend</h2>
        <div class="legend-columns">
            <div class="legend-col">
                <h3>Node shapes &mdash; <em>what a box is</em></h3>
                ${item(sw.service, '<strong>service</strong> &mdash; a deployable in this repo; fill is its dependency level')}
                ${item(sw.queue, '<strong>queue</strong> &mdash; each <em>line</em> in the box is one Cloud Tasks queue, the unit Terraform actually creates. Queues of one contract that flow between the <em>same</em> producer and consumer share a box; every one is still named, so you can always see <em>which</em> queue is stuck.')}
                ${item(sw.database, '<strong>database</strong> &mdash; a datastore outside this repo')}
                ${item(sw.storage, '<strong>object storage</strong> &mdash; a bucket outside this repo')}
                ${item(sw.external, '<strong>external system</strong> &mdash; outside this repo; nothing here implements it. Pointing <strong>OUT</strong> = a system this repo calls (firestore, gmail). Pointing <strong>IN</strong> = an endpoint driven from outside, and the box names the <strong>CALLER</strong> (<code>twilio</code>), not our contract &mdash; the contract and method are on the arrow. One vendor is ONE box however many endpoints it posts to, and the same box whether we call it or it calls us. A dotted box labelled <code>? unknown caller</code> means the endpoint never declared one.')}
                ${item(sw.cron, '<strong>cron</strong> &mdash; a scheduler fires this endpoint')}
            </div>
            <div class="legend-col">
                <h3>Lines &mdash; <em>what a call is</em></h3>
                ${item(sw.solid, '<strong>solid = rpc</strong> &mdash; the request follows the arrow, the response flows back')}
                ${item(sw.dashed, '<strong>dashed = event</strong> &mdash; asynchronous: the event flows in the direction of the arrow and returns once it is in the queue')}
                ${item(sw.scheduled, '<strong>scheduled</strong> &mdash; a cron invocation')}
                <div class="legend-note"><em>Every line is labeled with the contract the call flows over. A service that enqueues to itself loops through its own queue &mdash; a queue decouples the two sides, so it is not a dependency cycle.</em></div>
            </div>
            <div class="legend-col">
                <h3>Reading a box</h3>
                <pre class="legend-box-anatomy">name
(server|client, L#)
implements: &lt;contracts it serves&gt;
</pre>
                <div class="legend-note">A box lists only what it <strong>serves</strong>. What it <em>calls</em> is on its outgoing arrows.</div>
                <div class="legend-note"><code>(via &lt;lib&gt;)</code> = served through an embedded library, not its own source.</div>
            </div>
        </div>
    </div>`;
}
