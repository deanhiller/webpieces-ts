/**
 * A graph node's IDENTITY is the project key; its LABEL is the scope-stripped short name.
 *
 * The defect these pin, reproduced from a real consumer repo holding both
 * `@mealco-internal/public-api` (L0 contract lib) and `public-api` (L6 server): both stripped to
 * `public-api`, so ONE dot node carried both projects. That node was emitted into the L0 rank set
 * AND the L6 rank set, graphviz UNIONS rank sets sharing a node, and the two levels became one row —
 * which also made the invisible L6→…→L0 anchor chain unsatisfiable, so graphviz discarded the
 * ordering and floated L0 to the top. The server's dependency on the contract lib drew as a
 * self-loop on the fused box.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import type { EnhancedGraph } from '../graph-sorter';
import { GraphVisualizer } from '../graph-visualizer';
import { GraphNames, NodeIdCollisionError, NodeIdOwner } from '../graph-names';
import { ResponsibilitiesRenderer } from '../graph-responsibilities';
import type { RuntimeGraph } from '../runtime-graph-model';
import { generateRuntimeDot } from '../runtime-visualizer';
import { toError } from '../../toError';

const CLIENT_TS = path.join(__dirname, '..', 'graph-visualizer.client.ts');
const clientJs = (): string => ts.transpileModule(
    fs.readFileSync(CLIENT_TS, 'utf-8'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const viz = new GraphVisualizer(clientJs);
const names = new GraphNames();

/** The consumer shape, minimised: two DISTINCT projects whose names differ only by scope. */
const SCOPED_GRAPH: EnhancedGraph = {
    'public-api': { level: 2, dependsOn: ['@mealco-internal/public-api'], role: 'server' },
    '@mealco-internal/public-api': { level: 0, dependsOn: [], role: 'lib' },
    'core-util': { level: 0, dependsOn: [], role: 'lib' },
};

describe('GraphNames', () => {
    it('gives two projects that differ only by scope two DISTINCT node ids', () => {
        expect(names.getNodeId('public-api')).toBe('public-api');
        expect(names.getNodeId('@mealco-internal/public-api')).toBe('@mealco-internal/public-api');
        expect(names.getNodeId('public-api')).not.toBe(names.getNodeId('@mealco-internal/public-api'));
    });

    it('still strips the scope for the human-facing LABEL', () => {
        expect(names.getShortName('@mealco-internal/public-api')).toBe('public-api');
        expect(names.getShortName('public-api')).toBe('public-api');
    });

    it('accepts a set of projects that all draw as their own node', () => {
        expect((): void => names.assertUniqueNodeIds([
            new NodeIdOwner('public-api', 6),
            new NodeIdOwner('@mealco-internal/public-api', 0),
        ])).not.toThrow();
    });

    it('fails loudly, naming BOTH colliding project keys and their levels', () => {
        // The only way to collide now is a getNodeId that stops being 1:1 — so the assertion is
        // driven directly, with a subclass that reintroduces exactly the old lossy mapping.
        class LossyNames extends GraphNames {
            override getNodeId(projectKey: string): string {
                return this.getShortName(projectKey);
            }
        }
        let message = '';
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            new LossyNames().assertUniqueNodeIds([
                new NodeIdOwner('public-api', 6),
                new NodeIdOwner('@mealco-internal/public-api', 0),
            ]);
        } catch (err: unknown) {
            const error = toError(err);
            expect(error).toBeInstanceOf(NodeIdCollisionError);
            message = error.message;
        }
        expect(message).toContain('"@mealco-internal/public-api" (L0)');
        expect(message).toContain('"public-api" (L6)');
        expect(message).toContain('node "public-api" would be drawn for');
    });
});

describe('generateDot node identity', () => {
    it('keys the node on the full project key and labels it with the short name', () => {
        const dot = viz.generateDot(SCOPED_GRAPH);
        expect(dot).toContain('"@mealco-internal/public-api" [fillcolor=');
        expect(dot).toContain('label="public-api\\n(L0 · [] · lib)"');
        expect(dot).toContain('label="public-api\\n(L2 · [] · server)"');
    });

    it('draws the dependency as a real edge between two boxes, never as a self-loop', () => {
        const dot = viz.generateDot(SCOPED_GRAPH);
        expect(dot).toContain('"public-api" -> "@mealco-internal/public-api";');
        expect(dot).not.toContain('"public-api" -> "public-api"');
    });

    it("keeps every level's rank set disjoint from every other", () => {
        const dot = viz.generateDot(SCOPED_GRAPH);
        const members = dot
            .split('\n')
            .filter((line: string): boolean => line.includes('rank=same'))
            .map((line: string): string[] =>
                [...line.matchAll(/"([^"]+)"/g)]
                    .map((match): string => match[1])
                    .filter((name: string): boolean => !name.startsWith('__wp_layout')));
        const seen = new Set<string>();
        for (const band of members) {
            for (const name of band) {
                expect(seen.has(name)).toBe(false);
                seen.add(name);
            }
        }
        // ...and every project is placed exactly once.
        expect([...seen].sort()).toEqual(
            ['@mealco-internal/public-api', 'core-util', 'public-api']);
    });

    it('refuses to draw a cyclic graph rather than rendering meaningless levels', () => {
        expect((): string => viz.generateDot({
            a: { level: 1, dependsOn: ['b'] },
            b: { level: 1, dependsOn: ['a'] },
        })).toThrow(/a -> b -> a/);
    });
});

describe('lockControl', () => {
    it('uses the node id as the option VALUE and the short name as its text', () => {
        const html = viz.lockControl(SCOPED_GRAPH);
        expect(html).toContain('<option value="@mealco-internal/public-api">L0 · public-api</option>');
        expect(html).toContain('<option value="public-api">L2 · public-api</option>');
    });
});

/**
 * The RUNTIME graph had the identical defect (it was untouched by the level-band fix): its node ids
 * were scope-stripped too, so two same-short-named services fused into one box and the call between
 * them drew as a self-loop. It has no rank bands, so it never inverted a level — but a fused box is
 * still a picture that says something false.
 */
describe('generateRuntimeDot node identity', () => {
    const RUNTIME: RuntimeGraph = {
        services: {
            'public-api': { level: 1, role: 'server', implements: [] },
            '@mealco-internal/public-api': { level: 0, role: 'server', implements: ['OrdersApi'] },
        },
        apis: { OrdersApi: { implementedBy: ['@mealco-internal/public-api'], usedBy: ['public-api'], owner: 'orders-api' } },
        runtimeEdges: [{ from: 'public-api', to: '@mealco-internal/public-api', via: ['OrdersApi'], type: 'rpc' }],
        unresolvedUses: [],
        queues: {},
        triggers: [],
    };

    it('keys each service box on its project key while labeling it with the short name', () => {
        const dot = generateRuntimeDot(RUNTIME);
        expect(dot).toContain('"@mealco-internal/public-api" [fillcolor=');
        expect(dot).toContain('label="public-api\\n(server, L0)');
    });

    it('draws the call as a real arrow between two boxes, never as a self-loop', () => {
        const dot = generateRuntimeDot(RUNTIME);
        expect(dot).toContain('"public-api" -> "@mealco-internal/public-api" [label="OrdersApi"];');
        expect(dot).not.toContain('"public-api" -> "public-api"');
    });
});

describe('responsibilities cards', () => {
    it('keys data-node on the project key so two same-named projects get two cards', () => {
        const html = new ResponsibilitiesRenderer().generateSection(SCOPED_GRAPH, '/nowhere');
        expect(html).toContain('data-node="@mealco-internal/public-api"');
        expect(html).toContain('data-node="public-api"');
        // The heading a human reads stays the short name.
        expect(html.match(/<strong>public-api<\/strong>/g)).toHaveLength(2);
    });
});
