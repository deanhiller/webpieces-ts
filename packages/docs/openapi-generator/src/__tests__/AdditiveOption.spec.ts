import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenApiCli } from '../cli/OpenApiCli';

const ADDITIVE =
    'Additive: it only adds new state; it does not delete, replace or irreversibly change anything ' +
    'that already exists.';

/**
 * `@Endpoint`'s `additive` option in the generated documents (#1423): an additive write carries a
 * sentence in its description and `destructiveHint: false` in `x-mcp-hints`; every other shape is
 * unchanged.
 */
class Harness {
    private readonly fixtures = path.join(__dirname, 'fixtures');

    document(fileName: string): Record<string, unknown> {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-openapi-additive-'));
        new OpenApiCli().run(
            ['--manifest', path.join(this.fixtures, 'additive.manifest.json'), '--out', out],
            this.fixtures,
        );
        return JSON.parse(fs.readFileSync(path.join(out, fileName), 'utf8'));
    }

    operation(document: Record<string, unknown>, route: string): Record<string, unknown> {
        const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
        const found = paths[route]?.['post'];
        expect(found, `no post ${route}`).toBeDefined();
        return found!;
    }
}

const harness = new Harness();

describe('@Endpoint additive in OpenAPI (#1423)', () => {
    const privateDoc = harness.document('full-private-openapi.json');
    const mcpDoc = harness.document('mcp-openapi.json');

    it('says an additive write is additive, in its description', () => {
        expect(harness.operation(privateDoc, '/notes/add')['description']).toContain(ADDITIVE);
        expect(harness.operation(privateDoc, '/notes/draft')['description']).toContain(ADDITIVE);
    });

    it('says nothing new for a defaulted write, or for a READ', () => {
        expect(harness.operation(privateDoc, '/notes/replace')['description']).not.toContain(
            'Additive',
        );
        expect(harness.operation(privateDoc, '/notes/read')['description']).not.toContain(
            'Additive',
        );
    });

    it('emits destructiveHint false for the additive writes, leaving readOnly and idempotent alone', () => {
        expect(harness.operation(mcpDoc, '/notes/add')['x-mcp-hints']).toEqual({
            title: 'Add a note',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        });
        expect(harness.operation(mcpDoc, '/notes/draft')['x-mcp-hints']).toEqual({
            title: 'Save a draft',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        });
    });

    it('keeps the defaulted hints for a write and a READ', () => {
        expect(harness.operation(mcpDoc, '/notes/replace')['x-mcp-hints']).toMatchObject({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
        });
        expect(harness.operation(mcpDoc, '/notes/read')['x-mcp-hints']).toMatchObject({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
        });
    });
});
