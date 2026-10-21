import { specTempDirs } from '@webpieces/tooling-testkit';
/**
 * PUT / PATCH / DELETE endpoints reach `architecture/dependencies.json` (#1339). The scanner used to
 * `continue` past every verb other than GET and POST, so a PUT endpoint vanished from the graph with
 * no error. Now every verb `@Endpoint` accepts is scanned, the body argument is recorded only for the
 * verbs that carry one, and an UNKNOWN verb is a recorded diagnostic rather than a silent drop.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProjectInfo } from '../project-info';
import { ApiUsageScanner, buildApiContracts } from '../api-usage/api-scanner';
import { VoidResponseMismatchError } from '../api-usage/api-contract-errors';
import { ApiMethodMeta } from '../api-usage/api-relations';

let root = '';

function write(relPath: string, contents: string): void {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
}

function writeLib(name: string, source: string): void {
    write(
        `libraries/${name}/src/decorators.ts`,
        `export function ApiPath(_p: string): ClassDecorator { return (): void => undefined; }
export function Endpoint(_m: string, _p: string, _o: string, _k: string, _x?: object): MethodDecorator { return (): void => undefined; }
export function PathParam(_n: string): ParameterDecorator { return (): void => undefined; }
export function QueryParam(_n: string): ParameterDecorator { return (): void => undefined; }
`,
    );
    write(`libraries/${name}/src/index.ts`, source);
    write(
        `libraries/${name}/tsconfig.json`,
        JSON.stringify({
            compilerOptions: { moduleResolution: 'node', experimentalDecorators: true },
            include: ['src/**/*.ts'],
        }),
    );
}

function projectsOf(name: string): Map<string, ProjectInfo> {
    return new Map([[name, new ProjectInfo(name, `libraries/${name}`, ['role:lib'])]]);
}

function writeVerbFixtures(): void {
    writeLib(
        'verbs-api',
        `import { ApiPath, Endpoint, PathParam, QueryParam } from './decorators';

export class Body {}

@ApiPath('/things')
export abstract class VerbsApi {
    @Endpoint(PUT, '/{id}', WRITE_IDEMPOTENT, RPC)
    abstract replace(@PathParam('id') id: string, body: Body): Promise<Body>;

    @Endpoint(PATCH, '/{id}', WRITE, RPC)
    abstract rename(@PathParam('id') id: string, body: Body): Promise<Body>;

    @Endpoint(DELETE, '/{id}', WRITE_IDEMPOTENT, RPC)
    abstract remove(@PathParam('id') id: string, @QueryParam('reason') reason?: string): Promise<Body>;
}
`,
    );
    writeLib(
        'void-api',
        `import { ApiPath, Endpoint } from './decorators';

@ApiPath('/void')
export abstract class VoidApi {
    @Endpoint(POST, '/ok', WRITE, RPC, { responseBody: NONE })
    abstract ok(): Promise<void>;

    @Endpoint(POST, '/missing', WRITE, RPC)
    abstract missing(): Promise<void>;

    @Endpoint(POST, '/wrong', WRITE, RPC, { responseBody: NONE })
    abstract wrong(): Promise<object>;
}
`,
    );
}

function writeVendorFixtures(): void {
    writeLib(
        'vendor-api',
        `import { ApiPath, Endpoint } from './decorators';

@ApiPath('/v3')
export abstract class AcmeApi {
    @Endpoint(GET, '/items', READ, EXTERNAL_OUTBOUND)
    abstract items(): Promise<object>;
}

/**
 * A vendor with an explicit identity.
 * @externalSystem storage BlobStore
 */
@ApiPath('/blobs')
export abstract class BlobsApi {
    @Endpoint(DELETE, '/{id}', WRITE_IDEMPOTENT, EXTERNAL_OUTBOUND, { responseBody: NONE })
    abstract remove(id: string): Promise<void>;
}
`,
    );
    writeLib(
        'badverb-api',
        `import { ApiPath, Endpoint } from './decorators';

@ApiPath('/bad')
export abstract class BadVerbApi {
    @Endpoint('TRACE', '/one', READ, RPC)
    abstract one(): Promise<object>;
}
`,
    );
}

beforeAll(() => {
    root = specTempDirs.makeReal('wp-api-verbs-');
    writeVerbFixtures();
    writeVendorFixtures();
});

afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('ApiUsageScanner — every @Endpoint verb is scanned', () => {
    it('records PUT, PATCH and DELETE with their URL bindings and only a body where the verb carries one', () => {
        const contracts = buildApiContracts(new ApiUsageScanner(root, projectsOf('verbs-api')).scan());
        const methods = contracts['VerbsApi'].methods;
        expect(methods.map((method: ApiMethodMeta) => [method.name, method.httpMethod])).toEqual([
            ['replace', 'PUT'],
            ['rename', 'PATCH'],
            ['remove', 'DELETE'],
        ]);
        expect(methods[0].parameters).toEqual([
            { index: 0, source: 'path', wireName: 'id' },
            { index: 1, source: 'body' },
        ]);
        expect(methods[2].parameters).toEqual([
            { index: 0, source: 'path', wireName: 'id' },
            { index: 1, source: 'query', wireName: 'reason' },
        ]);
    });

    it('records an unknown verb as a diagnostic instead of silently dropping the endpoint', () => {
        const result = new ApiUsageScanner(root, projectsOf('badverb-api')).scan();
        expect(
            result.nonLiteralDecoratorArgs.filter(
                (arg: { decorator: string; argument: string }) =>
                    arg.decorator === 'Endpoint.httpMethod' && arg.argument === 'TRACE',
            ),
        ).toHaveLength(1);
    });

    it('refuses responseBody: NONE that disagrees with Promise<void>, naming every offender', () => {
        const scan = new ApiUsageScanner(root, projectsOf('void-api')).scan();
        expect(() => buildApiContracts(scan)).toThrow(VoidResponseMismatchError);
        expect(() => buildApiContracts(scan)).toThrow(
            'VoidApi.missing returns Promise<void> but does not declare responseBody: NONE',
        );
        expect(() => buildApiContracts(scan)).toThrow(
            'VoidApi.wrong declares responseBody: NONE but does not return Promise<void>',
        );
        expect(scan.voidResponseMismatches.map((m: { method: string }) => m.method)).toEqual([
            'missing',
            'wrong',
        ]);
        expect(scan.apiIndex.get('VoidApi')!.methods[0].responseBody).toBe('none');
    });

    it('indexes an EXTERNAL_OUTBOUND contract as a vendor seam with an external system identity', () => {
        const scan = new ApiUsageScanner(root, projectsOf('vendor-api')).scan();
        const acme = scan.apiIndex.get('AcmeApi')!;
        expect(acme.type).toBe('external');
        expect(acme.externalSystem).toEqual({ kind: 'saas', label: 'Acme' });
        expect(acme.methods.map((method: ApiMethodMeta) => method.kind)).toEqual(['external-outbound']);
        expect(scan.apiIndex.get('BlobsApi')!.externalSystem).toEqual({ kind: 'storage', label: 'BlobStore' });
    });
});
