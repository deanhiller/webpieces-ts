import { describe, it, expect } from 'vitest';
import { ContractDiffRenderer, ContractDiffSection, CONTRACT_DIFF_COMMENT_MARKER } from './contract-diff-renderer';
import { JsonObject } from './json-value';
import { ContractChange, OpenApiContractDiff } from './openapi-contract-diff';

const differ = new OpenApiContractDiff();

function base(): JsonObject {
    return {
        openapi: '3.1.0',
        info: { title: 'Orders', version: '1.0.0' },
        paths: {
            '/orders/fetch': { post: { operationId: 'fetchOrders', responses: { '200': { description: 'ok' } } } },
            '/orders/cancel': { post: { operationId: 'cancelOrder', responses: { '200': { description: 'ok' } } } },
        },
        webhooks: { 'order.state-changed': { post: { operationId: 'orderStateChanged' } } },
        components: {
            schemas: {
                Order: { type: 'object', properties: { id: { type: 'string' }, state: { type: 'string' } }, required: ['id'] },
                Legacy: { type: 'object', properties: {} },
            },
            securitySchemes: { PartnerApiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } },
        },
    };
}

function subjects(changes: readonly ContractChange[], kind: string): string[] {
    return changes.filter((change: ContractChange) => change.kind === kind).map((change: ContractChange) => change.subject);
}

describe('OpenApiContractDiff', () => {
    it('reports nothing for the same document, whatever the key order', () => {
        const reordered = JSON.parse(JSON.stringify(base())) as JsonObject;
        const doc = base();
        const shuffled: JsonObject = { components: doc['components']!, paths: doc['paths']!, webhooks: doc['webhooks']!, info: doc['info']!, openapi: '3.1.0' };
        expect(differ.diff(reordered, shuffled)).toEqual([]);
    });

    it('names an operation that becomes partner-visible, one that disappears, and what moved inside one', () => {
        const head = base();
        const paths = head['paths'] as JsonObject;
        paths['/orders/reindex'] = { post: { operationId: 'reindex' } };
        delete paths['/orders/cancel'];
        (paths['/orders/fetch'] as JsonObject)['post'] = { operationId: 'fetchOrders', responses: { '200': { description: 'changed' } } };

        const changes = differ.diff(base(), head);

        expect(subjects(changes, 'added')).toEqual(['POST /orders/reindex']);
        expect(subjects(changes, 'removed')).toEqual(['POST /orders/cancel']);
        const changed = changes.find((change: ContractChange) => change.kind === 'changed')!;
        expect(changed.subject).toBe('POST /orders/fetch');
        expect(changed.details).toEqual(['responses']);
    });

    it('reports schema changes field by field, including required-ness', () => {
        const head = base();
        const schemas = (head['components'] as JsonObject)['schemas'] as JsonObject;
        schemas['Order'] = {
            type: 'object',
            properties: { id: { type: 'string' }, state: { type: 'integer' }, window: { type: 'object' } },
            required: ['id', 'state'],
        };
        delete schemas['Legacy'];

        const changes = differ.diff(base(), head);

        expect(subjects(changes, 'removed')).toEqual(['schema Legacy']);
        const order = changes.find((change: ContractChange) => change.subject === 'schema Order')!;
        expect(order.details).toEqual(['~ field state', '+ field window', 'now required: state']);
    });

    it('treats a missing merge-base document as a brand-new contract — everything added', () => {
        const changes = differ.diff(undefined, base());
        expect(changes.every((change: ContractChange) => change.kind === 'added')).toBe(true);
        expect(subjects(changes, 'added')).toContain('webhook order.state-changed (POST)');
        expect(subjects(changes, 'added')).toContain('components.securitySchemes');
        expect(subjects(changes, 'added')).toContain('document info');
    });

    it('reports a changed top-level section, such as info, by name', () => {
        const head = base();
        head['info'] = { title: 'Orders', version: '2.0.0' };
        expect(differ.diff(base(), head)).toEqual([new ContractChange('changed', 'document info', [])]);
    });
});

describe('ContractDiffRenderer', () => {
    const renderer = new ContractDiffRenderer();

    it('leads with the marker, and lists Added first — the backstop for `hidden`', () => {
        const section = new ContractDiffSection('partner-api', 'apps/p/openapi.manifest.json', 'public-openapi.json',
            'aaaaaaaaaa', 'bbbbbbbbbb', '', false, [
                new ContractChange('removed', 'POST /orders/cancel', []),
                new ContractChange('added', 'POST /orders/reindex', []),
                new ContractChange('changed', 'schema Order', ['+ field window']),
            ]);

        const body = renderer.render([section]);

        expect(body.startsWith(CONTRACT_DIFF_COMMENT_MARKER)).toBe(true);
        expect(body).toContain('merge-base `aaaaaaa` → HEAD `bbbbbbb`');
        expect(body.indexOf('Added')).toBeLessThan(body.indexOf('Removed'));
        expect(body).toContain('- `POST /orders/reindex`');
        expect(body).toContain('- `schema Order` — `+ field window`');
    });

    it('says so plainly when nothing partner-facing moved', () => {
        const section = new ContractDiffSection('partner-api', 'm.json', 'public-openapi.json', 'a', 'b', '', false, []);
        expect(renderer.render([section])).toContain('**No partner-facing change.**');
    });
});
