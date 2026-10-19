import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Validator } from '@seriousme/openapi-schema-validator';
import { OpenApiCli } from '../cli/OpenApiCli';
import { OpenApiGenerationError } from '../OpenApiGenerationError';

/** A parsed JSON document, for assertions. */
type Json = Record<string, unknown>;

/**
 * #1246 — a field-level `@hidden` JSDoc tag, through the real CLI against `fixtures/hidden/`:
 *
 * - the CUSTOMER document (`public-openapi.json` and its bundled sibling) omits the property, its
 *   prose and its `required` entry everywhere the schema is written: an inlined single-use request,
 *   a nested `$ref` target, a flattened base, a webhook payload — and a type reached ONLY through a
 *   hidden field is not defined at all;
 * - the private document keeps every field, and so does the MCP output — the audience of
 *   `{ hidden: true }` on a method, which MCP keeps too;
 * - the `@hidden` reason is published NOWHERE;
 * - a required hidden field, an all-hidden type, and a `{@link}` to a hidden field from prose the
 *   customer document carries are refused.
 */
class Run {
    readonly written = new Map<string, string>();

    constructor(manifest: string) {
        const fixtures = path.join(__dirname, 'fixtures');
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-openapi-hidden-'));
        const result = new OpenApiCli().run(
            ['--manifest', path.join(fixtures, 'hidden', manifest), '--out', out, '--format', 'json'],
            fixtures,
        );
        for (const file of result.written) {
            this.written.set(path.basename(file), fs.readFileSync(file, 'utf8'));
        }
    }

    document(fileName: string): Json {
        const text = this.written.get(fileName);
        expect(text, `nothing written at ${fileName}`).toBeDefined();
        return JSON.parse(text!) as Json;
    }

    schemas(fileName: string): Json {
        return ((this.document(fileName)['components'] as Json)['schemas'] as Json | undefined) ?? {};
    }

    /** The request body or 200 response schema of `POST <url>`. */
    body(fileName: string, url: string, which: 'request' | 'response'): Json {
        const operation = ((this.document(fileName)['paths'] as Json)[url] as Json)['post'] as Json;
        return this.content(operation, which);
    }

    /** The request body of a webhook. */
    webhookBody(fileName: string, event: string): Json {
        const operation = ((this.document(fileName)['webhooks'] as Json)[event] as Json)['post'] as Json;
        return this.content(operation, 'request');
    }

    private content(operation: Json, which: 'request' | 'response'): Json {
        const holder =
            which === 'request'
                ? (operation['requestBody'] as Json)
                : ((operation['responses'] as Json)['200'] as Json);
        return ((holder['content'] as Json)['application/json'] as Json)['schema'] as Json;
    }
}

// webpieces-disable no-function-outside-class -- spec helper
function failureOf(manifest: string): OpenApiGenerationError {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS what this returns
    try {
        new Run(manifest);
    } catch (err: unknown) {
        //const error = toError(err);
        if (err instanceof OpenApiGenerationError) return err;
        throw err;
    }
    throw new Error(`${manifest} generated without refusing`);
}

// webpieces-disable no-function-outside-class -- spec helper
function propertiesOf(schema: Json): readonly string[] {
    return Object.keys((schema['properties'] as Json | undefined) ?? {});
}

// webpieces-disable no-function-outside-class -- spec helper
async function validate(text: string): Promise<unknown> {
    const result = await new Validator().validate(JSON.parse(text) as object);
    return result.valid ? true : result.errors;
}

const CUSTOMER = ['public-openapi.json', 'public-openapi.bundled.json'];
const PRIVATE = ['full-private-openapi.json', 'full-private-openapi.bundled.json'];

describe('field-level @hidden withholds a field from the customer document only (#1246)', () => {
    let run: Run;
    beforeAll(() => {
        run = new Run('hidden.manifest.json');
    }, 60_000);

    it('omits a hidden field of an INLINED request, its flattened base included', () => {
        for (const fileName of CUSTOMER) {
            const request = run.body(fileName, '/orders/fetch', 'request');
            expect(request['title'], fileName).toBe('FetchOrdersRequest');
            expect(propertiesOf(request), fileName).toEqual(['limit', 'storeId']);
            expect(request['required'], fileName).toEqual(['storeId']);
        }
        for (const fileName of PRIVATE) {
            const request = run.body(fileName, '/orders/fetch', 'request');
            expect(propertiesOf(request), fileName).toEqual(['limit', 'cursor', 'storeId', 'since']);
        }
    });

    it('omits a hidden field of a nested $ref target, and never defines a type only it reaches', () => {
        for (const fileName of CUSTOMER) {
            const schemas = run.schemas(fileName);
            expect(propertiesOf(schemas['OrderDto'] as Json), fileName).toEqual(['orderId']);
            expect(Object.keys(schemas), fileName).not.toContain('CourierDto');
            expect(run.body(fileName, '/orders/get', 'response'), fileName).toEqual({
                $ref: '#/components/schemas/OrderDto',
            });
        }
        for (const fileName of PRIVATE) {
            const schemas = run.schemas(fileName);
            expect(propertiesOf(schemas['OrderDto'] as Json), fileName).toEqual([
                'orderId',
                'deliveryEta',
                'courier',
            ]);
            expect(Object.keys(schemas), fileName).toContain('CourierDto');
        }
    });

    it('omits a hidden field of a webhook payload', () => {
        for (const fileName of CUSTOMER) {
            expect(propertiesOf(run.webhookBody(fileName, 'order.shipped')), fileName).toEqual([
                'orderId',
            ]);
        }
        for (const fileName of PRIVATE) {
            expect(propertiesOf(run.webhookBody(fileName, 'order.shipped')), fileName).toEqual([
                'orderId',
                'trackingCode',
            ]);
        }
    });

    it('keeps every hidden field in the MCP document and tool catalog, as MCP keeps hidden methods', () => {
        const schemas = run.schemas('mcp-openapi.json');
        expect(propertiesOf(schemas['OrderDto'] as Json)).toEqual(['orderId', 'deliveryEta', 'courier']);
        expect(propertiesOf(schemas['FetchOrdersRequest'] as Json)).toEqual([
            'limit',
            'cursor',
            'storeId',
            'since',
        ]);
        const catalog = run.written.get('mcp-OrdersApi-tools.json');
        expect(catalog).toBeDefined();
        expect(catalog).toContain('"deliveryEta"');
        expect(catalog).toContain('"since"');
        expect(catalog).toContain('"cursor"');
    });

    it('publishes the @hidden reason nowhere, and keeps the field prose out of the customer document', () => {
        expect(run.written.size).toBeGreaterThan(4);
        for (const [fileName, text] of Array.from(run.written.entries())) {
            expect(text, fileName).not.toContain('SECRET-REASON');
            expect(text, fileName).not.toContain('@hidden');
        }
        for (const fileName of CUSTOMER) {
            const text = run.written.get(fileName)!;
            for (const prose of ['Estimated delivery time', 'paging cursor', 'placed after', 'tracking code']) {
                expect(text, `${fileName}: ${prose}`).not.toContain(prose);
            }
        }
        expect(run.written.get('full-private-openapi.json')).toContain('Estimated delivery time');
    });

    it('writes documents that are valid OpenAPI 3.1', async () => {
        for (const fileName of [...CUSTOMER, ...PRIVATE, 'mcp-openapi.json']) {
            expect(await validate(run.written.get(fileName)!), fileName).toBe(true);
        }
    });
});

describe('field-level @hidden refusals (#1246)', () => {
    it('refuses a REQUIRED hidden field and an ALL-hidden type, both in one run', () => {
        const failure = failureOf('refused.manifest.json');
        expect(failure.message).toContain('1 @hidden field(s) are required');
        expect(failure.message).toContain('1 type(s) have every field @hidden');
        expect(failure.pointers).toEqual([
            expect.stringMatching(/^required: RequiredHiddenRequest\.secret \(.*RefusedHiddenApi\.ts:\d+:\d+\)$/),
            expect.stringMatching(/^every field hidden: AllHiddenResponse \(.*RefusedHiddenApi\.ts:\d+:\d+\)$/),
        ]);
        expect(failure.cure).toContain('`name?: T`');
    }, 60_000);

    it('refuses a {@link} to a hidden field from prose the customer document carries', () => {
        const failure = failureOf('link.manifest.json');
        expect(failure.message).toContain('{@link} reference(s) name nothing');
        const pointers = failure.pointers.join('\n');
        expect(pointers).toContain(
            '{@link QuoteRequest.discountCode} — QuoteRequest.discountCode is not published in public-openapi.json',
        );
        expect(pointers).toContain(
            '{@link discountCode} — field QuoteRequest.discountCode is not published in public-openapi.json',
        );
    }, 60_000);
});
