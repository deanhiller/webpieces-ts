import { GraphNavigation, NavigationLayout } from './graph-navigation';
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
import { SavedSnapshot } from './saved-snapshot';
import * as path from 'path';
import { execSync } from 'child_process';
import type { EnhancedGraph } from './graph-sorter';
import type { ApiRef, ApiRelation, ApiRelationKind } from './api-usage/api-relations';
import { GraphNames, NodeIdOwner } from './graph-names';
import { LevelBand, LevelBandLayout } from './graph-level-bands';
import { ProjectAdjacency, ProjectCycleDetector } from './graph-cycles';
import { ResponsibilitiesRenderer } from './graph-responsibilities';
import { GraphNodeMenu } from './graph-node-menu';
import { dotValue } from './dot-syntax';
import { GraphRenderModel, GraphFilterAssets } from './graph-render-model';
import { NodeFacts, NodeModeStyler, ProductCount } from './graph-color-modes';
import { ProductPalette } from './graph-products';
import { GraphLegend } from './graph-legend';
import { GraphPageShell, ShellParts } from './graph-page-shell';
import { GraphPageStyles } from './graph-page-styles';
import { IMPACT_SIDECAR_SRC } from './graph-impact';
import { toError } from '../toError';

/**
 * Directory (repo-relative) that the committed architecture HTML lives in.
 * Node click-through links are computed relative to this so they resolve when
 * the file is opened straight from the checkout.
 */
const ARCH_OUTPUT_DIR = 'architecture';

/** Contracts named on one `implements` edge label before it truncates to "+N more". */
const MAX_EDGE_LABEL_APIS = 4;

/**
 * One node's design page, handed to the browser so the node menu can offer "View Design" for the
 * boxes that HAVE one and omit the item entirely for the boxes that do not.
 *
 * The link is data on the PAGE now, not a `URL=` attribute in the DOT: a URL made viz.js wrap the
 * box in an `<a>` and clicking navigated straight out, which the menu replaces.
 */
export class DesignLink {
    constructor(
        public readonly nodeId: string,
        public readonly href: string,
    ) {}
}

export class VisualizationPaths {
    htmlPath: string;

    constructor(htmlPath: string) {
        this.htmlPath = htmlPath;
    }
}

/**
 * The token the client scripts carry where the DOT belongs. It must appear EXACTLY ONCE in a compiled
 * client — the inliner is a blind split/join, so a second occurrence (in a comment, say) would be
 * replaced by the entire DOT too, bloating every generated page.
 */
export const CLIENT_MODEL_PLACEHOLDER = '__' + 'RENDER_MODEL' + '__';

/** Same contract as CLIENT_MODEL_PLACEHOLDER, for the node → design.html links the menu offers. */
export const CLIENT_DESIGN_LINKS_PLACEHOLDER = '__' + 'DESIGN_LINKS' + '__';

/**
 * Read a compiled browser client sitting beside this file.
 *
 * It is generated from the matching `.client.ts` by tsc, so it exists in `dist` and in the published
 * tarball but NOT in a source checkout. The error says that outright rather than surfacing a bare
 * ENOENT, because "the build has not run" and "the file is missing" look identical otherwise.
 */
// webpieces-disable no-function-outside-class -- module-level resolver for the default injected into GraphVisualizer/RuntimeHtmlPage; making it a class would need a container in a module both of them load eagerly
export function readCompiledClient(name: string): string {
    const file = path.join(__dirname, name);
    if (!fs.existsSync(file)) {
        throw new Error(
            `${name} not found beside ${__dirname}. It is COMPILED from ${name.replace(/\.js$/, '.ts')} ` +
                'by tsc, so it only exists after a build — run the package build, or inject the text.',
        );
    }
    const source = fs.readFileSync(file, 'utf-8');
    return name === 'graph-visualizer.client.js' ? readCompiledClient('graph-mode-state.client.js') + source : source;
}

export class GraphVisualizer {
    private readonly filterAssets = new GraphFilterAssets();
    private readonly snapshot = new SavedSnapshot();
    private readonly names = new GraphNames();
    private readonly responsibilities = new ResponsibilitiesRenderer();
    private readonly bandLayout = new LevelBandLayout();
    private readonly cycles = new ProjectCycleDetector();
    /** The ONE floating-node-menu implementation, shared with the per-project design pages. */
    private readonly nodeMenu = new GraphNodeMenu();
    private readonly styler = new NodeModeStyler();
    private readonly legend = new GraphLegend();
    private readonly shell = new GraphPageShell();
    private readonly pageStyles = new GraphPageStyles();
    private readonly navigation = new GraphNavigation(NavigationLayout.FLOATING);

    /**
     * How to obtain the browser client's text. Injected so HTML generation does not depend on BUILD
     * ORDER: the default reads the compiled sibling, which exists in the tarball and in dist but NOT in
     * a source checkout (the source there is .client.ts). A unit test running from source supplies the
     * text itself rather than requiring the package to have been built first.
     */
    constructor(
        private readonly clientJs: () => string = (): string =>
            readCompiledClient('graph-visualizer.client.js'),
        private readonly filterJs: () => string = (): string =>
            readCompiledClient('graph-filter.client.js'),
    ) {}

    /**
     * A project tagged `drawOnGraph:false` is hidden from the rendered graph —
     * its node, its rank placement, its lock-search option, its responsibilities
     * card, and every edge touching it are all omitted. It stays in the JSON.
     */
    private isHidden(entry: EnhancedGraph[string]): boolean {
        return entry.drawOnGraph === false;
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
        if (kind === 'implements') return 'style=dashed';
        if (kind === 'uses-implements') return 'style=dashed, color="#1976d2", penwidth=2';
        return '';
    }

    /**
     * The DOT attribute list for ONE dependency edge. An edge that IMPLEMENTS contracts is also
     * LABELED with them: the dashed line alone says "something here is implemented", which reads as
     * "the tool did not detect anything" to everyone who has not memorized the legend. Naming the
     * contracts makes `auth-store-api` visibly resolve to the server that serves it — the single
     * most important relationship in a microservice architecture, and the one the diagram was
     * silent about.
     */
    private edgeDot(from: string, to: string, relation: ApiRelation | undefined): string {
        const attrs: string[] = [];
        const styling = this.edgeAttrs(relation?.kind);
        if (styling !== '') attrs.push(styling);
        const served = (relation?.implements ?? []).map((ref: ApiRef) => ref.api);
        if (served.length > 0)
            attrs.push(`label="implements: ${this.labelledApis(served)}", fontsize=9`);
        const suffix = attrs.length === 0 ? '' : ` [${attrs.join(', ')}]`;
        return `  "${dotValue(from)}" -> "${dotValue(to)}"${suffix};\n`;
    }

    /**
     * The contract names for an edge label, sorted and capped so a shared api-lib serving a dozen
     * contracts cannot blow the edge label up into a wall of text. The truncation is stated in the
     * label ("+N more") rather than silent — the full list is in dependencies.json.
     */
    private labelledApis(apis: string[]): string {
        const sorted = [...apis].sort();
        if (sorted.length <= MAX_EDGE_LABEL_APIS) return sorted.join(', ');
        const shown = sorted.slice(0, MAX_EDGE_LABEL_APIS).join(', ');
        return `${shown} +${sorted.length - MAX_EDGE_LABEL_APIS} more`;
    }

    /**
     * Href for a node's design page: the project's committed design.html, made
     * relative to architecture/dependencies.html. Returns null when the project
     * has no generated DI design (no design.json → no design page exists).
     */
    private designHtmlHref(designFile: string | undefined): string | null {
        if (!designFile) return null;
        const designHtml = designFile.replace(/design\.json$/, 'design.html');
        return path.posix.relative(ARCH_OUTPUT_DIR, designHtml);
    }

    /**
     * The design pages that EXIST, one entry per visible node that has one. A node absent from this
     * list gets no "View Design" item at all — the item is never rendered dead or greyed out.
     */
    designLinks(graph: EnhancedGraph): DesignLink[] {
        const links: DesignLink[] = [];
        for (const project of Object.keys(graph)) {
            const info = graph[project];
            if (this.isHidden(info)) continue;
            const href = this.designHtmlHref(info.designFile);
            if (href === null) continue;
            links.push(new DesignLink(this.names.getNodeId(project), href));
        }
        return links;
    }

    /**
     * Generate Graphviz DOT format from the graph
     */
    generateDot(graph: EnhancedGraph, title: string = 'Monorepo Dependency Architecture'): string {
        return this.generateRenderModel(graph, title).fullDot;
    }

    generateRenderModel(
        graph: EnhancedGraph,
        title: string = 'Monorepo Dependency Architecture',
    ): GraphRenderModel {
        this.assertDrawable(graph);
        const model = new GraphRenderModel();
        let dot = 'digraph Architecture {\n';
        dot += '  rankdir=TB;\n';
        dot += '  node [shape=box, style=filled, fontname="Arial"];\n';
        dot += '  edge [fontname="Arial"];\n\n';

        model.header = dot;
        const bands = this.levelBands(graph);
        model.bands = bands;

        dot += this.dotNodes(graph, model, ProductPalette.fromGraph(graph));
        dot += '\n';
        dot += this.bandLayout.dot(bands);
        dot += '\n';
        dot += this.dotEdges(graph, model);

        const footerStart = dot.length;
        dot += '\n  labelloc="t";\n';
        dot += `  label="${dotValue(title)}\\n(from architecture/dependencies.json)";\n`;
        dot += '  fontsize=20;\n';
        dot += '}\n';

        model.footer = dot.slice(footerStart);
        model.completeEndpoints();
        model.fullDot = dot;
        return model;
    }

    /**
     * Refuse to draw a graph that would render something false.
     *
     * Two conditions, both of which produced a confidently-wrong picture with no warning at all:
     *  - two projects sharing a node id fuse into one box, which UNIONS their two rank sets and
     *    collapses two whole dependency levels onto one row (see graph-names.ts);
     *  - a cycle makes the level numbers every row is keyed on meaningless (see graph-cycles.ts).
     */
    private assertDrawable(graph: EnhancedGraph): void {
        const owners: NodeIdOwner[] = [];
        const adjacency: ProjectAdjacency = {};
        for (const project of Object.keys(graph)) {
            owners.push(new NodeIdOwner(project, graph[project].level));
            adjacency[project] = graph[project].dependsOn ?? [];
        }
        this.names.assertUniqueNodeIds(owners);
        this.cycles.assertAcyclic(adjacency, 'architecture/dependencies.json');
    }

    /**
     * The visible projects grouped into one band per dependency level, ordered HIGHEST LEVEL FIRST
     * so the emitted bands read top-to-bottom with L0 last (hidden projects are omitted, so no
     * stray rank=same name is emitted for an absent node). LevelBandLayout turns these into the
     * rank sets and the invisible chain that pins them — see graph-level-bands.ts for why the
     * chain is required at all.
     */
    private levelBands(graph: EnhancedGraph): LevelBand[] {
        const byLevel = new Map<number, string[]>();
        for (const project of Object.keys(graph)) {
            if (this.isHidden(graph[project])) continue;
            const level = graph[project].level;
            const nodeIds = byLevel.get(level);
            if (nodeIds === undefined) byLevel.set(level, [this.names.getNodeId(project)]);
            else nodeIds.push(this.names.getNodeId(project));
        }
        const levels = [...byLevel.keys()].sort((a: number, b: number): number => b - a);
        return levels.map(
            (level: number): LevelBand =>
                new LevelBand(level, [...(byLevel.get(level) as string[])].sort()),
        );
    }

    // Node lines: one statement per color mode (graph-color-modes.ts) — the label is the short
    // name plus a short meta line, because the fill now shows what the env list used to spell out.
    // No node carries a URL: EVERY box is clickable and opens the floating node menu instead, which
    // is where a design page is reached (see designLinks).
    private dotNodes(graph: EnhancedGraph, model: GraphRenderModel, palette: ProductPalette): string {
        let dot = '';
        for (const project of Object.keys(graph)) {
            const info = graph[project];
            if (this.isHidden(info)) continue;
            // Identity is the project key; the LABEL is the pretty short name.
            const facts = new NodeFacts(
                this.names.getNodeId(project),
                this.names.getShortName(project),
                info.level,
                info.role ?? 'lib',
                info.framework ?? [],
                info.products ?? [],
            );
            this.styler.record(model.legend, facts, palette);
            dot += model.styledNode(facts, this.styler.dots(facts, palette));
        }
        return dot;
    }

    // Edge lines (dependencies). An edge to an api-lib is styled by WHY it exists
    // (implements/uses/uses-implements, from apiRelations); every other dependency
    // keeps the default plain arrow.
    private dotEdges(graph: EnhancedGraph, model: GraphRenderModel): string {
        let dot = '';
        for (const project of Object.keys(graph)) {
            const info = graph[project];
            if (this.isHidden(info)) continue;
            const nodeId = this.names.getNodeId(project);
            for (const dep of info.dependsOn || []) {
                // Both endpoints must be visible — an edge to/from a hidden box
                // is dropped so no connection dangles into empty space.
                if (graph[dep] !== undefined && this.isHidden(graph[dep])) continue;
                dot += model.edge(
                    nodeId,
                    this.names.getNodeId(dep),
                    this.edgeDot(nodeId, this.names.getNodeId(dep), info.apiRelations?.[dep]),
                );
            }
        }
        return dot;
    }

    /**
     * Generate the interactive page: the drawer shell around a viz.js-rendered graph.
     *
     * The Impact sidecar is a plain `<script src>` loaded BEFORE the page scripts, so the page knows
     * the branch's impact when it first draws. It is per-branch and gitignored (graph-impact.ts):
     * when it is absent the browser skips it and Impact is disabled with its reason.
     */
    generateHTML(
        model: GraphRenderModel,
        links: DesignLink[],
        title: string = 'Monorepo Dependency Architecture',
        lockControl: string = '',
        responsibilitiesHtml: string = '',
    ): string {
        const parts = new ShellParts(
            title,
            lockControl,
            this.legend.sections(model.legend),
            this.legend.edgeKey(),
            this.filterAssets.html(),
            this.snapshot.html(),
            responsibilitiesHtml,
            model.legend.products.map((count: ProductCount): string => count.product),
        );
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <script src="https://cdn.jsdelivr.net/npm/@viz-js/viz@3.28.0/dist/viz-global.js"></script>
    <script src="${IMPACT_SIDECAR_SRC}"></script>
    <style>${this.styles()}</style>
</head>
<body>
    ${this.shell.body(parts)}
    <script>${this.nodeMenu.script()}</script>
    <script>${this.filterJs()}</script>
    <script>${this.navigation.script()}</script>
    <script>${this.script(model, links)}</script>
</body>
</html>`;
    }

    /** Shared menu/dim/filter/zoom rules first, then the page's own, so its `#graph` rules win. */
    private styles(): string {
        return (
            this.nodeMenu.styles() +
            this.nodeMenu.dimStyles('#graph') +
            this.filterAssets.styles() +
            this.navigation.styles() +
            this.pageStyles.css()
        );
    }

    /**
     * The drawer's type-to-search lock field, replacing a `<select>` that listed every project and
     * was unusable at hundreds of options. Picking a project LOCKS the graph into that box's hover
     * view — its full ancestor + descendant chain stays lit while everything else dims — and narrows
     * the responsibilities panel to that chain. Clearing the field, or Esc, unlocks.
     *
     * Each option's VALUE is the node id the SVG is keyed on; its label is the level and short name.
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
            if (this.isHidden(graph[project])) continue;
            const nodeId = this.escapeHtml(this.names.getNodeId(project));
            const shortName = this.escapeHtml(this.names.getShortName(project));
            options += `<option value="${nodeId}">L${graph[project].level} · ${shortName}</option>`;
        }
        return (
            '<input type="search" id="wp-lock" list="wp-lock-options" placeholder="Lock a project…  ( / )" ' +
            'autocomplete="off" spellcheck="false">' +
            `<datalist id="wp-lock-options">${options}</datalist>`
        );
    }

    private escapeHtml(text: string): string {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /**
     * The page script. The browser code lives in graph-visualizer.client.ts — real, linted TypeScript
     * that tsc compiles in place, so what this inlines is its COMPILED .js sitting beside this file.
     *
     * The substitution is a blind split/join, which is why the placeholder token must appear EXACTLY
     * ONCE in the client (never in one of its comments): every literal occurrence would otherwise be
     * replaced by the whole DOT.
     */
    private script(model: GraphRenderModel, links: DesignLink[]): string {
        return this.clientJs()
            .split(CLIENT_MODEL_PLACEHOLDER)
            .join(this.filterAssets.json(model))
            .split(CLIENT_DESIGN_LINKS_PLACEHOLDER)
            .join(this.filterAssets.json(links));
    }

    /**
     * Write the committed architecture visualization to
     * architecture/dependencies.html, next to dependencies.json.
     *
     * This is a checked-in artifact, regenerated deterministically by
     * architecture:generate so every box keeps its menu, and the "View Design"
     * item keeps pointing at each project's committed design.html as designs
     * come and go. The DOT is embedded in the HTML (rendered client-side by
     * viz.js). Output is deterministic (sorted graph in → same bytes out) so git
     * only shows a diff when the architecture actually changed.
     */
    writeVisualization(
        graph: EnhancedGraph,
        workspaceRoot: string,
        title: string = 'Monorepo Dependency Architecture',
    ): VisualizationPaths {
        const outputDir = path.join(workspaceRoot, ARCH_OUTPUT_DIR);

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const lockControl = this.lockControl(graph);
        const responsibilities = this.responsibilities.generateSection(graph, workspaceRoot);
        const html = this.generateHTML(
            this.generateRenderModel(graph, title),
            this.designLinks(graph),
            title,
            lockControl,
            responsibilities,
        );
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
