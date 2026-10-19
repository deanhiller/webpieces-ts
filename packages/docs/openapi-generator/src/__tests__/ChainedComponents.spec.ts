import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { Validator } from '@seriousme/openapi-schema-validator';
import { OpenApiCli } from '../cli/OpenApiCli';
import { OpenApiGenerationError } from '../OpenApiGenerationError';
import { ComponentsLocator } from '../load/ComponentsLocator';

/**
 * CHAINED generation (#1058), end to end through the real CLI, against `fixtures/chain/` — a
 * miniature monorepo copied into a temporary nx workspace:
 *
 * | library | publishes | reaches |
 * |---|---|---|
 * | `dtos-b` | `components.openapi.json` | nothing — the bottom of the chain |
 * | `dtos-a` | `components.openapi.json` | `dtos-b`: its document `$ref`s into B's |
 * | `lang-apis` | contract documents + MCP catalog | `dtos-a`, `dtos-b`, and its OWN `LocalizedDescriptionsDto` |
 * | `fsdb-api` | contract documents + MCP catalog | `dtos-a`, and its OWN `LocalizedDescriptionsDto` |
 * | `company-core` | nothing (no components target) | — |
 * | `settings-api` | — | `company-core`'s `AiProvider`: the fail-closed refusal |
 * | `agent-api` | MCP only | `company-core`'s `AiProvider`: MCP requires no components document |
 * | `dup-api` | — | two `DupDto`s in ONE package: still an error |
 *
 * `package.fixture.json` / `project.fixture.json` are renamed in the copy: under their real names nx
 * and pnpm would read them as projects of THIS workspace. The documents are read back from each
 * library's build `outputPath` — the source-directory half of the same lookup
 * `McpToolCatalog.fromPackages` uses — and every one is checked with an OpenAPI 3.1 validator.
 *
 * Goldens live in `goldens/chain/`. To regenerate after an INTENDED change, run this spec with
 * `WP_UPDATE_CHAIN_GOLDENS=1` and read the diff.
 */
const FIXTURE = path.join(__dirname, 'fixtures', 'chain');
const GOLDENS = path.join(__dirname, 'goldens', 'chain');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const UPDATE = process.env['WP_UPDATE_CHAIN_GOLDENS'] === '1';
const FIXTURE_PACKAGES = ['dtos-a', 'dtos-b', 'company-core'];

/** A parsed JSON document, for assertions. */
type Json = Record<string, unknown>;

class ChainWorkspace {
    readonly root: string;

    constructor() {
        this.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-chain-')));
        this.copy(path.join(FIXTURE, 'libs'), path.join(this.root, 'libs'));
        fs.writeFileSync(path.join(this.root, 'nx.json'), '{}\n');
        fs.writeFileSync(path.join(this.root, 'tsconfig.json'), this.tsconfig());
    }

    /** Run `wp-openapi` for one library into its build outputPath; returns what it wrote. */
    generate(library: string, format = 'json'): Map<string, string> {
        const out = this.outDir(library);
        const result = new OpenApiCli().run(
            ['--manifest', this.manifest(library), '--out', out, '--format', format],
            this.root,
        );
        const written = new Map<string, string>();
        for (const file of result.written) {
            written.set(path.basename(file), fs.readFileSync(file, 'utf8'));
        }
        return written;
    }

    /** The failure one library's run threw. The catch IS the assertion. */
    failureOf(library: string, format = 'json'): OpenApiGenerationError {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS what this method returns
        try {
            this.generate(library, format);
        } catch (err: unknown) {
            //const error = toError(err);
            if (err instanceof OpenApiGenerationError) return err;
            throw err;
        }
        throw new Error(`${library} generated without refusing`);
    }

    outDir(library: string): string {
        return path.join(this.root, 'dist', 'libs', library);
    }

    manifest(library: string): string {
        return path.join(this.root, 'libs', library, 'openapi.manifest.json');
    }

    read(library: string, fileName: string): string {
        return fs.readFileSync(path.join(this.outDir(library), fileName), 'utf8');
    }

    /** Rename identifiers only: import paths, published prose, and enum values remain untouched. */
    renameTypes(rename: (name: string) => string): void {
        const libs = path.join(this.root, 'libs');
        const files = fs
            .readdirSync(libs, { recursive: true })
            .map(String)
            .filter((file: string) => file.endsWith('.ts'));
        const names = new Set<string>();
        for (const file of files) {
            const source = ts.createSourceFile(
                file,
                fs.readFileSync(path.join(libs, file), 'utf8'),
                ts.ScriptTarget.Latest,
                true,
            );
            for (const node of source.statements) {
                if (
                    (ts.isInterfaceDeclaration(node) ||
                        ts.isTypeAliasDeclaration(node) ||
                        ts.isEnumDeclaration(node) ||
                        ts.isClassDeclaration(node)) &&
                    node.name !== undefined &&
                    !node.name.text.endsWith('Api')
                )
                    names.add(node.name.text);
            }
        }
        for (const file of files) {
            const full = path.join(libs, file);
            let text = fs.readFileSync(full, 'utf8');
            const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
            const edits: ts.Identifier[] = [];
            const visit = (node: ts.Node): void => {
                if (ts.isIdentifier(node) && names.has(node.text)) edits.push(node);
                ts.forEachChild(node, visit);
            };
            visit(source);
            for (const node of edits.sort(
                (a: ts.Identifier, b: ts.Identifier) => b.getStart(source) - a.getStart(source),
            )) {
                text =
                    text.slice(0, node.getStart(source)) + rename(node.text) + text.slice(node.end);
            }
            fs.writeFileSync(full, text);
        }
    }

    stripSuffixes(library: string): void {
        const manifest = this.manifest(library);
        const raw = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Json;
        raw['schemaNames'] = [{ paths: ['../**'], stripSuffixes: ['Dto'] }];
        fs.writeFileSync(manifest, JSON.stringify(raw));
    }

    private copy(from: string, to: string): void {
        fs.mkdirSync(to, { recursive: true });
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
            const source = path.join(from, entry.name);
            const target = path.join(to, entry.name.replace('.fixture.json', '.json'));
            if (entry.isDirectory()) this.copy(source, target);
            else fs.copyFileSync(source, target);
        }
    }

    /** The repo's own path mappings (absolute), plus the fixture packages read as SOURCE. */
    private tsconfig(): string {
        const base = ts.readConfigFile(path.join(REPO_ROOT, 'tsconfig.base.json'), ts.sys.readFile)
            .config as { compilerOptions: { paths: Record<string, string[]> } };
        const paths: Record<string, string[]> = {};
        for (const [name, targets] of Object.entries(base.compilerOptions.paths)) {
            paths[name] = targets.map((target: string) => path.join(REPO_ROOT, target));
        }
        for (const name of FIXTURE_PACKAGES) {
            paths[`@fixture/${name}`] = [path.join(this.root, 'libs', name, 'src', 'index.ts')];
        }
        return JSON.stringify(
            {
                compilerOptions: {
                    target: 'ES2022',
                    module: 'commonjs',
                    moduleResolution: 'node',
                    experimentalDecorators: true,
                    strict: true,
                    skipLibCheck: true,
                    baseUrl: this.root,
                    paths,
                },
            },
            null,
            4,
        );
    }
}

/** Compare against `goldens/chain/<library>/<file>`, or rewrite it under WP_UPDATE_CHAIN_GOLDENS=1. */
function expectGolden(library: string, fileName: string, text: string | undefined): void {
    const file = path.join(GOLDENS, library, fileName);
    expect(text, `${library} wrote no ${fileName}`).toBeDefined();
    if (UPDATE) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text!);
    }
    expect(
        fs.existsSync(file),
        `${library}/${fileName} has no golden — rerun with WP_UPDATE_CHAIN_GOLDENS=1`,
    ).toBe(true);
    expect(text, `${library}/${fileName} no longer matches its golden`).toBe(
        fs.readFileSync(file, 'utf8'),
    );
}

function parse(text: string | undefined): Json {
    expect(text).toBeDefined();
    return JSON.parse(text!) as Json;
}

/** A catalog file is a JSON ARRAY of tool definitions. */
function firstTool(catalog: string | undefined): Json {
    expect(catalog).toBeDefined();
    return (JSON.parse(catalog!) as Json[])[0]!;
}

function schemasOf(document: Json): Record<string, Json> {
    return (document['components'] as { schemas: Record<string, Json> }).schemas;
}

/**
 * `/lang/passages`' request or success-response body schema. Its single-use wrappers are defined
 * INLINE there (#1303), titled with their published names, rather than in `components.schemas`.
 */
function passagesBody(document: Json, which: 'request' | 'response'): Json {
    const operation = ((document['paths'] as Json)['/lang/passages'] as Json)['post'] as Json;
    const body =
        which === 'request'
            ? (operation['requestBody'] as Json)
            : ((operation['responses'] as Json)['200'] as Json);
    return ((body['content'] as Json)['application/json'] as Json)['schema'] as Json;
}

/** Every `$ref` value anywhere in a document. */
function refsIn(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(refsIn);
    if (typeof value !== 'object' || value === null) return [];
    const found: string[] = [];
    for (const [key, child] of Object.entries(value as Json)) {
        if (key === '$ref' && typeof child === 'string') found.push(child);
        else found.push(...refsIn(child));
    }
    return found;
}

/** Validate with an OpenAPI 3.1 validator, registering each upstream document under its URI. */
async function validate(document: string, upstream: ReadonlyMap<string, string>): Promise<unknown> {
    const validator = new Validator();
    for (const [uri, text] of upstream) {
        await validator.addSpecRef(JSON.parse(text) as object, uri);
    }
    const result = await validator.validate(JSON.parse(document) as object);
    return result.valid ? true : result.errors;
}

const B_URI = '@fixture/dtos-b/components.openapi.json';
const A_URI = '@fixture/dtos-a/components.openapi.json';

const chain = new ChainWorkspace();
const out = new Map<string, Map<string, string>>();

describe('suffix stripping through chained documents and MCP catalogs (#1200)', () => {
    it('renames source types to Dto without changing any generated bytes', () => {
        const scenario = new ChainWorkspace();
        const api = path.join(scenario.root, 'libs/lang-apis/src/LangLessonApi.ts');
        // Keep this regression about suffix stripping; the existing golden separately tests package-qualified homonyms.
        fs.writeFileSync(
            api,
            fs
                .readFileSync(api, 'utf8')
                .replace('descriptions: LocalizedDescriptionsDto;', '')
                .replace('translations: SharedDescriptionsDto;', '')
                .replace('    MCP,', '    MCP,\n    EXTERNAL_CUSTOMER,')
                .replace(
                    '@ApiType(SVC_TO_SVC, MCP)',
                    '@ApiType(SVC_TO_SVC, MCP, EXTERNAL_CUSTOMER)',
                ),
        );
        scenario.renameTypes((name: string) => (name.endsWith('Dto') ? name.slice(0, -3) : name));
        const libraries = ['dtos-b', 'dtos-a', 'lang-apis'];
        const before = libraries.map((library: string) => scenario.generate(library));
        scenario.renameTypes((name: string) => `${name}Dto`);
        libraries.forEach((library: string) => scenario.stripSuffixes(library));
        const after = libraries.map((library: string) => scenario.generate(library));
        expect(after).toEqual(before);
        expect(after[2].has('public-openapi.json')).toBe(true);
        expect(after[2].has('mcp-LangLessonApi-tools.json')).toBe(true);
    }, 180_000);

    it('fails on two declarations whose published names collide', () => {
        const scenario = new ChainWorkspace();
        const file = path.join(scenario.root, 'libs/dtos-b/src/index.ts');
        fs.appendFileSync(
            file,
            '\nexport interface Order { id: string; }\nexport interface OrderDto { id: string; }\n',
        );
        scenario.stripSuffixes('dtos-b');
        const failure = scenario.failureOf('dtos-b');
        expect(failure.message).toContain("schema name 'Order' collides");
        expect(failure.message).toContain("'Order'");
        expect(failure.message).toContain("'OrderDto'");
        expect(failure.message).toContain('index.ts:');
    }, 60_000);
});

describe('a @hidden field on another package\'s type (#1246)', () => {
    it('is kept in that package\'s components document, and refused by a split customer document', () => {
        const scenario = new ChainWorkspace();
        const dtos = path.join(scenario.root, 'libs/dtos-b/src/VoiceDtos.ts');
        fs.writeFileSync(
            dtos,
            fs
                .readFileSync(dtos, 'utf8')
                .replace(
                    '    /** The Spanish description. */\n    es?: string;',
                    '    /**\n     * The Spanish description.\n     * @hidden not announced yet\n     */\n    es?: string;',
                ),
        );
        const api = path.join(scenario.root, 'libs/lang-apis/src/LangLessonApi.ts');
        fs.writeFileSync(
            api,
            fs
                .readFileSync(api, 'utf8')
                .replace('    MCP,', '    MCP,\n    EXTERNAL_CUSTOMER,')
                .replace('@ApiType(SVC_TO_SVC, MCP)', '@ApiType(SVC_TO_SVC, MCP, EXTERNAL_CUSTOMER)'),
        );
        const components = parse(scenario.generate('dtos-b').get('components.openapi.json'));
        const shared = ((components['components'] as Json)['schemas'] as Json)[
            'LocalizedDescriptionsDto'
        ] as Json;
        expect(Object.keys(shared['properties'] as Json)).toEqual(['en', 'es']);
        scenario.generate('dtos-a');
        const failure = scenario.failureOf('lang-apis');
        expect(failure.message).toContain(
            "1 @hidden field(s) are on types public-openapi references in another package's components document",
        );
        expect(failure.pointers).toEqual([
            expect.stringMatching(
                /^LocalizedDescriptionsDto\.es — declared in @fixture\/dtos-b \(.*VoiceDtos\.ts:\d+:\d+\)$/,
            ),
        ]);
    }, 120_000);
});

beforeAll(() => {
    // In dependency order, exactly as nx orders it through ^openapi-components-generate.
    for (const library of ['dtos-b', 'dtos-a', 'lang-apis', 'fsdb-api']) {
        out.set(library, chain.generate(library));
    }
}, 120_000);

describe('a DTO library publishes a components-only document', () => {
    it.each([['dtos-b'], ['dtos-a']])('%s matches its golden', (library: string) => {
        expect(Array.from(out.get(library)!.keys())).toEqual(['components.openapi.json']);
        expectGolden(
            library,
            'components.openapi.json',
            out.get(library)!.get('components.openapi.json'),
        );
    });

    it('is a VALID OpenAPI 3.1 document on its own, and with the library it references', async () => {
        const b = out.get('dtos-b')!.get('components.openapi.json')!;
        const a = out.get('dtos-a')!.get('components.openapi.json')!;
        expect(await validate(b, new Map())).toBe(true);
        expect(await validate(a, new Map([[B_URI, b]]))).toBe(true);
    });

    it('holds EVERY exported type the library declares, versioned as the package, identified by URI', () => {
        const a = parse(out.get('dtos-a')!.get('components.openapi.json'));
        expect(a['openapi']).toBe('3.1.0');
        expect((a['info'] as Json)['version']).toBe('1.4.0');
        expect(a['x-webpieces-id']).toBe(A_URI);
        expect(a['paths']).toBeUndefined();
        // LessonScopedDto is reached by no contract of dtos-a; it is exported, so it is published.
        // PageDto<T> is generic: it has no schema until it is instantiated.
        expect(Object.keys(schemasOf(a))).toEqual([
            'LessonScopedDto',
            'LessonTypeDto',
            'PassageItemDto',
        ]);
    });

    it('references the NEXT library in the chain instead of copying its schemas', () => {
        const a = parse(out.get('dtos-a')!.get('components.openapi.json'));
        expect(schemasOf(a)['VoiceChoiceDto']).toBeUndefined();
        expect(schemasOf(a)['SpeakerGenderDto']).toBeUndefined();
        expect(refsIn(a).sort()).toEqual([
            '#/components/schemas/LessonTypeDto',
            `${B_URI}#/components/schemas/SpeakerGenderDto`,
            `${B_URI}#/components/schemas/VoiceChoiceDto`,
        ]);
    });
});

describe('a contract document references the libraries and does not copy them', () => {
    it.each([
        ['lang-apis', 'full-private-openapi.json'],
        ['lang-apis', 'full-private-openapi.bundled.json'],
        ['lang-apis', 'mcp-openapi.json'],
        ['lang-apis', 'mcp-LangLessonApi-tools.json'],
        ['fsdb-api', 'full-private-openapi.json'],
        ['fsdb-api', 'full-private-openapi.bundled.json'],
        ['fsdb-api', 'mcp-openapi.json'],
        ['fsdb-api', 'mcp-FsdbApi-tools.json'],
    ])('%s %s matches its golden', (library: string, fileName: string) => {
        expectGolden(library, fileName, out.get(library)!.get(fileName));
    });

    it("defines only its OWN package's schemas, with two same-named types from two packages apart", () => {
        const split = parse(out.get('lang-apis')!.get('full-private-openapi.json'));
        // The single-use wrappers are inline at their operation (#1303), so only the shared noun is
        // a component.
        expect(Object.keys(schemasOf(split))).toEqual(['LocalizedDescriptionsDto']);
        expect(passagesBody(split, 'response')['title']).toBe('PassageListResponse');
        const response = passagesBody(split, 'response')['properties'] as Record<string, Json>;
        expect(response['descriptions']['$ref']).toBe(
            '#/components/schemas/LocalizedDescriptionsDto',
        );
        expect(response['translations']['$ref']).toBe(
            `${B_URI}#/components/schemas/LocalizedDescriptionsDto`,
        );
        expect((response['passages']['items'] as Json)['$ref']).toBe(
            `${A_URI}#/components/schemas/PassageItemDto`,
        );
    });

    it('FLATTENS a base declared in another package, with no allOf in any form', () => {
        const split = parse(out.get('lang-apis')!.get('full-private-openapi.json'));
        const request = passagesBody(split, 'request');
        expect(request['title']).toBe('PassageListRequest');
        expect(Object.keys(request['properties'] as Json)).toEqual([
            'lessonNumber',
            'lessonType',
            'narrator',
        ]);
        expect(request['required']).toEqual(['lessonNumber', 'lessonType']);
        for (const fileName of [
            'full-private-openapi.json',
            'full-private-openapi.bundled.json',
            'mcp-openapi.json',
            'mcp-LangLessonApi-tools.json',
        ]) {
            expect(out.get('lang-apis')!.get(fileName), fileName).not.toContain('allOf');
        }
    });

    it('the SPLIT document validates with its libraries registered; the BUNDLED one validates alone', async () => {
        const upstream = new Map([
            [B_URI, out.get('dtos-b')!.get('components.openapi.json')!],
            [A_URI, out.get('dtos-a')!.get('components.openapi.json')!],
        ]);
        for (const library of ['lang-apis', 'fsdb-api']) {
            const written = out.get(library)!;
            expect(
                await validate(written.get('full-private-openapi.json')!, upstream),
                library,
            ).toBe(true);
            expect(
                await validate(written.get('full-private-openapi.bundled.json')!, new Map()),
                library,
            ).toBe(true);
            expect(await validate(written.get('mcp-openapi.json')!, new Map()), library).toBe(true);
        }
    });

    it('the BUNDLED document has no external reference, and qualifies only the clashing name', () => {
        const bundled = parse(out.get('lang-apis')!.get('full-private-openapi.bundled.json'));
        expect(
            refsIn(bundled).every((ref: string) => ref.startsWith('#/components/schemas/')),
        ).toBe(true);
        expect(Object.keys(schemasOf(bundled))).toEqual([
            'LessonTypeDto',
            'LocalizedDescriptionsDto',
            'PassageItemDto',
            'SpeakerGenderDto',
            'VoiceChoiceDto',
            'fixture.dtos-b.LocalizedDescriptionsDto',
        ]);
    });

    it("renders a library's schema in the bundled document BYTE-IDENTICAL to the library's own document", () => {
        const b = schemasOf(parse(out.get('dtos-b')!.get('components.openapi.json')));
        const bundled = schemasOf(
            parse(out.get('lang-apis')!.get('full-private-openapi.bundled.json')),
        );
        expect(JSON.stringify(bundled['VoiceChoiceDto'])).toBe(JSON.stringify(b['VoiceChoiceDto']));
        expect(JSON.stringify(bundled['SpeakerGenderDto'])).toBe(
            JSON.stringify(b['SpeakerGenderDto']),
        );
        expect(JSON.stringify(bundled['fixture.dtos-b.LocalizedDescriptionsDto'])).toBe(
            JSON.stringify(b['LocalizedDescriptionsDto']),
        );
    });
});

describe('a single-use wrapper declared in ANOTHER package stays a $ref (#1303)', () => {
    it("references it in its package's components document in the split form, and defines it in the bundled form", () => {
        const scenario = new ChainWorkspace();
        const api = path.join(scenario.root, 'libs/fsdb-api/src/FsdbApi.ts');
        fs.writeFileSync(
            api,
            fs
                .readFileSync(api, 'utf8')
                .replace(
                    "import { PassageItemDto } from '@fixture/dtos-a';",
                    "import { LessonScopedDto, PassageItemDto } from '@fixture/dtos-a';",
                )
                .replace(
                    'readPassage(request: StoredPassageRequest)',
                    'readPassage(request: LessonScopedDto)',
                ),
        );
        for (const library of ['dtos-b', 'dtos-a']) {
            scenario.generate(library);
        }
        const written = scenario.generate('fsdb-api');
        const pointer = [
            'paths',
            '/fsdb/passage',
            'post',
            'requestBody',
            'content',
            'application/json',
            'schema',
        ];
        const bodyOf = (fileName: string): Json =>
            pointer.reduce(
                (node: Json, step: string) => node[step] as Json,
                parse(written.get(fileName)),
            );
        // One owner per schema (#1058): inlining it here would define dtos-a's schema in two documents.
        expect(bodyOf('full-private-openapi.json')).toEqual({
            $ref: `${A_URI}#/components/schemas/LessonScopedDto`,
        });
        expect(bodyOf('full-private-openapi.bundled.json')).toEqual({
            $ref: '#/components/schemas/LessonScopedDto',
        });
        // The home package's single-use response wrapper IS inlined, beside it.
        expect(written.get('full-private-openapi.json')).toContain(
            '"title": "StoredPassageResponse"',
        );
    }, 120_000);
});

describe('MCP catalogs stay fully inlined, and a shared DTO renders identically everywhere', () => {
    /** The shared PassageItemDto, as each catalog inlines it — minus the FIELD prose MCP puts on it. */
    function passageIn(library: string, catalog: string, at: (output: Json) => Json): string {
        const tools = firstTool(out.get(library)!.get(catalog));
        const schema = { ...at(tools['outputSchema'] as Json) };
        delete schema['description'];
        return JSON.stringify(schema);
    }

    it('writes no $ref into any catalog', () => {
        expect(out.get('lang-apis')!.get('mcp-LangLessonApi-tools.json')).not.toContain('$ref');
        expect(out.get('fsdb-api')!.get('mcp-FsdbApi-tools.json')).not.toContain('$ref');
    });

    it("inlines the shared DTO byte-identically in two libraries' catalogs, matching the bundled schema", () => {
        const lang = passageIn(
            'lang-apis',
            'mcp-LangLessonApi-tools.json',
            (o: Json) => (o['properties'] as Record<string, Json>)['passages']['items'] as Json,
        );
        const fsdb = passageIn(
            'fsdb-api',
            'mcp-FsdbApi-tools.json',
            (o: Json) => (o['properties'] as Record<string, Json>)['passage'],
        );
        expect(lang).toBe(fsdb);

        const mcp = JSON.parse(lang) as { properties: Record<string, Json>; required: string[] };
        const bundled = schemasOf(
            parse(out.get('lang-apis')!.get('full-private-openapi.bundled.json')),
        );
        const passage = bundled['PassageItemDto'];
        expect(Object.keys(mcp.properties)).toEqual(Object.keys(passage['properties'] as Json));
        expect(mcp.required).toEqual(passage['required']);
        expect(mcp.properties['narrator']['enum']).toEqual(bundled['SpeakerGenderDto']['enum']);
    });
});

describe('fail closed — OpenAPI documents only', () => {
    it('REFUSES a type from a package that publishes no components document, naming type, package and fix', () => {
        const failure = chain.failureOf('settings-api');
        expect(failure.message).toContain(
            'declared in a package that publishes no components document',
        );
        expect(failure.pointers.join('\n')).toContain(
            'AiProvider — declared in @fixture/company-core',
        );
        expect(failure.pointers.join('\n')).toContain('has no openapi-components-generate target');
        expect(failure.cure).toContain('`…Dto` string enum');
        expect(failure.cure).toContain('"generate:openapi-components"');
        // #1064 D5: tagging is offered only to a package that is already a role:api-lib DTO library.
        expect(failure.cure).toContain('Move each type into a role:api-lib DTO library');
        expect(failure.cure).toContain(
            'Only when the declaring package is ITSELF a role:api-lib DTO library',
        );
        expect(failure.cure).not.toContain('— or tag its package');
        expect(failure.cure).toContain('"kind": "components" openapi.manifest.json');
        expect(fs.existsSync(chain.outDir('settings-api'))).toBe(false);
    });

    it('lets an MCP-ONLY contract inline that same type: MCP never requires a components document', () => {
        const written = chain.generate('agent-api');
        expect(Array.from(written.keys()).sort()).toEqual([
            'mcp-AgentApi-tools.json',
            'mcp-openapi.json',
        ]);
        const tool = firstTool(written.get('mcp-AgentApi-tools.json'));
        const provider = ((tool['inputSchema'] as Json)['properties'] as Record<string, Json>)[
            'provider'
        ];
        expect(provider['enum']).toEqual(['claude', 'chatgpt']);
        expect(schemasOf(parse(written.get('mcp-openapi.json')))['AiProvider']).toBeDefined();
    });

    it('still REFUSES two different same-named types inside ONE package', () => {
        const failure = chain.failureOf('dup-api');
        expect(failure.message).toContain('declared twice in one package');
        expect(failure.pointers[0]).toContain('DupDto (@fixture/dup-api)');
    });

    it('REFUSES when the upstream library was never generated, naming the target that writes it', () => {
        const fresh = new ChainWorkspace();
        const failure = fresh.failureOf('lang-apis');
        expect(failure.pointers.join('\n')).toContain('nx run dtos-a:openapi-components-generate');
    });

    it('REFUSES a STALE upstream document that lacks a referenced schema', () => {
        const stale = new ChainWorkspace();
        stale.generate('dtos-b');
        const file = path.join(stale.outDir('dtos-b'), 'components.openapi.json');
        const document = JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
        delete schemasOf(document)['VoiceChoiceDto'];
        fs.writeFileSync(file, JSON.stringify(document));
        const failure = stale.failureOf('dtos-a');
        expect(failure.message).toContain("missing from their package's components document");
        expect(failure.pointers.join('\n')).toContain("has no schema 'VoiceChoiceDto'");
    });
});

describe('the components document, as a package ships it', () => {
    it('is found BESIDE package.json in a built or published package, the way fromPackages finds catalogs', () => {
        const consumer = path.join(chain.root, 'consumer');
        const installed = path.join(consumer, 'node_modules', '@fixture', 'dtos-b');
        fs.mkdirSync(installed, { recursive: true });
        fs.writeFileSync(
            path.join(installed, 'package.json'),
            '{"name":"@fixture/dtos-b","version":"2.1.0"}',
        );
        fs.copyFileSync(
            path.join(chain.outDir('dtos-b'), 'components.openapi.json'),
            path.join(installed, 'components.openapi.json'),
        );
        const located = new ComponentsLocator().locate('@fixture/dtos-b', consumer, undefined);
        expect(located.published?.documentPath).toBe(
            path.join(installed, 'components.openapi.json'),
        );
        expect(located.published?.schemaNames.has('VoiceChoiceDto')).toBe(true);
    });

    it('REFUSES --format yaml, which would publish no file a reference can name', () => {
        expect(chain.failureOf('dtos-b', 'yaml').message).toContain(
            '--format yaml writes no components.openapi.json',
        );
    });

    it("REFUSES a contract-manifest key in a components manifest — the version IS the package's", () => {
        const manifest = chain.manifest('dtos-b');
        const raw = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Json;
        raw['version'] = '9.9.9';
        fs.writeFileSync(manifest, JSON.stringify(raw));
        const failure = chain.failureOf('dtos-b');
        expect(failure.message).toContain("declares 'version'");
        expect(failure.cure).toContain('package version');
    });
});
