import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenApiCli } from '../cli/OpenApiCli';
import { OpenApiGenerationError } from '../OpenApiGenerationError';

/**
 * Issue #1296: one short title per endpoint, from ONE source — the method's `@summary` JSDoc tag —
 * published as the OpenAPI operation `summary` and as the MCP tool's `title` AND `annotations.title`;
 * the API's one-line `summary` from the manifest as `info.summary`; and MCP tool names the Claude
 * Connectors Directory accepts. Each rule runs against REAL fixture contracts under
 * `fixtures/summary/`, read through the real extractor, over every output a run writes.
 */
class Harness {
    readonly fixtures = path.join(__dirname, 'fixtures', 'summary');

    run(manifest: string): Map<string, string> {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-openapi-summary-'));
        const result = new OpenApiCli().run(
            ['--manifest', manifest, '--out', out, '--format', 'json'],
            this.fixtures,
        );
        const written = new Map<string, string>();
        for (const file of result.written) {
            written.set(path.basename(file), fs.readFileSync(file, 'utf8'));
        }
        return written;
    }

    fixture(manifest: string): string {
        return path.join(this.fixtures, manifest);
    }

    /** The failure a run threw, or undefined when it did not throw. The catch IS the assertion. */
    failureOf(manifest: string): OpenApiGenerationError | undefined {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS what this method returns
        try {
            this.run(manifest);
            return undefined;
        } catch (err: unknown) {
            //const error = toError(err);
            return err instanceof OpenApiGenerationError ? err : undefined;
        }
    }

    /** A copy of the shelves manifest with `summary` replaced (or deleted, for `undefined`). */
    manifestWithSummary(summary: string | undefined): string {
        const manifest = JSON.parse(fs.readFileSync(this.fixture('shelves.manifest.json'), 'utf8')) as Record<
            string,
            unknown
        >;
        if (summary === undefined) {
            delete manifest['summary'];
        } else {
            manifest['summary'] = summary;
        }
        // Beside the fixture, not in a temp directory: the manifest's location decides the home
        // package whose schemas the document defines.
        const file = path.join(this.fixtures, `tmp-${process.pid}-${this.copies++}.manifest.json`);
        fs.writeFileSync(file, JSON.stringify(manifest));
        return file;
    }

    /** The failure of a run over a manifest copy, which is deleted afterwards either way. */
    failureOfCopy(file: string): OpenApiGenerationError | undefined {
        const failure = this.failureOf(file);
        fs.rmSync(file, { force: true });
        return failure;
    }

    private copies = 0;

    json(written: Map<string, string>, fileName: string): Record<string, unknown> {
        const text = written.get(fileName);
        expect(text, `nothing written at ${fileName}`).toBeDefined();
        return JSON.parse(text!) as Record<string, unknown>;
    }

    /** One value by path; each step is a key, so a key containing '/' or '.' is one step. */
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
const DOCUMENTS = ['full-private-openapi.json', 'public-openapi.json', 'mcp-openapi.json'];

describe('@summary is the short title, everywhere it is published (#1296)', () => {
    const written = harness.run(harness.fixture('shelves.manifest.json'));

    it('publishes it as the operation summary of every document, and keeps it OUT of the description', () => {
        for (const fileName of [...DOCUMENTS, 'public-openapi.bundled.json']) {
            const operation = harness.at(harness.json(written, fileName), 'paths', '/shelves/read', 'post');
            expect(harness.at(operation, 'summary'), fileName).toBe('Read a shelf');
            expect(harness.at(operation, 'operationId'), fileName).toBe('ShelvesApi_read');
            const description = String(harness.at(operation, 'description'));
            expect(description, fileName).toContain('Reads one shelf, left to right.');
            expect(description, fileName).toContain('Empty shelves are returned');
            expect(description, fileName).not.toContain('Read a shelf');
            expect(description, fileName).not.toContain('summary');
        }
    });

    it('stamps it on the MCP document as the tool title AND the annotations title', () => {
        const operation = harness.at(harness.json(written, 'mcp-openapi.json'), 'paths', '/shelves/read', 'post');
        expect(harness.at(operation, 'x-mcp-title')).toBe('Read a shelf');
        expect(harness.at(operation, 'x-mcp-hints', 'title')).toBe('Read a shelf');
        const published = harness.at(harness.json(written, 'public-openapi.json'), 'paths', '/shelves/read', 'post');
        expect(harness.at(published, 'x-mcp-title')).toBeUndefined();
    });

    it('writes it into the MCP tool catalog as the title the server serves', () => {
        const tools = JSON.parse(written.get('mcp-ShelvesApi-tools.json')!) as Record<string, unknown>[];
        expect(tools.map((tool: Record<string, unknown>) => [tool['name'], tool['title']])).toEqual([
            ['read_shelf', 'Read a shelf'],
        ]);
        expect(String(tools[0]['description'])).not.toContain('Read a shelf');
    });

    it("publishes the manifest's summary as info.summary, beside the manifest's title", () => {
        for (const fileName of DOCUMENTS) {
            const info = harness.at(harness.json(written, fileName), 'info');
            expect(harness.at(info, 'title'), fileName).toBe('Shelves API');
            expect(harness.at(info, 'summary'), fileName).toBe('Read the books on a shelf, left to right.');
        }
    });
});

describe('a missing or unusable @summary refuses generation (#1296)', () => {
    const failure = harness.failureOf(harness.fixture('unsummarized.manifest.json'));

    it('names EVERY offender in one run — missing, multi-line, over-long, routes and webhooks alike', () => {
        expect(failure, 'the run published operations with no summary').toBeDefined();
        expect(failure!.message).toMatch(/4 published operation\(s\) have no usable @summary/);
        const file = (name: string): string => path.join(harness.fixtures, name);
        expect([...failure!.pointers].sort()).toEqual(
            [
                `UnsummarizedApi.open has no @summary (${file('UnsummarizedApi.ts')})`,
                `UnsummarizedApi.seal @summary spans more than one line (${file('UnsummarizedApi.ts')})`,
                `UnsummarizedApi.weigh @summary is 102 characters, over the 100-character limit (${file('UnsummarizedApi.ts')})`,
                `UnsummarizedWebhookApi.crateShipped has no @summary (${file('UnsummarizedWebhookApi.ts')})`,
            ].sort(),
        );
        expect(failure!.pointers.join('\n')).not.toContain('UnsummarizedApi.count');
    });

    it('prints the cure: the JSDoc line to write, and where it is published', () => {
        expect(failure!.cure).toContain('`@summary <short title>`');
        expect(failure!.cure).toMatch(/at most 100 characters/);
        expect(failure!.cure).toMatch(/MCP tool title and annotations\.title/);
    });
});

describe("the manifest's summary is REQUIRED, one line, at most 200 characters (#1296)", () => {
    it.each([
        ['missing', undefined, /'summary' is missing/],
        ['empty', '   ', /'summary' is not a non-empty string/],
        ['multi-line', 'Read shelves.\nAnd more.', /'summary' spans more than one line/],
        ['over-long', 'x'.repeat(201), /'summary' is 201 characters, over the 200-character limit/],
    ])('refuses a %s summary, naming the key and the cure', (_label: string, summary: string | undefined, why: RegExp) => {
        const failure = harness.failureOfCopy(harness.manifestWithSummary(summary));
        expect(failure, 'the manifest was accepted').toBeDefined();
        expect(failure!.message).toMatch(why);
        expect(failure!.cure).toMatch(/info\.summary/);
    });

    it('accepts exactly 200 characters', () => {
        expect(harness.failureOfCopy(harness.manifestWithSummary('x'.repeat(200)))).toBeUndefined();
    });
});

describe('MCP tool names the Claude Connectors Directory would refuse fail generation (#1296)', () => {
    it('names EVERY offending tool in one run, with why and where', () => {
        const failure = harness.failureOf(harness.fixture('long-tool-name.manifest.json'));
        expect(failure, 'the run published an illegal tool name').toBeDefined();
        expect(failure!.message).toMatch(/2 MCP tool name\(s\) would be refused by the Claude Connectors Directory/);
        const file = path.join(harness.fixtures, 'LongToolNameApi.ts');
        expect([...failure!.pointers].sort()).toEqual(
            [
                `LongToolNameApi.measure: tool name 'measure_one_barrel_in_the_cellar_and_report_its_level_in_litres_now' is 67 characters, over the 64-character limit (${file})`,
                `LongToolNameApi.tap: tool name 'barrels.tap' uses a character outside A-Z a-z 0-9 _ - (${file})`,
            ].sort(),
        );
        expect(failure!.cure).toMatch(/1-64 characters of A-Z a-z 0-9 _ -/);
    });
});
