import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

    generate(): void {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-openapi-'));
        const result = new OpenApiCli().run(
            ['--manifest', MANIFEST, '--out', out, '--format', 'both'],
            PROJECT,
        );
        for (const file of result.written) {
            this.fresh.set(path.basename(file), fs.readFileSync(file, 'utf8'));
        }
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
        expect(json).toEqual(DOCUMENTS.map((name: string) => `${name}.json`).sort());
    });

    it('the YAML parses back to the SAME document as its JSON counterpart', () => {
        const reader = new YamlReader();
        for (const name of DOCUMENTS) {
            const fromJson: unknown = JSON.parse(golden.fresh.get(`${name}.json`)!);
            const fromYaml: unknown = reader.read(golden.fresh.get(`${name}.yaml`)!);
            expect(fromYaml, `${name}.yaml does not match ${name}.json`).toEqual(fromJson);
        }
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
