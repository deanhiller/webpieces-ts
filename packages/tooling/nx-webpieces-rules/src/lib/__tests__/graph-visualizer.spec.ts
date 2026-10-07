/**
 * Tests for the architecture graph visualizer: nodes are colored by their
 * framework env set (libType) and the label carries the level, the env set, and
 * the role.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import type { EnhancedGraph } from '../graph-sorter';
import { GraphVisualizer } from '../graph-visualizer';
import type { RenderNode } from '../graph-render-model';

const GRAPH: EnhancedGraph = {
    'angular-site': { level: 3, dependsOn: ['http-client'], framework: ['angular', 'browser'], role: 'client' },
    server2: { level: 4, dependsOn: ['http-client'], framework: ['express', 'node'], role: 'server' },
    'http-client': { level: 2, dependsOn: [], framework: ['browser', 'node'], role: 'lib' },
};

// The browser client is COMPILED from graph-visualizer.client.ts, so it does not exist in a source
// checkout — reading it here would make this spec depend on the package having been built first.
// Transpiling the .ts is both build-order-independent AND closer to the truth: the assertions below
// then run against the very source that ships, not against a stand-in.
const CLIENT_TS = path.join(__dirname, '..', 'graph-visualizer.client.ts');
const clientJs = (): string => ts.transpileModule(
    fs.readFileSync(CLIENT_TS, 'utf-8'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const filterJs = (): string => ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', 'graph-filter.client.ts'), 'utf-8'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const viz = new GraphVisualizer(clientJs, filterJs);

const nodeOf = (graph: EnhancedGraph, id: string): RenderNode =>
    viz.generateRenderModel(graph).nodes.find((node: RenderNode): boolean => node.id === id)!;

describe('generateDot', () => {
    it('draws Runtime mode by default: one runtime plus a specialization is NESTED, text on the inner box', () => {
        const dot = viz.generateDot(GRAPH);
        // angular-site: a browser frame around a rounded angular box; white text follows the inner color.
        expect(dot).toContain(
            '"angular-site" [style="filled", fillcolor="#7d8cf2", fontcolor="#ffffff", margin=0, label=<<TABLE',
        );
        expect(dot).toContain(
            '<TD BGCOLOR="#7d8cf2" CELLPADDING="5"><TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="6" BGCOLOR="#c8243f" STYLE="rounded">',
        );
        // server2: express (dark green, white text) nested in the node frame.
        expect(dot).toContain(
            '<TD BGCOLOR="#6fcf8a" CELLPADDING="5"><TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="6" BGCOLOR="#2e7d4f"',
        );
        // http-client: browser+node → full-height stripes, no plate, no band rows.
        expect(dot).toContain(
            '"http-client" [style="striped", fillcolor="#7d8cf2;0.500:#6fcf8a", class="wp-striped", fontcolor="#1a1c22", label=<',
        );
        expect(dot).not.toContain('#fbfbfd');
    });

    it('writes the same three lines on every box in every mode: L# + bold name, role, every framework tag', () => {
        const server = nodeOf(GRAPH, 'server2').modes!;
        const lines = '<B>server2</B><BR/>server<BR/>node · express';
        for (const dot of [server.runtime, server.architecture, server.touched, server.affected, server.buildInput, server.untouched])
            expect(dot).toContain(lines);
        expect(server.runtime).toContain('<FONT COLOR="#ffffff99">L4</FONT>&#160;&#160;<B>server2</B>');
        expect(viz.generateDot(GRAPH)).toContain('<B>angular-site</B><BR/>client<BR/>browser · angular');
        // Impact state is color + legend only, never text on the box.
        expect(server.touched).not.toContain('touched');
        expect(server.buildInput).not.toContain('build input');
    });

    it('fills a single-runtime box with no specialization plainly', () => {
        const dot = viz.generateDot({ svc: { level: 0, dependsOn: [], framework: ['node'], role: 'lib' } });
        expect(dot).toContain('"svc" [style="filled", fillcolor="#6fcf8a", fontcolor="#1a1c22", label=<');
        expect(dot).toContain('<B>svc</B><BR/>lib<BR/>node>];');
    });

    it('treats an absent framework as an empty set and absent role as "lib"', () => {
        const dot = viz.generateDot({ mystery: { level: 0, dependsOn: [] } });
        expect(dot).toContain('"mystery" [style="filled", fillcolor="#e4e6ec", fontcolor="#1a1c22", label=<');
        expect(dot).toContain('<B>mystery</B><BR/>lib<BR/>no framework tag>];');
    });

    it('treats an unknown framework value as no runtime, but still lists the tag', () => {
        const dot = viz.generateDot({ odd: { level: 0, dependsOn: [], framework: ['vue'], role: 'lib' } });
        expect(dot).toContain('"odd" [style="filled", fillcolor="#e4e6ec", fontcolor="#1a1c22", label=<');
        expect(dot).toContain('<BR/>vue>];');
    });

    it('carries an Architecture statement per box: a role fill, no framework color', () => {
        expect(nodeOf(GRAPH, 'server2').modes!.architecture).toContain(
            '  "server2" [style="filled", fillcolor="#4caf50", fontcolor="#ffffff", label=<',
        );
        expect(nodeOf(GRAPH, 'http-client').modes!.architecture).toContain('fillcolor="#d7dae2", fontcolor="#1a1c22"');
    });

    it('carries all four Impact statements per box, since only the sidecar knows which applies', () => {
        const modes = nodeOf(GRAPH, 'server2').modes!;
        expect(modes.touched).toContain('style="filled", fillcolor="#f5a524", fontcolor="#1a1c22", label=<');
        expect(modes.affected).toContain('fillcolor="#fde3b0", fontcolor="#1a1c22", color="#f5a524", penwidth=2, label=<');
        expect(modes.buildInput).toContain(
            'style="filled,dashed", fillcolor="#e3e9f2", fontcolor="#1a1c22", color="#7c8aa3", penwidth=1.5, label=<',
        );
        expect(modes.untouched).toContain('fillcolor="#eef0f4", fontcolor="#6b7180", color="#b4b9c4", label=<');
    });

    it("records each box's role and framework tags for the page's Filter", () => {
        const facts = nodeOf(GRAPH, 'angular-site').tags!;
        expect(facts.role).toBe('client');
        expect(facts.frameworks).toEqual(['angular', 'browser']);
        expect(facts.level).toBe(3);
    });

    it('uses the Runtime statement for fullDot, so the committed page draws Runtime first', () => {
        const model = viz.generateRenderModel(GRAPH);
        for (const node of model.nodes) {
            expect(node.dot).toBe(node.modes!.runtime);
            expect(model.fullDot).toContain(node.dot);
        }
    });

    it('never emits a node URL — clicking a box opens the menu, it does not navigate', () => {
        const dot = viz.generateDot({
            'http-api': {
                level: 0,
                dependsOn: [],
                framework: ['browser', 'node'],
                role: 'lib',
                designFile: 'packages/http/http-api/design.json',
            },
        });
        expect(dot).not.toContain('URL=');
        expect(dot).not.toContain('target="_blank"');
    });
});

/**
 * "View Design" exists on a node's menu ONLY when that project really has a committed design.html,
 * which is exactly "the graph entry carries a designFile (a generated design.json)".
 */
describe('designLinks', () => {
    it('links a project with a design.json to its design.html, relative to architecture/', () => {
        const links = viz.designLinks({
            'http-api': {
                level: 0,
                dependsOn: [],
                designFile: 'packages/http/http-api/design.json',
            },
        });
        expect(links).toHaveLength(1);
        expect(links[0].nodeId).toBe('http-api');
        expect(links[0].href).toBe('../packages/http/http-api/design.html');
    });

    it('yields nothing for a project with no design.json — so its menu has no View Design item', () => {
        expect(viz.designLinks({ 'no-design': { level: 0, dependsOn: [] } })).toEqual([]);
    });

    it('omits a hidden project even when it has a design.json', () => {
        const links = viz.designLinks({
            secret: { level: 0, dependsOn: [], drawOnGraph: false, designFile: 'svc/secret/design.json' },
        });
        expect(links).toEqual([]);
    });
});

/**
 * The layout defect these pin: `{ rank=same; ... }` ties a level's boxes to one row but says
 * NOTHING about where that row goes, so graphviz inferred each row's position from the edges. A
 * level containing a box nothing visibly depends on (a leaf sdk, an api-lib whose consumers are
 * hidden) was unconstrained, floated to rank 0, and dragged its whole level to the TOP — which is
 * how L0 ended up above everything, and how an L0 lib ended up sharing a row with L6 servers.
 */
describe('generateDot level bands', () => {
    /** The `{ rank=same; ... }` lines, in emission order. */
    const rankLines = (dot: string): string[] =>
        dot.split('\n').filter((line: string): boolean => line.includes('rank=same'));

    /** The level of a rank line, read off the invisible anchor that pins it. */
    const bandLevel = (line: string): number => {
        const match = /__wp_layout_L(\d+)"/.exec(line);
        return match === null ? -1 : Number(match[1]);
    };

    const LEAF_GRAPH: EnhancedGraph = {
        // L2 servers. Nothing depends on them, and NOTHING depends on the two L0 sdks either —
        // the exact shape that used to invert the graph.
        'orders-manager': { level: 2, dependsOn: ['orders-api'], role: 'server' },
        'public-api': { level: 2, dependsOn: ['orders-api'], role: 'server' },
        'orders-api': { level: 1, dependsOn: ['core-util'], role: 'api-lib' },
        'core-util': { level: 0, dependsOn: [], role: 'lib' },
        'attio-sdk': { level: 0, dependsOn: [], role: 'lib' },
        'claude-sdk': { level: 0, dependsOn: [], role: 'lib' },
    };

    it('emits the bands highest level first, descending, with L0 last', () => {
        const levels = rankLines(viz.generateDot(LEAF_GRAPH)).map(bandLevel);
        expect(levels).toEqual([2, 1, 0]);
    });

    it('puts every node of a level in that level band and no other — including leaf L0 libs', () => {
        const lines = rankLines(viz.generateDot(LEAF_GRAPH));
        const byLevel = new Map<number, string>(
            lines.map((line: string): [number, string] => [bandLevel(line), line]));
        expect(byLevel.get(2)).toBe('  { rank=same; "__wp_layout_L2"; "orders-manager"; "public-api"; }');
        expect(byLevel.get(1)).toBe('  { rank=same; "__wp_layout_L1"; "orders-api"; }');
        expect(byLevel.get(0)).toBe(
            '  { rank=same; "__wp_layout_L0"; "attio-sdk"; "claude-sdk"; "core-util"; }');
    });

    it('chains the band anchors with invisible edges so the ordering is stated, not inferred', () => {
        const dot = viz.generateDot(LEAF_GRAPH);
        expect(dot).toContain('"__wp_layout_L2" -> "__wp_layout_L1" [style=invis, class="wp-layout"];');
        expect(dot).toContain('"__wp_layout_L1" -> "__wp_layout_L0" [style=invis, class="wp-layout"];');
    });

    it('never draws the ordering chain through a real project box', () => {
        const dot = viz.generateDot(LEAF_GRAPH);
        for (const line of dot.split('\n')) {
            if (!line.includes('style=invis')) continue;
            if (!line.includes('->')) continue;
            expect(line).toMatch(/"__wp_layout_[^"]*" -> "__wp_layout_[^"]*"/);
        }
    });

    it('marks every layout node invisible and class-tagged so the page never shows or indexes it', () => {
        const dot = viz.generateDot(LEAF_GRAPH);
        expect(dot).toContain(
            '"__wp_layout_L0" [style=invis, shape=point, width=0.01, height=0.01, label="", class="wp-layout"];');
    });

    it('chains whatever levels EXIST when the levels are not contiguous', () => {
        const dot = viz.generateDot({
            top: { level: 7, dependsOn: ['bottom'], role: 'server' },
            bottom: { level: 0, dependsOn: [], role: 'lib' },
        });
        expect(rankLines(dot).map(bandLevel)).toEqual([7, 0]);
        expect(dot).toContain('"__wp_layout_L7" -> "__wp_layout_L0" [style=invis, class="wp-layout"];');
    });

    it('keeps a hidden project out of its band without disturbing the ordering', () => {
        const dot = viz.generateDot({
            app: { level: 1, dependsOn: ['secret', 'core-util'], role: 'server' },
            secret: { level: 0, dependsOn: [], role: 'lib', drawOnGraph: false },
            'core-util': { level: 0, dependsOn: [], role: 'lib' },
        });
        expect(rankLines(dot)).toEqual([
            '  { rank=same; "__wp_layout_L1"; "app"; }',
            '  { rank=same; "__wp_layout_L0"; "core-util"; }',
        ]);
    });
});

/**
 * A crowded row's outgoing edges used to be drawn straight through the boxes of the row below.
 * A blank band next to a crowded one gives them a whole rank of vertical room to fan out in.
 */
describe('generateDot spacer bands', () => {
    const wideGraph = (count: number): EnhancedGraph => {
        const graph: EnhancedGraph = { 'core-util': { level: 0, dependsOn: [], role: 'lib' } };
        for (let i = 0; i < count; i++) {
            graph[`svc${i}`] = { level: 1, dependsOn: ['core-util'], role: 'server' };
        }
        return graph;
    };

    it('inserts a spacer band beside a crowded layer (> 10 boxes)', () => {
        const dot = viz.generateDot(wideGraph(11));
        expect(dot).toContain('"__wp_layout_spacer_L1_L0" [style=invis');
        expect(dot).toContain('{ rank=same; "__wp_layout_spacer_L1_L0"; }');
        expect(dot).toContain('"__wp_layout_L1" -> "__wp_layout_spacer_L1_L0" [style=invis, class="wp-layout"];');
        expect(dot).toContain('"__wp_layout_spacer_L1_L0" -> "__wp_layout_L0" [style=invis, class="wp-layout"];');
    });

    it('leaves an ordinary-width layer alone (10 boxes is not crowded)', () => {
        const dot = viz.generateDot(wideGraph(10));
        expect(dot).not.toContain('__wp_layout_spacer');
        expect(dot).toContain('"__wp_layout_L1" -> "__wp_layout_L0" [style=invis, class="wp-layout"];');
    });
});

describe('generateDot edge styling', () => {
    it('styles api-lib edges by relation kind and leaves plain deps unstyled', () => {
        const dot = viz.generateDot({
            'client-server': {
                level: 5,
                dependsOn: ['client-server-api', 'server2-api', 'core-util'],
                framework: ['express'],
                role: 'server',
                apiRelations: {
                    'client-server-api': { kind: 'implements', implements: [{ api: 'SaveApi', type: 'rpc' }], uses: [] },
                    'server2-api': { kind: 'uses', implements: [], uses: [{ api: 'Server2Api', type: 'rpc' }] },
                },
            },
            'client-server-api': { level: 1, dependsOn: [], framework: ['browser', 'node'], role: 'api-lib' },
            'server2-api': { level: 1, dependsOn: [], framework: ['browser', 'node'], role: 'api-lib' },
            'core-util': { level: 0, dependsOn: [], framework: ['browser', 'node'], role: 'lib' },
        });
        // implements = black dashed, LABELED with the contracts it serves
        expect(dot).toContain('"client-server" -> "client-server-api" [style=dashed, label="implements: SaveApi", fontsize=9]');
        expect(dot).toContain('"client-server" -> "server2-api" [id="wp-real-edge-1"];'); // uses = plain black solid, same as a plain dep
        expect(dot).toContain('"client-server" -> "core-util" [id="wp-real-edge-2"];'); // plain dep, unstyled
    });

    it('styles a uses-implements edge distinctly', () => {
        const dot = viz.generateDot({
            svc: {
                level: 2,
                dependsOn: ['shared-api'],
                role: 'server',
                apiRelations: {
                    'shared-api': {
                        kind: 'uses-implements',
                        implements: [{ api: 'AApi', type: 'rpc' }],
                        uses: [{ api: 'BApi', type: 'pubsub' }],
                    },
                },
            },
            'shared-api': { level: 1, dependsOn: [], role: 'api-lib' },
        });
        expect(dot).toContain(
            '"svc" -> "shared-api" [style=dashed, color="#1976d2", penwidth=2, label="implements: AApi", fontsize=9]',
        );
    });

});

/**
 * "Which server implements this contract?" is the question the diagram exists to answer, and a
 * bare dashed line reads as "nothing was detected". Naming the contracts on the edge is the fix.
 */
describe('generateDot implements-edge labels', () => {
    it('names the implemented contracts on the edge, capped with a stated "+N more"', () => {
        const dot = viz.generateDot({
            svc: {
                level: 2,
                dependsOn: ['big-api'],
                role: 'server',
                apiRelations: {
                    'big-api': {
                        kind: 'implements',
                        implements: [
                            { api: 'EApi', type: 'rpc' },
                            { api: 'AApi', type: 'rpc' },
                            { api: 'CApi', type: 'rpc' },
                            { api: 'BApi', type: 'rpc' },
                            { api: 'DApi', type: 'rpc' },
                            { api: 'FApi', type: 'rpc' },
                        ],
                        uses: [],
                    },
                },
            },
            'big-api': { level: 1, dependsOn: [], role: 'api-lib' },
        });
        expect(dot).toContain('label="implements: AApi, BApi, CApi, DApi +2 more"');
    });
});

describe('generateDot drawOnGraph:false hiding', () => {
    const HIDDEN_GRAPH: EnhancedGraph = {
        visible: { level: 1, dependsOn: ['secret', 'core-util'], framework: ['node'], role: 'lib' },
        secret: { level: 0, dependsOn: [], framework: ['node'], role: 'lib', drawOnGraph: false },
        'core-util': { level: 0, dependsOn: [], framework: ['node'], role: 'lib' },
    };

    it('omits the hidden node, its rank placement, and its lock option', () => {
        const dot = viz.generateDot(HIDDEN_GRAPH);
        expect(dot).not.toContain('"secret" [');
        expect(dot).not.toContain('rank=same; "secret"');
        expect(viz.lockControl(HIDDEN_GRAPH)).not.toContain('>secret<');
    });

    it('drops every edge touching a hidden node but keeps edges between visible nodes', () => {
        const dot = viz.generateDot(HIDDEN_GRAPH);
        expect(dot).not.toContain('"visible" -> "secret"');
        expect(dot).toContain('"visible" -> "core-util" [id="wp-real-edge-0"];');
    });

    it('still renders visible nodes normally', () => {
        const dot = viz.generateDot(HIDDEN_GRAPH);
        expect(dot).toContain('"visible" [');
        expect(dot).toContain('"core-util" [');
    });
});

describe('generateHTML', () => {
    it('renders the drawer shell: Color-by pulldown, Filter button, lock search, legend, edge key, footer links', () => {
        const html = viz.generateHTML(viz.generateRenderModel(GRAPH), viz.designLinks(GRAPH));
        expect(html).toContain('id="wp-shell"');
        // ONE pill trigger showing the current mode; the three modes are options of its menu.
        expect(html).toContain('id="wp-mode-trigger" aria-haspopup="menu" aria-controls="wp-mode-menu" aria-expanded="false"');
        expect(html).toContain('<div class="wp-menu" id="wp-mode-menu" role="menu" aria-label="Color by" hidden>');
        expect(html).toContain('role="menuitemradio" data-wp-mode="runtime" aria-checked="true" title="Key 1"');
        expect(html).toContain('id="wp-filter-open" aria-controls="wp-filter-pop"');
        expect(html).toContain('id="wp-filter-badge" hidden');
        expect(html).toContain('id="wp-filter-pills"');
        expect(html).toContain('<span class="wp-mode-name">Runtime</span><span class="wp-mode-sub">where the code can run</span>');
        expect(html).toContain('<span class="wp-mode-name">Architecture</span><span class="wp-mode-sub">servers · clients · APIs</span>');
        expect(html).toContain('<span class="wp-mode-name">Impact</span><span class="wp-mode-sub">what changed</span>');
        expect(html).toContain('id="wp-legend-pop"');
        expect(html).toContain('id="wp-resp-open"');
        expect(html).toContain('id="wp-snapshot-open"');
        // The two hint paragraphs moved into the "?" popover; nothing sits above the graph any more.
        expect(html).toContain('id="wp-help"');
        expect(html).not.toContain('<h1>');
    });

    it('loads the gitignored impact sidecar with a plain script tag, before the page scripts', () => {
        const html = viz.generateHTML(viz.generateRenderModel(GRAPH), viz.designLinks(GRAPH));
        expect(html).toContain('<script src=".impact/dependencies.impact.js"></script>');
        expect(html.indexOf('.impact/dependencies.impact.js')).toBeLessThan(html.indexOf('class WpNodeMenu'));
    });

    it('generates the legend from the projects present, per mode', () => {
        const html = viz.generateHTML(viz.generateRenderModel(GRAPH), viz.designLinks(GRAPH));
        for (const key of ['browser', 'node', 'angular', 'express', 'multi'])
            expect(html).toContain(`data-wp-legend="${key}"`);
        // Nothing in GRAPH is react / react-native / an app — so no row for them.
        for (const key of ['react', 'react-native', 'app', 'bundle'])
            expect(html).not.toContain(`data-wp-legend="${key}"`);
        for (const key of ['server', 'client', 'lib', 'touched', 'affected', 'build-input', 'untouched'])
            expect(html).toContain(`data-wp-legend="${key}"`);
    });

    it('skips the invisible layout scaffolding when indexing, so an anchor is never a dependency', () => {
        const html = viz.generateHTML(viz.generateRenderModel(GRAPH), viz.designLinks(GRAPH));
        expect(html).toContain("classList.contains('wp-layout')");
        // Both indexes must skip it — a layout node would pick up hover handlers, and a layout edge
        // would chain two bands into one dependency that does not exist.
        expect(html).toContain('class WpGraphChain');
    });

    it('wires up hover-highlight so connections bolden on box hover', () => {
        const html = viz.generateHTML(viz.generateRenderModel(GRAPH), viz.designLinks(GRAPH));
        // The post-render wiring and its mouse handlers must be present. The logic is a CLASS now
        // (it was loose functions while the client was an unlinted .js asset), so this asserts the
        // class and its entry point rather than the old free function.
        expect(html).toContain('GraphHighlighter');
        expect(html).toContain('wireHover');
        expect(html).toContain('mouseenter');
        expect(html).toContain('mouseleave');
        expect(html).toContain('this.hovered = name');
        expect(html).toContain('this.hovered = null');
        expect(html).toContain('[locked, this.hovered]');
        // The hover-highlight CSS classes the script toggles.
        expect(html).toContain('wp-hl');
        expect(html).toContain('wp-neighbor');
        expect(html).toContain('wp-focus');
        // Directed adjacency + a transitive walk that follows edges past the
        // immediate neighbors, up through all ancestors and down through all
        // descendants (not just one hop).
        expect(html).toContain('inNodes');
        expect(html).toContain('outNodes');
        expect(html).toContain('wp-real-edge-');
        expect(html).toContain('this.model.edges');
        expect(html).toContain('visited');
        expect(html).toContain('stack');
    });
});

/**
 * Every box is clickable and opens the floating menu — the SAME menu (one implementation, in
 * graph-node-menu.ts) that every project's design.html uses. Direct navigation is gone: a box no
 * longer carries a URL, so "View Design" in the menu is the only way into a design page.
 */
describe('generateHTML node menu', () => {
    const DESIGNED: EnhancedGraph = {
        'http-api': {
            level: 0,
            dependsOn: [],
            role: 'lib',
            designFile: 'packages/http/http-api/design.json',
        },
        plain: { level: 0, dependsOn: [], role: 'lib' },
    };

    const htmlFor = (graph: EnhancedGraph): string =>
        viz.generateHTML(viz.generateRenderModel(graph), viz.designLinks(graph), 'T', viz.lockControl(graph));

    it('inlines the shared menu implementation and wires every node to open it', () => {
        const html = htmlFor(DESIGNED);
        expect(html).toContain('class WpNodeMenu');
        expect(html).toContain('class WpNodeMenuItem');
        expect(html).toContain("querySelectorAll('g.node')");
        expect(html).toContain('wireMenu');
        expect(html).toContain('wp-node-menu');
    });

    it('dismisses on an outside click and on Escape', () => {
        const html = htmlFor(DESIGNED);
        expect(html).toContain("document.addEventListener('click'");
        expect(html).toContain("ev.key === 'Escape'");
        expect(html).toContain('WpNodeMenu.close()');
    });

    it('offers View Design for a project that HAS a design page, keyed by its node id', () => {
        const html = htmlFor(DESIGNED);
        expect(html).toContain("'View Design'");
        expect(html).toContain('{"nodeId":"http-api","href":"../packages/http/http-api/design.html"}');
    });

    it('carries no link for a project with no design page, so its menu omits the item', () => {
        const html = htmlFor({ plain: { level: 0, dependsOn: [], role: 'lib' } });
        // The links payload is empty — nothing for the menu to build a View Design item from.
        expect(html).toContain('for (const link of [])');
        expect(html).not.toContain('"nodeId"');
    });

    it('makes the bottom item Lock or Unlock by the box the page is locked on right now', () => {
        const html = htmlFor(DESIGNED);
        expect(html).toContain("locked ? 'Unlock' : 'Lock'");
        expect(html).toContain('isLocked');
    });

    it('routes menu and lock search through ONE lock, so each reflects the other', () => {
        const html = htmlFor(DESIGNED);
        // setLock applies the highlight + card filter and repaints the search field; the field's own
        // input handler calls the same setLock, so the two can never disagree.
        expect(html).toContain('setLock');
        expect(html).toContain('this.highlighter?.relight()');
        expect(html).toContain("input.value = locked ?? ''");
        expect(html).toContain('<input type="search" id="wp-lock" list="wp-lock-options"');
    });

    it('has no Mode submenu: the drawer is the one place to switch modes', () => {
        const html = htmlFor(DESIGNED);
        expect(html).not.toContain('modeItem');
        expect(html).not.toContain("new WpNodeMenuItem('Mode'");
        expect(html).not.toContain('WpSubmenu');
        expect(html).not.toContain('wp-node-menu-sub');
        expect(html).not.toContain('Mode ▸');
    });
});
