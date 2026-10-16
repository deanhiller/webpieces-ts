import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenApiCli } from '../cli/OpenApiCli';
import { OpenApiGenerationError } from '../OpenApiGenerationError';

/**
 * Issue #1292: the description rules, each against REAL fixture contracts under `fixtures/docrules/`
 * read through the real extractor, and each over EVERY output a run writes — the OpenAPI documents,
 * their bundled siblings, `mcp-openapi.json` and the `mcp-<Contract>-tools.json` catalogs:
 *
 * 1. `@privateRemarks` (the tag and its text) is published NOWHERE.
 * 2. The success response's `description` is the method's `@returns`; a body-carrying operation
 *    without one is refused, naming every method — an MCP-only contract included.
 * 3. A published schema with no JSDoc description is refused, naming every type and its file.
 * 4. A tag's description is its non-webhook owner's JSDoc; two owners on one tag is refused; a
 *    webhook-only tag takes the first webhook contract's.
 */
class Harness {
    readonly fixtures = path.join(__dirname, 'fixtures', 'docrules');

    run(manifest: string): Map<string, string> {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-openapi-docrules-'));
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

    tagDescription(document: Record<string, unknown>, tag: string): unknown {
        const tags = document['tags'] as Record<string, unknown>[];
        return tags.find((each: Record<string, unknown>) => each['name'] === tag)?.['description'];
    }
}

const harness = new Harness();

describe('rule 1: @privateRemarks is never published (#1292)', () => {
    const written = harness.run('private-remarks.manifest.json');

    it('writes every document AND the MCP tool catalog for the fixture', () => {
        expect(Array.from(written.keys()).sort()).toEqual([
            'full-private-openapi.bundled.json',
            'full-private-openapi.json',
            'mcp-PrivateRemarksApi-tools.json',
            'mcp-openapi.json',
            'public-openapi.bundled.json',
            'public-openapi.json',
        ]);
    });

    it('drops the tag and its text from every file — OpenAPI, bundled, MCP document, MCP catalog', () => {
        for (const [fileName, text] of Array.from(written.entries())) {
            expect(text, fileName).not.toContain('SECRET-NOTE');
            expect(text, fileName).not.toContain('privateRemarks');
        }
    });

    it('keeps everything else in each block: the body, @returns and @mcp', () => {
        const doc = harness.json(written, 'public-openapi.json');
        const operation = harness.at(doc, 'paths', '/lamps/switch', 'post');
        expect(harness.at(operation, 'description')).toContain('Switches one lamp.');
        expect(harness.at(operation, 'responses', '200', 'description')).toBe(
            'The lamp after the switch.',
        );
        expect(harness.tagDescription(doc, 'Lamps')).toBe('Lamps in a room.');
        const schemas = harness.at(doc, 'components', 'schemas');
        expect(harness.at(schemas, 'BrightnessDto', 'description')).toBe('How bright a lamp is.');
        expect(harness.at(schemas, 'LampSwitchDto', 'description')).toBe(
            'Either way of switching a lamp.',
        );
        expect(harness.at(schemas, 'SwitchLampRequest', 'properties', 'lampId', 'description')).toBe(
            "The lamp's identifier.",
        );
        const mcp = harness.json(written, 'mcp-openapi.json');
        expect(harness.at(mcp, 'paths', '/lamps/switch', 'post', 'x-mcp-description')).toBe(
            'Switch exactly the lamp the user named.',
        );
    });
});

describe('rule 2: @returns is the success description, and a missing one fails (#1292)', () => {
    it('publishes @returns on the success response of every document, MCP included', () => {
        const written = harness.run('private-remarks.manifest.json');
        for (const fileName of ['full-private-openapi.json', 'public-openapi.json', 'mcp-openapi.json']) {
            const doc = harness.json(written, fileName);
            expect(
                harness.at(doc, 'paths', '/lamps/switch', 'post', 'responses', '200', 'description'),
                fileName,
            ).toBe('The lamp after the switch.');
        }
    });

    it("carries @returns into the MCP tool catalog as the outputSchema's description", () => {
        const written = harness.run('private-remarks.manifest.json');
        const tools = JSON.parse(written.get('mcp-PrivateRemarksApi-tools.json')!) as Record<
            string,
            unknown
        >[];
        expect(harness.at(tools[0], 'outputSchema', 'description')).toBe(
            'The lamp after the switch.',
        );
        expect(harness.at(tools[0], 'inputSchema', 'description')).toBe(
            'Which lamp to switch, and how.',
        );
    });

    it('REFUSES naming EVERY method without @returns in one run — the MCP-only contract too', () => {
        const failure = harness.failureOf('no-returns.manifest.json');
        expect(failure).toBeDefined();
        expect(failure!.message).toContain('have no @returns');
        expect(failure!.cure).toContain('@returns');
        const named = failure!.pointers.map((pointer: string) => pointer.split(' ')[0]).sort();
        expect(named).toEqual(['McpOnlyApi.ask', 'NoReturnsApi.read', 'NoReturnsApi.reread']);
    });

    it('does NOT demand @returns of a void method, which has no body to describe', () => {
        const failure = harness.failureOf('no-returns.manifest.json');
        expect(failure!.pointers.join('\n')).not.toContain('touch');
    });
});

describe('rule 3: a published schema with no description fails (#1292)', () => {
    it('REFUSES naming every undocumented class, enum and union alias, with its file', () => {
        const failure = harness.failureOf('undocumented.manifest.json');
        expect(failure).toBeDefined();
        expect(failure!.message).toContain('have no JSDoc description');
        const names = failure!.pointers.map((pointer: string) => pointer.split(' ')[0]).sort();
        // GuessRequest is reached ONLY by an MCP-only contract's tool: the MCP output is judged too.
        expect(names).toEqual(['GuessRequest', 'PaintDto', 'PaintRequest', 'ShadeDto']);
        for (const pointer of failure!.pointers) {
            expect(pointer).toMatch(/\.ts:\d+:\d+\)$/);
        }
    });
});

describe('rule 4: a tag is introduced by the contract that OWNS it (#1292)', () => {
    it('takes the non-webhook contract\'s JSDoc even when the webhook is listed first', () => {
        const doc = harness.json(harness.run('webhook-first.manifest.json'), 'full-private-openapi.json');
        expect(harness.tagDescription(doc, 'Orders')).toBe(
            'OWNER PROSE: the Orders section intro, from the API contract.',
        );
    });

    it('takes the FIRST webhook contract\'s JSDoc for a tag only webhooks carry', () => {
        const doc = harness.json(harness.run('webhook-only.manifest.json'), 'full-private-openapi.json');
        expect(harness.tagDescription(doc, 'Events')).toBe(
            'FIRST WEBHOOK PROSE: the events we send about orders.',
        );
    });

    it('REFUSES two non-webhook contracts on one tag, naming both', () => {
        const failure = harness.failureOf('two-owners.manifest.json');
        expect(failure).toBeDefined();
        expect(failure!.message).toContain('more than one non-webhook contract');
        expect(failure!.pointers).toHaveLength(1);
        expect(failure!.pointers[0]).toContain("tag 'Orders'");
        expect(failure!.pointers[0]).toContain('OrdersTagApi');
        expect(failure!.pointers[0]).toContain('SecondOrdersTagApi');
        expect(failure!.pointers[0]).not.toContain('OrdersWebhookApi');
    });
});
