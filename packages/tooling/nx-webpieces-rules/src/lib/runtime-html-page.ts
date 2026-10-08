import * as fs from 'fs';
import * as path from 'path';
import { DesignLink } from './graph-visualizer';
import { GraphRenderModel, GraphFilterAssets } from './graph-render-model';
import { RuntimeDetails } from './runtime-details';
import type { RuntimeGraph } from './runtime-graph-model';
import { RuntimeVizOptions } from './runtime-viz-options';
import { GraphNavigation, NavigationLayout } from './graph-navigation';
import { SavedSnapshot } from './saved-snapshot';
import {
    CLIENT_MODEL_PLACEHOLDER,
    CLIENT_DESIGN_LINKS_PLACEHOLDER,
    readCompiledClient,
} from './graph-visualizer';
import { GraphNodeMenu } from './graph-node-menu';
import { GraphPageShell, ShellParts } from './graph-page-shell';
import { GraphPageStyles } from './graph-page-styles';
import { GraphLegend } from './graph-legend';
import { ProductPalette } from './graph-products';
import { FRAMEWORK_STYLES, ROLE_STYLES } from './graph-color-modes';
import { IMPACT_SIDECAR_SRC } from './graph-impact';
import { ResponsibilitiesRenderer } from './graph-responsibilities';
import { htmlLabelText } from './dot-syntax';
import type { EnhancedGraph } from './graph-sorter';

/** Runtime facts and shape adapter inside the same shell/controller as the project viewer. */
export class RuntimeHtmlPage {
    private readonly assets = new GraphFilterAssets();
    private readonly menu = new GraphNodeMenu();
    private readonly navigation = new GraphNavigation(NavigationLayout.FLOATING);

    constructor(
        private readonly clientJs: () => string = (): string =>
            readCompiledClient('runtime-visualizer.client.js'),
        private readonly filterJs: () => string = (): string =>
            readCompiledClient('graph-filter.client.js'),
        private readonly sharedJs: () => string = (): string =>
            readCompiledClient('graph-visualizer.client.js'),
    ) {}

    render(
        model: GraphRenderModel,
        title: string,
        graph: RuntimeGraph,
        options: RuntimeVizOptions = new RuntimeVizOptions(),
    ): string {
        model.viewer = 'runtime';
        const frameworks = [
            ...new Set(model.nodes.flatMap((node) => node.tags?.frameworks ?? [])),
        ].sort();
        const roles = [
            ...new Set(model.nodes.flatMap((node) => (node.tags === null ? [] : [node.tags.role]))),
        ].sort();
        const products = [...new Set(model.nodes.flatMap((node) => node.products))].sort();
        const parts = new ShellParts(
            title,
            this.lockControl(model),
            this.legend(model),
            this.edgeKey(),
            this.assets.html() + '<span id="wp-context-count"></span>',
            new SavedSnapshot().html(),
            this.responsibilities(graph, options),
            products,
            true,
            frameworks,
            roles,
            '<div class="wp-empty" id="wp-empty" hidden>No matching services. Open Filter and Clear all, or turn off Hide unconnected.</div>',
        );
        const shared = this.sharedJs()
            .split(CLIENT_MODEL_PLACEHOLDER)
            .join(this.assets.json(model))
            .split(CLIENT_DESIGN_LINKS_PLACEHOLDER)
            .join(this.assets.json(this.designLinks(graph, options)));
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlLabelText(title)}</title>
<script src="https://cdn.jsdelivr.net/npm/@viz-js/viz@3.28.0/dist/viz-global.js"></script>
<script src="${IMPACT_SIDECAR_SRC}"></script>
<style>${this.menu.styles()}${this.menu.dimStyles('#graph')}${this.assets.styles()}${this.navigation.styles()}${new GraphPageStyles().css()}
.wp-graph-details { position:fixed; z-index:60; max-width:min(520px,calc(100vw - 24px)); max-height:70vh; overflow:auto; background:var(--wp-surface); border:1px solid var(--wp-line); border-radius:10px; padding:14px; box-shadow:0 8px 24px #0002; }
.wp-graph-details button { cursor:pointer; } .wp-api-detail { cursor:pointer; text-decoration:underline; }
.wp-api-detail:focus-visible { outline:3px solid var(--wp-accent); } #wp-context-count { font-size:11px; color:var(--wp-muted); }
.wp-empty { position:absolute; top:70px; left:16px; padding:16px; background:var(--wp-surface); border-radius:10px; }
</style></head><body data-wp-project-facts="${options.projects !== null}">${new GraphPageShell().body(parts)}
<script>${this.menu.script()}</script><script>${this.filterJs()}</script><script>${this.navigation.script()}</script>
<script>${new RuntimeDetails(graph, options.showExternalNodes, model).script()}</script>
<script>${this.clientJs()}</script><script>${shared}</script></body></html>`;
    }

    private designLinks(graph: RuntimeGraph, options: RuntimeVizOptions): DesignLink[] {
        const links: DesignLink[] = [];
        for (const name of Object.keys(graph.services).sort()) {
            if (graph.services[name].drawOnGraph === false) continue;
            const design = options.projects?.[name]?.designFile?.replace(
                /design\.json$/,
                'design.html',
            );
            if (
                !design ||
                !options.workspaceRoot ||
                !fs.existsSync(path.join(options.workspaceRoot, design))
            )
                continue;
            links.push(new DesignLink(name, path.posix.relative('tmp/webpieces', design)));
        }
        return links;
    }

    private lockControl(model: GraphRenderModel): string {
        const entries = model.nodes
            .map(
                (node) =>
                    `<option value="${htmlLabelText(node.id)}">${htmlLabelText(node.id)} · ${node.tags?.role ?? 'context'}</option>`,
            )
            .join('');
        return `<input type="search" id="wp-lock" list="wp-lock-options" placeholder="Lock a node… ( / )" autocomplete="off" spellcheck="false"><datalist id="wp-lock-options">${entries}</datalist>`;
    }

    private legend(model: GraphRenderModel): string {
        const tag = (group: string, value: string, color: string): string =>
            `<div class="wp-legend-row" data-wp-legend-group="${group}" data-wp-legend-value="${htmlLabelText(value)}"><svg width="20" height="14"><rect width="20" height="14" rx="2" fill="${color}"/></svg>${htmlLabelText(value)}</div>`;
        const frameworks = Object.values(FRAMEWORK_STYLES)
            .filter((style) => model.legend.frameworks.includes(style.framework))
            .map((style) => tag('runtime', style.framework, style.color))
            .join('');
        const roles = [
            ...new Set(model.nodes.flatMap((node) => (node.tags === null ? [] : [node.tags.role]))),
        ]
            .map((role) =>
                tag(
                    'role',
                    role,
                    ROLE_STYLES.find((style) => style.role === role)?.fill ?? '#e4e6ec',
                ),
            )
            .join('');
        const products = new ProductPalette(
            model.legend.products.map((count) => count.product),
        ).colors
            .map((color) => tag('product', color.product, color.color))
            .join('');
        return (
            `<section data-wp-legend-mode="runtime" class="wp-legend-list">${frameworks}${tag('runtime', 'unknown', '#e4e6ec')}<p>Neutral: unknown runtime. Nested: specialization; stripes: multiple runtimes. Context retains kind colors.</p></section>
<section data-wp-legend-mode="architecture" class="wp-legend-list" hidden>${roles}<p>Auxiliary nodes use kind colors, never project roles.</p></section>` +
            `<section data-wp-legend-mode="impact" class="wp-legend-list" hidden>${new GraphLegend().impactRows()}</section><section data-wp-legend-mode="product" class="wp-legend-list" hidden>${products}<p>Stripes: several products; neutral: all products; white/dashed: no product. Context inherits adjacent service memberships.</p></section>` +
            '<p>Queues, clocks, datastores and vendors remain context in Impact; no source ownership or CI status is implied.</p>'
        );
    }

    private edgeKey(): string {
        return '<div class="wp-legend-list"><p>→ RPC · ⇢ queued/event · red: legacy cycle</p><p>Horizontal cylinder: queue<br>Upright cylinder: datastore<br>⏰: scheduler<br>Dashed box: external system</p></div>';
    }

    private responsibilities(graph: RuntimeGraph, options: RuntimeVizOptions): string {
        const projects: EnhancedGraph = {};
        for (const [name, service] of Object.entries(graph.services)) {
            projects[name] = {
                ...options.projects?.[name],
                level: service.level,
                dependsOn: service.dependsOn,
                drawOnGraph: service.drawOnGraph,
            };
        }
        return new ResponsibilitiesRenderer().generateSection(projects, options.workspaceRoot);
    }
}
