/**
 * DI Design HTML Visualizer
 *
 * Builds one HTML page per project showing EVERY controller/root design as
 * its own Graphviz graph (rendered client-side with viz.js, same pipeline as
 * the architecture visualization). Output goes to tmp/webpieces/ — a view,
 * never committed (the committed artifacts are design.json/design.md).
 */

import * as fs from 'fs';
import * as path from 'path';
import { DiDesign, DiGraph, DiNode } from './model';
import { sortGraph } from './serializer';
import { generateDesignDot, isStackedNode } from './dot';

export class DesignVisualizationPaths {
    constructor(
        public readonly dotPath: string,
        public readonly htmlPath: string
    ) {}
}

class DesignGraphEntry {
    constructor(
        public readonly id: string,
        public readonly dot: string,
        /** Node ids to paint as a stack of instances (transient). Sorted, so the HTML is stable. */
        public readonly stackedIds: string[]
    ) {}
}

/** The transient nodes of one design, in the design's (already sorted) node order. */
// webpieces-disable no-function-outside-class -- pure emitter helper, matching every sibling in this file
function stackedIdsOf(design: DiDesign): string[] {
    return design.nodes.filter((node: DiNode) => isStackedNode(node)).map((node: DiNode) => node.id);
}

function htmlEscape(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pageStyles(): string {
    return `
        body { margin: 0; padding: 20px; font-family: Arial, sans-serif; background: #f5f5f5; }
        h1 { text-align: center; color: #333; }
        .back { max-width: 95%; margin: 0 auto 8px; }
        .back a { color: #1565C0; text-decoration: none; }
        .back a:hover { text-decoration: underline; }
        h2 { color: #333; margin-bottom: 4px; }
        .meta { color: #777; font-family: monospace; font-size: 13px; margin-bottom: 10px; }
        .section { background: white; padding: 20px; border-radius: 8px;
                   box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin: 20px auto; max-width: 95%; }
        .graph { text-align: center; overflow-x: auto; }
        .legend { margin: 20px auto; max-width: 700px; padding: 15px; background: white;
                  border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .legend-item { margin: 8px 0; }
        .legend-box { display: inline-block; width: 20px; height: 20px;
                      border: 1px solid #ccc; margin-right: 10px; vertical-align: middle; }
    `;
}

function pageLegend(): string {
    return `<div class="legend">
        <h2>Legend</h2>
        <div class="legend-item"><span class="legend-box" style="background: #E3F2FD;"></span>
            <strong>Design root</strong> — level 0, the @DocumentDesign entry class of the tree
        <div class="legend-item"><span class="legend-box" style="background: #F5F5F5;"></span>
            <strong>Class</strong> — injectable class (constructor injection)</div>
        <div class="legend-item"><span class="legend-box" style="background: #FFF3E0;"></span>
            <strong>Constant / dynamic</strong> — toConstantValue / toDynamicValue leaf</div>
        <div class="legend-item"><span class="legend-box" style="background: #FCE4EC; border-style: dashed;"></span>
            <strong>Unresolved</strong> — token the analyzer could not resolve</div>
        <div class="legend-item"><span class="legend-box" style="background: #EDE7F6; border: 3px double #5e35b1;"></span>
            <strong>External</strong> — class from a published package outside this workspace; shown as a boundary, not expanded</div>
        <div class="legend-item"><span class="legend-box" style="background: #E1F5FE; border: 3px double #0277bd;"></span>
            <strong>API client</strong> — generated <code>createApiClient</code> proxy (service/network boundary); shown as a boundary, not expanded</div>
        <div class="legend-item"><span class="legend-box" style="background: #F5F5F5; margin-left: 12px; box-shadow: -5px -5px 0 -1px #fff, -5px -5px 0 0 #ccc, -10px -10px 0 -1px #fff, -10px -10px 0 0 #ccc;"></span>
            <strong>Stack of boxes</strong> — a TRANSIENT class: every arrow into it resolves its OWN
            instance. A single box is a singleton, whose arrows all share one instance.</div>
        <div class="legend-item" style="margin-top: 15px;">
            <em>One graph per controller/root; a shared dependency appears in each root's tree.
            Edge labels are injection tokens; unlabeled edges are inject-by-type.</em></div>
    </div>`;
}

/**
 * Paint the "many instances" glyph: for each transient node, clone its outline twice and offset
 * the copies up-and-left BEHIND the real box, so you see a stack of three whose back two show only
 * their top and left edges.
 *
 * Graphviz has no offset-stack primitive, so we do it on the SVG viz.js hands back before it is
 * attached. That costs nothing in review stability — the committed design.html holds only this
 * static script plus a sorted id list; the SVG itself is produced in the browser at view time.
 *
 * Nodes are matched by their <title>, which Graphviz always emits as the node id. (Its `class`
 * attribute arrived in Graphviz 2.40 and is not verified to survive viz.js@2.1.2.)
 */
// webpieces-disable no-function-outside-class -- pure emitter helper, matching every sibling in this file
function stackScript(): string {
    return `
        function paintStacks(element, stackedIds) {
            const nodes = element.querySelectorAll('g.node');
            const byTitle = new Map();
            nodes.forEach(n => {
                const title = n.querySelector('title');
                if (title) byTitle.set(title.textContent, n);
            });
            for (const id of stackedIds) {
                const node = byTitle.get(id);
                if (!node) continue;
                const outline = node.querySelector('polygon, polyline, path');
                if (!outline) continue;
                // Farthest copy first so the nearer one paints over it; both go behind the original.
                for (const offset of [-10, -5]) {
                    const ghost = outline.cloneNode(false);
                    ghost.setAttribute('transform', 'translate(' + offset + ',' + offset + ')');
                    ghost.setAttribute('fill', '#ffffff');
                    node.insertBefore(ghost, node.firstChild);
                }
            }
        }
    `;
}

function renderScript(entries: DesignGraphEntry[]): string {
    return `
        const graphs = ${JSON.stringify(entries)};
        ${stackScript()}
        const viz = new Viz();
        for (const g of graphs) {
            viz.renderSVGElement(g.dot)
                .then(element => {
                    paintStacks(element, g.stackedIds);
                    document.getElementById(g.id).appendChild(element);
                })
                .catch(err => {
                    console.error(err);
                    document.getElementById(g.id).innerHTML = '<pre>' + err + '</pre>';
                });
        }
    `;
}

/**
 * Build the full HTML page for a project's DI designs — one section (heading
 * + meta + rendered graph) per controller/root design.
 *
 * `backHref`, when given, renders a "back to architecture" link at the top —
 * used by the committed per-project design.html so a reader who clicked in from
 * dependencies.html can click back out. Omitted for the tmp view.
 */
export function generateDesignHTML(graph: DiGraph, backHref?: string): string {
    const title = `DI Designs — ${graph.project}`;
    const entries: DesignGraphEntry[] = [];
    const sections: string[] = [];
    const backLink = backHref
        ? `<p class="back"><a href="${htmlEscape(backHref)}">← Back to architecture graph</a></p>`
        : '';

    graph.designs.forEach((design: DiDesign, index: number) => {
        const id = `graph-${index}`;
        entries.push(new DesignGraphEntry(id, generateDesignDot(design), stackedIdsOf(design)));
        sections.push(`<div class="section">
        <h2>${htmlEscape(design.root)} — ${design.rootKind}, Level 0…${design.maxLevel}</h2>
        <div class="meta">${htmlEscape(design.file)}</div>
        <div id="${id}" class="graph"></div>
    </div>`);
    });

    const body =
        sections.length > 0
            ? sections.join('\n    ')
            : '<div class="section"><em>No DI-registered classes found in this project.</em></div>';

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>${htmlEscape(title)}</title>
    <script src="https://cdn.jsdelivr.net/npm/viz.js@2.1.2/viz.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/viz.js@2.1.2/full.render.js"></script>
    <style>${pageStyles()}</style>
</head>
<body>
    ${backLink}
    <h1>${htmlEscape(title)}</h1>
    ${pageLegend()}
    ${body}
    <script>${renderScript(entries)}</script>
</body>
</html>`;
}

/**
 * Write tmp/webpieces/design-<project>.html (+ .dot with all digraphs
 * concatenated, for debugging) and return the paths.
 */
export function writeDesignVisualization(
    graph: DiGraph,
    workspaceRoot: string
): DesignVisualizationPaths {
    sortGraph(graph);

    const outputDir = path.join(workspaceRoot, 'tmp', 'webpieces');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const allDot = graph.designs.map((design: DiDesign) => generateDesignDot(design)).join('\n');
    const dotPath = path.join(outputDir, `design-${graph.project}.dot`);
    fs.writeFileSync(dotPath, allDot, 'utf-8');

    const htmlPath = path.join(outputDir, `design-${graph.project}.html`);
    fs.writeFileSync(htmlPath, generateDesignHTML(graph), 'utf-8');

    return new DesignVisualizationPaths(dotPath, htmlPath);
}
