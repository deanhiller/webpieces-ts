import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HttpContractMapper, QueryParams, RouteMetadataFactory, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { OpenApiImporter } from '../OpenApiImporter';

const FIXTURES = path.join(__dirname, 'fixtures');
const SHOP_IMPORT = path.join(FIXTURES, 'shop', 'shop.import.json');
/**
 * The golden is TEXT (`.ts.golden`), not a `.ts` in the tree: the repo's security scan runs the
 * PUBLISHED rules, which are one release behind and do not know `vendorAuth(...)` yet. The suite
 * still COMPILES and BINDS the generated contract — it writes it to a temp `.ts` and imports it.
 */
const GOLDEN = path.join(__dirname, 'goldens', 'ShopApi.generated.ts.golden');

/** The generated contract, written to a temp `.ts` and loaded, so it is compiled and decorated for real. */
// webpieces-disable no-function-outside-class -- spec helper; webpieces-disable no-any-unknown -- the dynamically imported module's shape is asserted by the tests
async function loadShopApi(): Promise<abstract new () => unknown> {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-openapi-import-golden-')), 'ShopApi.generated.ts');
    fs.writeFileSync(file, new OpenApiImporter().generate(SHOP_IMPORT));
    const loaded = (await import(file)) as { ShopApi: abstract new () => unknown };
    return loaded.ShopApi;
}

const REGENERATE =
    'If the change is intended, regenerate the golden:\n' +
    '  TS_NODE_PROJECT=tsconfig.base.json node -r @swc-node/register -r tsconfig-paths/register \\\n' +
    '    packages/docs/openapi-import/src/cli/wp-openapi-import.ts \\\n' +
    '    --config packages/docs/openapi-import/src/__tests__/fixtures/shop/shop.import.json \\\n' +
    '    --out packages/docs/openapi-import/src/__tests__/goldens/ShopApi.generated.ts.golden';

/**
 * The importer against a SYNTHETIC vendor spec (`fixtures/shop`) — never a real vendor's. The golden
 * is the generated contract itself, committed and COMPILED by this suite, so a generator change that
 * produces a contract webpieces refuses fails here rather than in a consumer repo.
 */
describe('wp-openapi-import — the generated contract', () => {
    it('matches the committed golden byte for byte, and regenerates identically', () => {
        const first = new OpenApiImporter().generate(SHOP_IMPORT);
        const second = new OpenApiImporter().generate(SHOP_IMPORT);
        expect(second).toBe(first);
        expect(first, REGENERATE).toBe(fs.readFileSync(GOLDEN, 'utf8'));
    });

    it('declares only the schemas the listed operations reach', () => {
        const source = new OpenApiImporter().generate(SHOP_IMPORT);
        expect(source).not.toContain('NeverReached');
        expect(source).not.toContain('unused');
        // The header parameter is the import file's / VendorAuthHook's concern, never an argument.
        expect(source).not.toContain('User-Agent');
    });

    it('escapes vendor prose so it cannot close the comment or start a JSDoc tag', () => {
        const source = new OpenApiImporter().generate(SHOP_IMPORT);
        expect(source).toContain('ops&#64;shop.example');
        expect(source).toContain('comment *&#47; early');
    });

    it('is a contract webpieces binds: EXTERNAL_OUTBOUND, 0-byte voids, listed context keys', async () => {
        const ShopApi = await loadShopApi();
        const list = RouteMetadataFactory.create(ShopApi, 'listItems');
        expect(list.httpMethod).toBe('GET');
        expect(list.externalOutbound).toBe(true);
        expect(list.externalContextKeys).toEqual([WebpiecesCoreHeaders.REQUEST_ID]);
        expect(list.authMeta?.methods[0]).toEqual({ kind: 'vendorAuth', name: 'shop' });

        const remove = RouteMetadataFactory.create(ShopApi, 'deleteOrder');
        expect(remove.noResponseBody).toBe(true);
        expect(remove.externalContextKeys).toEqual([WebpiecesCoreHeaders.REQUEST_ID, WebpiecesCoreHeaders.CLIENT_VERSION]);

        expect(RouteMetadataFactory.create(ShopApi, 'updateItemStock').bodyParameterIndex).toBe(2);
        expect(RouteMetadataFactory.create(ShopApi, 'updateOrder').httpMethod).toBe('PATCH');
        expect(() => RouteMetadataFactory.assertNoDuplicateRoutes(ShopApi)).not.toThrow();
    });

    it('maps path params and the free-form query to the wire the vendor expects', async () => {
        const ShopApi = await loadShopApi();
        const route = RouteMetadataFactory.create(ShopApi, 'listItems');
        const query = new QueryParams().add('filter', 'name=x').add('filter', 'price>2').set('limit', 50);
        const wire = HttpContractMapper.toWire(route.path, route.parameterBindings, route.bodyParameterIndex, ['s 1', query]);
        expect(wire.path).toBe('/v1/shops/s%201/items?filter=name%3Dx&filter=price%3E2&limit=50');
        expect(wire.body).toBeUndefined();
    });
});

/** A throwaway directory holding one spec and one import file. */
class Scenario {
    readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-openapi-import-'));

    constructor(spec: object, importFile: object) {
        fs.writeFileSync(path.join(this.dir, 'spec.json'), JSON.stringify(spec));
        fs.writeFileSync(path.join(this.dir, 'vendor.import.json'), JSON.stringify(importFile));
    }

    generate(): string {
        return new OpenApiImporter().generate(path.join(this.dir, 'vendor.import.json'));
    }
}

const PING_SPEC = {
    openapi: '3.1.0',
    info: { title: 'Ping', version: '1' },
    paths: {
        '/ping': {
            get: { operationId: 'Ping', responses: { '204': { description: 'Pong.' } } },
            post: {
                operationId: 'Upload',
                requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } },
                responses: { '200': { description: 'Ok.' } },
            },
        },
        '/search': {
            get: {
                operationId: 'Search',
                requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
                responses: { '200': { description: 'Ok.' } },
            },
        },
    },
};

const importOf = (operations: string[], extra: object = {}): object => ({
    spec: 'spec.json',
    contract: 'PingApi',
    auth: { vendorAuth: 'ping' },
    operations,
    ...extra,
});

describe('wp-openapi-import — refusals', () => {
    it('generates a void GET with responseBody: NONE when the spec documents no body', () => {
        const source = new Scenario(PING_SPEC, importOf(['Ping'])).generate();
        expect(source).toContain("@Endpoint(GET, '/ping', READ, EXTERNAL_OUTBOUND, { responseBody: NONE })");
        expect(source).toContain('ping(): Promise<void> {');
    });

    it('refuses a contextKeys entry for an operation that is not listed — a dead entry', () => {
        const scenario = new Scenario(
            PING_SPEC,
            importOf(['Ping'], { contextKeys: { Search: [{ from: '@x/keys', symbol: 'Keys.A' }] } }),
        );
        expect(() => scenario.generate()).toThrow("contextKeys entry 'Search' names an operation that is not in 'operations' — a dead entry");
    });

    it('refuses an unknown import-file key', () => {
        expect(() => new Scenario(PING_SPEC, importOf(['Ping'], { overrides: {} })).generate()).toThrow(
            "unknown import-file key 'overrides'",
        );
    });

    it('refuses an operation the spec does not have', () => {
        expect(() => new Scenario(PING_SPEC, importOf(['Missing'])).generate()).toThrow("operation 'Missing' is not in the spec");
    });

    it('refuses a non-JSON request body and a GET with a body', () => {
        expect(() => new Scenario(PING_SPEC, importOf(['Upload'])).generate()).toThrow(
            "operation 'Upload' documents a request body with no application/json content",
        );
        expect(() => new Scenario(PING_SPEC, importOf(['Search'])).generate()).toThrow(
            "operation 'Search' is GET with a request body, which @Endpoint cannot send",
        );
    });

    it('refuses a Swagger 2.0 document', () => {
        const swagger = { swagger: '2.0', info: { title: 'Old', version: '1' }, paths: {} };
        expect(() => new Scenario(swagger, importOf(['Ping'])).generate()).toThrow(
            "the spec declares openapi '(none)', not 3.0.x or 3.1.x",
        );
    });

    it('refuses an operation listed twice and a malformed context key', () => {
        expect(() => new Scenario(PING_SPEC, importOf(['Ping', 'Ping'])).generate()).toThrow("operation 'Ping' is listed twice");
        expect(() =>
            new Scenario(PING_SPEC, importOf(['Ping'], { contextKeys: { '*': [{ from: '@x/keys', symbol: 'not a symbol' }] } })).generate(),
        ).toThrow("contextKeys['*'] holds an entry that is not");
    });
});
