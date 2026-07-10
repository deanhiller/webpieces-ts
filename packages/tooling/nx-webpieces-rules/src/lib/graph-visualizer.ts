/**
 * Graph Visualizer
 *
 * Generates visual representations of the architecture graph:
 * - DOT format (for Graphviz)
 * - Interactive HTML (using viz.js)
 *
 * All behavior lives on the injectable GraphVisualizer class so webpieces DI +
 * @DocumentDesign can wire it — module-scope functions are a dead end the DI
 * graph can't reach.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { EnhancedGraph } from './graph-sorter';
import type { ApiRelationKind } from './api-usage/api-relations';
import { GraphNames } from './graph-names';
import { ResponsibilitiesRenderer } from './graph-responsibilities';
import { toError } from '../toError';

/**
 * Framework (libType) colors for visualization — nodes are filled by the FIRST
 * env in their set that has a color, so it is obvious at a glance which side a
 * project targets. A project's full env set is shown in the label.
 */
const FRAMEWORK_COLORS: Record<string, string> = {
    angular: '#FCE4EC', // pink   - Angular front-end
    react: '#E3F2FD', // blue   - React front-end
    browser: '#EDE7F6', // purple - browser (front-end base env)
    express: '#E8F5E9', // green  - Express / server side
    node: '#FFF9C4', // yellow - node (server base env)
};

const DEFAULT_FRAMEWORK_COLOR = '#F5F5F5'; // grey - unknown/empty env set

/**
 * Directory (repo-relative) that the committed architecture HTML lives in.
 * Node click-through links are computed relative to this so they resolve when
 * the file is opened straight from the checkout.
 */
const ARCH_OUTPUT_DIR = 'architecture';

export class VisualizationPaths {
    htmlPath: string;

    constructor(htmlPath: string) {
        this.htmlPath = htmlPath;
    }
}

export class GraphVisualizer {
    private readonly names = new GraphNames();
    private readonly responsibilities = new ResponsibilitiesRenderer();

    /**
     * Fill color for an env set — the color of the first env in the set that has
     * a known color, else the default.
     */
    private frameworkColor(frameworks: string[]): string {
        for (const env of frameworks) {
            const color = FRAMEWORK_COLORS[env];
            if (color !== undefined) return color;
        }
        return DEFAULT_FRAMEWORK_COLOR;
    }

    /**
     * Role border styling — fill stays keyed on framework; the border shows a
     * project's ROLE at a glance. Server and client are the top-level runnable
     * nodes, so they get bold, colored borders to stand out:
     *   server       → thick GREEN border (a runnable server app)
     *   client       → thick RED border   (a client app, e.g. angular)
     *   designed-lib → bold border        (a library with a generated @DocumentDesign design)
     *   lib / other  → plain thin border
     */
    private roleBorderAttrs(role: string): string {
        if (role === 'server') return ', color="green", penwidth=3';
        if (role === 'client') return ', color="red", penwidth=3';
        if (role === 'api-lib') return ', color="#EF6C00", penwidth=2';
        if (role === 'designed-lib') return ', penwidth=2';
        return '';
    }

    /**
     * Edge styling by API-relation kind (why the edge exists):
     *   implements       → BLACK dashed (a controller serves this api-lib's contract)
     *   uses             → BLACK solid (a generated client calls it) — same as a
     *                      plain library import, since a plain dependency IS a use.
     *   uses-implements  → BLUE dashed, thicker (does both — implements some
     *                      contracts of the api-lib, uses others)
     *   plain lib (none) → the default thin black solid arrow, unchanged.
     * `kind` is undefined for every non-api-lib dependency edge.
     */
    private edgeAttrs(kind: ApiRelationKind | undefined): string {
        if (kind === 'implements') return ' [style=dashed]';
        if (kind === 'uses-implements') return ' [style=dashed, color="#1976d2", penwidth=2]';
        return '';
    }

    /**
     * Click-through href for a node: the project's committed design.html, made
     * relative to architecture/dependencies.html. Returns null when the project
     * has no generated DI design (no design.json → no clickable design page).
     */
    private designHtmlHref(designFile: string | undefined): string | null {
        if (!designFile) return null;
        const designHtml = designFile.replace(/design\.json$/, 'design.html');
        return path.posix.relative(ARCH_OUTPUT_DIR, designHtml);
    }

    /**
     * Generate Graphviz DOT format from the graph
     */
    generateDot(graph: EnhancedGraph, title: string = 'Monorepo Dependency Architecture'): string {
        let dot = 'digraph Architecture {\n';
        dot += '  rankdir=TB;\n';
        dot += '  node [shape=box, style=filled, fontname="Arial"];\n';
        dot += '  edge [fontname="Arial"];\n\n';

        // Group projects by level
        const levels: Record<number, string[]> = {};
        for (const project of Object.keys(graph)) {
            const level = graph[project].level;
            if (!levels[level]) levels[level] = [];
            levels[level].push(project);
        }

        dot += this.dotNodes(graph);
        dot += '\n';

        // Create same-rank subgraphs for each level
        for (const projects of Object.values(levels)) {
            dot += `  { rank=same; `;
            for (const p of projects) {
                dot += `"${this.names.getShortName(p)}"; `;
            }
            dot += '}\n';
        }

        dot += '\n';
        dot += this.dotEdges(graph);

        dot += '\n  labelloc="t";\n';
        dot += `  label="${title}\\n(from architecture/dependencies.json)";\n`;
        dot += '  fontsize=20;\n';
        dot += '}\n';

        return dot;
    }

    // Node lines: fill colored by framework env set (libType), border shaped by
    // role; the label shows the env set + role (e.g. [browser, node] · server). A
    // node with a generated DI design also gets a URL so the rendered SVG box is
    // clickable — it opens that project's committed design.html in a new tab.
    private dotNodes(graph: EnhancedGraph): string {
        let dot = '';
        for (const project of Object.keys(graph)) {
            const info = graph[project];
            const shortName = this.names.getShortName(project);
            const frameworks = info.framework ?? [];
            const role = info.role ?? 'lib';
            const color = this.frameworkColor(frameworks);
            const border = this.roleBorderAttrs(role);
            const href = this.designHtmlHref(info.designFile);
            const link = href ? `, URL="${href}", target="_blank"` : '';
            const envSet = `[${frameworks.join(', ')}]`;
            const labelMeta = `L${info.level} · ${envSet} · ${role}`;
            dot += `  "${shortName}" [fillcolor="${color}"${border}${link}, label="${shortName}\\n(${labelMeta})"];\n`;
        }
        return dot;
    }

    // Edge lines (dependencies). An edge to an api-lib is styled by WHY it exists
    // (implements/uses/uses-implements, from apiRelations); every other dependency
    // keeps the default plain arrow.
    private dotEdges(graph: EnhancedGraph): string {
        let dot = '';
        for (const project of Object.keys(graph)) {
            const shortName = this.names.getShortName(project);
            const info = graph[project];
            for (const dep of info.dependsOn || []) {
                const attrs = this.edgeAttrs(info.apiRelations?.[dep]?.kind);
                dot += `  "${shortName}" -> "${this.names.getShortName(dep)}"${attrs};\n`;
            }
        }
        return dot;
    }

    /**
     * Generate interactive HTML with embedded SVG using viz.js
     */
    generateHTML(
        dot: string,
        title: string = 'Monorepo Dependency Architecture',
        lockControl: string = '',
        responsibilitiesHtml: string = ''
    ): string {
        const styles = this.styles();
        const legend = this.legend();
        const script = this.script(dot);

        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>${title}</title>
    <script src="https://cdn.jsdelivr.net/npm/viz.js@2.1.2/viz.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/viz.js@2.1.2/full.render.js"></script>
    <style>${styles}</style>
</head>
<body>
    <h1>${title}</h1>
    <p class="hint">💡 Click any box with a generated DI design to open its <strong>design.html</strong> (what the AI sees inside that project).</p>
    <p class="hint">🔦 <strong>Hover any box</strong> to trace its <em>entire</em> dependency chain — every ancestor above it (all the way up) <em>and</em> every dependency below it (all the way down), with all the boxes and lines between — while the rest of the graph dims so you can follow one box at a glance.</p>
    ${legend}
    ${lockControl}
    <div id="graph"></div>
    ${responsibilitiesHtml}
    <script>${script}</script>
</body>
</html>`;
    }

    /**
     * The lock control (a single-select dropdown, rendered below the legend).
     * Picking a module LOCKS the graph into that box's hover view — its full
     * ancestor + descendant chain stays lit while everything else stays dimmed —
     * and narrows the responsibilities list below the graph to just that chain.
     * The first option, "All", is the default and clears the lock. Hover still
     * works on top of a lock; leaving a box returns to the locked view.
     *
     * Options are ordered by level DESCENDING to match the responsibilities cards.
     */
    lockControl(graph: EnhancedGraph): string {
        const projects = Object.keys(graph);
        projects.sort((a: string, b: string): number => {
            const levelDiff = graph[b].level - graph[a].level;
            if (levelDiff !== 0) return levelDiff;
            return a.localeCompare(b);
        });
        let options = '';
        for (const project of projects) {
            const shortName = this.names.getShortName(project);
            options += `<option value="${shortName}">L${graph[project].level} · ${shortName}</option>`;
        }
        return `<div class="wp-lock-control">
        <label for="wp-lock">🔒 Lock a box (dim the rest &amp; filter responsibilities):</label>
        <select id="wp-lock"><option value="">All (no lock)</option>${options}</select>
    </div>`;
    }

    private styles(): string {
        return `
        body { margin: 0; padding: 20px; font-family: Arial, sans-serif; background: #f5f5f5; }
        h1 { text-align: center; color: #333; }
        .hint { text-align: center; color: #555; margin: 0 0 16px; }
        /* viz.js renders node URLs as <a> — only boxes with a design.html get
         * one, so a:hover is a clickable-only signal. Make it pop clearly: a
         * thicker border PLUS a blue glow lift the box off the page, so it is
         * obvious which boxes you can click into vs. which you cannot. (A plain
         * stroke bump is invisible on server/client boxes, whose resting border
         * is already thick.) */
        #graph a { cursor: pointer; }
        #graph a polygon,
        #graph a ellipse { transition: stroke-width 0.12s ease, filter 0.12s ease; }
        #graph a:hover polygon,
        #graph a:hover ellipse {
            stroke: #1976d2;
            stroke-width: 5;
            filter: drop-shadow(0 0 6px rgba(25, 118, 210, 0.85));
        }
        /* Hover-highlight (wired up in JS after viz.js renders). Hovering a node
         * adds .wp-dim to the <svg> and .wp-focus/.wp-neighbor/.wp-hl to the
         * connected box, its neighbors, and its edges. We ONLY dim: the connected
         * subgraph keeps its exact normal look (full opacity), the rest recedes.
         * The un-dim rules repeat "svg.wp-dim" so they out-specify the dim rule
         * (which has an extra type selector) — else the subgraph stays dimmed. */
        #graph .node, #graph .edge { transition: opacity 0.12s ease; }
        #graph svg.wp-dim .node,
        #graph svg.wp-dim .edge { opacity: 0.15; }
        #graph svg.wp-dim .node.wp-focus,
        #graph svg.wp-dim .node.wp-neighbor,
        #graph svg.wp-dim .edge.wp-hl { opacity: 1; }
        #graph {
            text-align: center;
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .legend {
            margin: 20px auto;
            max-width: 1100px;
            padding: 15px;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .legend h2 { margin-top: 0; }
        .legend-item { margin: 8px 0; }
        .legend-box {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 1px solid #ccc;
            margin-right: 10px;
            vertical-align: middle;
        }
        ${this.componentStyles()}
    `;
    }

    // Styles for the lock dropdown and the responsibilities card list below the
    // graph. Split out of styles() to keep each method within the line limit.
    private componentStyles(): string {
        return `
        /* The architecture graph is very wide, so lay the legend out as three
         * side-by-side columns (fill / border / edge) instead of one tall
         * column — it keeps the legend short next to the wide graph, and
         * collapses back to a single column on narrow viewports. */
        .legend-columns {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 28px;
            align-items: start;
        }
        .legend-col h3 { margin: 0 0 8px; color: #333; font-size: 15px; }
        @media (max-width: 800px) { .legend-columns { grid-template-columns: 1fr; } }
        .wp-lock-control {
            max-width: 600px;
            margin: 0 auto 16px;
            padding: 12px 15px;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            text-align: center;
        }
        .wp-lock-control label { font-weight: bold; color: #333; margin-right: 8px; }
        .wp-lock-control select { font-size: 14px; padding: 4px 8px; }
        #wp-responsibilities { max-width: 900px; margin: 24px auto 0; }
        #wp-responsibilities h2 { color: #333; }
        .wp-resp-card {
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            margin: 10px 0;
            padding: 10px 15px;
        }
        .wp-resp-card > summary { cursor: pointer; color: #333; }
        .wp-resp-level {
            display: inline-block;
            min-width: 26px;
            padding: 1px 6px;
            margin-right: 6px;
            border-radius: 4px;
            background: #eef;
            font-size: 12px;
            font-weight: bold;
            text-align: center;
        }
        .wp-resp-body { margin-top: 8px; color: #444; }
        .wp-resp-body code {
            background: #f2f2f2;
            padding: 1px 4px;
            border-radius: 3px;
            font-family: monospace;
        }
        .wp-hidden { display: none; }`;
    }

    // The legend is laid out in three side-by-side columns (fill / border /
    // edge) so it stays short next to the very wide architecture graph. Each
    // column's rows come from a helper below to keep this method within the line
    // limit; the footnote spans the full width beneath the columns.
    private legend(): string {
        return `<div class="legend">
        <h2>Legend</h2>
        <div class="legend-columns">
            <div class="legend-col">
                <h3>Fill = framework (libType)</h3>
                ${this.fillItems()}
            </div>
            <div class="legend-col">
                <h3>Border = role</h3>
                ${this.borderItems()}
            </div>
            <div class="legend-col">
                <h3>Edge lines — <em>why</em> a project depends on an api-lib</h3>
                ${this.edgeItems()}
            </div>
        </div>
        <div class="legend-item" style="margin-top: 15px;">
            <em>Each node label shows its dependency level (L#), its framework env set (e.g. [browser, node]), and its role. Rows are laid out by level (top = no dependencies), with the deepest libraries at the bottom. Transitive dependencies are allowed but not shown.</em>
        </div>
    </div>`;
    }

    // Column 1 — fill color keyed on the project's framework (libType) env set.
    private fillItems(): string {
        return `<div class="legend-item">
            <span class="legend-box" style="background: #FCE4EC;"></span>
            <strong>angular:</strong> Angular front-end
        </div>
        <div class="legend-item">
            <span class="legend-box" style="background: #E3F2FD;"></span>
            <strong>react:</strong> React front-end
        </div>
        <div class="legend-item">
            <span class="legend-box" style="background: #EDE7F6;"></span>
            <strong>browser:</strong> browser front-end base env
        </div>
        <div class="legend-item">
            <span class="legend-box" style="background: #E8F5E9;"></span>
            <strong>express:</strong> Express / server side
        </div>
        <div class="legend-item">
            <span class="legend-box" style="background: #FFF9C4;"></span>
            <strong>node:</strong> node server base env
        </div>`;
    }

    // Column 2 — border style keyed on the project's role.
    private borderItems(): string {
        return `<div class="legend-item">
            <span class="legend-box" style="border: 3px solid green;"></span>
            <strong>server:</strong> runnable server app (thick green border)
        </div>
        <div class="legend-item">
            <span class="legend-box" style="border: 3px solid red;"></span>
            <strong>client:</strong> client app, e.g. angular (thick red border)
        </div>
        <div class="legend-item">
            <span class="legend-box" style="border: 2px solid #333;"></span>
            <strong>designed-lib:</strong> library with a generated @DocumentDesign design (bold border)
        </div>
        <div class="legend-item">
            <span class="legend-box" style="border: 1px solid #ccc;"></span>
            <strong>lib:</strong> plain library, no generated design (thin border)
        </div>
        <div class="legend-item">
            <span class="legend-box" style="border: 2px solid #EF6C00;"></span>
            <strong>api-lib:</strong> API-contract library (defines <code>@ApiPath</code>/<code>@Rpc</code>/<code>@PubSub</code> <code>*Api</code> classes)
        </div>`;
    }

    // Column 3 — edge line style keyed on WHY a project depends on an api-lib.
    private edgeItems(): string {
        return `<div class="legend-item">
            <svg width="42" height="12" style="vertical-align: middle; margin-right: 10px;"><line x1="0" y1="6" x2="42" y2="6" stroke="#333" stroke-width="2"/></svg>
            <strong>uses:</strong> calls the API (generates an rpc/pubsub client via <code>createRpcClient</code>/<code>createPubSubClient</code>) — also covers a plain library import, since a plain dependency is just a use.
        </div>
        <div class="legend-item">
            <svg width="42" height="12" style="vertical-align: middle; margin-right: 10px;"><line x1="0" y1="6" x2="42" y2="6" stroke="#333" stroke-width="2" stroke-dasharray="5,3"/></svg>
            <strong>implements:</strong> serves the API — NOTE: this is a build-dependency diagram, so a UML <em>implements</em> arrow can't be used; we use a dashed line to signal a build dep, because this server implements the api and the api is built first, then this server after.
        </div>
        <div class="legend-item">
            <svg width="42" height="12" style="vertical-align: middle; margin-right: 10px;"><line x1="0" y1="6" x2="42" y2="6" stroke="#1976d2" stroke-width="2" stroke-dasharray="5,3"/></svg>
            <strong>uses/implements:</strong> both — implements some of the api-lib's contracts, uses others
        </div>`;
    }

    /**
     * The page script. The browser code lives in graph-visualizer.client.js (a
     * plain .js asset, NOT a TS template literal) so its dim/highlight/lock
     * functions can be ordinary browser functions — the TS lint rules that scan
     * .ts template strings would otherwise forbid them, and browser JS cannot
     * carry TS return annotations. We inline it and substitute the DOT.
     */
    private script(dot: string): string {
        const clientJs = fs.readFileSync(path.join(__dirname, 'graph-visualizer.client.js'), 'utf-8');
        return clientJs.split('__DOT__').join(JSON.stringify(dot));
    }

    /**
     * Write the committed architecture visualization to
     * architecture/dependencies.html, next to dependencies.json.
     *
     * This is a checked-in artifact, regenerated deterministically by
     * architecture:generate so the boxes stay clickable into each project's
     * design.html. The DOT is embedded in the HTML (rendered client-side by
     * viz.js). Output is deterministic (sorted graph in → same bytes out) so git
     * only shows a diff when the architecture actually changed.
     */
    writeVisualization(
        graph: EnhancedGraph,
        workspaceRoot: string,
        title: string = 'Monorepo Dependency Architecture'
    ): VisualizationPaths {
        const outputDir = path.join(workspaceRoot, ARCH_OUTPUT_DIR);

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const lockControl = this.lockControl(graph);
        const responsibilities = this.responsibilities.generateSection(graph, workspaceRoot);
        const html = this.generateHTML(this.generateDot(graph, title), title, lockControl, responsibilities);
        const htmlPath = path.join(outputDir, 'dependencies.html');
        fs.writeFileSync(htmlPath, html, 'utf-8');

        return new VisualizationPaths(htmlPath);
    }

    /**
     * Open the HTML visualization in the default browser
     */
    openVisualization(htmlPath: string): boolean {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const platform = process.platform;
            let openCommand: string;

            if (platform === 'darwin') {
                openCommand = `open "${htmlPath}"`;
            } else if (platform === 'win32') {
                openCommand = `start "" "${htmlPath}"`;
            } else {
                openCommand = `xdg-open "${htmlPath}"`;
            }

            execSync(openCommand, { stdio: 'ignore' });
            return true;
        } catch (err: unknown) {
            const error = toError(err);
            console.warn(`⚠️  Could not open browser: ${error.message}`);
            return false;
        }
    }
}
