import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenApiCli } from '../cli/OpenApiCli';

/**
 * PUT / PATCH / DELETE and URL parameters in the generated document (#1339): `parameters` for every
 * `@PathParam` / `@QueryParam`, and a `requestBody` on exactly the verbs that carry one.
 */
class Harness {
    private readonly fixtures = path.join(__dirname, 'fixtures');

    privateDocument(): Record<string, unknown> {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-openapi-verbs-'));
        new OpenApiCli().run(
            ['--manifest', path.join(this.fixtures, 'rest-verbs.manifest.json'), '--out', out],
            this.fixtures,
        );
        return JSON.parse(fs.readFileSync(path.join(out, 'full-private-openapi.json'), 'utf8'));
    }

    operation(document: Record<string, unknown>, route: string, verb: string): Record<string, unknown> {
        const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
        const found = paths[route]?.[verb];
        expect(found, `no ${verb} ${route}`).toBeDefined();
        return found!;
    }
}

const harness = new Harness();

describe('REST verbs and URL parameters in OpenAPI', () => {
    const document = harness.privateDocument();

    it('a GET publishes its path and query arguments as parameters, with no body', () => {
        const find = harness.operation(document, '/gadgets/{shopId}', 'get');
        expect(find['requestBody']).toBeUndefined();
        expect(find['parameters']).toEqual([
            { name: 'shopId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'number' } },
            {
                name: 'tag',
                in: 'query',
                required: false,
                style: 'form',
                explode: true,
                schema: { type: 'array', items: { type: 'string' } },
            },
        ]);
    });

    it('PUT and PATCH publish the one unbound argument as the request body', () => {
        for (const verb of ['put', 'patch']) {
            const operation = harness.operation(document, '/gadgets/{shopId}/{gadgetId}', verb);
            const parameters = operation['parameters'] as Record<string, unknown>[];
            expect(parameters.map((parameter: Record<string, unknown>) => parameter['name'])).toEqual([
                'shopId',
                'gadgetId',
            ]);
            const body = operation['requestBody'] as Record<string, unknown>;
            expect(JSON.stringify(body)).toContain('#/components/schemas/ReplaceGadgetRequest');
        }
    });

    it('DELETE publishes its path parameters and no body', () => {
        const remove = harness.operation(document, '/gadgets/{shopId}/{gadgetId}', 'delete');
        expect(remove['requestBody']).toBeUndefined();
        expect((remove['parameters'] as unknown[]).length).toBe(2);
    });

    it('a void route documents 204 with no content, exactly what the server sends', () => {
        const touch = harness.operation(document, '/gadgets/{shopId}/{gadgetId}/touch', 'put');
        expect(touch['responses']).toEqual({ '204': { description: 'Success. The response has no body.' } });
    });
});
