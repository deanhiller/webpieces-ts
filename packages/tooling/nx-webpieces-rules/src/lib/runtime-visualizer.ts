/**
 * Runtime Visualizer
 *
 * Renders the runtime microservice graph (services + inferred Z -> X edges,
 * each labeled with the api(s) they flow over) to DOT + interactive HTML in
 * tmp/webpieces/runtime-architecture.{dot,html}.
 *
 * Each service node names the contracts it IMPLEMENTS. That list used to be
 * collapsed into a server/client boolean and thrown away — leaving an api that a
 * server serves but nothing in-repo calls completely invisible, and making a
 * correct api design look like a detection failure. What a service USES is NOT
 * listed: every use already draws an outgoing arrow labeled with the same
 * contract, so repeating it in the box only made every box wider.
 *
 * Shape says what a node IS and line style says what a call IS. Solid = rpc: the
 * request follows the arrow and the response flows back. Dashed = event: it flows
 * in the arrow's direction and returns once it is queued. A queue is a sideways
 * cylinder, a datastore an upright one.
 *
 * Calls that leave the repo (a contract NOTHING in-repo implements — firestore,
 * gmail, ...) are drawn as terminal nodes, so the vendor systems that actually
 * page you at 3am stop being missing from the picture. One that DECLARES what it
 * is, via an `@externalSystem` JSDoc tag or an `external:` nx tag, gets the shape
 * of the thing it is; the rest stay generic dashed boxes. They are RENDER-ONLY:
 * derivation, levels and cycle detection never see them.
 *
 * The same is true in the other direction for endpoints nothing in-repo CALLS: a
 * `cron` method hangs off a clock and an `external` method off a dashed inbound
 * box. Those are the entry points that wake a service up at 3am, and a graph
 * built only from in-repo callers cannot show them at all.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RuntimeGraph, RuntimeEdge, RuntimeQueue, RuntimeService, RuntimeTrigger } from './runtime-graph';
import { dotValue, recordValue, assertValidDot } from './dot-syntax';

const LEVEL_COLORS: Record<number, string> = {
    0: '#E8F5E9',
    1: '#E3F2FD',
    2: '#FFF3E0',
    3: '#FCE4EC',
};

const QUEUE_FILL = '#FFF3E0';

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
const QUEUE_SHAPE = 'Mrecord';
const QUEUE_LABEL_PREFIX = ' |';

/**
 * Marker class stamped on every queue node. Graphviz copies `class` straight into the rendered
 * `<g class="node wp_queue">`, which is how runtime-visualizer.client.js finds these nodes and
 * redraws them as true horizontal cylinders in the browser.
 *
 * A CLASS rather than an id prefix, because queue-kind EXTERNAL systems are queues too and share the
 * `system__` id space with databases — which must stay upright. Underscored, not hyphenated: DOT
 * emits a hyphen as `&#45;`, which is harmless but needlessly surprising to anyone reading the SVG.
 */
const QUEUE_CLASS = 'wp_queue';

/** Fill for the upright cylinder standing for an external DATASTORE (firestore, postgres, ...). */
const DATABASE_FILL = '#E1F5FE';

/** Shape per external-system kind. Anything unrecognised falls back to the generic dashed box. */
const EXTERNAL_SHAPES: Record<string, string> = {
    database: 'cylinder',
    cache: 'cylinder',
    queue: 'Mrecord',
    storage: 'folder',
};

/** Fill per external-system kind, paired with {@link EXTERNAL_SHAPES}. */
const EXTERNAL_FILLS: Record<string, string> = {
    database: DATABASE_FILL,
    cache: DATABASE_FILL,
    queue: QUEUE_FILL,
    storage: '#F3E5F5',
};

/** Fill + border for the dashed terminal node standing for a system outside this repo. */
const EXTERNAL_FILL = '#FAFAFA';
const EXTERNAL_BORDER = '#9E9E9E';

/** Fill + border for the clock node standing for a scheduler-driven endpoint. */
const CRON_FILL = '#FFF9C4';
const CRON_BORDER = '#F9A825';

/** Apis per line inside a node label — beyond this the box grows wider than it is readable. */
const APIS_PER_LABEL_LINE = 3;

/** Separator for the (service, external-library) grouping key; illegal in both project names. */
const PAIR_SEP = '|';

/** Render options for the runtime graph. */
export class RuntimeVizOptions {
    constructor(
        /**
         * Draw the dashed terminal nodes for contracts nothing in-repo implements. On by default;
         * a repo whose external surface is noisy can turn them off in webpieces.config.json
         * (runtime-architecture.showExternalNodes).
         */
        public readonly showExternalNodes: boolean = true,
    ) {}
}

function getShortName(name: string): string {
    return name.includes('/') ? name.split('/').pop()! : name;
}

/** Chunk a list into `\n`-separated label lines of at most APIS_PER_LABEL_LINE entries. */
// webpieces-disable no-function-outside-class -- DOT label builder, matching getShortName in this file
function labelList(entries: string[]): string {
    const lines: string[] = [];
    const safe = entries.map((entry: string) => dotValue(entry));
    for (let i = 0; i < safe.length; i += APIS_PER_LABEL_LINE) {
        lines.push(safe.slice(i, i + APIS_PER_LABEL_LINE).join(', '));
    }
    return lines.join('\\n');
}

/**
 * The implemented-api entries for a node label. An api served through an EMBEDDED LIBRARY is
 * annotated with that library, because "who implements WarmupApi?" otherwise requires knowing that
 * the derivation walks the dependsOn closure and then walking it by hand.
 */
// webpieces-disable no-function-outside-class -- DOT label builder, matching getShortName in this file
function implementsEntries(svc: RuntimeService): string[] {
    return svc.implements.map((api: string) => {
        const via = svc.implementsVia?.[api];
        return via === undefined ? api : `${api} (via ${getShortName(via)})`;
    });
}

/**
 * The full node label: name, role/level/declared service name, then the contracts it SERVES.
 *
 * What a service USES is deliberately absent. Every `uses` entry already draws an outgoing arrow —
 * to the implementing service, to a queue, or to an external node — and the arrow carries the same
 * contract name as its label, so listing them in the box restated the picture and made every box
 * wider than it needed to be. `implements` stays because it has no such arrow: an api a service
 * serves but nothing in-repo calls is invisible otherwise.
 *
 * The one case this loses information is `showExternalNodes:false`, where an outbound call draws no
 * node and therefore no arrow. That is precisely what that opt-out asks for, and the legend says so.
 */
// webpieces-disable no-function-outside-class -- DOT label builder, matching getShortName in this file
function nodeLabel(name: string, svc: RuntimeService): string {
    // The DECLARED role when the graph carries one; the old inference only as a fallback for a
    // runtime-dependencies.json committed before `role` existed. Inferring it labelled every server
    // with no implements as a "client", which is exactly wrong for a queue-driven service.
    const role = svc.role ?? (svc.implements.length > 0 ? 'server' : 'client');
    // The declared name is quoted for the reader — those quotes MUST be DOT-escaped, or they end
    // the label string and the whole graph stops parsing.
    const declared = svc.serviceName === undefined ? '' : `, \\"${dotValue(svc.serviceName)}\\"`;
    let label = `${dotValue(getShortName(name))}\\n(${role}, L${svc.level}${declared})`;
    if (svc.implements.length > 0) label += `\\nimplements: ${labelList(implementsEntries(svc))}`;
    return label;
}

/**
 * DOT for ONE runtime edge. rpc → a direct labeled SOLID arrow (producer calls consumer, response
 * comes back). pubsub → the producer enqueues and the consumer is delivered later, so we draw
 * producer → QUEUE → consumer through a sideways-cylinder queue node with DASHED arrows.
 *
 * Solid vs dashed is the graph's one line-level distinction: solid is a call that returns a
 * response, dashed is an event that returns as soon as it is queued.
 */
// webpieces-disable no-function-outside-class -- DOT string builder, matching getShortName in this file
function edgeDot(edge: RuntimeEdge, queues: Record<string, RuntimeQueue>): string {
    const from = dotValue(getShortName(edge.from));
    const to = dotValue(getShortName(edge.to));
    // Kept RAW: an ordinary edge label needs dotValue, the record-mode queue label needs
    // recordValue, and recordValue already applies dotValue — escaping here would double it.
    const viaRaw = edge.via.map((v: string) => getShortName(v)).join(', ');
    if (edge.type !== 'pubsub') {
        return `  "${from}" -> "${to}" [label="${dotValue(viaRaw)}"];\n`;
    }
    // The queue node is identified by the METHOD, not by the (from,to) pair, so every producer and
    // consumer of one queue converges on ONE box — including a service that enqueues to itself,
    // which then renders as a visible loop through its queue instead of vanishing.
    const queueId = edge.queue === undefined ? `queue__${from}__${to}` : `queue__${dotId(edge.queue)}`;
    const queueName = edge.queue === undefined ? undefined : queues[edge.queue]?.queueName;
    // Record-mode label: the text must clear recordValue(), and QUEUE_LABEL_PREFIX supplies the
    // empty leading field that draws the cylinder's end cap.
    const body =
        edge.queue === undefined
            ? `${recordValue(viaRaw)}\\nqueue`
            : `${recordValue(edge.queue)}\\nqueue: ${recordValue(queueName ?? edge.queue)}`;
    return (
        `  "${queueId}" [shape=${QUEUE_SHAPE}, style="filled", fillcolor="${QUEUE_FILL}", ` +
        `class="${QUEUE_CLASS}", label="${QUEUE_LABEL_PREFIX}${body}"];\n` +
        `  "${from}" -> "${queueId}" [label="enqueue", style=dashed];\n` +
        `  "${queueId}" -> "${to}" [label="deliver", style=dashed];\n`
    );
}

/** A DOT-safe node-id fragment: anything but letters, digits and `_` becomes `_`. */
// webpieces-disable no-function-outside-class -- DOT id builder, matching getShortName in this file
function dotId(raw: string): string {
    return raw.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * The clock and outside-system nodes for endpoints NOTHING in-repo calls.
 *
 * A cron sweep and a GCP push subscription are real runtime entry points with real Terraform behind
 * them, but they produce no runtime EDGE (there is no in-repo caller), so until now they were simply
 * absent — a server's most operationally interesting endpoint could be invisible on its own graph.
 * Both are drawn pointing INTO the service that serves them, the opposite direction from
 * {@link externalDot}'s outbound vendor calls.
 */
// webpieces-disable no-function-outside-class -- DOT string builder, matching getShortName in this file
function triggerDot(graph: RuntimeGraph, hidden: Set<string>): string {
    const triggers = graph.triggers.filter((t: RuntimeTrigger) => !hidden.has(t.service));
    if (triggers.length === 0) return '';

    let dot = '\n  // Entry points nothing in this repo calls: a clock, or a system outside the repo.\n';
    for (const trigger of triggers) {
        const service = dotValue(getShortName(trigger.service));
        const label = dotValue(`${trigger.api}.${trigger.method}`);
        if (trigger.kind === 'cron') {
            const id = `cron__${dotId(`${trigger.api}_${trigger.method}`)}`;
            const schedule = dotValue(trigger.queueName ?? `${trigger.api}-${trigger.method}`);
            dot +=
                `  "${id}" [shape=circle, style="filled", fillcolor="${CRON_FILL}", ` +
                `color="${CRON_BORDER}", label="⏰\\ncron"];\n` +
                `  "${id}" -> "${service}" [label="${label}\\n${schedule}", color="${CRON_BORDER}"];\n`;
            continue;
        }
        const id = `inbound__${dotId(trigger.api)}`;
        dot +=
            `  "${id}" [shape=box, style="dashed,filled", fillcolor="${EXTERNAL_FILL}", ` +
            `color="${EXTERNAL_BORDER}", label="${dotValue(trigger.api)}\\n(external caller)"];\n` +
            `  "${id}" -> "${service}" [label="${label}", style=dashed, color="${EXTERNAL_BORDER}"];\n`;
    }
    return dot;
}

/**
 * The DECLARED external systems — the ones that said what they are, so they get a shape that says
 * it: a cylinder for a database, a folder for a bucket. Everything undeclared falls through to
 * {@link externalDot}'s generic grey box, which is why adding this broke nothing existing.
 *
 * The arrows are SOLID. A call to firestore or postgres is synchronous — it returns a value — and
 * the graph's rule is that solid means "response comes back". Being outside the repo is carried by
 * the node's shape, never by the line style; conflating the two is what made a blocking database
 * read look like an event.
 */
// webpieces-disable no-function-outside-class -- DOT string builder, matching getShortName in this file
function externalSystemsDot(graph: RuntimeGraph, hidden: Set<string>): string {
    const systems = graph.externalSystems ?? {};
    const ids = Object.keys(systems).sort();
    if (ids.length === 0) return '';

    let dot = '\n  // Declared external systems — drawn with the shape of what they actually are.\n';
    for (const id of ids) {
        const system = systems[id];
        const shape = EXTERNAL_SHAPES[system.kind] ?? 'box';
        const fill = EXTERNAL_FILLS[system.kind] ?? EXTERNAL_FILL;
        // An Mrecord-shaped system needs the same empty leading field as a queue node, or it
        // renders as a plain box and silently loses the sideways-cylinder read.
        const isQueue = shape === QUEUE_SHAPE;
        const prefix = isQueue ? QUEUE_LABEL_PREFIX : '';
        const text = isQueue ? recordValue(system.label) : dotValue(system.label);
        // Only a queue-kind system is marked: a database here is an UPRIGHT cylinder and must not be
        // caught by the browser-side reshaping that lays queues on their side.
        const marker = isQueue ? `class="${QUEUE_CLASS}", ` : '';
        dot +=
            `  "system__${dotId(id)}" [shape=${shape}, style="filled", fillcolor="${fill}", ` +
            `${marker}label="${prefix}${text}\\n(external ${dotValue(system.kind)})"];\n`;
    }
    for (const id of ids) {
        const system = systems[id];
        const via = system.apis.length === 0 ? '' : ` [label="${labelList([...system.apis].sort())}"]`;
        for (const service of [...system.usedBy].sort()) {
            if (hidden.has(service)) continue;
            dot += `  "${dotValue(getShortName(service))}" -> "system__${dotId(id)}"${via};\n`;
        }
    }
    return dot;
}

/**
 * The dashed terminal nodes + edges for calls that LEAVE the repo. Built from `unresolvedUses` —
 * a contract used by a node and implemented by nobody in-repo — which the derivation already
 * computes and which was, until now, only ever printed as a warning.
 *
 * Grouped by the api-lib that owns the contracts, so a service reaching three firestore contracts
 * draws ONE `lib-firestore (external)` box rather than three. These are drawn, never derived: they
 * are absent from levels, cycle detection and the transitive implements attribution.
 *
 * A contract carrying an `@externalSystem` declaration is skipped here — {@link externalSystemsDot}
 * has already drawn it with a real shape, and rendering it in both places would double the node.
 */
// webpieces-disable no-function-outside-class -- DOT string builder, matching getShortName in this file
function externalDot(graph: RuntimeGraph, hidden: Set<string>): string {
    // "service|externalName" -> the apis flowing over it.
    const apisByPair = new Map<string, string[]>();
    for (const use of graph.unresolvedUses) {
        if (hidden.has(use.service)) continue;
        if (graph.apis[use.api]?.externalSystem !== undefined) continue;
        const external = dotValue(getShortName(graph.apis[use.api]?.owner ?? use.api));
        const key = `${use.service}${PAIR_SEP}${external}`;
        if (!apisByPair.has(key)) apisByPair.set(key, []);
        apisByPair.get(key)!.push(use.api);
    }
    if (apisByPair.size === 0) return '';

    let dot = '\n  // Systems outside this repo — no in-repo service implements these contracts.\n';
    // The node ID is prefixed so an external library can never collide with a service of the same
    // short name; only the label carries the bare name.
    const externals = new Set([...apisByPair.keys()].map((key: string) => key.split(PAIR_SEP)[1]));
    for (const external of [...externals].sort()) {
        dot +=
            `  "external__${external}" [shape=box, style="dashed,filled", fillcolor="${EXTERNAL_FILL}", ` +
            `color="${EXTERNAL_BORDER}", label="${external}\\n(external)"];\n`;
    }
    for (const key of [...apisByPair.keys()].sort()) {
        const parts = key.split(PAIR_SEP);
        const service = parts[0];
        const external = parts[1];
        const via = labelList(apisByPair.get(key)!.sort());
        // SOLID: this is a synchronous call that returns a value. Dashed is reserved for events, and
        // "outside the repo" is already said by the node's dashed border.
        dot +=
            `  "${dotValue(getShortName(service))}" -> "external__${external}" ` +
            `[label="${via}", color="${EXTERNAL_BORDER}"];\n`;
    }
    return dot;
}

/** Build the Graphviz DOT for the runtime service graph. */
// webpieces-disable no-function-outside-class -- module entry point, matching the sibling builders here
export function generateRuntimeDot(
    graph: RuntimeGraph,
    title: string = 'WebPieces Runtime Architecture',
    options: RuntimeVizOptions = new RuntimeVizOptions(),
): string {
    let dot = 'digraph RuntimeArchitecture {\n';
    dot += '  rankdir=TB;\n';
    dot += '  node [shape=box, style="filled,rounded", fontname="Arial"];\n';
    dot += '  edge [fontname="Arial", fontsize=10];\n\n';

    // Services tagged drawOnGraph:false stay in the JSON but are omitted here —
    // both their node and any edge touching them are dropped from the render.
    const hidden = new Set(
        Object.keys(graph.services).filter((name: string) => graph.services[name].drawOnGraph === false)
    );

    for (const name of Object.keys(graph.services)) {
        if (hidden.has(name)) continue;
        const svc = graph.services[name];
        const color = LEVEL_COLORS[svc.level] || '#F5F5F5';
        dot += `  "${dotValue(getShortName(name))}" [fillcolor="${color}", label="${nodeLabel(name, svc)}"];\n`;
    }

    dot += '\n';

    for (const edge of graph.runtimeEdges) {
        if (hidden.has(edge.from) || hidden.has(edge.to)) continue;
        dot += edgeDot(edge, graph.queues);
    }

    dot += triggerDot(graph, hidden);

    if (options.showExternalNodes) {
        dot += externalSystemsDot(graph, hidden);
        dot += externalDot(graph, hidden);
    }

    dot += '\n  labelloc="t";\n';
    dot += `  label="${dotValue(title)}\\n(from architecture/runtime-dependencies.json)";\n`;
    dot += '  fontsize=20;\n';
    dot += '}\n';
    // Nothing downstream parses this DOT until a human opens the page, so parse-shape is checked
    // HERE — a graph that cannot render is a generation failure, not a blank page to discover later.
    assertValidDot(dot, 'runtime-architecture.dot');
    return dot;
}

/**
 * Inline SVG swatches for the legend, hand-drawn to match what Graphviz emits for each shape.
 *
 * Hand-drawn on purpose: the alternative is shelling out to Graphviz at generate time, which would
 * make writing the HTML depend on a `dot` binary being installed — a dependency this tool does not
 * otherwise have, since rendering happens in the browser.
 */
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
function legendHtml(): string {
    const sw = new LegendSwatches();
    const item = (swatch: string, text: string): string =>
        `<div class="legend-item"><span class="sw">${swatch}</span><span>${text}</span></div>`;
    return `<div class="legend">
        <h2>Legend</h2>
        <div class="legend-columns">
            <div class="legend-col">
                <h3>Node shapes &mdash; <em>what a box is</em></h3>
                ${item(sw.service, '<strong>service</strong> &mdash; a deployable in this repo; fill is its dependency level')}
                ${item(sw.queue, '<strong>queue</strong> &mdash; one box <em>per method</em>, the unit Cloud Tasks and Terraform actually create')}
                ${item(sw.database, '<strong>database</strong> &mdash; a datastore outside this repo')}
                ${item(sw.storage, '<strong>object storage</strong> &mdash; a bucket outside this repo')}
                ${item(sw.external, '<strong>external system</strong> &mdash; outside this repo; nothing here implements it. Pointing <strong>OUT</strong> = a system this repo calls (firestore, gmail). Pointing <strong>IN</strong> = an endpoint driven from outside (a Pub/Sub push, a Gmail or Twilio webhook).')}
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

function generateRuntimeHtml(dot: string, title: string): string {
    // The browser half lives in a plain .js asset (matching graph-visualizer.client.js) rather than
    // in a template literal here: it renders with @viz-js/viz v3 AND redraws every queue node as a
    // true horizontal cylinder, which is more logic than belongs inline in a .ts string.
    const clientJs = fs.readFileSync(path.join(__dirname, 'runtime-visualizer.client.js'), 'utf-8');
    const script = clientJs.split('__DOT__').join(JSON.stringify(dot));
    return `<!DOCTYPE html>
<html>
<head>
    <!-- REQUIRED: the cron node's label is a literal ⏰, and the DOT is embedded in this file. With
         no declared charset the browser falls back to a locale guess and renders it as mojibake
         ("â °") whenever the page is served without a charset header. -->
    <meta charset="utf-8">
    <title>${title}</title>
    <script src="https://cdn.jsdelivr.net/npm/@viz-js/viz@3.28.0/dist/viz-global.js"></script>
    <style>
        body { margin: 0; padding: 20px; font-family: Arial, sans-serif; background: #f5f5f5; }
        h1 { text-align: center; color: #333; }
        #graph { text-align: center; background: white; padding: 20px; border-radius: 8px; overflow-x: auto; }
        #graph svg { max-width: 100%; height: auto; }
        .legend {
            margin: 20px auto;
            max-width: 1100px;
            padding: 15px 20px;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .legend h2 { margin-top: 0; color: #333; }
        .legend-columns { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; align-items: start; }
        .legend-col h3 { margin: 0 0 10px; color: #333; font-size: 15px; border-bottom: 1px solid #eee; padding-bottom: 5px; }
        .legend-item { margin: 9px 0; display: flex; align-items: center; gap: 10px; line-height: 1.4; color: #444; }
        /* Prose rows carry no swatch, so they must NOT be flex containers: flex would promote every
         * inline <strong>/<em>/<code> to a flex item and shred the sentence into columns. */
        .legend-note { margin: 9px 0; line-height: 1.5; color: #444; }
        .legend-box-anatomy {
            margin: 0 0 12px;
            padding: 8px 10px;
            background: #f7f7f7;
            border-radius: 4px;
            font-family: monospace;
            font-size: 12px;
            line-height: 1.5;
            color: #333;
            white-space: pre;
            overflow-x: auto;
        }
        .sw { flex: 0 0 auto; display: inline-flex; }
        code { background: #f2f2f2; padding: 1px 4px; border-radius: 3px; font-family: monospace; }
        @media (max-width: 900px) { .legend-columns { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <h1>${title}</h1>
    <div id="graph"></div>
    ${legendHtml()}
    <script>${script}</script>
</body>
</html>`;
}

export interface RuntimeVisualizationPaths {
    dotPath: string;
    htmlPath: string;
}

/** Write the DOT + HTML renderings to tmp/webpieces/. */
export function writeRuntimeVisualization(
    graph: RuntimeGraph,
    workspaceRoot: string,
    title: string = 'WebPieces Runtime Architecture',
    options: RuntimeVizOptions = new RuntimeVizOptions(),
): RuntimeVisualizationPaths {
    const outputDir = path.join(workspaceRoot, 'tmp', 'webpieces');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const dot = generateRuntimeDot(graph, title, options);
    const dotPath = path.join(outputDir, 'runtime-architecture.dot');
    fs.writeFileSync(dotPath, dot, 'utf-8');

    const htmlPath = path.join(outputDir, 'runtime-architecture.html');
    fs.writeFileSync(htmlPath, generateRuntimeHtml(dot, title), 'utf-8');

    return { dotPath, htmlPath };
}
