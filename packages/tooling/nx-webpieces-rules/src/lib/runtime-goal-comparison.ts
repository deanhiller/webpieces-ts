/**
 * Goal vs Current (#1239): turns the semantic diff of the two saved runtime files into the overlay the
 * runtime viewer's "Goal vs Current" color mode draws.
 *
 * The overlay is rendered by the SAME shared runtime renderer as both pages (generateRuntimeRenderModel
 * over RuntimeUnionGraph), so queue boxes, self-queue sub-rows, level bands and non-constraining
 * feedback edges behave exactly as on the normal pages. Only the statements are restyled afterwards:
 *
 *   added in goal      green
 *   removed from goal  red, dashed box / dotted arrow — still drawn, never dropped
 *   changed            amber; a moved level reads `L4 → L2`
 *   unchanged          subdued grey, kept for context
 *
 * Every drawn box and arrow maps back to the diff's FACT identities (never to display names or edge
 * ids), and its before/after lines travel in the page for the details panel.
 */

import { dotValue, htmlLabelText, assertValidDot } from './dot-syntax';
import { GraphRenderModel, RenderEdge, RenderNode, RuntimeComparisonView } from './graph-render-model';
import type { RuntimeGraph, RuntimeUnresolved } from './runtime-graph-model';
import { RuntimeGraphDiff, RuntimeDiffStatus, RuntimeFactChange, RuntimeGraphDiffResult } from './runtime-graph-diff';
import { RuntimeUnionGraph } from './runtime-union-graph';
import { RuntimeVizOptions, RuntimePageKind } from './runtime-viz-options';
import { generateRuntimeRenderModel } from './runtime-visualizer';
import { RuntimeLayout } from './runtime-layout';
import { RemoteServiceNodeId } from './remote-service-node-id';
import { RuntimeExternalTriggers } from './runtime-external-triggers';
import { DIFF_STYLES } from './runtime-goal-styles';

/** Render-node / render-edge → the diff fact identities it draws. */
export class RuntimeComparisonIds {
    private readonly byNode = new Map<string, string[]>();
    private readonly triggerService = new Map<string, string>();

    constructor(private readonly graph: RuntimeGraph) {
        const safe = (raw: string): string => raw.replace(/[^A-Za-z0-9_]/g, '_');
        for (const name of Object.keys(graph.services)) this.put(name, `service:${name}`);
        for (const id of Object.keys(graph.externalSystems ?? {})) this.put(`system__${safe(id)}`, `external-system:${id}`);
        for (const name of Object.keys(graph.remoteServices ?? {})) this.put(new RemoteServiceNodeId().of(name), `remote-service:${name}`);
        for (const use of graph.unresolvedUses) {
            const owner = graph.apis[use.api]?.owner ?? use.api;
            if (graph.apis[use.api]?.externalSystem === undefined) this.put(`external__${owner}`, `external-library:${owner}`);
        }
        for (const trigger of graph.triggers) {
            const id = `trigger:${trigger.kind}:${trigger.api}.${trigger.method}@${trigger.service}`;
            this.triggerService.set(id, trigger.service);
            if (trigger.kind === 'cron') this.put(`cron__${safe(`${trigger.api}_${trigger.method}`)}`, id);
        }
        for (const group of new RuntimeExternalTriggers(graph.triggers).groups) {
            for (const trigger of group.triggers) this.put(group.from, `trigger:external:${trigger.api}.${trigger.method}@${trigger.service}`);
        }
    }

    node(node: RenderNode): string[] {
        if (node.queueKeys.length > 0) return this.queues(node);
        return this.byNode.get(node.id) ?? [];
    }

    edge(edge: RenderEdge, nodes: Map<string, RenderNode>): string[] {
        const from = nodes.get(edge.from);
        const to = nodes.get(edge.to);
        if (from !== undefined && from.queueKeys.length > 0) return this.queues(from).map((queue: string) => `deliver:${queue}->${edge.to}`);
        if (to !== undefined && to.queueKeys.length > 0) return this.queues(to).map((queue: string) => `enqueue:${edge.from}->${queue}`);
        if (this.graph.services[edge.from] === undefined)
            return (this.byNode.get(edge.from) ?? []).filter((id: string) => this.triggerService.get(id) === edge.to);
        if (this.graph.services[edge.to] !== undefined) return [`rpc:${edge.from}->${edge.to}`];
        return (this.byNode.get(edge.to) ?? []).flatMap((target: string) => this.towards(edge, target));
    }

    /** A service's arrow into a context node: an external system, a remote service or a vendor library. */
    private towards(edge: RenderEdge, target: string): string[] {
        if (target.startsWith('external-system:')) return [`external-use:${edge.from}->${target}`];
        if (target.startsWith('remote-service:'))
            return [`remote-call:${edge.from}->${target}#${edge.dot.includes('enqueue') ? 'pubsub' : 'rpc'}`];
        const owner = target.slice('external-library:'.length);
        return this.graph.unresolvedUses
            .filter((use: RuntimeUnresolved) => use.service === edge.from && (this.graph.apis[use.api]?.owner ?? use.api) === owner)
            .map((use: RuntimeUnresolved) => `unresolved-use:${use.service}->${use.api}`);
    }

    private queues(node: RenderNode): string[] {
        return node.queueKeys.map((key: string) => (key.startsWith('queue:') ? `contract-queue:${key.slice(6)}` : `queue:${key}`));
    }

    private put(renderId: string, factId: string): void {
        if (!this.byNode.has(renderId)) this.byNode.set(renderId, []);
        if (!this.byNode.get(renderId)!.includes(factId)) this.byNode.get(renderId)!.push(factId);
    }
}

/** Restyles one rendered statement for its diff status. */
export class RuntimeComparisonStyler {
    status(changes: RuntimeFactChange[]): RuntimeDiffStatus {
        const statuses = new Set(changes.map((change: RuntimeFactChange) => change.status));
        if (statuses.size === 0) return RuntimeDiffStatus.UNCHANGED;
        if (statuses.size === 1) return [...statuses][0];
        return RuntimeDiffStatus.CHANGED;
    }

    /** A service box: rebuilt (its HTML label carries the level badge and the status in words). */
    service(node: RenderNode, status: RuntimeDiffStatus, changes: RuntimeFactChange[]): string {
        const style = DIFF_STYLES[status];
        const change = changes[0];
        const level = this.levels(change);
        const changed = status === RuntimeDiffStatus.CHANGED && change !== undefined ? `: ${change.changedFields.join(', ')}` : '';
        const label =
            `<FONT COLOR="${style.text}99">${htmlLabelText(level)}</FONT>&#160;&#160;<B>${htmlLabelText(node.id.split('/').pop() ?? node.id)}</B>` +
            `<BR/>${htmlLabelText(node.tags?.role ?? 'unknown')}<BR/>${htmlLabelText(`${style.word}${changed}`)}`;
        const boxStyle = status === RuntimeDiffStatus.REMOVED ? 'filled,rounded,dashed' : 'filled,rounded';
        return (
            `  "${dotValue(node.id)}" [style="${boxStyle}", fillcolor="${style.fill}", color="${style.border}", ` +
            `penwidth=2, fontcolor="${style.text}", label=<${label}>];\n`
        );
    }

    /** A context box (queue, datastore, clock, vendor): kind shape kept, status colors laid over it. */
    context(node: RenderNode, status: RuntimeDiffStatus, changes: RuntimeFactChange[]): string {
        const style = DIFF_STYLES[status];
        let dot = node.dot;
        const moved = changes.find((change: RuntimeFactChange) => change.changedFields.includes('level'));
        if (node.queueKeys.length > 0 && moved !== undefined)
            dot = dot.replace(/(label=" \|)L\d+ {2}/, `$1${this.levels(moved).replace(/>/g, '\\>')}  `);
        const base = /style="([^"]*)"/.exec(dot)?.[1] ?? 'filled';
        const boxStyle = status === RuntimeDiffStatus.REMOVED && !base.includes('dashed') ? `${base},dashed` : base;
        return `${dot.slice(0, -2)} [style="${boxStyle}", fillcolor="${style.fill}", color="${style.border}", penwidth=2, fontcolor="${style.text}"];\n`;
    }

    /** An arrow: its line style says rpc/event as always; color (and dots for a removal) says the diff. */
    edge(dot: string, status: RuntimeDiffStatus): string {
        const style = DIFF_STYLES[status];
        const removed = status === RuntimeDiffStatus.REMOVED ? ', style=dotted' : '';
        const width = status === RuntimeDiffStatus.UNCHANGED ? 1 : 2.2;
        return `${dot.slice(0, -2)} [color="${style.border}", fontcolor="${style.border}", penwidth=${width}${removed}];\n`;
    }

    /** `L4`, or `L4 → L2` when the level moved. */
    levels(change: RuntimeFactChange | undefined): string {
        const before = change?.before?.['level'];
        const after = change?.after?.['level'];
        if (before !== undefined && after !== undefined && before !== after) return `${before} → ${after}`;
        return after ?? before ?? '';
    }
}

/** Builds the Goal vs Current view both runtime pages carry. */
export class RuntimeGoalComparison {
    private readonly styler = new RuntimeComparisonStyler();

    build(current: RuntimeGraph, goal: RuntimeGraph, options: RuntimeVizOptions): RuntimeComparisonView {
        const diff = new RuntimeGraphDiff().compare(current, goal);
        const union = new RuntimeUnionGraph().build(current, goal);
        const tags: Record<string, string> = {};
        for (const key of Object.keys(union.queues)) tags[key] = diff.get(`queue:${key}`)?.status ?? '';
        const model = generateRuntimeRenderModel(union, 'Goal vs Current', options.withPage(RuntimePageKind.COMPARISON, tags));
        const nodeDetails: Record<string, string[]> = {};
        const edgeDetails: Record<string, string[]> = {};
        const ids = new RuntimeComparisonIds(union);
        this.restyleNodes(model, ids, diff, nodeDetails);
        this.restyleEdges(model, ids, diff, edgeDetails);
        model.fullDot = new RuntimeLayout().assemble(model);
        assertValidDot(model.fullDot, 'runtime-architecture goal comparison');
        return new RuntimeComparisonView(
            true,
            '',
            'Current → Goal',
            this.summary(diff),
            model,
            nodeDetails,
            edgeDetails,
            diff.differences().map((change: RuntimeFactChange) => this.line(change)),
        );
    }

    private restyleNodes(model: GraphRenderModel, ids: RuntimeComparisonIds, diff: RuntimeGraphDiffResult, details: Record<string, string[]>): void {
        for (let index = 0; index < model.nodes.length; index++) {
            const node = model.nodes[index];
            const changes = this.changes(ids.node(node), diff);
            const status = this.styler.status(changes);
            const dot = node.tags !== null ? this.styler.service(node, status, changes) : this.styler.context(node, status, changes);
            model.nodes[index] = new RenderNode(node.id, dot, null, node.tags, node.products, node.queueKeys);
            details[node.id] = changes.flatMap((change: RuntimeFactChange) => change.lines());
        }
    }

    private restyleEdges(model: GraphRenderModel, ids: RuntimeComparisonIds, diff: RuntimeGraphDiffResult, details: Record<string, string[]>): void {
        const nodes = new Map<string, RenderNode>();
        for (const node of model.nodes) nodes.set(node.id, node);
        for (let index = 0; index < model.edges.length; index++) {
            const edge = model.edges[index];
            const changes = this.changes(ids.edge(edge, nodes), diff);
            const status = this.styler.status(changes);
            model.edges[index] = new RenderEdge(edge.from, edge.to, this.styler.edge(edge.dot, status), edge.id, null);
            details[edge.id] = [`${edge.from} → ${edge.to}`, ...changes.flatMap((change: RuntimeFactChange) => change.lines())];
        }
    }

    private changes(factIds: string[], diff: RuntimeGraphDiffResult): RuntimeFactChange[] {
        return factIds
            .map((id: string) => diff.get(id))
            .filter((change: RuntimeFactChange | undefined): change is RuntimeFactChange => change !== undefined);
    }

    private summary(diff: RuntimeGraphDiffResult): string {
        if (diff.identical()) return 'No differences: the goal matches the current runtime graph.';
        const counts = diff.counts();
        const levels = diff.maxLevelBefore === diff.maxLevelAfter ? '' : ` · max level L${diff.maxLevelBefore} → L${diff.maxLevelAfter}`;
        return `${counts.added} added · ${counts.removed} removed · ${counts.changed} changed · ${counts.unchanged} unchanged${levels}`;
    }

    private line(change: RuntimeFactChange): string {
        const fields = change.status === RuntimeDiffStatus.CHANGED ? ` (${change.changedFields.join(', ')})` : '';
        return `${change.status}: ${change.label}${fields}`;
    }
}
