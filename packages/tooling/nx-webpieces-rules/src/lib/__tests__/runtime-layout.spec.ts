import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { RuntimeLayoutFixture } from './runtime-layout-fixture';
import { FilterFixture } from './graph-filter-fixture';
import type { GraphRenderModel } from '../graph-render-model';

/** Inspect actual Graphviz output: rank declarations alone missed both reported defects. */
class LayoutResult {
    readonly rows = new Map<string, number>();
    readonly edges: string[] = [];
    constructor(dot: string) {
        const plain = execFileSync('dot', ['-Tplain'], { input: dot, encoding: 'utf8' });
        for (const line of plain.split('\n')) {
            const fields = line.match(/"(?:\\.|[^"\\])*"|\S+/g) ?? [];
            const name = (field: string): string =>
                field.startsWith('"') ? (JSON.parse(field) as string) : field;
            if (fields[0] === 'node') this.rows.set(name(fields[1]), Number(fields[3]));
            if (fields[0] === 'edge') this.edges.push(`${name(fields[1])}->${name(fields[2])}`);
        }
    }

    checkBands(model: GraphRenderModel): void {
        for (const upper of model.bands) {
            for (const lower of model.bands.filter((band) => band.level < upper.level)) {
                for (const from of upper.nodeNames) {
                    for (const to of lower.nodeNames)
                        expect(this.rows.get(from)!).toBeGreaterThan(this.rows.get(to)!);
                }
            }
            const main = upper.nodeNames.filter((name) => !upper.selfQueueNames.includes(name));
            expect(new Set(main.map((name) => this.rows.get(name))).size).toBeLessThanOrEqual(1);
            for (const self of upper.selfQueueNames) {
                for (const service of main)
                    expect(this.rows.get(self)!).toBeLessThan(this.rows.get(service)!);
            }
        }
    }
}

describe('runtime Graphviz layout', () => {
    it('keeps each level strictly above all lower levels despite the real mixed-queue cycle', () => {
        const model = new RuntimeLayoutFixture().model();
        new LayoutResult(model.fullDot).checkBands(model);
        expect(model.fullDot).toContain('label=" |L3  PublicWebhooksApi queue"');
        expect(model.fullDot).toContain('label=" |L1  ReportsDispatcherApi queue"');
    });

    it('draws both directions for each pure self-queue on its own sub-row', () => {
        const model = new RuntimeLayoutFixture().model();
        const layout = new LayoutResult(model.fullDot);
        for (const [service, queue] of [
            ['reports-dispatcher', 'queue__ReportsDispatcherApi'],
            ['ai-chat', 'queue__WhatsAppApi'],
        ]) {
            expect(layout.edges).toContain(`${service}->${queue}`);
            expect(layout.edges).toContain(`${queue}->${service}`);
            expect(layout.rows.get(service)!).toBeGreaterThan(layout.rows.get(queue)!);
        }
        expect(layout.edges).toHaveLength(model.edges.length + model.bands.length - 1 + 2);
    });

    it('allows only downward real edges to constrain positions, including future RPC feedback edges', () => {
        const fixture = new RuntimeLayoutFixture();
        fixture.graph.runtimeEdges.push({
            from: 'pg-dataaccess',
            to: 'orders-manager',
            via: ['LegacyApi'],
            type: 'rpc',
        });
        fixture.graph.runtimeEdges.push({
            from: 'ai-chat',
            to: 'public-webhooks',
            via: ['PeerApi'],
            type: 'rpc',
        });
        const model = fixture.model();
        const levels = new Map(
            model.bands.flatMap((band) =>
                band.nodeNames.map((name) => [name, band.level] as const),
            ),
        );
        for (const edge of model.edges) {
            expect(edge.dot.includes('constraint=false')).toBe(
                levels.get(edge.from)! <= levels.get(edge.to)!,
            );
        }
        new LayoutResult(model.fullDot).checkBands(model);
    });

    it('keeps the mixed queue above its consumer when foreign producers are hidden', () => {
        const fixture = new RuntimeLayoutFixture();
        fixture.graph.services['orders-manager'].drawOnGraph = false;
        fixture.graph.services['stores-manager'].drawOnGraph = false;
        const model = fixture.model();
        const result = new LayoutResult(model.fullDot);
        expect(result.rows.get('queue__PublicWebhooksApi')!).toBeGreaterThan(
            result.rows.get('public-webhooks')!,
        );
        expect(model.bands.flatMap((band) => band.selfQueueNames)).not.toContain(
            'queue__PublicWebhooksApi',
        );
        result.checkBands(model);
    });

    it('keeps crowded spacer bands below self-queue sub-rows in both native and browser-rebuilt DOT', () => {
        const fixture = new RuntimeLayoutFixture();
        for (let index = 0; index < 12; index++) {
            fixture.graph.services[`spare-${index}`] = {
                ...fixture.graph.services['reports-dispatcher'],
            };
        }
        const model = fixture.model();
        new LayoutResult(model.fullDot).checkBands(model);
        const rebuilt = FilterFixture.api()
            .dot(model)
            .render(new Set(model.nodes.map((node) => node.id)));
        new LayoutResult(rebuilt).checkBands(model);
    });

    it('preserves sub-rows and constraints in browser-rebuilt DOT, including a retained self-queue alone', () => {
        const model = new RuntimeLayoutFixture().model();
        const filtered = FilterFixture.api().dot(model);
        const retained = new Set(model.nodes.map((node) => node.id));
        const rebuilt = filtered.render(retained);
        new LayoutResult(rebuilt).checkBands(model);
        expect(new LayoutResult(rebuilt).edges).toContain(
            'reports-dispatcher->queue__ReportsDispatcherApi',
        );
        const onlyQueue = filtered.render(new Set(['queue__ReportsDispatcherApi']));
        expect(new LayoutResult(onlyQueue).rows.has('queue__ReportsDispatcherApi')).toBe(true);
    });
});
