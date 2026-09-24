import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpToolCatalogFile } from '@webpieces/core-util';
import { OpenApiCli, YamlReader } from '@webpieces/openapi-generator';

/**
 * REGENERATE this contract's OpenAPI documents and diff them against the GOLDENS beside this spec.
 *
 * ## These are test fixtures, not the published documents
 *
 * An app's generated documents are BUILD OUTPUT: `openapi-generate` writes them into the project's
 * `build` target's `outputPath` and they ship inside its npm package, never committed (#986, #1021).
 * A consuming repo commits nothing generated — it trusts the generator. webpieces is the one place
 * that must PROVE the generator still works, so this spec pins its output against expected bytes, exactly as any unit test
 * pins its expected output. `src/__tests__/goldens/` holds those bytes and nothing else reads them.
 *
 * ## Why a golden and not a set of assertions about the document
 *
 * Assertions only fail for the things somebody thought to assert. What this test has to catch is a
 * change nobody predicted in what the GENERATOR emits for an ordinary-looking contract: a decorator
 * gains an argument, a JSDoc sentence is reworded, a DTO field turns optional — and the output moves.
 * (Whether a CONTRACT change moved what partners see is read off the contract source's own diff in
 * review, not this spec's job: nothing generated is committed or compared, #1021.)
 *
 * ## Why only the JSON is pinned
 *
 * Pinning the YAML too would double the golden for a file that is the first one restated. Instead the
 * run below asks for BOTH formats and one test parses each YAML and asserts deep equality with its
 * JSON counterpart — which proves the YAML is right without keeping a second copy.
 *
 * ## The cure, when it goes red
 *
 * If the change to the generator's output is intended, regenerate the goldens exactly as the failure
 * message says, and READ the diff: it is what the generator now emits differently.
 */
const PROJECT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(PROJECT, 'openapi.manifest.json');
const GOLDENS = path.join(__dirname, 'goldens');

/** The documents this contract set produces, by the `@ApiType`s it declares. */
const DOCUMENTS = ['full-private-openapi', 'public-openapi', 'mcp-openapi'];

/**
 * The MCP tool catalog: ONE FILE PER CONTRACT (#1021). Only `PartnerOrdersApi` declares `MCP`, so it is
 * the only one — `PartnerDeliveryWebhookApi` is a partner contract with no agent tools.
 */
const MCP_CATALOG = 'mcp-PartnerOrdersApi-tools.json';

const REGENERATE = [
    'If the new output is intended, regenerate the goldens:',
    '  node -r @swc-node/register -r tsconfig-paths/register \\',
    '    packages/docs/openapi-generator/src/cli/wp-openapi.ts \\',
    '    --manifest apps/app-example/partner-api/openapi.manifest.json \\',
    '    --out apps/app-example/partner-api/src/__tests__/goldens --format json',
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

    golden(fileName: string): string {
        const file = path.join(GOLDENS, fileName);
        expect(fs.existsSync(file), `${fileName} has no golden.\n${REGENERATE}`).toBe(true);
        return fs.readFileSync(file, 'utf8');
    }
}

const golden = new Golden();

beforeAll(() => {
    golden.generate();
});

describe('the OpenAPI documents generated from the example contract', () => {
    it.each(DOCUMENTS.map((name: string) => [`${name}.json`]))(
        '%s matches what the generator produces today',
        (fileName: string) => {
            expect(
                golden.fresh.get(fileName),
                `${fileName} no longer matches its golden.\n${REGENERATE}`,
            ).toBe(golden.golden(fileName));
        },
    );

    it('writes NOTHING that has no golden — a new document is a review decision', () => {
        const json = Array.from(golden.fresh.keys())
            .filter((name: string) => name.endsWith('.json'))
            .sort();
        // The per-contract MCP catalog is not a DOCUMENT — it is the RUNTIME catalog, not serialized
        // by --format — but it is pinned exactly like one.
        expect(json).toEqual(
            [...DOCUMENTS.map((name: string) => `${name}.json`), MCP_CATALOG].sort(),
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
     * own subset's limit, so the tool now renders and the catalog is written.
     *
     * The catalog golden matters because `McpToolRegistry` reads exactly these bytes at boot and
     * agents are shown exactly this `tools/list`, so a moved byte here is a moved live protocol
     * surface.
     */
    it('gives fetch_orders an MCP schema, skipping nothing, and writes the catalog', () => {
        expect(golden.skippedMcpTools).toEqual([]);
        expect(golden.fresh.has(MCP_CATALOG)).toBe(true);
        expect(golden.fresh.get(MCP_CATALOG)).toBe(golden.golden(MCP_CATALOG));
    });

    /** The union itself, in the bytes an agent is served: `oneOf` + the DERIVED discriminator. */
    it('publishes Order.window as a discriminated oneOf, nested inside the response object', () => {
        // Read back through the runtime's own parser, which is what `McpToolRegistry` boots with —
        // so this asserts the bytes survive the round trip, not merely that they were written.
        const fetch = McpToolCatalogFile.fromJsonText(MCP_CATALOG, golden.golden(MCP_CATALOG)).find(
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
        const published = golden.golden('public-openapi.json');
        const full = JSON.parse(golden.golden('full-private-openapi.json')) as Record<
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
