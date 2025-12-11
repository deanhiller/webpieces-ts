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

/**
 * Level colors for visualization
 */
const LEVEL_COLORS: Record<number, string> = {
    0: '#E8F5E9', // Light green - foundation
    1: '#E3F2FD', // Light blue - middleware
    2: '#FFF3E0', // Light orange - applications
    3: '#FCE4EC', // Light pink - higher level
};

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
export function generateDot(graph: EnhancedGraph, title: string = 'WebPieces Architecture'): string {
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

    // Create nodes with level-based colors
    for (const [project, info] of Object.entries(graph)) {
        const shortName = getShortName(project);
        const color = LEVEL_COLORS[info.level] || '#F5F5F5';
        dot += `  "${shortName}" [fillcolor="${color}", label="${shortName}\\n(L${info.level})"];\n`;
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
export function generateHTML(dot: string, title: string = 'WebPieces Architecture'): string {
    return `<!DOCTYPE html>
<html>
<head>
    <title>${title}</title>
    <script src="https://cdn.jsdelivr.net/npm/viz.js@2.1.2/viz.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/viz.js@2.1.2/full.render.js"></script>
    <style>
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
    </style>
</head>
<body>
    <h1>${title}</h1>

    <div class="legend">
        <h2>Legend</h2>
        <div class="legend-item">
            <span class="legend-box" style="background: #E8F5E9;"></span>
            <strong>Level 0:</strong> Foundation libraries (no dependencies)
        </div>
        <div class="legend-item">
            <span class="legend-box" style="background: #E3F2FD;"></span>
            <strong>Level 1:</strong> Middleware libraries (depend on Level 0)
        </div>
        <div class="legend-item">
            <span class="legend-box" style="background: #FFF3E0;"></span>
            <strong>Level 2:</strong> Applications (depend on Level 1)
        </div>
        <div class="legend-item" style="margin-top: 15px;">
            <em>Note: Transitive dependencies are allowed but not shown in the graph.</em>
        </div>
    </div>

    <div id="graph"></div>

    <script>
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
    </script>
</body>
</html>`;
}

/**
 * Write visualization files to tmp/webpieces/
 */
export function writeVisualization(
    graph: EnhancedGraph,
    workspaceRoot: string,
    title: string = 'WebPieces Architecture'
): { dotPath: string; htmlPath: string } {
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
        return false;
    }
}
