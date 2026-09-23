import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpToolCatalog } from '@webpieces/core-util';
import { OpenApiCli, YamlReader } from '@webpieces/openapi-generator';

/**
 * REGENERATE the committed OpenAPI documents and diff them against what is in the tree.
 *
 * ## Why a golden and not a set of assertions about the document
 *
 * Assertions only fail for the things somebody thought to assert. What this test has to catch is a
 * change nobody predicted: a decorator gains an argument, a JSDoc sentence is reworded, a DTO field
 * turns optional — and the published customer contract MOVES. Committing the documents makes every one
 * of those a visible diff in the PR that causes it, which is the only point at which anybody can say
 * whether the customer-facing change was intended. A green build that silently republishes a different
 * contract is the failure mode the whole generator exists to remove.
 *
 * ## Why only the JSON is committed
 *
 * Committing the YAML too would double the review surface every decorator change has to be diffed
 * against, for a file that is the first one restated. Instead the run below asks for BOTH formats and
 * one test parses each YAML and asserts deep equality with its JSON counterpart — which proves the
 * YAML is right without asking anybody to read it.
 *
 * ## The cure, when it goes red
 *
 * Re-run the generator and commit what it writes, exactly as the failure message says. Then READ the
 * diff: that diff is the change your edit made to the published contract.
 */
const PROJECT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(PROJECT, 'openapi.manifest.json');
const COMMITTED = path.join(PROJECT, 'generated');

/** The documents this contract set produces, by the `@ApiType`s it declares. */
const DOCUMENTS = ['full-private-openapi', 'public-openapi', 'mcp-openapi'];

const REGENERATE = [
    'To accept it, regenerate and commit:',
    '  node -r @swc-node/register -r tsconfig-paths/register \\',
    '    packages/docs/openapi-generator/src/cli/wp-openapi.ts \\',
    '    --manifest apps/app-example/partner-api/openapi.manifest.json \\',
    '    --out apps/app-example/partner-api/generated --format json',
].join('\n');

class Golden {
    readonly fresh = new Map<string, string>();
    skippedMcpTools: readonly string[] = [];

    generate(): void {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-openapi-'));
        const result = new OpenApiCli().run(
            ['--manifest', MANIFEST, '--out', out, '--format', 'both'],
            PROJECT,
        );
        for (const file of result.written) {
            this.fresh.set(path.basename(file), fs.readFileSync(file, 'utf8'));
        }
        this.skippedMcpTools = result.skippedMcpTools.map(String);
    }

    committed(fileName: string): string {
        const file = path.join(COMMITTED, fileName);
        expect(fs.existsSync(file), `${fileName} is not committed.\n${REGENERATE}`).toBe(true);
        return fs.readFileSync(file, 'utf8');
    }
}

const golden = new Golden();

beforeAll(() => {
    golden.generate();
});

describe('the committed OpenAPI documents', () => {
    it.each(DOCUMENTS.map((name: string) => [`${name}.json`]))(
        '%s matches what the generator produces today',
        (fileName: string) => {
            expect(
                golden.fresh.get(fileName),
                `${fileName} has drifted from the contract.\n${REGENERATE}`,
            ).toBe(golden.committed(fileName));
        },
    );

    it('writes NOTHING that is not committed — a new document is a review decision', () => {
        const json = Array.from(golden.fresh.keys())
            .filter((name: string) => name.endsWith('.json'))
            .sort();
        // mcp-tools.json is not a DOCUMENT — it is the RUNTIME catalog, not serialized by --format —
        // but it is committed and reviewed exactly like one.
        expect(json).toEqual(
            [...DOCUMENTS.map((name: string) => `${name}.json`), 'mcp-tools.json'].sort(),
        );
    });

    it('the YAML parses back to the SAME document as its JSON counterpart', () => {
        const reader = new YamlReader();
        for (const name of DOCUMENTS) {
            const fromJson: unknown = JSON.parse(golden.fresh.get(`${name}.json`)!);
            const fromYaml: unknown = reader.read(golden.fresh.get(`${name}.yaml`)!);
            expect(fromYaml, `${name}.yaml does not match ${name}.json`).toEqual(fromJson);
        }
    });

    /**
     * `fetch_orders` was DECLARED as an MCP tool and, for two releases, was not servable as one:
     * `Order.window` is a discriminated union and `ApiJsonSchema` had no `oneOf`. That was recorded
     * here as a PROTOCOL limit, which it never was — MCP tool schemas are JSON Schema 2020-12, the
     * same dialect the OpenAPI document beside it already publishes the union in. #1009 removed our
     * own subset's limit, so the tool now renders and the catalog is COMMITTED.
     *
     * The committed catalog is the review device: `McpToolRegistry` reads exactly these bytes at
     * boot and agents are shown exactly this `tools/list`, so a diff here is a diff in a live
     * protocol surface.
     */
    it('gives fetch_orders an MCP schema, skipping nothing, and commits the catalog', () => {
        expect(golden.skippedMcpTools).toEqual([]);
        expect(golden.fresh.has('mcp-tools.json')).toBe(true);
        expect(golden.fresh.get('mcp-tools.json')).toBe(golden.committed('mcp-tools.json'));
    });

    /** The union itself, in the bytes an agent is served: `oneOf` + the DERIVED discriminator. */
    it('publishes Order.window as a discriminated oneOf, nested inside the response object', () => {
        // Read back through the runtime's own parser, which is what `McpToolRegistry` boots with —
        // so this asserts the bytes survive the round trip, not merely that they were written.
        const fetch = McpToolCatalog.fromJsonText(golden.committed('mcp-tools.json')).find(
            'fetch_orders',
        );
        expect(fetch).toBeDefined();
        const window = fetch!.outputSchema.properties!['orders'].items!.properties!['window'];
        expect(window.oneOf?.length).toBe(2);
        expect(window.discriminator).toEqual({
            propertyName: 'kind',
            mapping: { scheduled: 'ScheduledWindow', asap: 'AsapWindow' },
        });
        // NESTED, which is the legal half. A union at the ROOT of a tool schema is refused by the
        // OpenAI and Anthropic function-calling APIs and by the no-root-union-api-type build rule.
        expect(fetch!.inputSchema.oneOf).toBeUndefined();
        expect(fetch!.outputSchema.oneOf).toBeUndefined();
    });

    it('the hidden method is absent from the customer document by TYPE NAME, not only by path', () => {
        const published = golden.committed('public-openapi.json');
        const full = JSON.parse(golden.committed('full-private-openapi.json')) as Record<
            string,
            unknown
        >;
        const fullPaths = Object.keys(full['paths'] as object);
        const publishedPaths = Object.keys(
            (JSON.parse(published) as Record<string, unknown>)['paths'] as object,
        );
        expect(fullPaths.filter((each: string) => !publishedPaths.includes(each))).toEqual([
            '/orders/reindex',
        ]);
        // The check that matters: a test greping only for the path passes while every field of the
        // unreleased DTO is still published. Select-then-render makes this trivially true, which is
        // the point — it can only fail if the architecture regressed.
        for (const typeName of ['ReindexRequest', 'ReindexResponse']) {
            expect(published).not.toContain(typeName);
        }
        expect(published).not.toContain('operator tool');
    });
});
