import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonObject, JsonValue } from '../json/JsonObject';
import { OpenApiCli } from '../cli/OpenApiCli';
import { OpenApiGenerationError } from '../OpenApiGenerationError';
import { WpOpenApiMain } from '../cli/WpOpenApiMain';
import { YamlReader } from '../json/YamlReader';

/**
 * The matrix issues #982 and #1002 enumerate, one `it` per row, asserted against REAL fixture
 * contracts read through the real extractor — never against a hand-built model. What this package has
 * to survive is a document rendered from source somebody actually wrote.
 *
 * Every test goes through {@link OpenApiCli}, which is the whole command minus the process, so the
 * argument parsing, the manifest read, the extraction, the render and both serializations are covered
 * by the same assertions rather than by a layer of unit tests that never meet.
 */
class Harness {
    readonly fixtures = path.join(__dirname, 'fixtures');

    /** Run the CLI into a throwaway directory and return what it wrote, by file name. */
    run(manifest: string, ...extra: readonly string[]): Map<string, string> {
        const out = this.temporaryDirectory();
        const result = new OpenApiCli().run(
            ['--manifest', path.join(this.fixtures, manifest), '--out', out, ...extra],
            this.fixtures,
        );
        const written = new Map<string, string>();
        for (const file of result.written) {
            written.set(path.basename(file), fs.readFileSync(file, 'utf8'));
        }
        return written;
    }

    temporaryDirectory(): string {
        return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-openapi-'));
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

    document(written: Map<string, string>, fileName: string): Record<string, unknown> {
        const text = written.get(fileName);
        expect(text, `nothing written at ${fileName}`).toBeDefined();
        return JSON.parse(text!) as Record<string, unknown>;
    }

    /** One value out of a parsed document by dotted path, so no test needs a cast. */
    at(document: Record<string, unknown>, dotted: string): unknown {
        let current: unknown = document;
        for (const step of dotted.split('.')) {
            if (typeof current !== 'object' || current === null) {
                return undefined;
            }
            current = (current as Record<string, unknown>)[step];
        }
        return current;
    }

    /**
     * One webhook's operation. It gets its own accessor because an EVENT NAME contains dots
     * (`widget.made`) and the dotted-path reader would split it into two steps — which is itself
     * worth pinning, since a dotted event name is the normal spelling.
     */
    webhook(document: Record<string, unknown>, event: string): Record<string, unknown> {
        const webhooks = document['webhooks'] as Record<string, unknown> | undefined;
        const item = webhooks?.[event] as Record<string, unknown> | undefined;
        expect(item, `no webhook '${event}'`).toBeDefined();
        return item!['post'] as Record<string, unknown>;
    }
}

const harness = new Harness();

/** A `process.stdout` stand-in, so the bin's own output is asserted rather than printed. */
class Sink {
    readonly lines: string[] = [];

    asStream(): NodeJS.WriteStream {
        const sink = this;
        return {
            write: (text: string): boolean => {
                sink.lines.push(text);
                return true;
            },
        } as NodeJS.WriteStream;
    }

    text(): string {
        return this.lines.join('');
    }
}

describe('which documents are written', () => {
    it('writes one per @ApiType some contract declares, in both formats by default', () => {
        expect(Array.from(harness.run('single.manifest.json').keys()).sort()).toEqual([
            'full-private-openapi.json',
            'full-private-openapi.yaml',
            // NOT a document: the runtime catalog WpMcpServer boots from — ONE PER CONTRACT, named
            // after it — so --format never applies to it and there is no .yaml twin.
            'mcp-WidgetsApi-tools.json',
            'mcp-openapi.json',
            'mcp-openapi.yaml',
            'public-openapi.json',
            'public-openapi.yaml',
        ]);
    });

    it('writes ONLY the internal document when no contract declares anything else', () => {
        // The fail-closed default, from the other side: a document nobody asked for is not written
        // empty, it is not written. There is no second "is it empty?" rule to keep in step with this.
        expect(Array.from(harness.run('internal-only.manifest.json').keys()).sort()).toEqual([
            'full-private-openapi.json',
            'full-private-openapi.yaml',
        ]);
    });

    it('--format chooses the SERIALIZATION and nothing else', () => {
        expect(
            Array.from(harness.run('mixed.manifest.json', '--format', 'json').keys()).sort(),
        ).toEqual(['full-private-openapi.json', 'public-openapi.json']);
        expect(
            Array.from(harness.run('mixed.manifest.json', '--format', 'yaml').keys()).sort(),
        ).toEqual(['full-private-openapi.yaml', 'public-openapi.yaml']);
    });

    it('REFUSES an unknown --format rather than silently writing the default', () => {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the refusal IS the assertion
        expect(() => harness.run('mixed.manifest.json', '--format', 'xml')).toThrow(
            /unknown --format 'xml'/,
        );
    });

    it('declares OpenAPI 3.1.0, because that is what the model can state honestly', () => {
        const published = harness.document(
            harness.run('single.manifest.json'),
            'public-openapi.json',
        );
        expect(published['openapi']).toBe('3.1.0');
        // 3.1's spelling of nullable. 3.0's `nullable: true` is not JSON Schema at all.
        expect(harness.at(published, 'components.schemas.Widget.properties.label.type')).toEqual([
            'string',
            'null',
        ]);
        // OPTIONAL is a different fact, recorded by ABSENCE from `required`.
        expect(
            harness.at(published, 'components.schemas.ListWidgetsRequest.required'),
        ).toBeUndefined();
    });
});

describe('hidden methods', () => {
    it('are ABSENT from the customer document — no path, no schema, no prose', () => {
        const written = harness.run('single.manifest.json');
        const published = harness.document(written, 'public-openapi.json');
        const full = harness.document(written, 'full-private-openapi.json');

        expect(harness.at(full, 'paths./widgets/purge')).toBeDefined();
        expect(harness.at(published, 'paths./widgets/purge')).toBeUndefined();

        // The TYPE NAMES, not merely the path: a test that greps for the path passes while every
        // field of the unreleased DTO is still published. Select-then-render is what makes this
        // trivially true — an unselected operation's schemas are never constructed at all.
        for (const typeName of ['PurgeRequest', 'PurgeResponse']) {
            expect(harness.at(published, `components.schemas.${typeName}`)).toBeUndefined();
            expect(written.get('public-openapi.json')).not.toContain(typeName);
        }
        expect(written.get('public-openapi.json')).not.toContain('operator tool');
        // Nothing announces that something was withheld; an extension saying so would defeat it.
        expect(written.get('public-openapi.json')).not.toContain('hidden');
    });

    it('stay in the private document, which is where the diff that reviews them comes from', () => {
        const written = harness.run('single.manifest.json');
        expect(
            harness.at(
                harness.document(written, 'full-private-openapi.json'),
                'paths./widgets/purge',
            ),
        ).toBeDefined();
        // `purge` is not a tool, so it is not in the MCP document — but being hidden is not what
        // would have excluded it.
        expect(
            harness.at(harness.document(written, 'mcp-openapi.json'), 'paths./widgets/list'),
        ).toBeDefined();
    });

    it('the INTERNAL document is the only one carrying the internal-use-only line', () => {
        const written = harness.run('single.manifest.json');
        const internalLine = 'INTERNAL — service-to-service use only';
        expect(
            harness.at(harness.document(written, 'full-private-openapi.json'), 'info.description'),
        ).toContain(internalLine);
        for (const other of ['public-openapi.json', 'mcp-openapi.json']) {
            expect(harness.at(harness.document(written, other), 'info.description')).not.toContain(
                internalLine,
            );
        }
    });
});

describe('derived security', () => {
    it('DERIVES the schemes from @WpAuthApiKey, keyed by the manifest names in order', () => {
        const published = harness.document(
            harness.run('single.manifest.json'),
            'public-openapi.json',
        );
        expect(harness.at(published, 'components.securitySchemes.WidgetKey')).toEqual({
            type: 'apiKey',
            in: 'header',
            name: 'x-api-key',
            description: 'Your key.',
        });
        // `bearer` is a STRUCTURALLY different document — `type: http`, and no header name, because
        // its location IS `Authorization` and a name there would be a lie.
        expect(harness.at(published, 'components.securitySchemes.WidgetOrg')).toEqual({
            type: 'http',
            scheme: 'bearer',
            description: 'The organization token.',
        });
    });

    it('HOISTS ONE AND-ed requirement when every operation is covered', () => {
        const published = harness.document(
            harness.run('single.manifest.json'),
            'public-openapi.json',
        );
        // ONE object holding BOTH keys is an AND. A list of one-key objects would mean OR — "either
        // header alone suffices" — which no build could contradict.
        expect(published['security']).toEqual([{ WidgetKey: [], WidgetOrg: [] }]);
        expect(harness.at(published, 'paths./widgets/list.post.security')).toBeUndefined();
    });

    it('STAMPS it per operation when the document mixes credentialled and uncredentialled routes', () => {
        const published = harness.document(
            harness.run('mixed.manifest.json'),
            'public-openapi.json',
        );
        expect(published['security']).toBeUndefined();
        expect(harness.at(published, 'paths./mixed/secret.post.security')).toEqual([
            { MixedKey: [] },
        ]);
        // Hoisting here would have told a customer that the PUBLIC endpoint needs a key. The public
        // one says "no credential required" OUT LOUD — `security: []` — rather than leaving the key
        // off, which would mean "inherit the document's" and only coincides today.
        expect(harness.at(published, 'paths./mixed/ping.post.security')).toEqual([]);
    });

    it('REFUSES a scheme-name list that does not match the declared credentials', () => {
        const failure = harness.failureOf('mismatched-schemes.manifest.json');
        expect(failure, 'a mismatched scheme list was accepted').toBeDefined();
        expect(failure!.message).toMatch(
            /securitySchemeNames has 1 name\(s\) but the 'partner' regime declares 2/,
        );
    });
});

describe('the webhook block', () => {
    it('lands under top-level `webhooks`, keyed by the EVENT NAME with no @ApiPath base', () => {
        const published = harness.document(
            harness.run('single.manifest.json'),
            'public-openapi.json',
        );
        // There is no url of OURS: the partner hosts it, at whatever path they choose.
        expect(Object.keys(published['webhooks'] as object)).toEqual(['widget.made']);
        expect(harness.at(published, 'paths./hooks/widget.made')).toBeUndefined();
    });

    it('carries x-webpieces-webhook and no trigger or auth extension of any kind', () => {
        const published = harness.document(
            harness.run('single.manifest.json'),
            'public-openapi.json',
        );
        const operation = harness.webhook(published, 'widget.made');
        expect(operation['x-webpieces-webhook']).toBe(true);
        expect(operation['x-webpieces-trigger']).toBeUndefined();
        expect(operation['x-webpieces-auth']).toBeUndefined();
    });

    it('documents a `void` method as "return any 2xx to acknowledge"', () => {
        const published = harness.document(
            harness.run('single.manifest.json'),
            'public-openapi.json',
        );
        const success = harness.at(
            harness.webhook(published, 'widget.made'),
            'responses.200',
        ) as Record<string, unknown>;
        expect(success['description']).toMatch(/2xx to acknowledge/);
        expect(success['content']).toBeUndefined();
    });

    it('contributes NOTHING to the derived security requirement, and takes none of OUR envelope', () => {
        const published = harness.document(
            harness.run('single.manifest.json'),
            'public-openapi.json',
        );
        const operation = harness.webhook(published, 'widget.made');
        // Our api key must never be published as a guard on a partner's own server, and our failure
        // envelope and our response header are facts about OUR server, not theirs.
        expect(operation['security']).toBeUndefined();
        expect(operation['responses']).not.toHaveProperty('400');
        expect(harness.at(operation, 'responses.200.headers')).toBeUndefined();
    });
});

describe('the document-wide error contract', () => {
    it('adds the declared statuses to every served operation, with the body read from a TS type', () => {
        const published = harness.document(
            harness.run('single.manifest.json'),
            'public-openapi.json',
        );
        expect(harness.at(published, 'paths./widgets/list.post.responses.400.description')).toBe(
            'The request failed validation.',
        );
        expect(
            harness.at(
                published,
                'paths./widgets/list.post.responses.400.content.application/json.schema.$ref',
            ),
        ).toBe('#/components/schemas/ApiError');
        // The SHAPE came from the compiler, not from a schema hand-written in the manifest.
        expect(harness.at(published, 'components.schemas.ApiError.properties.code.type')).toBe(
            'string',
        );
    });
});

describe('the folded response header', () => {
    it('folds `nameConstant` to the real header name and hangs it off every success response', () => {
        const published = harness.document(
            harness.run('single.manifest.json'),
            'public-openapi.json',
        );
        // The manifest named TRACE_HEADER, never the string. A literal there would be a copy a
        // rename leaves silently stale, in a file no compiler reads.
        expect(harness.at(published, 'components.headers.x-trace-id.schema.type')).toBe('string');
        expect(
            harness.at(published, 'paths./widgets/list.post.responses.200.headers.x-trace-id.$ref'),
        ).toBe('#/components/headers/x-trace-id');
    });
});

describe('prose', () => {
    it('makes `summary` the operation NAME and the JSDoc body the `description`', () => {
        const published = harness.document(
            harness.run('single.manifest.json'),
            'public-openapi.json',
        );
        // A docs theme TITLES the page from `summary`; a sentence there produces a sidebar of
        // sentences and a page whose heading repeats its own first line.
        expect(harness.at(published, 'paths./widgets/list.post.summary')).toBe('list');
        expect(harness.at(published, 'paths./widgets/list.post.description')).toContain(
            'Lists widgets.',
        );
    });

    it('appends the DERIVED retry sentence, and publishes the rule it comes from once', () => {
        const written = harness.run('single.manifest.json');
        const published = harness.document(written, 'public-openapi.json');
        // A read is safe to retry; a write is not. The sentence is prose and not an `x-` extension
        // because Swagger UI and most themes do not render extensions at all.
        expect(harness.at(published, 'paths./widgets/list.post.description')).toContain(
            'Safe to retry',
        );
        expect(
            harness.at(
                harness.document(written, 'full-private-openapi.json'),
                'paths./widgets/purge.post.description',
            ),
        ).toContain('NOT safe to retry');
        // WHAT FIRES an endpoint is internal: a customer calls what they are given a url for.
        expect(
            harness.at(
                harness.document(written, 'full-private-openapi.json'),
                'paths./widgets/list.post.description',
            ),
        ).toContain('Triggered by a direct call.');
        expect(harness.at(published, 'paths./widgets/list.post.description')).not.toContain(
            'Triggered by',
        );
        // The mapping itself is stated ONCE, so the rule is published and not only its consequences.
        expect(harness.at(published, 'info.description')).toContain('| write-idempotent |');
    });

    it('puts the `x-mcp-*` extensions in the MCP document only', () => {
        const written = harness.run('single.manifest.json');
        const mcp = harness.document(written, 'mcp-openapi.json');
        const published = harness.document(written, 'public-openapi.json');
        expect(harness.at(mcp, 'paths./widgets/list.post.x-mcp-tool')).toBe('list_widgets');
        // The three side-effect hints are COMPUTED from `operation` by core-util's own mapping; only
        // `openWorldHint` is declared, and it defaults false.
        expect(harness.at(mcp, 'paths./widgets/list.post.x-mcp-hints')).toEqual({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        });
        expect(harness.at(mcp, 'paths./widgets/list.post.x-mcp-description')).toMatch(/Read-only/);
        expect(harness.at(mcp, 'paths./widgets/list.post.x-mcp-auth')).toContain('agent');
        // A published document says what a customer must send; our agent-side roles are not that.
        expect(harness.at(published, 'paths./widgets/list.post.x-mcp-tool')).toBeUndefined();
    });

    it('gives the agent the SAME description the human reads, byte for byte', () => {
        const written = harness.run('single.manifest.json');
        const mcp = harness.document(written, 'mcp-openapi.json');
        const published = harness.document(written, 'public-openapi.json');
        // `@WpMcpTool`'s `description` field is never read: two authored copies of one paragraph
        // drift the first time somebody edits one.
        expect(harness.at(mcp, 'paths./widgets/list.post.description')).toBe(
            harness.at(published, 'paths./widgets/list.post.description'),
        );
        expect(harness.at(mcp, 'paths./widgets/list.post.description')).not.toContain(
            'List widgets.',
        );
    });
});

describe('the unmapped-type guard', () => {
    it('REFUSES rather than publishing a field with no shape, and names its JSON pointer', () => {
        const failure = harness.failureOf('unmapped.manifest.json');
        expect(failure, 'an unmapped field was published').toBeDefined();
        expect(failure!.message).toMatch(/have no schema it can state/);
        expect(failure!.pointers.join('\n')).toContain(
            '#/components/schemas/SendRequest/properties/payload',
        );
        expect(failure!.cure).toMatch(/named DTO/);
    });

    it('EXITS NON-ZERO through the bin, printing every pointer, and writes NOTHING', () => {
        const sink = new Sink();
        const out = harness.temporaryDirectory();
        const code = new WpOpenApiMain().run(
            ['--manifest', path.join(harness.fixtures, 'unmapped.manifest.json'), '--out', out],
            harness.fixtures,
            sink.asStream(),
        );
        expect(code).toBe(1);
        expect(sink.text()).toContain('#/components/schemas/SendRequest/properties/payload');
        // A refused document is not half-written.
        expect(fs.readdirSync(out)).toEqual([]);
    });

    it('EXITS ZERO and names every file it wrote on the happy path', () => {
        const sink = new Sink();
        const out = harness.temporaryDirectory();
        const code = new WpOpenApiMain().run(
            [
                '--manifest',
                path.join(harness.fixtures, 'single.manifest.json'),
                '--out',
                out,
                '--format',
                'json',
            ],
            harness.fixtures,
            sink.asStream(),
        );
        expect(code).toBe(0);
        expect(sink.text()).toContain('full-private-openapi.json');
        expect(fs.readdirSync(out).sort()).toEqual([
            'full-private-openapi.json',
            'mcp-WidgetsApi-tools.json',
            'mcp-openapi.json',
            'public-openapi.json',
        ]);
    });
});

describe('the YAML is the SAME document as the JSON', () => {
    it('parses back to a deep-equal value, for every document written', () => {
        const written = harness.run('single.manifest.json');
        const reader = new YamlReader();
        for (const name of ['full-private-openapi', 'public-openapi', 'mcp-openapi']) {
            const fromJson: unknown = JSON.parse(written.get(`${name}.json`)!);
            const fromYaml: unknown = reader.read(written.get(`${name}.yaml`)!);
            expect(fromYaml, `${name}.yaml does not match ${name}.json`).toEqual(fromJson);
        }
    });
});

describe('the JsonObject the documents are built from', () => {
    it('omits an `undefined` value and keeps INSERTION order, which is what makes a golden stable', () => {
        const nulled: JsonValue = null;
        const object = new JsonObject()
            .set('b', 1)
            .set('missing', undefined)
            .set('a', 2)
            .set('nulled', nulled);
        expect(object.keys()).toEqual(['b', 'a', 'nulled']);
    });
});
