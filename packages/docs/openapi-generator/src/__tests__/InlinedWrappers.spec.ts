import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenApiCli } from '../cli/OpenApiCli';

/** A parsed JSON document, for assertions. */
type Json = Record<string, unknown>;

/**
 * #1303, items 1 and 2, through the real CLI against real fixture contracts:
 *
 * 1. A single-use request/response wrapper is defined INLINE at its operation, titled with its
 *    published name; a wrapper two operations share, or one nested in another schema, stays a
 *    component. (The cross-package case — a wrapper another package declares stays a `$ref` — needs
 *    a second package, so it lives in `ChainedComponents.spec.ts`.)
 * 2. `public-openapi.json` and its bundled sibling carry no `x-webpieces-*` key anywhere; the private
 *    and MCP documents keep theirs.
 */
class Documents {
    private readonly written = new Map<string, Json>();

    load(manifest: string): this {
        const fixtures = path.join(__dirname, 'fixtures');
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-openapi-wrappers-'));
        const result = new OpenApiCli().run(
            ['--manifest', path.join(fixtures, manifest), '--out', out, '--format', 'json'],
            fixtures,
        );
        for (const file of result.written) {
            this.written.set(
                path.basename(file),
                JSON.parse(fs.readFileSync(file, 'utf8')) as Json,
            );
        }
        return this;
    }

    document(fileName: string): Json {
        const found = this.written.get(fileName);
        expect(found, `nothing written at ${fileName}`).toBeDefined();
        return found!;
    }

    schemaNames(fileName: string): readonly string[] {
        const components = this.document(fileName)['components'] as Json | undefined;
        return Object.keys((components?.['schemas'] as Json | undefined) ?? {});
    }

    /** The request body or 200 response schema of `POST <url>`. */
    body(fileName: string, url: string, which: 'request' | 'response'): Json {
        const operation = ((this.document(fileName)['paths'] as Json)[url] as Json)['post'] as Json;
        const holder =
            which === 'request'
                ? (operation['requestBody'] as Json)
                : ((operation['responses'] as Json)['200'] as Json);
        return ((holder['content'] as Json)['application/json'] as Json)['schema'] as Json;
    }
}

/** Every key anywhere in a JSON value that starts with `prefix`, as `<path>: <key>`. */
function keysStartingWith(value: unknown, prefix: string, at = ''): string[] {
    if (Array.isArray(value)) {
        return value.flatMap((each: unknown, index: number) =>
            keysStartingWith(each, prefix, `${at}/${index}`),
        );
    }
    if (typeof value !== 'object' || value === null) {
        return [];
    }
    const found: string[] = [];
    for (const [key, child] of Object.entries(value as Json)) {
        if (key.startsWith(prefix)) {
            found.push(`${at}: ${key}`);
        }
        found.push(...keysStartingWith(child, prefix, `${at}/${key}`));
    }
    return found;
}

const SPLIT = ['full-private-openapi.json', 'public-openapi.json'];
const SPLIT_AND_BUNDLED = [
    ...SPLIT,
    'full-private-openapi.bundled.json',
    'public-openapi.bundled.json',
];

describe('single-use request/response wrappers are inlined at their operation (#1303)', () => {
    const docs = new Documents();
    beforeAll(() => docs.load('wrappers/wrappers.manifest.json'), 60_000);

    it('inlines a single-use request with its published name as `title` and its description', () => {
        for (const fileName of SPLIT_AND_BUNDLED) {
            expect(docs.body(fileName, '/things/make', 'request'), fileName).toEqual({
                type: 'object',
                title: 'MakeThingRequest',
                description: 'Which thing to make. Used by ONE operation, so it is inlined there (#1303).',
                properties: { name: { type: 'string', description: "The new thing's name." } },
                required: ['name'],
            });
            expect(docs.schemaNames(fileName), fileName).not.toContain('MakeThingRequest');
        }
    });

    it('inlines a single-use response the same way', () => {
        for (const fileName of SPLIT_AND_BUNDLED) {
            const response = docs.body(fileName, '/things/ping', 'response');
            expect(response['title'], fileName).toBe('PingResponse');
            expect(response['description'], fileName).toBe('The answer to a ping.');
            expect(docs.schemaNames(fileName), fileName).not.toContain('PingResponse');
        }
    });

    it('keeps `properties: {}` on an EMPTY request, which a client generator needs for an empty class', () => {
        for (const fileName of SPLIT_AND_BUNDLED) {
            expect(docs.body(fileName, '/things/ping', 'request'), fileName).toEqual({
                type: 'object',
                title: 'PingRequest',
                description: 'A ping. It carries nothing, and still inlines with an empty `properties`.',
                properties: {},
            });
        }
    });

    it('keeps a wrapper two operations share a component — counted over the MANIFEST, not one document', () => {
        // `audit` is hidden, so the public document holds only `make`; SharedReply is still shared.
        for (const fileName of SPLIT_AND_BUNDLED) {
            expect(docs.body(fileName, '/things/make', 'response'), fileName).toEqual({
                $ref: '#/components/schemas/SharedReply',
            });
            expect(docs.schemaNames(fileName), fileName).toContain('SharedReply');
        }
    });

    it('keeps a wrapper nested in another schema a component, and inlines the one that nests it', () => {
        for (const fileName of SPLIT_AND_BUNDLED) {
            expect(docs.body(fileName, '/things/note', 'request'), fileName).toEqual({
                $ref: '#/components/schemas/NoteRequest',
            });
            const response = docs.body(fileName, '/things/note', 'response');
            expect(response['title'], fileName).toBe('FiledNoteResponse');
            expect((response['properties'] as Json)['note'], fileName).toEqual({
                $ref: '#/components/schemas/NoteRequest',
                description: 'The note that was filed.',
            });
            expect(docs.schemaNames(fileName), fileName).toEqual(['NoteRequest', 'SharedReply']);
        }
    });
});

describe('the PUBLIC document carries no x-webpieces-* key (#1303)', () => {
    const docs = new Documents();
    beforeAll(() => docs.load('single.manifest.json'), 60_000);

    it('has none anywhere in public-openapi.json or its bundled sibling', () => {
        for (const fileName of ['public-openapi.json', 'public-openapi.bundled.json']) {
            expect(keysStartingWith(docs.document(fileName), 'x-webpieces'), fileName).toEqual([]);
        }
    });

    it('still states authentication the STANDARD way, through security and securitySchemes', () => {
        const published = docs.document('public-openapi.json');
        expect(published['security']).toBeDefined();
        expect(Object.keys((published['components'] as Json)['securitySchemes'] as Json)).toEqual([
            'WidgetKey',
            'WidgetOrg',
        ]);
    });

    it('keeps x-webpieces-authentication and x-webpieces-webhook in the private document', () => {
        const keys = keysStartingWith(docs.document('full-private-openapi.json'), 'x-webpieces');
        expect(keys).toContain('/paths//widgets/list/post: x-webpieces-authentication');
        expect(keys).toContain('/webhooks/widget.made/post: x-webpieces-webhook');
    });

    it('keeps them in the MCP document too', () => {
        const keys = keysStartingWith(docs.document('mcp-openapi.json'), 'x-webpieces');
        expect(keys).toContain('/paths//widgets/list/post: x-webpieces-authentication');
        expect(keys).toContain('/paths//widgets/list/post: x-webpieces-authorization');
    });
});

describe('the MCP projection keeps every wrapper a component (#1303)', () => {
    const docs = new Documents();
    beforeAll(() => docs.load('single.manifest.json'), 60_000);

    it('references the single-use wrappers from components.schemas, unchanged', () => {
        expect(docs.body('mcp-openapi.json', '/widgets/list', 'request')).toEqual({
            $ref: '#/components/schemas/ListWidgetsRequest',
        });
        expect(docs.schemaNames('mcp-openapi.json')).toContain('ListWidgetsResponse');
        // ...while the private document, rendered from the same model, inlines them.
        expect(docs.body('full-private-openapi.json', '/widgets/list', 'request')['title']).toBe(
            'ListWidgetsRequest',
        );
    });
});
