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

/** The per-kind response-body rules of #1348: CLOUDTASKS / CRON, EXTERNAL_INBOUND, EXTERNAL_OUTBOUND. */
function writeKindFixtures(): void {
    writeLib(
        'trigger-api',
        `import { ApiPath, Endpoint } from './decorators';

@ApiPath('/triggers')
export abstract class TriggerApi {
    @Endpoint(POST, '/task', WRITE, CLOUDTASKS)
    abstract task(): Promise<void>;

    @Endpoint(POST, '/cron', WRITE, CRON)
    abstract cron(): Promise<void>;
}
`,
    );
    writeLib(
        'external-void-api',
        `import { ApiPath, Endpoint } from './decorators';

@ApiPath('/hooks')
export abstract class InboundHookApi {
    @Endpoint(POST, '/ok', WRITE, EXTERNAL_INBOUND, { calledBy: 'stripe', responseBody: NONE })
    abstract ok(): Promise<void>;

    @Endpoint(POST, '/missing', WRITE, EXTERNAL_INBOUND, { calledBy: 'stripe' })
    abstract missing(): Promise<void>;

    @Endpoint(POST, '/wrong', WRITE, EXTERNAL_INBOUND, { calledBy: 'stripe', responseBody: NONE })
    abstract wrong(): Promise<object>;
}

@ApiPath('/partner')
export abstract class PartnerHookApi {
    @Endpoint(POST, '/notify', WRITE, EXTERNAL_OUTBOUND)
    abstract notify(): Promise<void>;

    @Endpoint(POST, '/declared', WRITE, EXTERNAL_OUTBOUND, { responseBody: NONE })
    abstract declared(): Promise<void>;
}
`,
    );
    writeLib(
        'bad-trigger-api',
        `import { ApiPath, Endpoint } from './decorators';

@ApiPath('/bad-triggers')
export abstract class BadTriggerApi {
    @Endpoint(POST, '/redundant-task', WRITE, CLOUDTASKS, { responseBody: NONE })
    abstract redundantTask(): Promise<void>;

    @Endpoint(POST, '/redundant-cron', WRITE, CRON, { responseBody: NONE })
    abstract redundantCron(): Promise<void>;

    @Endpoint(POST, '/valued-task', WRITE, CLOUDTASKS)
    abstract valuedTask(): Promise<object>;

    @Endpoint(POST, '/valued-cron', WRITE, CRON)
    abstract valuedCron(): Promise<object>;
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
    @Endpoint(DELETE, '/{id}', WRITE_IDEMPOTENT, EXTERNAL_OUTBOUND)
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
    writeKindFixtures();
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

    it('EXTERNAL_INBOUND keeps the both-directions NONE check; EXTERNAL_OUTBOUND refuses NONE and needs none (#1348)', () => {
        const scan = new ApiUsageScanner(root, projectsOf('external-void-api')).scan();
        expect(scan.voidResponseMismatches.map((m: { api: string; method: string; problem: string }) => [m.api, m.method, m.problem])).toEqual([
            ['InboundHookApi', 'missing', 'void-without-none'],
            ['InboundHookApi', 'wrong', 'none-without-void'],
            ['PartnerHookApi', 'declared', 'outbound-none'],
        ]);
        expect(() => buildApiContracts(scan)).toThrow(
            'InboundHookApi.missing returns Promise<void> but does not declare responseBody: NONE',
        );
        expect(() => buildApiContracts(scan)).toThrow(
            'PartnerHookApi.declared is an EXTERNAL_OUTBOUND endpoint and declares responseBody: NONE, which does not apply',
        );
        expect(scan.apiIndex.get('InboundHookApi')!.methods[0].responseBody).toBe('none');
        expect(scan.apiIndex.get('PartnerHookApi')!.methods[0].responseBody).toBeUndefined();
    });

    it('accepts a Promise<void> CLOUDTASKS / CRON endpoint with no responseBody: the kind implies it (#1348)', () => {
        const scan = new ApiUsageScanner(root, projectsOf('trigger-api')).scan();
        expect(scan.voidResponseMismatches).toEqual([]);
        const contracts = buildApiContracts(scan);
        expect(contracts['TriggerApi'].methods.map((m: ApiMethodMeta) => [m.name, m.kind])).toEqual([
            ['task', 'cloudtasks'],
            ['cron', 'cron'],
        ]);
    });

    it('refuses a redundant responseBody: NONE and a non-void signature on CLOUDTASKS / CRON, naming the kind', () => {
        const scan = new ApiUsageScanner(root, projectsOf('bad-trigger-api')).scan();
        expect(scan.voidResponseMismatches.map((m: { method: string; problem: string }) => [m.method, m.problem])).toEqual([
            ['redundantTask', 'redundant-none'],
            ['redundantCron', 'redundant-none'],
            ['valuedTask', 'trigger-not-void'],
            ['valuedCron', 'trigger-not-void'],
        ]);
        expect(() => buildApiContracts(scan)).toThrow(VoidResponseMismatchError);
        expect(() => buildApiContracts(scan)).toThrow(
            'BadTriggerApi.redundantTask is a CLOUDTASKS endpoint and declares responseBody: NONE, which is redundant',
        );
        expect(() => buildApiContracts(scan)).toThrow(
            'BadTriggerApi.redundantCron is a CRON endpoint and declares responseBody: NONE, which is redundant',
        );
        expect(() => buildApiContracts(scan)).toThrow(
            'BadTriggerApi.valuedTask is a CLOUDTASKS endpoint but does not return Promise<void>',
        );
        expect(() => buildApiContracts(scan)).toThrow(
            'BadTriggerApi.valuedCron is a CRON endpoint but does not return Promise<void>',
        );
        expect(scan.apiIndex.get('BadTriggerApi')!.methods[0].responseBody).toBeUndefined();
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
