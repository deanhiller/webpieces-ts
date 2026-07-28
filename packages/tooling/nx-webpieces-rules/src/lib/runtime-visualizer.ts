/**
 * Runtime Visualizer
 *
 * Renders the runtime microservice graph (services + inferred Z -> X edges,
 * each labeled with the api(s) they flow over) to DOT + interactive HTML in
 * tmp/webpieces/runtime-architecture.{dot,html}.
 *
 * Each service node names the contracts it IMPLEMENTS and USES. That list is the
 * single most important fact in a microservice architecture, and it used to be
 * collapsed into a server/client boolean and thrown away — leaving an api that a
 * server serves but nothing in-repo calls completely invisible, and making a
 * correct api design look like a detection failure.
 *
 * Calls that leave the repo (a contract NOTHING in-repo implements — firestore,
 * gmail, ...) are drawn as dashed terminal nodes, so the vendor systems that
 * actually page you at 3am stop being missing from the picture. They are
 * RENDER-ONLY: derivation, levels and cycle detection never see them.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RuntimeGraph, RuntimeEdge, RuntimeService } from './runtime-graph';

const LEVEL_COLORS: Record<number, string> = {
    0: '#E8F5E9',
    1: '#E3F2FD',
    2: '#FFF3E0',
    3: '#FCE4EC',
};

const QUEUE_FILL = '#FFF3E0';

/** Fill + border for the dashed terminal node standing for a system outside this repo. */
const EXTERNAL_FILL = '#FAFAFA';
const EXTERNAL_BORDER = '#9E9E9E';

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
    for (let i = 0; i < entries.length; i += APIS_PER_LABEL_LINE) {
        lines.push(entries.slice(i, i + APIS_PER_LABEL_LINE).join(', '));
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
 * The full node label: name, role/level/declared service name, then the contracts it serves and
 * the contracts it calls. A node with neither reads exactly as before.
 */
// webpieces-disable no-function-outside-class -- DOT label builder, matching getShortName in this file
function nodeLabel(name: string, svc: RuntimeService): string {
    const role = svc.implements.length > 0 ? 'server' : 'client';
    const declared = svc.serviceName === undefined ? '' : `, "${svc.serviceName}"`;
    let label = `${getShortName(name)}\\n(${role}, L${svc.level}${declared})`;
    if (svc.implements.length > 0) label += `\\nimplements: ${labelList(implementsEntries(svc))}`;
    if (svc.uses.length > 0) label += `\\nuses: ${labelList(svc.uses)}`;
    return label;
}

/**
 * DOT for ONE runtime edge. rpc → a direct labeled arrow (producer calls consumer). pubsub → the
 * producer enqueues and the consumer is delivered later, so we draw producer → QUEUE → consumer
 * with a cylinder queue node and dashed enqueue/deliver arrows.
 */
// webpieces-disable no-function-outside-class -- DOT string builder, matching getShortName in this file
function edgeDot(edge: RuntimeEdge): string {
    const from = getShortName(edge.from);
    const to = getShortName(edge.to);
    const via = edge.via.map((v: string) => getShortName(v)).join(', ');
    if (edge.type !== 'pubsub') {
        return `  "${from}" -> "${to}" [label="${via}"];\n`;
    }
    const queueId = `queue__${from}__${to}`;
    return (
        `  "${queueId}" [shape=cylinder, style="filled", fillcolor="${QUEUE_FILL}", label="${via}\\nqueue"];\n` +
        `  "${from}" -> "${queueId}" [label="enqueue", style=dashed];\n` +
        `  "${queueId}" -> "${to}" [label="deliver", style=dashed];\n`
    );
}

/**
 * The dashed terminal nodes + edges for calls that LEAVE the repo. Built from `unresolvedUses` —
 * a contract used by a node and implemented by nobody in-repo — which the derivation already
 * computes and which was, until now, only ever printed as a warning.
 *
 * Grouped by the api-lib that owns the contracts, so a service reaching three firestore contracts
 * draws ONE `lib-firestore (external)` box rather than three. These are drawn, never derived: they
 * are absent from levels, cycle detection and the transitive implements attribution.
 */
// webpieces-disable no-function-outside-class -- DOT string builder, matching getShortName in this file
function externalDot(graph: RuntimeGraph, hidden: Set<string>): string {
    // "service|externalName" -> the apis flowing over it.
    const apisByPair = new Map<string, string[]>();
    for (const use of graph.unresolvedUses) {
        if (hidden.has(use.service)) continue;
        const external = getShortName(graph.apis[use.api]?.owner ?? use.api);
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
        dot +=
            `  "${getShortName(service)}" -> "external__${external}" ` +
            `[label="${via}", style=dashed, color="${EXTERNAL_BORDER}"];\n`;
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
        dot += `  "${getShortName(name)}" [fillcolor="${color}", label="${nodeLabel(name, svc)}"];\n`;
    }

    dot += '\n';

    for (const edge of graph.runtimeEdges) {
        if (hidden.has(edge.from) || hidden.has(edge.to)) continue;
        dot += edgeDot(edge);
    }

    if (options.showExternalNodes) dot += externalDot(graph, hidden);

    dot += '\n  labelloc="t";\n';
    dot += `  label="${title}\\n(from architecture/runtime-dependencies.json)";\n`;
    dot += '  fontsize=20;\n';
    dot += '}\n';
    return dot;
}

function generateRuntimeHtml(dot: string, title: string): string {
    const script = `
        const dot = ${JSON.stringify(dot)};
        const viz = new Viz();
        viz.renderSVGElement(dot)
            .then(el => document.getElementById('graph').appendChild(el))
            .catch(err => { document.getElementById('graph').innerHTML = '<pre>' + err + '</pre>'; });
    `;
    return `<!DOCTYPE html>
<html>
<head>
    <title>${title}</title>
    <script src="https://cdn.jsdelivr.net/npm/viz.js@2.1.2/viz.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/viz.js@2.1.2/full.render.js"></script>
    <style>
        body { margin: 0; padding: 20px; font-family: Arial, sans-serif; background: #f5f5f5; }
        h1 { text-align: center; color: #333; }
        #graph { text-align: center; background: white; padding: 20px; border-radius: 8px; }
        .note { max-width: 700px; margin: 12px auto; color: #555; text-align: center; }
    </style>
</head>
<body>
    <h1>${title}</h1>
    <div class="note">Runtime calls between services. <strong>rpc</strong> = a direct arrow (synchronous call, labeled with the api). <strong>pubsub</strong> = producer &rarr; <em>queue</em> (cylinder) &rarr; consumer: the producer enqueues a Cloud Task and the consumer is delivered it later.</div>
    <div class="note">Each box lists the contracts it <strong>implements</strong> (serves) and <strong>uses</strong> (calls) — so an api a service serves is visible even when nothing in this repo calls it. <em>(via &lt;lib&gt;)</em> means the service serves that contract through an embedded library rather than its own source. A <strong>dashed box</strong> is a system OUTSIDE this repo (firestore, gmail, ...): a contract this repo calls and nothing here implements.</div>
    <div id="graph"></div>
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
