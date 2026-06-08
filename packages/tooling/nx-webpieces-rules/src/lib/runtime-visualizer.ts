/**
 * Runtime Visualizer
 *
 * Renders the runtime microservice graph (services + inferred Z -> X edges,
 * each labeled with the api(s) they flow over) to DOT + interactive HTML in
 * tmp/webpieces/runtime-architecture.{dot,html}.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RuntimeGraph } from './runtime-graph';

const LEVEL_COLORS: Record<number, string> = {
    0: '#E8F5E9',
    1: '#E3F2FD',
    2: '#FFF3E0',
    3: '#FCE4EC',
};

function getShortName(name: string): string {
    return name.includes('/') ? name.split('/').pop()! : name;
}

/** Build the Graphviz DOT for the runtime service graph. */
export function generateRuntimeDot(graph: RuntimeGraph, title: string = 'WebPieces Runtime Architecture'): string {
    let dot = 'digraph RuntimeArchitecture {\n';
    dot += '  rankdir=TB;\n';
    dot += '  node [shape=box, style="filled,rounded", fontname="Arial"];\n';
    dot += '  edge [fontname="Arial", fontsize=10];\n\n';

    for (const name of Object.keys(graph.services)) {
        const svc = graph.services[name];
        const color = LEVEL_COLORS[svc.level] || '#F5F5F5';
        const role = svc.implements.length > 0 ? 'server' : 'client';
        dot += `  "${getShortName(name)}" [fillcolor="${color}", label="${getShortName(name)}\\n(${role}, L${svc.level})"];\n`;
    }

    dot += '\n';

    for (const edge of graph.runtimeEdges) {
        const via = edge.via.map((v: string) => getShortName(v)).join(', ');
        dot += `  "${getShortName(edge.from)}" -> "${getShortName(edge.to)}" [label="${via}"];\n`;
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
    <div class="note">Edges are runtime calls (client &rarr; server), labeled with the api project they flow over.</div>
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
