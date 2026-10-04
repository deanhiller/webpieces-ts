import { describe, expect, it } from 'vitest';
import type { RuntimeGraph } from './runtime-graph-model';
import { RuntimeDetails } from './runtime-details';
import { generateRuntimeDot } from './runtime-visualizer';

function graph(apis: string[]): RuntimeGraph {
    return {
        services: {
            source: { level: 1, role: 'client', implements: [], uses: [...apis], dependsOn: [] },
            target: {
                level: 0,
                role: 'server',
                implements: [...apis],
                uses: [],
                dependsOn: [],
                implementsVia: Object.fromEntries(apis.map((api) => [api, 'shared#Routes'])),
            },
        },
        apis: Object.fromEntries(
            apis.map((api) => [
                api,
                {
                    owner: 'contracts',
                    implementedBy: ['target'],
                    usedBy: ['source'],
                    type: 'rpc' as const,
                },
            ]),
        ),
        runtimeEdges:
            apis.length === 0
                ? []
                : [{ from: 'source', to: 'target', via: [...apis], type: 'rpc' }],
        queues: {},
        triggers: [],
        unresolvedUses: [],
    };
}

describe('compact runtime graph details', () => {
    for (const count of [0, 1, 2, 3, 10]) {
        it(`keeps ${count} edge relationships complete with the correct inline/dropdown threshold`, () => {
            const apis = Array.from({ length: count }, (_, index) => `Api${index}`);
            const data = graph(apis);
            const details = new RuntimeDetails(data, true);
            const dot = generateRuntimeDot(data);
            expect(details.nodes.source.used).toHaveLength(count);
            expect(details.nodes.target.implemented).toHaveLength(count);
            if (count > 2) expect(dot).toContain(`label="Uses (${count}) ▾"`);
            else if (count > 0) expect(dot).toContain(`label="${apis.join(', ')}"`);
            expect(dot).toContain(`Implements (${count})`);
            expect(
                details.nodes.target.implemented.every((value) =>
                    value.includes('via shared#Routes'),
                ),
            ).toBe(true);
        });
    }
    it('retains two providers of one API and hidden external uses in the node list', () => {
        const data = graph(['AuthApi']);
        data.runtimeEdges.push({ from: 'source', to: 'second', via: ['AuthApi'], type: 'rpc' });
        data.services.source.uses.push('GmailApi');
        data.apis.GmailApi = {
            owner: 'gmail',
            type: 'external',
            implementedBy: [],
            usedBy: ['source'],
        };
        const details = new RuntimeDetails(data, false);
        expect(details.nodes.source.used).toHaveLength(3);
        expect(details.nodes.source.used.join('\n')).toContain('→ second');
        expect(details.nodes.source.used.join('\n')).toContain('destination hidden');
        expect(details.edges['source->target']).toHaveLength(1);
        expect(details.edges['source->second']).toHaveLength(1);
    });
});
