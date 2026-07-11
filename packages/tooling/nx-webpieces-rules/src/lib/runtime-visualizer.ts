/**
 * Runtime Visualizer
 *
 * Renders the runtime microservice graph (services + inferred Z -> X edges,
 * each labeled with the api(s) they flow over) to DOT + interactive HTML in
 * tmp/webpieces/runtime-architecture.{dot,html}.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RuntimeGraph, RuntimeEdge } from './runtime-graph';

const LEVEL_COLORS: Record<number, string> = {
    0: '#E8F5E9',
    1: '#E3F2FD',
    2: '#FFF3E0',
    3: '#FCE4EC',
};

const QUEUE_FILL = '#FFF3E0';

function getShortName(name: string): string {
    return name.includes('/') ? name.split('/').pop()! : name;
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

/** Build the Graphviz DOT for the runtime service graph. */
export function generateRuntimeDot(graph: RuntimeGraph, title: string = 'WebPieces Runtime Architecture'): string {
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
        const role = svc.implements.length > 0 ? 'server' : 'client';
        dot += `  "${getShortName(name)}" [fillcolor="${color}", label="${getShortName(name)}\\n(${role}, L${svc.level})"];\n`;
    }

    dot += '\n';

    for (const edge of graph.runtimeEdges) {
        if (hidden.has(edge.from) || hidden.has(edge.to)) continue;
        dot += edgeDot(edge);
    }

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
): RuntimeVisualizationPaths {
    const outputDir = path.join(workspaceRoot, 'tmp', 'webpieces');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const dot = generateRuntimeDot(graph, title);
    const dotPath = path.join(outputDir, 'runtime-architecture.dot');
    fs.writeFileSync(dotPath, dot, 'utf-8');

    const htmlPath = path.join(outputDir, 'runtime-architecture.html');
    fs.writeFileSync(htmlPath, generateRuntimeHtml(dot, title), 'utf-8');

    return { dotPath, htmlPath };
}
