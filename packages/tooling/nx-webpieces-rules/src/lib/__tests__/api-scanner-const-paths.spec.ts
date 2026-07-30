/**
 * Regression: a contract that hoists its route to a `const` instead of writing a string literal.
 *
 * Mirrors the real file that exposed this (`whatsapp-api.ts`): ONE source file, ONE hoisted
 * `const WHATSAPP_API_PATH = '/whatsapp'`, and TWO api classes both using it for `@ApiPath` — one
 * with LITERAL endpoint paths, one with CONST endpoint paths. That pairing is what isolates the
 * variable: same file, same api-kind, same `@ApiPath` const, and only the endpoint-argument form
 * differs.
 *
 * Before the fix the scanner only read `ts.isStringLiteral` arguments, so:
 *   - both classes lost `basePath` (present-but-wrong: `basePath + path` computed `/test`, not
 *     `/whatsapp/test`, and every other entry HAS a basePath so a consumer treats it as required);
 *   - the all-const class resolved zero methods and was dropped from `apiContracts` entirely.
 *
 * Builds a throwaway mini-workspace on disk, matching api-scanner-no-paths.spec.ts, because the
 * scanner walks real project roots.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProjectInfo } from '../project-info';
import { ApiUsageScanner, buildApiContracts, describeNonLiteralDecoratorArgs } from '../api-usage/api-scanner';
import {
    EmptiedApiContractError,
    MissingBasePathError,
    UnresolvedEndpointPathError,
} from '../api-usage/api-contract-errors';
import { ApiMethodMeta } from '../api-usage/api-relations';

let root = '';

function write(relPath: string, contents: string): void {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
}

function writeDecorators(): void {
    write(
        'libraries/whatsapp-api/src/decorators.ts',
        `export function ApiPath(_p: string): ClassDecorator { return (): void => undefined; }
export function PubSub(): ClassDecorator { return (): void => undefined; }
export function Endpoint(_p: string, _k: string): MethodDecorator { return (): void => undefined; }
`,
    );
}

/**
 * The real shape: a hoisted base-path const, hoisted endpoint-path consts, and two contracts —
 * WhatsAppTestApi (const @ApiPath + LITERAL endpoint paths) and WhatsAppApi (const everywhere).
 */
function writeApiLib(): void {
    writeDecorators();
    write(
        'libraries/whatsapp-api/src/index.ts',
        `import { ApiPath, Endpoint, PubSub } from './decorators';

export const WHATSAPP_API_PATH = '/whatsapp';
const PROCESS_PATH = '/process';
const CONTINUE_PATH = '/continue-conversation';
const INBOUND_PATH = '/inbound';

@ApiPath(WHATSAPP_API_PATH)
export abstract class WhatsAppTestApi {
    @Endpoint('/test', 'rpc')
    abstract test(): Promise<void>;

    @Endpoint('/pg-security-test', 'rpc')
    abstract pgSecurityTest(): Promise<void>;
}

@PubSub()
@ApiPath(WHATSAPP_API_PATH)
export abstract class WhatsAppApi {
    @Endpoint(PROCESS_PATH, 'cloudtasks')
    abstract process(): Promise<void>;

    @Endpoint(CONTINUE_PATH, 'cloudtasks')
    abstract continueConversation(): Promise<void>;

    @Endpoint(INBOUND_PATH, 'external')
    abstract inbound(): Promise<void>;
}
`,
    );
    write(
        'libraries/whatsapp-api/tsconfig.json',
        JSON.stringify({
            compilerOptions: { moduleResolution: 'node', experimentalDecorators: true },
            include: ['src/**/*.ts'],
        }),
    );
}

/** A second lib whose endpoint path const lives in ANOTHER module — genuinely unresolvable. */
function writeCrossModuleApiLib(): void {
    write(
        'libraries/cross-api/src/paths.ts',
        `export const CROSS_PATH = '/cross';
`,
    );
    write(
        'libraries/cross-api/src/decorators.ts',
        `export function ApiPath(_p: string): ClassDecorator { return (): void => undefined; }
export function Endpoint(_p: string, _k: string): MethodDecorator { return (): void => undefined; }
`,
    );
    write(
        'libraries/cross-api/src/index.ts',
        `import { ApiPath, Endpoint } from './decorators';
import { CROSS_PATH } from './paths';

@ApiPath('/cross-base')
export abstract class CrossApi {
    @Endpoint(CROSS_PATH, 'rpc')
    abstract go(): Promise<void>;
}
`,
    );
    write(
        'libraries/cross-api/tsconfig.json',
        JSON.stringify({
            compilerOptions: { moduleResolution: 'node', experimentalDecorators: true },
            include: ['src/**/*.ts'],
        }),
    );
}

/**
 * THREE unreadable endpoint paths across TWO classes. The point is aggregation: an author who moved
 * a paths module out of the contract's file broke all of them at once and must see all of them at
 * once, not one per re-run.
 */
function writeMultiOffenderApiLib(): void {
    write(
        'libraries/multi-api/src/paths.ts',
        `export const A_PATH = '/a';
export const B_PATH = '/b';
export const C_PATH = '/c';
`,
    );
    write(
        'libraries/multi-api/src/decorators.ts',
        `export function ApiPath(_p: string): ClassDecorator { return (): void => undefined; }
export function Endpoint(_p: string, _k: string): MethodDecorator { return (): void => undefined; }
`,
    );
    write(
        'libraries/multi-api/src/index.ts',
        `import { ApiPath, Endpoint } from './decorators';
import { A_PATH, B_PATH, C_PATH } from './paths';

@ApiPath('/one')
export abstract class OneApi {
    @Endpoint(A_PATH, 'rpc')
    abstract a(): Promise<void>;

    @Endpoint(B_PATH, 'rpc')
    abstract b(): Promise<void>;
}

@ApiPath('/two')
export abstract class TwoApi {
    @Endpoint(C_PATH, 'rpc')
    abstract c(): Promise<void>;
}
`,
    );
    write(
        'libraries/multi-api/tsconfig.json',
        JSON.stringify({
            compilerOptions: { moduleResolution: 'node', experimentalDecorators: true },
            include: ['src/**/*.ts'],
        }),
    );
}

/**
 * A contract emptied by its KIND arguments rather than its paths — the paths are literals and read
 * perfectly. This is the mechanism, isolated: every method is skipped, the class reaches
 * buildApiContracts with zero methods, and the zero-method skip would drop it without a word.
 */
function writeEmptiedApiLib(): void {
    write(
        'libraries/badkind-api/src/kinds.ts',
        `export const RPC_KIND = 'rpc';
`,
    );
    write(
        'libraries/badkind-api/src/decorators.ts',
        `export function ApiPath(_p: string): ClassDecorator { return (): void => undefined; }
export function Endpoint(_p: string, _k: string): MethodDecorator { return (): void => undefined; }
`,
    );
    write(
        'libraries/badkind-api/src/index.ts',
        `import { ApiPath, Endpoint } from './decorators';
import { RPC_KIND } from './kinds';

@ApiPath('/badkind')
export abstract class BadKindApi {
    @Endpoint('/one', RPC_KIND)
    abstract one(): Promise<void>;

    @Endpoint('/two', RPC_KIND)
    abstract two(): Promise<void>;
}
`,
    );
    write(
        'libraries/badkind-api/tsconfig.json',
        JSON.stringify({
            compilerOptions: { moduleResolution: 'node', experimentalDecorators: true },
            include: ['src/**/*.ts'],
        }),
    );
}

/**
 * The exact shape that shipped a present-but-WRONG entry: an unreadable `@ApiPath` (its constant
 * lives in another module) but perfectly readable literal endpoint paths. The contract survives with
 * methods and no basePath, so `basePath + path` computes `/test` where the route is `/hidden/test`.
 */
function writeNoBasePathApiLib(): void {
    write(
        'libraries/nobase-api/src/paths.ts',
        `export const HIDDEN_API_PATH = '/hidden';
`,
    );
    write(
        'libraries/nobase-api/src/decorators.ts',
        `export function ApiPath(_p: string): ClassDecorator { return (): void => undefined; }
export function Endpoint(_p: string, _k: string): MethodDecorator { return (): void => undefined; }
`,
    );
    write(
        'libraries/nobase-api/src/index.ts',
        `import { ApiPath, Endpoint } from './decorators';
import { HIDDEN_API_PATH } from './paths';

@ApiPath(HIDDEN_API_PATH)
export abstract class HiddenApi {
    @Endpoint('/test', 'rpc')
    abstract test(): Promise<void>;
}
`,
    );
    write(
        'libraries/nobase-api/tsconfig.json',
        JSON.stringify({
            compilerOptions: { moduleResolution: 'node', experimentalDecorators: true },
            include: ['src/**/*.ts'],
        }),
    );
}

/**
 * ONLY the good lib. cross-api now lives in its own map because an unreadable @Endpoint path FAILS
 * generation — mixing it in would make every "the good class still works" assertion below throw for
 * a reason that has nothing to do with what it is testing.
 */
function projects(): Map<string, ProjectInfo> {
    const infos = new Map<string, ProjectInfo>();
    infos.set('whatsapp-api', new ProjectInfo('whatsapp-api', 'libraries/whatsapp-api', ['role:lib']));
    return infos;
}

function crossProjects(): Map<string, ProjectInfo> {
    const infos = new Map<string, ProjectInfo>();
    infos.set('cross-api', new ProjectInfo('cross-api', 'libraries/cross-api', ['role:lib']));
    return infos;
}

function multiProjects(): Map<string, ProjectInfo> {
    const infos = new Map<string, ProjectInfo>();
    infos.set('multi-api', new ProjectInfo('multi-api', 'libraries/multi-api', ['role:lib']));
    return infos;
}

function badKindProjects(): Map<string, ProjectInfo> {
    const infos = new Map<string, ProjectInfo>();
    infos.set('badkind-api', new ProjectInfo('badkind-api', 'libraries/badkind-api', ['role:lib']));
    return infos;
}

function noBasePathProjects(): Map<string, ProjectInfo> {
    const infos = new Map<string, ProjectInfo>();
    infos.set('nobase-api', new ProjectInfo('nobase-api', 'libraries/nobase-api', ['role:lib']));
    return infos;
}

function methodNames(methods: ApiMethodMeta[]): string[] {
    return methods.map((m: ApiMethodMeta) => m.name);
}

// File-level so BOTH describe blocks below share the one mini-workspace.
beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-api-const-')));
    writeApiLib();
    writeCrossModuleApiLib();
    writeMultiOffenderApiLib();
    writeEmptiedApiLib();
    writeNoBasePathApiLib();
});

afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('ApiUsageScanner — decorator arguments that are same-module consts', () => {
    it('indexes BOTH contracts — the all-const class is not dropped', () => {
        const result = new ApiUsageScanner(root, projects()).scan();
        expect(result.apiIndex.get('WhatsAppTestApi')?.owner).toBe('whatsapp-api');
        expect(result.apiIndex.get('WhatsAppApi')?.owner).toBe('whatsapp-api');
    });

    it('resolves the const @ApiPath into basePath for both classes', () => {
        const result = new ApiUsageScanner(root, projects()).scan();
        expect(result.apiIndex.get('WhatsAppTestApi')?.basePath).toBe('/whatsapp');
        expect(result.apiIndex.get('WhatsAppApi')?.basePath).toBe('/whatsapp');
    });

    it('keeps every method of the all-const class, with its resolved paths and kinds', () => {
        const result = new ApiUsageScanner(root, projects()).scan();
        const methods = result.apiIndex.get('WhatsAppApi')!.methods;
        expect(methodNames(methods)).toEqual(['process', 'continueConversation', 'inbound']);
        expect(methods.map((m: ApiMethodMeta) => m.path)).toEqual([
            '/process',
            '/continue-conversation',
            '/inbound',
        ]);
        expect(methods.map((m: ApiMethodMeta) => m.kind)).toEqual(['cloudtasks', 'cloudtasks', 'external']);
    });

    it('emits an apiContracts entry with basePath for the all-const class', () => {
        const contracts = buildApiContracts(new ApiUsageScanner(root, projects()).scan());
        expect(contracts['WhatsAppApi']).toBeDefined();
        expect(contracts['WhatsAppApi'].basePath).toBe('/whatsapp');
        expect(contracts['WhatsAppTestApi'].basePath).toBe('/whatsapp');
    });

    it('names a queue only for the queued methods, never for synchronous rpc', () => {
        const contracts = buildApiContracts(new ApiUsageScanner(root, projects()).scan());
        const queued = contracts['WhatsAppApi'].methods.filter((m: ApiMethodMeta) => m.kind === 'cloudtasks');
        expect(queued.map((m: ApiMethodMeta) => m.queueName)).toEqual([
            'WhatsAppApi-process',
            'WhatsAppApi-continueConversation',
        ]);
        for (const method of contracts['WhatsAppTestApi'].methods) {
            expect(method.queueName).toBeUndefined();
        }
    });

    it('warns about the cross-module const it genuinely cannot resolve', () => {
        const result = new ApiUsageScanner(root, crossProjects()).scan();
        const cross = result.nonLiteralDecoratorArgs.filter((a: { api: string }) => a.api === 'CrossApi');
        expect(cross).toHaveLength(1);
        expect(cross[0].decorator).toBe('Endpoint');
        expect(cross[0].argument).toBe('CROSS_PATH');
        expect(cross[0].at).toContain('libraries/cross-api/src/index.ts:');

        const report = describeNonLiteralDecoratorArgs(result.nonLiteralDecoratorArgs);
        expect(report).toContain('CROSS_PATH');
        expect(report).toContain('CrossApi');
    });

    it('reports nothing for the same-module consts it CAN resolve', () => {
        const result = new ApiUsageScanner(root, projects()).scan();
        const whatsapp = result.nonLiteralDecoratorArgs.filter((a: { api: string }) => a.api.startsWith('WhatsApp'));
        expect(whatsapp).toEqual([]);
    });
});

describe('apiContracts schema — basePath is required', () => {
    it('FAILS generation rather than emitting a routed contract with no basePath', () => {
        const scan = new ApiUsageScanner(root, noBasePathProjects()).scan();
        // The contract itself is found and keeps its literal method — only the basePath is unreadable.
        expect(scan.apiIndex.get('HiddenApi')?.methods).toHaveLength(1);
        expect(scan.apiIndex.get('HiddenApi')?.basePath).toBeUndefined();

        expect(() => buildApiContracts(scan)).toThrow(MissingBasePathError);
        expect(() => buildApiContracts(scan)).toThrow(/HiddenApi/);
        expect(() => buildApiContracts(scan)).toThrow(/basePath is REQUIRED/);
    });

    it('names the unreadable @ApiPath argument so the fix is obvious', () => {
        const scan = new ApiUsageScanner(root, noBasePathProjects()).scan();
        const report = describeNonLiteralDecoratorArgs(scan.nonLiteralDecoratorArgs);
        expect(report).toContain('@ApiPath(HIDDEN_API_PATH)');
        expect(report).toContain('HiddenApi');
    });
});

/**
 * The other half of the URL. PR #507 made `basePath` required and fatal; a method `path` is the same
 * kind of data for the same reason — a client computes `basePath + path` — so an unreadable one must
 * fail generation rather than delete the method (and, when it takes every method, the whole class).
 */
describe('apiContracts schema — an @Endpoint path is required', () => {
    it('FAILS generation for a cross-module const path, naming the class AND the method', () => {
        const scan = new ApiUsageScanner(root, crossProjects()).scan();
        expect(() => buildApiContracts(scan)).toThrow(UnresolvedEndpointPathError);
        expect(() => buildApiContracts(scan)).toThrow(/CrossApi\.go/);
        expect(() => buildApiContracts(scan)).toThrow(/CROSS_PATH/);
        expect(() => buildApiContracts(scan)).toThrow(/path is REQUIRED/);
    });

    it('spells out the non-obvious fix: same-module consts resolve, imported ones do not', () => {
        const scan = new ApiUsageScanner(root, crossProjects()).scan();
        expect(() => buildApiContracts(scan)).toThrow(/SAME module/);
        expect(() => buildApiContracts(scan)).toThrow(/string literal/);
    });

    it('records the offender on the scan with its file and line, not just in the message', () => {
        const scan = new ApiUsageScanner(root, crossProjects()).scan();
        expect(scan.unresolvedEndpointPaths).toHaveLength(1);
        expect(scan.unresolvedEndpointPaths[0].api).toBe('CrossApi');
        expect(scan.unresolvedEndpointPaths[0].method).toBe('go');
        expect(scan.unresolvedEndpointPaths[0].argument).toBe('CROSS_PATH');
        expect(scan.unresolvedEndpointPaths[0].at).toContain('libraries/cross-api/src/index.ts:');
    });

    it('reports EVERY offender in ONE error, not just the first', () => {
        const scan = new ApiUsageScanner(root, multiProjects()).scan();
        expect(scan.unresolvedEndpointPaths).toHaveLength(3);
        // One error, three names: an author who moved a paths module fixes all three in one run.
        expect(() => buildApiContracts(scan)).toThrow(/3 @Endpoint path\(s\)/);
        expect(() => buildApiContracts(scan)).toThrow(/OneApi\.a/);
        expect(() => buildApiContracts(scan)).toThrow(/OneApi\.b/);
        expect(() => buildApiContracts(scan)).toThrow(/TwoApi\.c/);
    });

    it('does NOT regress same-module const paths — those still resolve and generate', () => {
        const scan = new ApiUsageScanner(root, projects()).scan();
        expect(scan.unresolvedEndpointPaths).toEqual([]);
        expect(() => buildApiContracts(scan)).not.toThrow();
        expect(buildApiContracts(scan)['WhatsAppApi'].methods).toHaveLength(3);
    });
});

/**
 * The mechanism that hid WhatsAppApi: buildApiContracts skips a zero-method class, so a contract
 * gutted by unreadable decorator arguments left by the same door a routeless vendor seam uses.
 */
describe('apiContracts schema — a contract emptied of its methods cannot vanish silently', () => {
    it('FAILS generation when a class declared @Endpoint methods and kept none', () => {
        const scan = new ApiUsageScanner(root, badKindProjects()).scan();
        // Paths are literals here — it is the required `kind` that is unreadable, so every method is
        // (deliberately) skipped and the class arrives at buildApiContracts empty.
        expect(scan.apiIndex.get('BadKindApi')?.methods).toEqual([]);
        expect(scan.unresolvedEndpointPaths).toEqual([]);

        expect(() => buildApiContracts(scan)).toThrow(EmptiedApiContractError);
        expect(() => buildApiContracts(scan)).toThrow(/BadKindApi/);
        expect(() => buildApiContracts(scan)).toThrow(/2 @Endpoint method\(s\) declared, 0 usable/);
    });

    it('records the emptied contract on the scan with its location', () => {
        const scan = new ApiUsageScanner(root, badKindProjects()).scan();
        expect(scan.emptiedApiContracts).toHaveLength(1);
        expect(scan.emptiedApiContracts[0].api).toBe('BadKindApi');
        expect(scan.emptiedApiContracts[0].declared).toBe(2);
        expect(scan.emptiedApiContracts[0].at).toContain('libraries/badkind-api/src/index.ts:');
    });

    it('leaves a genuinely routeless contract alone — nothing was declared, so nothing was dropped', () => {
        // A vendor seam (and a marker contract with no @Endpoint at all) still emits no entry and no
        // error: the rule is "declared endpoints and kept none", not "has no endpoints".
        const scan = new ApiUsageScanner(root, projects()).scan();
        expect(scan.emptiedApiContracts).toEqual([]);
    });
});
