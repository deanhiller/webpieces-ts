import { RuntimeDetails } from './runtime-details';
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
 * cylinder, a datastore an upright one. A queue box lists ONE LINE PER QUEUE: the
 * unit underneath is still the METHOD (what Terraform creates, and what
 * runtime-dependencies.json records), but queues of one contract sharing the same
 * producers and consumers are drawn together instead of as adjacent near-identical
 * boxes — every queue is still named, only the node count drops.
 *
 * Calls that leave the repo (a contract NOTHING in-repo implements — firestore,
 * gmail, ...) are drawn as terminal nodes, so the vendor systems that actually
 * page you at 3am stop being missing from the picture. One that DECLARES what it
 * is, via an `@externalSystem` JSDoc tag or an `external:` nx tag, gets the shape
 * of the thing it is; the rest stay generic dashed boxes. They are RENDER-ONLY:
 * derivation, levels and cycle detection never see them.
 *
 * The same is true in the other direction for endpoints nothing in-repo CALLS: a
 * `cron` method hangs off a clock and an `external` method off a box naming the
 * CALLER that posts to it (`twilio`), in the same id space as the outbound
 * systems, so a vendor we both call and are called by is ONE box. Those are the
 * entry points that wake a service up at 3am, and a graph built only from in-repo
 * callers cannot show them at all.
 *
 * EVERY node on the rendered page is clickable and opens the SHARED floating menu
 * (graph-node-menu.ts — one implementation, also used by architecture/dependencies.html
 * and every project's design.html). Lock/Unlock dims every
 * other node and every edge and lights the locked box alone. There is no "View Design"
 * item here — a node is a running service, queue, datastore or third-party system, not
 * an nx project, so no design.html exists to point at and the item is absent rather than
 * dead. Filter Unconnected follows separate incoming/outgoing chains and compacts the rendered
 * topology; Turn off Filter restores the full picture. Lock remains independent of Filter.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
    RuntimeGraph,
    RuntimeEdge,
    RuntimeQueue,
    RuntimeService,
    RuntimeTrigger,
} from './runtime-graph';
import { dotValue, recordValue, assertValidDot } from './dot-syntax';
import { GraphRenderModel } from './graph-render-model';
import { RuntimeHtmlPage } from './runtime-html-page';
import {
    LEVEL_COLORS,
    QUEUE_FILL,
    QUEUE_SHAPE,
    QUEUE_LABEL_PREFIX,
    QUEUE_CLASS,
    EXTERNAL_SHAPES,
    EXTERNAL_FILLS,
    EXTERNAL_FILL,
    EXTERNAL_BORDER,
    CRON_FILL,
    CRON_BORDER,
    CUT_CYCLE_EDGE_ATTRS,
} from './runtime-viz-theme';

/** Apis per line inside a node label — beyond this the box grows wider than it is readable. */
const APIS_PER_LABEL_LINE = 3;

/** Separator for the (service, external-library) grouping key; illegal in both project names. */
const PAIR_SEP = '|';

/** Render options for the runtime graph. */
export class RuntimeVizOptions {
    constructor(
        /**
         * Draw the dashed terminal nodes for contracts nothing in-repo implements. On by default;
         * a repo whose external surface is noisy can turn them off in the declared Nx owner file's
         * direct policy-ID map (runtime-architecture.showExternalNodes).
         */
        public readonly showExternalNodes: boolean = true,
    ) {}
}

/**
 * The DISPLAY name of a project/service: scope stripped. LABELS ONLY.
 *
 * Never an identity. `@scope/public-api` and `public-api` are two distinct projects that strip to
 * the same string, and keying nodes or edges on that fuses them into one box (and draws the edge
 * between them as a self-loop). See {@link serviceNodeId} and lib/graph-names.ts.
 */
function getShortName(name: string): string {
    return name.includes('/') ? name.split('/').pop()! : name;
}

/** The DOT identity of a runtime service: its project key, escaped — never the display name. */
// webpieces-disable no-function-outside-class -- DOT id builder, matching getShortName in this file
function serviceNodeId(name: string): string {
    return dotValue(name);
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

/** Compact affordances carry full details in the HTML, including hidden external uses. */
// webpieces-disable no-function-outside-class -- DOT label builder, matching getShortName in this file
function nodeLabel(name: string, svc: RuntimeService, usesCount: number): string {
    // The DECLARED role when the graph carries one; the old inference only as a fallback for a
    // runtime-dependencies.json committed before `role` existed. Inferring it labelled every server
    // with no implements as a "client", which is exactly wrong for a queue-driven service.
    const role = svc.role ?? (svc.implements.length > 0 ? 'server' : 'client');
    // The declared name is quoted for the reader — those quotes MUST be DOT-escaped, or they end
    // the label string and the whole graph stops parsing.
    const declared = svc.serviceName === undefined ? '' : `, \\"${dotValue(svc.serviceName)}\\"`;
    let label = `${dotValue(getShortName(name))}\\n(${role}, L${svc.level}${declared})`;
    label += `\\nImplements (${svc.implements.length})\\nUses (${usesCount})`;
    return label;
}

/**
 * DOT for ONE NON-QUEUED runtime edge: a direct labeled SOLID arrow (producer calls consumer, the
 * response comes back). Queued (pubsub) hops are drawn by {@link queuesDot} instead, because they
 * are merged across methods and therefore cannot be emitted one edge at a time.
 *
 * Dashed is the graph's one line-level distinction, and it now says one of two things: an event that
 * returns as soon as it is queued, or (in red, labelled "legacy cycle") an edge a `cutLegacyCycle:`
 * tag holds out of leveling. A cut edge is still DRAWN — erasing the arrow would erase exactly the
 * debt the tag records — it is only drawn as the debt it is. See lib/cut-legacy-cycle-resolver.ts.
 */
// webpieces-disable no-function-outside-class -- DOT string builder, matching getShortName in this file
function edgeDot(edge: RuntimeEdge): string {
    const from = serviceNodeId(edge.from);
    const to = serviceNodeId(edge.to);
    const viaRaw =
        edge.via.length > 2
            ? `Uses (${edge.via.length}) ▾`
            : edge.via.map((v: string) => getShortName(v)).join(', ');
    const cut = edge.cutLegacyCycle === true;
    const label = cut ? `${dotValue(viaRaw)}\\nlegacy cycle` : dotValue(viaRaw);
    return `  "${from}" -> "${to}" [label="${label}"${cut ? CUT_CYCLE_EDGE_ATTRS : ''}];\n`;
}

/** The VISIBLE producers and consumers of one queue, gathered from the edges that survived hiding. */
class QueueEndpoints {
    readonly producers = new Set<string>();
    readonly consumers = new Set<string>();
}

/**
 * One drawn queue BOX: the queue keys (`Api.method`) it shows, and the endpoints they all share.
 * Several keys land in one box only when they agree on all three of contract, producers and
 * consumers — see {@link queuesDot}.
 */
class QueueGroup {
    constructor(
        public readonly members: string[],
        public readonly producers: string[],
        public readonly consumers: string[],
    ) {}
}

/**
 * The label line for ONE queue inside a box: `Api.method`, and the Terraform queue name ONLY when it
 * is not the derived `${Api}-${method}`.
 *
 * Printing a derived name was pure restatement — the line above it already said `Api.method`, so
 * every queue box carried a second line that added nothing and doubled its height. A `@Queue(...)`
 * OVERRIDE is the opposite: that string appears nowhere else on the graph, and it is the one string
 * Terraform must match, so it stays.
 */
// webpieces-disable no-function-outside-class -- DOT label builder, matching getShortName in this file
function queueLine(key: string, queue: RuntimeQueue | undefined): string {
    const line = recordValue(key);
    if (queue === undefined) return line;
    if (queue.queueName === `${queue.api}-${queue.method}`) return line;
    return `${line}\\nqueue: ${recordValue(queue.queueName)}`;
}

/** The node statement + enqueue/deliver arrows for one queue box. Service identities remain raw; only emitted DOT is escaped. */
// webpieces-disable no-function-outside-class -- DOT string builder, matching getShortName in this file
function queueBoxDot(
    id: string,
    body: string,
    producers: string[],
    consumers: string[],
    model: GraphRenderModel,
): string {
    // Record-mode label: the text must clear recordValue(), and QUEUE_LABEL_PREFIX supplies the
    // empty leading field that draws the cylinder's end cap. Drop it and the node silently
    // degrades to a plain box.
    let dot = model.node(
        id,
        `  "${id}" [shape=${QUEUE_SHAPE}, style="filled", fillcolor="${QUEUE_FILL}", ` +
            `class="${QUEUE_CLASS}", label="${QUEUE_LABEL_PREFIX}${body}"];\n`,
    );
    for (const producer of producers)
        dot += model.edge(
            producer,
            id,
            `  "${serviceNodeId(producer)}" -> "${id}" [label="enqueue", style=dashed];\n`,
        );
    for (const consumer of consumers)
        dot += model.edge(
            id,
            consumer,
            `  "${id}" -> "${serviceNodeId(consumer)}" [label="deliver", style=dashed];\n`,
        );
    return dot;
}

/**
 * Group the queued hops into boxes. The key is (contract, producer SET, consumer SET) — NOT the
 * (from,to) pair of some edge.
 *
 * A queue node converges EVERY producer and consumer of its method onto one box, so keying by a
 * service PAIR would re-split a two-producer queue into two boxes and invent topology nobody wrote.
 * Only queues of the same contract whose producer and consumer sets are IDENTICAL may share a box;
 * anything else stays separate, because merging it would assert a routing that does not exist.
 */
// webpieces-disable no-function-outside-class -- DOT string builder, matching getShortName in this file
function groupQueues(byQueue: Map<string, QueueEndpoints>, graph: RuntimeGraph): QueueGroup[] {
    const groups = new Map<string, QueueGroup>();
    // Sorted keys → the first member of every group, and therefore its node id, is deterministic.
    for (const key of [...byQueue.keys()].sort()) {
        const ends = byQueue.get(key)!;
        const producers = [...ends.producers].sort();
        const consumers = [...ends.consumers].sort();
        const api = graph.queues[key]?.api ?? key.split('.')[0];
        const mergeKey = [api, producers.join(','), consumers.join(',')].join(PAIR_SEP);
        const existing = groups.get(mergeKey);
        if (existing === undefined)
            groups.set(mergeKey, new QueueGroup([key], producers, consumers));
        else existing.members.push(key);
    }
    return [...groups.values()];
}

/**
 * The queued half of the graph: producer → QUEUE → consumer, drawn with a sideways-cylinder node and
 * DASHED arrows (an event returns as soon as it is queued).
 *
 * One BOX may list several queues, one per line. The unit Cloud Tasks and Terraform create is still
 * the METHOD — that is what runtime-dependencies.json records and this render never changes it — but
 * two methods of one contract flowing between exactly the same producers and consumers drew two
 * adjacent boxes whose only difference was the method name, and each carried a `queue:` line that
 * merely restated it. Listing them inside ONE box keeps every queue named (you can still see which
 * one is stuck) at a fraction of the node count.
 */
// webpieces-disable no-function-outside-class -- DOT string builder, matching getShortName in this file
function queuesDot(graph: RuntimeGraph, hidden: Set<string>, model: GraphRenderModel): string {
    const queued = graph.runtimeEdges.filter(
        (e: RuntimeEdge) => e.type === 'pubsub' && !hidden.has(e.from) && !hidden.has(e.to),
    );
    if (queued.length === 0) return '';

    let dot =
        '\n  // Queued hops. Each LINE in a box is one Cloud Tasks queue; queues of one contract\n' +
        '  // sharing the same producers AND consumers are drawn in a single box.\n';

    // A contract with no method table (no architecture/apis/<Api>.json for it) has no
    // per-method queue at all, so it keeps the historical unnamed per-pair box.
    const byQueue = new Map<string, QueueEndpoints>();
    for (const edge of queued) {
        const from = edge.from;
        const to = edge.to;
        if (edge.queue === undefined) {
            // Kept RAW: recordValue already applies dotValue, so escaping here would double it.
            const viaRaw =
                edge.via.length > 2
                    ? `Uses (${edge.via.length}) ▾`
                    : edge.via.map((v: string) => getShortName(v)).join(', ');
            dot += queueBoxDot(
                `queue__${dotId(edge.from)}__${dotId(edge.to)}`,
                `${recordValue(viaRaw)}\\nqueue`,
                [from],
                [to],
                model,
            );
            continue;
        }
        if (!byQueue.has(edge.queue)) byQueue.set(edge.queue, new QueueEndpoints());
        byQueue.get(edge.queue)!.producers.add(from);
        byQueue.get(edge.queue)!.consumers.add(to);
    }

    for (const group of groupQueues(byQueue, graph)) {
        const body = group.members
            .map((key: string) => queueLine(key, graph.queues[key]))
            .join('\\n');
        dot += queueBoxDot(
            `queue__${dotId(group.members[0])}`,
            body,
            group.producers,
            group.consumers,
            model,
        );
    }
    return dot;
}

/** A DOT-safe node-id fragment: anything but letters, digits and `_` becomes `_`. */
// webpieces-disable no-function-outside-class -- DOT id builder, matching getShortName in this file
function dotId(raw: string): string {
    return raw.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * ONE external-system node statement: the shape/fill of what the system IS, its label, and a
 * parenthesised subtitle saying which way it faces.
 *
 * Shared by the OUTBOUND systems ({@link externalSystemsDot}) and the INBOUND callers
 * ({@link triggerDot}) on purpose. They emit into the SAME `system__<identity>` id space, so a
 * vendor this repo both calls and is called by is one box with arrows in both directions — and a
 * copy-pasted attribute string would have let the two drift until they stopped being one box.
 */
// webpieces-disable no-function-outside-class -- DOT string builder, matching getShortName in this file
function externalSystemNodeDot(
    identity: string,
    kind: string,
    label: string,
    subtitle: string,
    model: GraphRenderModel,
): string {
    const shape = EXTERNAL_SHAPES[kind] ?? 'box';
    const fill = EXTERNAL_FILLS[kind] ?? EXTERNAL_FILL;
    // An Mrecord-shaped system needs the same empty leading field as a queue node, or it renders as
    // a plain box and silently loses the sideways-cylinder read.
    const isQueue = shape === QUEUE_SHAPE;
    const prefix = isQueue ? QUEUE_LABEL_PREFIX : '';
    const text = isQueue ? recordValue(label) : dotValue(label);
    // Only a queue-kind system is marked: a database here is an UPRIGHT cylinder and must not be
    // caught by the browser-side reshaping that lays queues on their side.
    const marker = isQueue ? `class="${QUEUE_CLASS}", ` : '';
    return model.node(
        `system__${dotId(identity)}`,
        `  "system__${dotId(identity)}" [shape=${shape}, style="filled", fillcolor="${fill}", ` +
            `${marker}label="${prefix}${text}\\n(${subtitle})"];\n`,
    );
}

/**
 * The clock and outside-system nodes for endpoints NOTHING in-repo calls.
 *
 * A cron sweep and a GCP push subscription are real runtime entry points with real Terraform behind
 * them, but they produce no runtime EDGE (there is no in-repo caller), so until now they were simply
 * absent — a server's most operationally interesting endpoint could be invisible on its own graph.
 * Both are drawn pointing INTO the service that serves them, the opposite direction from
 * {@link externalDot}'s outbound vendor calls.
 *
 * The inbound box names the CALLER (`twilio`), never the contract. Naming the contract was the whole
 * bug: it restated what the service box directly below already says, while the one fact the box
 * exists to convey — which vendor is posting to us — appeared nowhere. The contract keeps its place
 * on the EDGE label, where `WhatsAppApi.inbound` reads as "…posts to this method".
 *
 * Identity is the caller's label in the SAME `system__` space {@link externalSystemsDot} uses, which
 * buys three things at once: two vendors hitting one contract are two boxes, one vendor hitting three
 * methods is one box with three arrows, and a vendor this repo also CALLS is that same single box.
 * `options` is passed in for the last of those — when that outbound half will be drawn, this half
 * must not restate the node statement.
 */
// webpieces-disable no-function-outside-class -- DOT string builder, matching getShortName in this file
function triggerDot(
    graph: RuntimeGraph,
    hidden: Set<string>,
    options: RuntimeVizOptions,
    model: GraphRenderModel,
): string {
    const triggers = graph.triggers.filter((t: RuntimeTrigger) => !hidden.has(t.service));
    if (triggers.length === 0) return '';

    // Identities externalSystemsDot is about to draw; skipped here so the node is stated ONCE.
    const drawnOutbound = new Set(
        options.showExternalNodes ? Object.keys(graph.externalSystems ?? {}) : [],
    );
    const emitted = new Set<string>();
    let dot =
        '\n  // Entry points nothing in this repo calls: a clock, or a system outside the repo.\n';
    for (const trigger of triggers) {
        const service = serviceNodeId(trigger.service);
        const label = dotValue(`${trigger.api}.${trigger.method}`);
        if (trigger.kind === 'cron') {
            const id = `cron__${dotId(`${trigger.api}_${trigger.method}`)}`;
            const schedule = dotValue(trigger.queueName ?? `${trigger.api}-${trigger.method}`);
            dot +=
                model.node(
                    id,
                    `  "${id}" [shape=circle, style="filled", fillcolor="${CRON_FILL}", ` +
                        `color="${CRON_BORDER}", label="⏰\\ncron"];\n`,
                ) +
                model.edge(
                    id,
                    trigger.service,
                    `  "${id}" -> "${service}" [label="${label}\\n${schedule}", color="${CRON_BORDER}"];\n`,
                );
            continue;
        }
        const caller = trigger.caller;
        // Undeclared: only possible for a graph generated BEFORE the caller was required (generation
        // now fails instead). DOTTED and question-marked, so "we were never told who this is" cannot
        // be mistaken for a named vendor.
        const id =
            caller === undefined
                ? `inbound__${dotId(trigger.api)}`
                : `system__${dotId(caller.label)}`;
        if (!emitted.has(id) && !(caller !== undefined && drawnOutbound.has(caller.label))) {
            emitted.add(id);
            dot +=
                caller === undefined
                    ? model.node(
                          id,
                          `  "${id}" [shape=box, style="dotted,filled", fillcolor="${EXTERNAL_FILL}", ` +
                              `color="${EXTERNAL_BORDER}", label="${dotValue(trigger.api)}\\n? unknown caller"];\n`,
                      )
                    : externalSystemNodeDot(
                          caller.label,
                          caller.kind,
                          caller.label,
                          'external caller',
                          model,
                      );
        }
        dot += model.edge(
            id,
            trigger.service,
            `  "${id}" -> "${service}" [label="${label}", style=dashed, color="${EXTERNAL_BORDER}"];\n`,
        );
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
function externalSystemsDot(
    graph: RuntimeGraph,
    hidden: Set<string>,
    model: GraphRenderModel,
): string {
    const systems = graph.externalSystems ?? {};
    const ids = Object.keys(systems).sort();
    if (ids.length === 0) return '';

    let dot =
        '\n  // Declared external systems — drawn with the shape of what they actually are.\n';
    for (const id of ids) {
        const system = systems[id];
        dot += externalSystemNodeDot(
            id,
            system.kind,
            system.label,
            `external ${dotValue(system.kind)}`,
            model,
        );
    }
    for (const id of ids) {
        const system = systems[id];
        const via =
            system.apis.length === 0
                ? ''
                : ` [label="${system.apis.length > 2 ? `Uses (${system.apis.length}) ▾` : labelList([...system.apis].sort())}"]`;
        for (const service of [...system.usedBy].sort()) {
            if (hidden.has(service)) continue;
            dot += model.edge(
                service,
                `system__${dotId(id)}`,
                `  "${serviceNodeId(service)}" -> "system__${dotId(id)}"${via};\n`,
            );
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
function externalDot(graph: RuntimeGraph, hidden: Set<string>, model: GraphRenderModel): string {
    // "service|externalName" -> the apis flowing over it.
    const apisByPair = new Map<string, string[]>();
    for (const use of graph.unresolvedUses) {
        if (hidden.has(use.service)) continue;
        if (graph.apis[use.api]?.externalSystem !== undefined) continue;
        // Keyed on the OWNER's full name, never its short name: two scoped api-libs whose short
        // names match are two external systems, and fusing them draws one box for both.
        const external = graph.apis[use.api]?.owner ?? use.api;
        const key = `${use.service}${PAIR_SEP}${external}`;
        if (!apisByPair.has(key)) apisByPair.set(key, []);
        apisByPair.get(key)!.push(use.api);
    }
    if (apisByPair.size === 0) return '';

    let dot = '\n  // Systems outside this repo — no in-repo service implements these contracts.\n';
    // The node ID is prefixed so an external library can never collide with a service, and built
    // from the owner's FULL name so two same-short-named owners stay two boxes; only the label
    // carries the bare name.
    const externals = new Set([...apisByPair.keys()].map((key: string) => key.split(PAIR_SEP)[1]));
    for (const external of [...externals].sort()) {
        dot += model.node(
            `external__${external}`,
            `  "external__${dotValue(external)}" [shape=box, style="dashed,filled", fillcolor="${EXTERNAL_FILL}", ` +
                `color="${EXTERNAL_BORDER}", label="${dotValue(getShortName(external))}\\n(external)"];\n`,
        );
    }
    for (const key of [...apisByPair.keys()].sort()) {
        const parts = key.split(PAIR_SEP);
        const service = parts[0];
        const external = parts[1];
        const apis = apisByPair.get(key)!.sort();
        const via = apis.length > 2 ? `Uses (${apis.length}) ▾` : labelList(apis);
        // SOLID: this is a synchronous call that returns a value. Dashed is reserved for events, and
        // "outside the repo" is already said by the node's dashed border.
        dot += model.edge(
            service,
            `external__${external}`,
            `  "${serviceNodeId(service)}" -> "external__${dotValue(external)}" ` +
                `[label="${via}", color="${EXTERNAL_BORDER}"];\n`,
        );
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
    return generateRuntimeRenderModel(graph, title, options).fullDot;
}

/** Capture synthetic drawable nodes and edges at their original emission sites. */
// webpieces-disable no-function-outside-class -- renderer entry point matching generateRuntimeDot
export function generateRuntimeRenderModel(
    graph: RuntimeGraph,
    title: string = 'WebPieces Runtime Architecture',
    options: RuntimeVizOptions = new RuntimeVizOptions(),
): GraphRenderModel {
    const model = new GraphRenderModel();
    const details = new RuntimeDetails(graph, options.showExternalNodes);
    let dot = 'digraph RuntimeArchitecture {\n';
    dot += '  rankdir=TB;\n';
    dot += '  node [shape=box, style="filled,rounded", fontname="Arial"];\n';
    dot += '  edge [fontname="Arial", fontsize=12];\n\n';

    model.header = dot;

    // Services tagged drawOnGraph:false stay in the JSON but are omitted here —
    // both their node and any edge touching them are dropped from the render.
    const hidden = new Set(
        Object.keys(graph.services).filter(
            (name: string) => graph.services[name].drawOnGraph === false,
        ),
    );

    for (const name of Object.keys(graph.services)) {
        if (hidden.has(name)) continue;
        const svc = graph.services[name];
        const color = LEVEL_COLORS[svc.level] || '#F5F5F5';
        dot += model.node(
            name,
            `  "${serviceNodeId(name)}" [fillcolor="${color}", label="${nodeLabel(name, svc, details.nodes[name].used.length)}"];\n`,
            svc.products ?? [],
        );
    }

    dot += '\n';

    for (const edge of graph.runtimeEdges) {
        if (hidden.has(edge.from) || hidden.has(edge.to)) continue;
        // Queued hops are merged across methods, so they cannot be emitted one edge at a time.
        if (edge.type === 'pubsub') continue;
        dot += model.edge(edge.from, edge.to, edgeDot(edge));
    }

    dot += queuesDot(graph, hidden, model);
    dot += triggerDot(graph, hidden, options, model);

    if (options.showExternalNodes) {
        dot += externalSystemsDot(graph, hidden, model);
        dot += externalDot(graph, hidden, model);
    }

    const footerStart = dot.length;
    dot += '\n  labelloc="t";\n';
    dot += `  label="${dotValue(title)}\\n(from architecture/runtime-dependencies.json)";\n`;
    dot += '  fontsize=20;\n';
    dot += '}\n';
    // Nothing downstream parses this DOT until a human opens the page, so parse-shape is checked
    // HERE — a graph that cannot render is a generation failure, not a blank page to discover later.
    assertValidDot(dot, 'runtime-architecture.dot');
    model.footer = dot.slice(footerStart);
    model.completeEndpoints();
    // #1179: a queue, trigger or external system belongs to the products of the services it touches.
    model.attachProducts((id: string): boolean => graph.services[id] !== undefined);
    model.fullDot = dot;
    return model;
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

    const model = generateRuntimeRenderModel(graph, title, options);
    const dot = model.fullDot;
    const dotPath = path.join(outputDir, 'runtime-architecture.dot');
    fs.writeFileSync(dotPath, dot, 'utf-8');

    const htmlPath = path.join(outputDir, 'runtime-architecture.html');
    fs.writeFileSync(
        htmlPath,
        new RuntimeHtmlPage().render(model, title, graph, options.showExternalNodes),
        'utf-8',
    );

    return { dotPath, htmlPath };
}
