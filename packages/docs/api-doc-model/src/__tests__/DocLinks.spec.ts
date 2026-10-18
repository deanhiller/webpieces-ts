import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as ts from 'typescript';
import { McpToolCatalogError, McpToolDefinition, toError } from '@webpieces/core-util';
import { ApiDocExtractor } from '../extract/ApiDocExtractor';
import { ApiDocModel, DocumentedEndpoint, DocumentedField } from '../model/ApiDocModel';
import { DocLink, DocLinkKind, DocLinkText } from '../model/DocLink';
import { OperationIds, OperationIdStyle } from '../model/OperationIds';
import { SchemaNameEntry, SchemaNames } from '../model/SchemaNames';
import { McpSchemaRenderer } from '../render/McpSchemaRenderer';

/**
 * `{@link}` resolves to the PUBLISHED identity of what it names (#1284), read from real fixture
 * contracts through the real extractor and the real MCP renderer.
 *
 * The defect: a link was flattened to its SOURCE text, so `{@link MenuDto}` published `MenuDto` in a
 * document whose schema is `Menu`, and `{@link OrdersApi.fetchOrders}` leaked the contract class name.
 */
const CORE_UTIL = path.resolve(__dirname, '..', '..', '..', '..', 'core', 'core-util');
const COMPILER_OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    baseUrl: CORE_UTIL,
    paths: { '@webpieces/core-util': [path.join(CORE_UTIL, 'src', 'index.ts')] },
};

/** Strip `Dto` from every fixture type, the way a consumer's manifest does. */
const SCHEMA_NAMES = new SchemaNames([new SchemaNameEntry(['**/fixtures/**'], ['Dto'])]);
const CONTRACT_METHOD = new OperationIds(OperationIdStyle.CONTRACT_METHOD);

class Fixture {
    extract(name: string): ApiDocModel {
        return new ApiDocExtractor(SCHEMA_NAMES).extractFile(
            path.join(__dirname, 'fixtures', name),
            COMPILER_OPTIONS,
        );
    }

    endpoint(model: ApiDocModel, method: string): DocumentedEndpoint {
        return model.endpoints.find((each: DocumentedEndpoint) => each.methodName === method)!;
    }

    /** What `catalogOf` threw, or undefined. The throw IS the measurement. */
    catalogFailure(model: ApiDocModel): McpToolCatalogError | undefined {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS what this returns
        try {
            McpSchemaRenderer.catalogOf([model], CONTRACT_METHOD);
            return undefined;
        } catch (err: unknown) {
            const error = toError(err);
            if (error instanceof McpToolCatalogError) return error;
            throw error;
        }
    }
}

const fixture = new Fixture();

describe('a {@link} at extraction', () => {
    let model: ApiDocModel;

    beforeAll(() => {
        model = fixture.extract('LinksApi.ts');
    }, 60_000);

    it('records WHAT each link names, never its flattened source text', () => {
        const fetch = fixture.endpoint(model, 'fetchMenu');
        const links = DocLinkText.linksIn(fetch.description);
        expect(
            links.map((link: DocLink) => [link.kind, link.owner, link.ownerName, link.member]),
        ).toEqual([
            [DocLinkKind.TYPE, 'MenuDto', 'Menu', ''],
            [DocLinkKind.TYPE, 'MenuKindDto', 'MenuKind', '.LUNCH'],
            [DocLinkKind.OPERATION, 'LinksApi', 'publishMenu', ''],
            [DocLinkKind.OPERATION, 'LinksApi', 'auditMenu', ''],
        ]);
        // The tool's name is read off @WpMcpTool, so a catalog can name what an agent calls.
        expect(links.map((link: DocLink) => link.mcpToolName)).toEqual([
            undefined,
            undefined,
            'publish_menu',
            undefined,
        ]);
        expect(links[2]!.label).toBe('the publish tool');
        expect(links[0]!.location).toMatch(/LinksApi\.ts:\d+:\d+$/);
    });

    it('records a field linked BARE as a MEMBER: the field\'s own name, its declaring type as owner (#1308)', () => {
        const request = model.types.get('FetchMenuRequestDto')!;
        const field = (name: string): string =>
            request.fields.find((each: DocumentedField) => each.name === name)!.description;
        expect(
            [field('locationCode'), field('storeId')].map((text: string) =>
                DocLinkText.linksIn(text).map((link: DocLink) => [
                    link.kind,
                    link.owner,
                    link.member,
                    link.label,
                ]),
            ),
        ).toEqual([
            [[DocLinkKind.MEMBER, 'FetchMenuRequestDto', 'storeId', undefined]],
            [[DocLinkKind.MEMBER, 'FetchMenuRequestDto', 'locationCode', 'the location']],
        ]);
        expect(DocLinkText.asWritten(field('locationCode'))).toBe(
            "The location's code. Mutually exclusive with `storeId` — see that field.",
        );
    });

    it('writes a URL out as a markdown link, since it names no declaration', () => {
        const description = fixture.endpoint(model, 'fetchMenu').description;
        expect(description).toContain('[the guide](https://example.com/menus)');
        expect(description).toContain('<https://example.com/raw>');
    });

    it('resolves links in @returns, field prose and type prose too', () => {
        const returns = fixture.endpoint(model, 'fetchMenu').returnsDescription!;
        expect(DocLinkText.asWritten(returns)).toBe('The `MenuDto` asked for.');
        const menu = model.types.get('MenuDto')!;
        expect(DocLinkText.linksIn(menu.description)[0]!.ownerName).toBe('MenuKind');
    });
});

describe('a {@link} in an MCP tool catalog', () => {
    let tools: readonly McpToolDefinition[];

    beforeAll(() => {
        const rendered = McpSchemaRenderer.catalogOf(
            [fixture.extract('LinksApi.ts')],
            CONTRACT_METHOD,
        );
        tools = rendered.catalogs[0]!.tools;
    }, 60_000);

    it('publishes a type as its STRIPPED schema name, a tool as its tool name, any other method as its operationId — each a code span', () => {
        const fetch = tools.find((tool: McpToolDefinition) => tool.name === 'fetch_menu')!;
        expect(fetch.description).toBe(
            'Reads one menu as a `Menu`, served at `MenuKind.LUNCH`. Then call\n' +
                'the publish tool (`publish_menu`) or `LinksApi_auditMenu`. See\n' +
                '[the guide](https://example.com/menus) and <https://example.com/raw>.',
        );
        expect(fetch.outputSchema.description).toBe('The `Menu` asked for.');
        expect(fetch.inputSchema.properties!['menuId']!.description).toBe(
            "Which menu; the same id as the first dish (`Menu.items`)'s menu.",
        );
        // A field linked BARE publishes the field, never its class (#1308).
        expect(fetch.inputSchema.properties!['locationCode']!.description).toBe(
            "The location's code. Mutually exclusive with `storeId` — see that field.",
        );
        expect(fetch.inputSchema.properties!['storeId']!.description).toBe(
            "The store's id. MUTUALLY EXCLUSIVE WITH the location (`locationCode`).",
        );
        const menu = fetch.outputSchema.properties!['menu']!;
        expect(menu.properties!['items']!.description).toBe(
            'The dishes, in the order `publish_menu` printed them.',
        );
    });

    it('never publishes a Dto source name, a Contract. prefix or the model encoding', () => {
        const text = JSON.stringify(tools);
        expect(text).not.toMatch(/MenuDto|MenuKindDto|LinksApi\.|@link/);
        expect(DocLinkText.hasLinks(text)).toBe(false);
    });

    it('names a non-tool method by its bare name under "operationIds": "method"', () => {
        const rendered = McpSchemaRenderer.catalogOf(
            [fixture.extract('LinksApi.ts')],
            new OperationIds(OperationIdStyle.METHOD),
        );
        const fetch = rendered.catalogs[0]!.find('fetch_menu')!;
        expect(fetch.description).toContain('or `auditMenu`.');
    });
});

describe('a {@link} that names nothing publishable', () => {
    it('REFUSES the catalog, naming every offender with its file:line in one run', () => {
        const failure = fixture.catalogFailure(fixture.extract('BrokenLinksApi.ts'));
        expect(failure).toBeDefined();
        expect(failure!.message).toMatch(/3 \{@link\} reference/);
        expect(failure!.message).toMatch(
            /BrokenLinksApi\.ts:\d+:\d+ \{@link NoSuchThing\} — the compiler cannot resolve it/,
        );
        expect(failure!.message).toMatch(
            /\{@link helperOf\} — it names neither a published type nor a contract operation/,
        );
        expect(failure!.message).toMatch(
            /\{@link BrokenLinksApi\} — a contract class is not published under its own name/,
        );
    });
});
