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
 * Framework (libType) colors for visualization — nodes are colored by which
 * client side they target so it is obvious at a glance which projects are
 * Angular, which are Express, and which libraries are shared ("all").
 */
const FRAMEWORK_COLORS: Record<string, string> = {
    angular: '#FCE4EC', // pink   - Angular front-end
    react: '#E3F2FD', // blue   - React front-end
    express: '#E8F5E9', // green  - Express / server side
    all: '#F5F5F5', // grey   - library usable by any side
};

const DEFAULT_FRAMEWORK_COLOR = '#FFF3E0'; // orange - unknown/other libType

/**
 * Remove scope from name for display
 * '@scope/name' → 'name'
 * 'name' → 'name'
 */
function getShortName(name: string): string {
    return name.includes('/') ? name.split('/').pop()! : name;
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

    // Create nodes colored by framework (libType); level is kept in the label
    for (const [project, info] of Object.entries(graph)) {
        const shortName = getShortName(project);
        const framework = info.framework ?? 'all';
        const color = FRAMEWORK_COLORS[framework] ?? DEFAULT_FRAMEWORK_COLOR;
        dot += `  "${shortName}" [fillcolor="${color}", label="${shortName}\\n(L${info.level} · ${framework})"];\n`;
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
    <title>${title}</title>
    <script src="https://cdn.jsdelivr.net/npm/viz.js@2.1.2/viz.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/viz.js@2.1.2/full.render.js"></script>
    <style>${styles}</style>
</head>
<body>
    <h1>${title}</h1>
    ${legend}
    <div id="graph"></div>
    <script>${script}</script>
</body>
</html>`;
}

function generateHTMLStyles(): string {
    return `
        body {
            margin: 0;
            padding: 20px;
            font-family: Arial, sans-serif;
            background: #f5f5f5;
        }
        h1 {
            text-align: center;
            color: #333;
        }
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
        <h2>Legend — colored by framework (libType)</h2>
        <div class="legend-item">
            <span class="legend-box" style="background: #FCE4EC;"></span>
            <strong>angular:</strong> Angular front-end
        </div>
        <div class="legend-item">
            <span class="legend-box" style="background: #E3F2FD;"></span>
            <strong>react:</strong> React front-end
        </div>
        <div class="legend-item">
            <span class="legend-box" style="background: #E8F5E9;"></span>
            <strong>express:</strong> Express / server side
        </div>
        <div class="legend-item">
            <span class="legend-box" style="background: #F5F5F5;"></span>
            <strong>all:</strong> Library usable by any side
        </div>
        <div class="legend-item" style="margin-top: 15px;">
            <em>Each node label shows its dependency level (L#) and framework. Rows are still laid out by level (top = no dependencies). Transitive dependencies are allowed but not shown.</em>
        </div>
    </div>`;
}

function generateHTMLScript(dot: string): string {
    return `
        const dot = ${JSON.stringify(dot)};
        const viz = new Viz();

        viz.renderSVGElement(dot)
            .then(element => {
                document.getElementById('graph').appendChild(element);
            })
            .catch(err => {
                console.error(err);
                document.getElementById('graph').innerHTML = '<pre>' + err + '</pre>';
            });
    `;
}

interface VisualizationPaths {
    dotPath: string;
    htmlPath: string;
}

/**
 * Write visualization files to tmp/webpieces/
 */
export function writeVisualization(
    graph: EnhancedGraph,
    workspaceRoot: string,
    title: string = 'Monorepo Dependency Architecture'
): VisualizationPaths {
    const outputDir = path.join(workspaceRoot, 'tmp', 'webpieces');

    // Ensure directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Generate DOT
    const dot = generateDot(graph, title);
    const dotPath = path.join(outputDir, 'architecture.dot');
    fs.writeFileSync(dotPath, dot, 'utf-8');

    // Generate HTML
    const html = generateHTML(dot, title);
    const htmlPath = path.join(outputDir, 'architecture.html');
    fs.writeFileSync(htmlPath, html, 'utf-8');

    return { dotPath, htmlPath };
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
