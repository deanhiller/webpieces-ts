import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toError } from '@webpieces/core-util';
import { OpenApiCli } from '../cli/OpenApiCli';
import { OpenApiGenerationError } from '../OpenApiGenerationError';

/**
 * Issue #1284: a JSDoc `{@link X}` publishes as X's PUBLISHED identity — the schemaNames-stripped
 * schema name, the operationId, or (in an MCP tool catalog) the tool name — as a markdown code span,
 * in every output a run writes. A link the document cannot name is refused, every offender at once.
 * Real fixture contracts under `fixtures/links/`, read through the real extractor.
 */
class Harness {
    readonly fixtures = path.join(__dirname, 'fixtures', 'links');

    run(manifest: string): Map<string, string> {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-openapi-links-'));
        const result = new OpenApiCli().run(
            ['--manifest', path.join(this.fixtures, manifest), '--out', out, '--format', 'json'],
            this.fixtures,
        );
        const written = new Map<string, string>();
        for (const file of result.written) {
            written.set(path.basename(file), fs.readFileSync(file, 'utf8'));
        }
        return written;
    }

    /** The failure a run threw, or undefined. The catch IS the assertion. */
    failureOf(manifest: string): OpenApiGenerationError | undefined {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS what this method returns
        try {
            this.run(manifest);
            return undefined;
        } catch (err: unknown) {
            const error = toError(err);
            return error instanceof OpenApiGenerationError ? error : undefined;
        }
    }

    json(written: Map<string, string>, fileName: string): Record<string, unknown> {
        const text = written.get(fileName);
        expect(text, `nothing written at ${fileName}`).toBeDefined();
        return JSON.parse(text!) as Record<string, unknown>;
    }

    at(value: unknown, ...steps: readonly string[]): unknown {
        let current = value;
        for (const step of steps) {
            if (typeof current !== 'object' || current === null) {
                return undefined;
            }
            current = (current as Record<string, unknown>)[step];
        }
        return current;
    }
}

const harness = new Harness();
const DOCUMENTS = [
    'full-private-openapi.json',
    'full-private-openapi.bundled.json',
    'public-openapi.json',
    'public-openapi.bundled.json',
    'mcp-openapi.json',
];

describe('{@link} publishes the published identity, as a code span (#1284)', () => {
    const written = harness.run('links.manifest.json');

    it('names a type by its STRIPPED schema name and a method by its operationId, in every document', () => {
        for (const fileName of DOCUMENTS) {
            const document = harness.json(written, fileName);
            const fetch = harness.at(document, 'paths', '/menus/fetch', 'post');
            // The derived sentences (retry safety, trigger) follow the JSDoc body.
            expect(String(harness.at(fetch, 'description')), fileName).toContain(
                'Reads one menu as a `Menu`, served at `MenuKind.LUNCH`. Then call\n' +
                    'the publish operation (`publishMenu`). See\n' +
                    '[the guide](https://example.com/menus).',
            );
            expect(harness.at(fetch, 'responses', '200', 'description'), fileName).toBe(
                'The `Menu` asked for.',
            );
            const schemas = harness.at(document, 'components', 'schemas');
            expect(harness.at(schemas, 'Menu', 'description'), fileName).toBe(
                'One menu. Its kind is one of `MenuKind`.',
            );
            expect(harness.at(schemas, 'Menu', 'properties', 'items', 'description'), fileName).toBe(
                'The dishes, in the order `publishMenu` printed them.',
            );
            expect(
                harness.at(schemas, 'FetchMenuRequest', 'properties', 'menuId', 'description'),
                fileName,
            ).toBe("Which menu; the same id as the first dish (`Menu.items`)'s menu.");
        }
    });

    it('names a method that IS a tool by its tool name in the MCP tool catalog', () => {
        const catalog = written.get('mcp-MenusApi-tools.json')!;
        const tools = JSON.parse(catalog) as { name: string; description: string }[];
        const fetch = tools.find((tool: { name: string }) => tool.name === 'fetch_menu')!;
        expect(fetch.description).toContain('the publish operation (`publish_menu`)');
        const publish = tools.find((tool: { name: string }) => tool.name === 'publish_menu')!;
        expect(publish.description).toBe('Publishes one menu, as `fetch_menu` reads it.');
    });

    it('never publishes a Dto source name, a Contract. prefix or the model encoding anywhere', () => {
        for (const [fileName, text] of written) {
            expect(text, fileName).not.toMatch(/MenuDto|MenuKindDto|MenusApi\.|@link|/);
        }
    });
});

describe('a {@link} the document cannot publish is REFUSED (#1284)', () => {
    const failure = harness.failureOf('dangling.manifest.json');

    it('names every offender, with file:line, in one run', () => {
        expect(failure).toBeDefined();
        expect(failure!.message).toContain('3 {@link} reference(s) name nothing');
        expect(failure!.pointers).toHaveLength(3);
        const pointers = failure!.pointers.join('\n');
        expect(pointers).toMatch(
            /DanglingLinksApi\.ts:\d+:\d+ \{@link NoSuchShelf\} — the compiler cannot resolve it/,
        );
        // A real type, reached only by a HIDDEN operation: the customer document does not publish it.
        expect(pointers).toMatch(
            /\{@link AuditNoteDto\} — type AuditNoteDto is not published in public-openapi\.json/,
        );
        expect(pointers).toMatch(
            /\{@link DanglingLinksApi\.audit\} — operation DanglingLinksApi\.audit is not published in public-openapi\.json/,
        );
    });
});
