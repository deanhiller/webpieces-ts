import { GraphRenderModel, GraphFilterAssets } from './graph-render-model';
import { RuntimeDetails } from './runtime-details';
import type { RuntimeGraph } from './runtime-graph-model';
import { GraphNavigation } from './graph-navigation';
import { SavedSnapshot } from './saved-snapshot';
import { CLIENT_MODEL_PLACEHOLDER, readCompiledClient } from './graph-visualizer';
import { GraphNodeMenu } from './graph-node-menu';
import { legendHtml } from './runtime-viz-theme';

/**
 * The runtime-architecture HTML page: its styles, the shared floating node menu, the graph host
 * and the legend.
 *
 * A CLASS rather than a bag of module functions so the client-text seam can be a constructor
 * parameter the way GraphVisualizer's is: the default reads the COMPILED sibling, which exists in
 * dist and in the published tarball but NOT in a source checkout, and a unit test running from
 * source hands in the text itself instead of requiring the package to have been built first.
 */
export class RuntimeHtmlPage {
    private readonly filterAssets = new GraphFilterAssets();
    private readonly snapshot = new SavedSnapshot();
    /** The ONE floating-node-menu implementation, shared with dependencies.html and every design.html. */
    private readonly nodeMenu = new GraphNodeMenu();

    constructor(
        private readonly clientJs: () => string = (): string =>
            readCompiledClient('runtime-visualizer.client.js'),
        private readonly filterJs: () => string = (): string =>
            readCompiledClient('graph-filter.client.js'),
    ) {}

    render(
        model: GraphRenderModel,
        title: string,
        graph: RuntimeGraph,
        showExternalNodes: boolean = true,
    ): string {
        return `<!DOCTYPE html>
<html>
<head>
    <!-- REQUIRED: the cron node's label is a literal ⏰, and the DOT is embedded in this file. With
         no declared charset the browser falls back to a locale guess and renders it as mojibake
         ("â °") whenever the page is served without a charset header. -->
    <meta charset="utf-8">
    <title>${title}</title>
    <script src="https://cdn.jsdelivr.net/npm/@viz-js/viz@3.28.0/dist/viz-global.js"></script>
    <style>${this.styles()}</style>
</head>
<body>
    <h1>${title}</h1>
    ${this.snapshot.html()}
    <p class="hint">💡 <strong>Click any box</strong> for its menu — <strong>Lock</strong> dims every other box and every arrow so one service, queue, datastore or external system stands alone; <strong>Unlock</strong> restores the whole picture.</p>
    <p class="hint"><strong>Filter Unconnected</strong> keeps incoming and outgoing chains and compacts the picture. <strong>Turn off Filter</strong> restores it.</p>
    ${this.filterAssets.html()}
    <div id="graph"></div>
    ${legendHtml()}
    <script>${this.nodeMenu.script()}</script>
    <script>${this.filterJs()}</script>
    <script>${this.script(model)}</script>
    <script>${new GraphNavigation().script()}</script>
    <script>${new RuntimeDetails(graph, showExternalNodes).script()}</script>
</body>
</html>`;
    }

    /**
     * The browser half lives in runtime-visualizer.client.ts (matching graph-visualizer.client.ts)
     * rather than in a template literal here: it renders with @viz-js/viz v3, redraws every queue
     * node as a true horizontal cylinder, and wires the shared node menu onto every box — more
     * logic than belongs inline in a .ts string. The substitution is a blind split/join, so the
     * render-model placeholder must appear EXACTLY ONCE in the client.
     */
    private script(model: GraphRenderModel): string {
        return this.clientJs().split(CLIENT_MODEL_PLACEHOLDER).join(this.filterAssets.json(model));
    }

    /**
     * Page styles, including the shared menu stylesheet: the clickable cursor + blue glow on every
     * box, and the dim/undim rules the lock toggles, scoped to this page's `#graph` host. Those two
     * blocks are shared verbatim with architecture/dependencies.html and every design.html.
     *
     * The legend swatches are hand-drawn inline SVG on purpose: the alternative is shelling out to
     * Graphviz at generate time, which would make writing the HTML depend on a `dot` binary being
     * installed — a dependency this tool does not otherwise have, since rendering is client-side.
     */
    private styles(): string {
        return `
        body { margin: 0; padding: 20px; font-family: Arial, sans-serif; background: #f5f5f5; }
        h1 { text-align: center; color: #333; }
        .hint { text-align: center; color: #555; margin: 0 0 16px; }
        /* Every box is clickable and opens the shared floating menu, so the menu's own stylesheet
         * carries the cursor + blue glow and the dim/undim rules the lock toggles. Shared verbatim
         * with architecture/dependencies.html and every project's design.html. */
        ${this.nodeMenu.styles()}
        ${this.filterAssets.styles()}
        ${this.nodeMenu.dimStyles('#graph')}
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
        ${new GraphNavigation().styles()}
        @media (max-width: 900px) { .legend-columns { grid-template-columns: 1fr; } }`;
    }
}
