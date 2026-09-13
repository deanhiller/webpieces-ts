import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    auditSecurityContracts,
    findDirectlyChangedProjectRoots,
    missingSecurityBaseError,
    securityContractsError,
    SecurityContractViolation,
} from './validate-ensure-we-are-secure';
import { InformAiError, RuleFailError } from '@webpieces/rules-config';

let root: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-rule-'));
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, content: string): void {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

function project(relative: string): void {
    write(path.join(relative, 'project.json'), JSON.stringify({ name: relative }));
}

function codes(relative = 'packages/api'): string[] {
    return auditSecurityContracts(root, [relative]).map((violation) => violation.code);
}

describe('ensure-we-are-secure project scope', () => {
    it('selects only nearest directly changed projects and not neighboring or parent projects', () => {
        project('packages/parent');
        project('packages/parent/nested');
        project('packages/other');
        write('packages/parent/src/a.ts', 'export const a = 1;');
        write('packages/parent/nested/src/b.ts', 'export const b = 1;');
        expect(
            findDirectlyChangedProjectRoots(root, [
                'packages/parent/src/a.ts',
                'packages/parent/nested/src/b.ts',
            ]),
        ).toEqual(['packages/parent', 'packages/parent/nested']);
    });

    it('audits unchanged API files throughout a selected project but excludes a nested project', () => {
        project('packages/api');
        project('packages/api/nested');
        write('packages/api/src/changed.txt', 'changed');
        write(
            'packages/api/src/unchanged.ts',
            `
            import { ApiPath, Endpoint } from '@webpieces/core-util';
            @ApiPath('/x') class Api { @Endpoint('/x', 'rpc') x(v: object): Promise<object> { throw 0; } }
        `,
        );
        write(
            'packages/api/nested/src/bad.ts',
            `
            import { ApiPath, Endpoint } from '@webpieces/core-util';
            @ApiPath('/nested') class Nested { @Endpoint('/x', 'rpc') x(v: object): Promise<object> { throw 0; } }
        `,
        );
        expect(codes()).toEqual(['HTTP_AUTH_COUNT']);
    });
});

describe('ensure-we-are-secure HTTP contracts', () => {
    beforeEach(() => project('packages/api'));

    it('accepts all seven canonical method auth modes', () => {
        write(
            'packages/api/src/Api.ts',
            `
            import { ApiPath, Endpoint, WpAuthJwt, WpAuthOidc, WpAuthWebhook,
                WpAuthSharedSecret, WpAuthApiKey, WpAuthLocalOnly, WpAuthPublic } from '@webpieces/core-util';
            @ApiPath('/x') class Api {
                @Endpoint('/jwt', 'rpc') @WpAuthJwt({ allRolesAllowed: true }) jwt(v: object): Promise<object> { throw 0; }
                @Endpoint('/oidc', 'rpc') @WpAuthOidc() oidc(v: object): Promise<object> { throw 0; }
                @Endpoint('/webhook', 'rpc') @WpAuthWebhook('x') webhook(v: object): Promise<object> { throw 0; }
                @Endpoint('/secret', 'rpc') @WpAuthSharedSecret('x') secret(v: object): Promise<object> { throw 0; }
                @Endpoint('/key', 'rpc') @WpAuthApiKey('x') key(v: object): Promise<object> { throw 0; }
                @Endpoint('/local', 'rpc') @WpAuthLocalOnly() local(v: object): Promise<object> { throw 0; }
                @Endpoint('/public', 'rpc') @WpAuthPublic('health probe') public(v: object): Promise<object> { throw 0; }
            }
        `,
        );
        expect(codes()).toEqual([]);
    });

    it('resolves direct aliases and namespace imports', () => {
        write(
            'packages/api/src/Aliases.ts',
            `
            import { ApiPath as Path, Endpoint as Route, WpAuthJwt as Jwt } from '@webpieces/core-util';
            import * as wp from '@webpieces/core-util';
            @Path('/a') class A { @Route('/x', 'rpc') @Jwt({ allRolesAllowed: true }) x(v: object): Promise<object> { throw 0; } }
            @wp.ApiPath('/b') class B { @wp.Endpoint('/x', 'rpc') @wp.WpAuthOidc() x(v: object): Promise<object> { throw 0; } }
        `,
        );
        expect(codes()).toEqual([]);
    });

    it('rejects a local same-name decorator as proof of auth', () => {
        write(
            'packages/api/src/Fake.ts',
            `
            import { ApiPath, Endpoint } from '@webpieces/core-util';
            function WpAuthJwt(): MethodDecorator { return () => undefined; }
            @ApiPath('/x') class Api { @Endpoint('/x', 'rpc') @WpAuthJwt() x(v: object): Promise<object> { throw 0; } }
        `,
        );
        expect(codes()).toEqual(['HTTP_AUTH_COUNT']);
    });

    it('does not treat negative test fixtures as production API contracts', () => {
        write(
            'packages/api/src/Bad.spec.ts',
            `
            import { ApiPath, Endpoint } from '@webpieces/core-util';
            @ApiPath('/test') class TestApi { @Endpoint('/x', 'rpc') x(v: object): Promise<object> { throw 0; } }
        `,
        );
        expect(codes()).toEqual([]);
    });

    it('reports class auth, missing/multiple auth, public reason, and orphans deterministically', () => {
        write(
            'packages/api/src/Bad.ts',
            `
            import { ApiPath, Endpoint, WpAuthJwt, WpAuthOidc, WpAuthPublic } from '@webpieces/core-util';
            @WpAuthJwt({ allRolesAllowed: true }) @ApiPath('/x') class Api {
                @Endpoint('/missing', 'rpc') missing(v: object): Promise<object> { throw 0; }
                @Endpoint('/many', 'rpc') @WpAuthJwt({ allRolesAllowed: true }) @WpAuthOidc() many(v: object): Promise<object> { throw 0; }
                @Endpoint('/public', 'rpc') @WpAuthPublic('   ') public(v: object): Promise<object> { throw 0; }
                @WpAuthOidc() orphan(v: object): Promise<object> { throw 0; }
            }
        `,
        );
        expect(codes()).toEqual([
            'HTTP_CLASS_AUTH',
            'HTTP_AUTH_COUNT',
            'HTTP_AUTH_COUNT',
            'HTTP_PUBLIC_REASON',
            'HTTP_ORPHAN_AUTH',
        ]);
    });
});

describe('ensure-we-are-secure IPC contracts', () => {
    beforeEach(() => project('packages/api'));

    it('accepts internal API and stable method ids with one DTO and Promise return', () => {
        write(
            'packages/api/src/Internal.ts',
            `
            import { WpInternal, WpIpcEndpoint } from '@webpieces/core-util/ipc';
            @WpInternal('native') class NativeApi {
                @WpIpcEndpoint('read') read(v: object): Promise<object> { throw 0; }
                @WpIpcEndpoint('notify', { kind: 'notification' }) notify(v: object): Promise<void> { throw 0; }
            }
        `,
        );
        expect(codes()).toEqual([]);
    });

    it('fails closed on missing, duplicate, mixed, and malformed IPC metadata', () => {
        write(
            'packages/api/src/BadInternal.ts',
            `
            import { WpInternal, WpIpcEndpoint } from '@webpieces/core-util/ipc';
            import { ApiPath, Endpoint, WpAuthJwt } from '@webpieces/core-util';
            @WpInternal('native') @ApiPath('/bad') class Bad {
                @WpIpcEndpoint('same') one(): object { throw 0; }
                @WpIpcEndpoint('same') @Endpoint('/x', 'rpc') @WpAuthJwt({ allRolesAllowed: true }) two(a: object, b: object): Promise<object> { throw 0; }
                three(v: object): Promise<object> { throw 0; }
            }
            class Orphan { @WpIpcEndpoint('x') x(v: object): Promise<object> { throw 0; } }
        `,
        );
        const found = codes();
        expect(found).toContain('HTTP_IPC_CLASS_MIX');
        expect(found).toContain('IPC_API_PATH');
        expect(found).toContain('IPC_DTO_COUNT');
        expect(found).toContain('IPC_PROMISE_RETURN');
        expect(found).toContain('IPC_DUPLICATE_METHOD_ID');
        expect(found).toContain('IPC_HTTP_MIX');
        expect(found).toContain('IPC_ENDPOINT_COUNT');
        expect(found).toContain('IPC_MISSING_INTERNAL');
    });

    it('reports every duplicate API id in stable file order', () => {
        const source = (name: string): string => `
            import { WpInternal, WpIpcEndpoint } from '@webpieces/core-util/ipc';
            @WpInternal('duplicate') class ${name} { @WpIpcEndpoint('x') x(v: object): Promise<object> { throw 0; } }
        `;
        write('packages/api/src/B.ts', source('B'));
        write('packages/api/src/A.ts', source('A'));
        const violations = auditSecurityContracts(root, ['packages/api']);
        expect(violations.map((violation) => `${violation.file}:${violation.code}`)).toEqual([
            'packages/api/src/A.ts:IPC_DUPLICATE_API_ID',
            'packages/api/src/B.ts:IPC_DUPLICATE_API_ID',
        ]);
    });
});

describe('ensure-we-are-secure failure reporting', () => {
    it('returns one structured rule failure with framework-owned cure options', () => {
        const error = securityContractsError([
            new SecurityContractViolation(
                'packages/api/src/Api.ts',
                12,
                'HTTP_AUTH_COUNT',
                'run must have exactly one method-level @WpAuth* decorator; found 0.',
            ),
        ]);

        expect(error).toBeInstanceOf(RuleFailError);
        expect(error.ruleName).toBe('ensure-we-are-secure');
        expect(error.line).toBe(12);
        expect(error.aiMessage).toContain('packages/api/src/Api.ts:12 [HTTP_AUTH_COUNT]');
        expect(error.fixOptions).toHaveLength(2);
        expect(error.fixOptions[0]?.preferred).toBe(true);
    });

    it('uses a plumbing error rather than reporting success when no base can be detected', () => {
        const error = missingSecurityBaseError();
        expect(error).toBeInstanceOf(InformAiError);
        expect(error.message).toContain('Set NX_BASE');
    });
});
