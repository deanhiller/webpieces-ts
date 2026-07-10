/**
 * Graph Visualizer
 *
 * Generates visual representations of the architecture graph:
 * - DOT format (for Graphviz)
 * - Interactive HTML (using viz.js)
 *
 * Output files go to tmp/webpieces/ for easy viewing without committing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { EnhancedGraph } from './graph-sorter';
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
 * Fill color for an env set — the color of the first env in the set that has a
 * known color, else the default.
 */
function frameworkColor(frameworks: string[]): string {
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
function roleBorderAttrs(role: string): string {
    if (role === 'server') return ', color="green", penwidth=3';
    if (role === 'client') return ', color="red", penwidth=3';
    if (role === 'designed-lib') return ', penwidth=2';
    return '';
}

/**
 * Remove scope from name for display
 * '@scope/name' → 'name'
 * 'name' → 'name'
 */
function getShortName(name: string): string {
    return name.includes('/') ? name.split('/').pop()! : name;
}

/**
 * Directory (repo-relative) that the committed architecture HTML lives in.
 * Node click-through links are computed relative to this so they resolve when
 * the file is opened straight from the checkout.
 */
const ARCH_OUTPUT_DIR = 'architecture';

/**
 * Click-through href for a node: the project's committed design.html, made
 * relative to architecture/dependencies.html. Returns null when the project has
 * no generated DI design (no design.json → no clickable design page).
 *
 * designFile is repo-relative posix (e.g. 'packages/http/http-api/design.json');
 * we swap the extension and re-root it at architecture/ so the browser resolves
 * '../packages/http/http-api/design.html' from the checkout.
 */
function designHtmlHref(designFile: string | undefined): string | null {
    if (!designFile) return null;
    const designHtml = designFile.replace(/design\.json$/, 'design.html');
    return path.posix.relative(ARCH_OUTPUT_DIR, designHtml);
}

/**
 * Generate Graphviz DOT format from the graph
 */
export function generateDot(graph: EnhancedGraph, title: string = 'Monorepo Dependency Architecture'): string {
    let dot = 'digraph Architecture {\n';
    dot += '  rankdir=TB;\n';
    dot += '  node [shape=box, style=filled, fontname="Arial"];\n';
    dot += '  edge [fontname="Arial"];\n\n';

    // Group projects by level
    const levels: Record<number, string[]> = {};
    for (const [project, info] of Object.entries(graph)) {
        if (!levels[info.level]) levels[info.level] = [];
        levels[info.level].push(project);
    }

    // Nodes: fill colored by framework env set (libType), border shaped by role;
    // the label shows the env set + role (e.g. [browser, node] · server).
    // A node with a generated DI design also gets a URL so the rendered SVG box
    // is clickable — it opens that project's committed design.html in a new tab.
    for (const [project, info] of Object.entries(graph)) {
        const shortName = getShortName(project);
        const frameworks = info.framework ?? [];
        const role = info.role ?? 'lib';
        const color = frameworkColor(frameworks);
        const border = roleBorderAttrs(role);
        const href = designHtmlHref(info.designFile);
        const link = href ? `, URL="${href}", target="_blank"` : '';
        const envSet = `[${frameworks.join(', ')}]`;
        const labelMeta = `L${info.level} · ${envSet} · ${role}`;
        dot += `  "${shortName}" [fillcolor="${color}"${border}${link}, label="${shortName}\\n(${labelMeta})"];\n`;
    }

    dot += '\n';

    // Create same-rank subgraphs for each level
    for (const [level, projects] of Object.entries(levels)) {
        dot += `  { rank=same; `;
        projects.forEach((p) => {
            const shortName = getShortName(p);
            dot += `"${shortName}"; `;
        });
        dot += '}\n';
    }

    dot += '\n';

    // Create edges (dependencies)
    for (const [project, info] of Object.entries(graph)) {
        const shortName = getShortName(project);
        for (const dep of info.dependsOn || []) {
            const depShortName = getShortName(dep);
            dot += `  "${shortName}" -> "${depShortName}";\n`;
        }
    }

    dot += '\n  labelloc="t";\n';
    dot += `  label="${title}\\n(from architecture/dependencies.json)";\n`;
    dot += '  fontsize=20;\n';
    dot += '}\n';

    return dot;
}

/**
 * Generate interactive HTML with embedded SVG using viz.js
 */
export function generateHTML(dot: string, title: string = 'Monorepo Dependency Architecture'): string {
    const styles = generateHTMLStyles();
    const legend = generateHTMLLegend();
    const script = generateHTMLScript(dot);

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
    <p class="hint">🔦 <strong>Hover any box</strong> to bolden all of its connections (incoming <em>and</em> outgoing) and highlight the boxes on the other end — the rest of the graph dims so you can trace one box at a glance.</p>
    ${legend}
    <div id="graph"></div>
    <script>${script}</script>
</body>
</html>`;
}

function generateHTMLStyles(): string {
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
        /* Hover-highlight (wired up in JS after viz.js renders — see
         * wireHoverHighlight). Hovering a node adds .wp-dim to the <svg> and
         * .wp-focus/.wp-neighbor/.wp-hl to the connected box, its neighbors, and
         * its edges. We ONLY dim: the connected subgraph keeps its exact normal
         * look (full opacity), the rest recedes. The un-dim rules repeat the
         * "svg.wp-dim" ancestor so they out-specify the dim rule (which has an
         * extra type selector) — else the highlighted subgraph stays dimmed. */
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
            max-width: 600px;
            padding: 15px;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .legend h2 {
            margin-top: 0;
        }
        .legend-item {
            margin: 8px 0;
        }
        .legend-box {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 1px solid #ccc;
            margin-right: 10px;
            vertical-align: middle;
        }
    `;
}

function generateHTMLLegend(): string {
    return `<div class="legend">
        <h2>Legend — fill = framework (libType), border = role</h2>
        <div class="legend-item">
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
        </div>
        <div class="legend-item" style="margin-top: 12px;">
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
        <div class="legend-item" style="margin-top: 15px;">
            <em>Each node label shows its dependency level (L#), its framework env set (e.g. [browser, node]), and its role. Rows are laid out by level (top = no dependencies), with the deepest libraries at the bottom. Transitive dependencies are allowed but not shown.</em>
        </div>
    </div>`;
}

/**
 * The page script (injected as a string). After viz.js renders the Graphviz
 * SVG, `wireHoverHighlight` indexes its nodes and edges so hovering a box
 * boldens every connection (incoming AND outgoing) and highlights the boxes on
 * the other end, dimming the rest. viz.js emits a predictable structure:
 *   <g class="node"><title>NAME</title> ... </g>
 *   <g class="edge"><title>FROM->TO</title> <path/> <polygon/> ... </g>
 * The edge <title> text (decoded by the DOM as "FROM->TO") gives both
 * endpoints, so adjacency is built without touching the DOT.
 */
function generateHTMLScript(dot: string): string {
    return `
        const dot = ${JSON.stringify(dot)};
        const viz = new Viz();
        viz.renderSVGElement(dot)
            .then(element => {
                document.getElementById('graph').appendChild(element);
                wireHoverHighlight(element);
            })
            .catch(err => {
                console.error(err);
                document.getElementById('graph').innerHTML = '<pre>' + err + '</pre>';
            });
        function wireHoverHighlight(svg) {
            const nodeByName = new Map();
            svg.querySelectorAll('g.node').forEach(g => {
                const t = g.querySelector('title');
                if (t) nodeByName.set(t.textContent.trim(), g);
            });
            const edgesOf = new Map();
            const neighborsOf = new Map();
            const ensure = (map, key) => {
                let v = map.get(key);
                if (!v) { v = new Set(); map.set(key, v); }
                return v;
            };
            svg.querySelectorAll('g.edge').forEach(edge => {
                const t = edge.querySelector('title');
                if (!t) return;
                const idx = t.textContent.indexOf('->');
                if (idx < 0) return;
                const from = t.textContent.slice(0, idx).trim();
                const to = t.textContent.slice(idx + 2).trim();
                ensure(edgesOf, from).add(edge);
                ensure(edgesOf, to).add(edge);
                ensure(neighborsOf, from).add(to);
                ensure(neighborsOf, to).add(from);
            });
            const clear = () => {
                svg.classList.remove('wp-dim');
                svg.querySelectorAll('.wp-focus, .wp-neighbor, .wp-hl').forEach(el => {
                    el.classList.remove('wp-focus', 'wp-neighbor', 'wp-hl');
                });
            };
            const highlight = (name, focusEl) => {
                clear();
                svg.classList.add('wp-dim');
                focusEl.classList.add('wp-focus');
                (edgesOf.get(name) || []).forEach(e => e.classList.add('wp-hl'));
                (neighborsOf.get(name) || []).forEach(n => {
                    const g = nodeByName.get(n);
                    if (g) g.classList.add('wp-neighbor');
                });
            };
            nodeByName.forEach((g, name) => {
                g.addEventListener('mouseenter', () => highlight(name, g));
                g.addEventListener('mouseleave', clear);
            });
        }
    `;
}

interface VisualizationPaths {
    htmlPath: string;
}

/**
 * Write the committed architecture visualization to architecture/dependencies.html,
 * next to dependencies.json.
 *
 * This is a checked-in artifact, regenerated deterministically by
 * architecture:generate so the boxes stay clickable into each project's
 * design.html. The DOT is embedded in the HTML (rendered client-side by
 * viz.js), so no separate .dot file is committed — same as design.html. Output
 * is deterministic (sorted graph in → same bytes out) so git only shows a diff
 * when the architecture actually changed.
 */
export function writeVisualization(
    graph: EnhancedGraph,
    workspaceRoot: string,
    title: string = 'Monorepo Dependency Architecture'
): VisualizationPaths {
    const outputDir = path.join(workspaceRoot, ARCH_OUTPUT_DIR);

    // Ensure directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const html = generateHTML(generateDot(graph, title), title);
    const htmlPath = path.join(outputDir, 'dependencies.html');
    fs.writeFileSync(htmlPath, html, 'utf-8');

    return { htmlPath };
}

/**
 * Open the HTML visualization in the default browser
 */
export function openVisualization(htmlPath: string): boolean {
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
        //const error = toError(err);
        void err;
        return false;
    }
}
