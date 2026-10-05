import { specTempDirs } from '@webpieces/tooling-testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    auditSecurityContracts,
    findDirectlyChangedProjectRoots,
    missingSecurityBaseError,
    securityContractsError,
    SecurityContractViolation,
} from './validate-ensure-we-are-secure';
import { InformAiError } from '@webpieces/tooling-common';
import { RuleFailError } from '@webpieces/rules-config';

let root: string;

beforeEach(() => {
    root = specTempDirs.make('secure-rule-');
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
            @ApiPath('/x') class Api { @Endpoint(POST, '/x', WRITE, RPC) x(v: object): Promise<object> { throw 0; } }
        `,
        );
        write(
            'packages/api/nested/src/bad.ts',
            `
            import { ApiPath, Endpoint } from '@webpieces/core-util';
            @ApiPath('/nested') class Nested { @Endpoint(POST, '/x', WRITE, RPC) x(v: object): Promise<object> { throw 0; } }
        `,
        );
        expect(codes()).toEqual(['HTTP_AUTH_COUNT', 'HTTP_AUTHORIZATION_COUNT']);
    });
});

describe('ensure-we-are-secure HTTP contracts', () => {
    beforeEach(() => project('packages/api'));

    it('accepts canonical credentials, OR alternatives, and separate locality', () => {
        write('packages/api/src/Api.ts', `
            import { ApiPath, Endpoint, WpAuth, WpAuthPublic, WpAuthorization,
                AuthorizationType, WpLocalOnly, jwt, oidc, webhook, sharedSecret, apiKey } from '@webpieces/core-util';
            @ApiPath('/x') class Api {
                @Endpoint() @WpAuth([jwt()]) @WpAuthorization({authType: AuthorizationType.ALL_USERS}) user(v: object): Promise<object> {throw 0;}
                @Endpoint() @WpAuth([oidc()]) @WpAuthorization({authType: AuthorizationType.SERVICE_ONLY}) service(v: object): Promise<object> {throw 0;}
                @Endpoint() @WpAuth([webhook('x')]) @WpAuthorization({authType: AuthorizationType.USERS_OR_SERVICES}) hook(v: object): Promise<object> {throw 0;}
                @Endpoint() @WpAuth([sharedSecret('x'), jwt()]) @WpAuthorization({authType: AuthorizationType.USERS_OR_SERVICES}) either(v: object): Promise<object> {throw 0;}
                @Endpoint() @WpAuth([apiKey('partner', [{in:'header',name:'x-api-key'}])]) @WpAuthorization({authType: AuthorizationType.ROLES, roles:['agent']}) key(v: object): Promise<object> {throw 0;}
                @Endpoint() @WpLocalOnly() @WpAuthPublic('diagnostics') @WpAuthorization({authType: AuthorizationType.ANONYMOUS, reason:'diagnostics'}) local(v: object): Promise<object> {throw 0;}
                @Endpoint() @WpAuth([jwt()]) @WpAuthorization({authType: AuthorizationType.CUSTOM, appPolicy:{inOrg:true}}) custom(v: object): Promise<object> {throw 0;}
            }
        `);
        expect(codes()).toEqual([]);
    });

    it('resolves aliases and namespace imports for credentials and policies', () => {
        write('packages/api/src/Aliases.ts', `
            import {ApiPath as Path, Endpoint as Route, WpAuth as Auth, jwt as credential,
                WpAuthorization as Policy, AuthorizationType as Type} from '@webpieces/core-util';
            import * as wp from '@webpieces/core-util';
            @Path('/a') class A {@Route() @Auth([credential()]) @Policy({authType:Type.ALL_USERS}) x(v: object): Promise<object> {throw 0;}}
            @wp.ApiPath('/b') class B {@wp.Endpoint() @wp.WpAuth([wp.oidc()]) @wp.WpAuthorization({authType:wp.AuthorizationType.SERVICE_ONLY}) x(v: object): Promise<object> {throw 0;}}
        `);
        expect(codes()).toEqual([]);
    });

    it('rejects local same-name declarations as security evidence', () => {
        write('packages/api/src/Fake.ts', `
            import {ApiPath, Endpoint} from '@webpieces/core-util';
            function WpAuth(): MethodDecorator {return () => undefined;}
            function WpAuthorization(): MethodDecorator {return () => undefined;}
            @ApiPath('/x') class Api {@Endpoint() @WpAuth() @WpAuthorization() x(v: object): Promise<object> {throw 0;}}
        `);
        expect(codes()).toEqual(['HTTP_AUTH_COUNT', 'HTTP_AUTHORIZATION_COUNT']);
    });

    it.each(['WpAuthJwt', 'WpAuthOidc', 'WpAuthSharedSecret', 'WpAuthWebhook', 'WpAuthApiKey', 'WpAuthLocalOnly', 'WpMcpAuthJwt'])('rejects removed %s with migration instructions', (legacy: string) => {
        write('packages/api/src/Legacy.ts', `
            import {ApiPath, Endpoint, ${legacy}} from '@webpieces/core-util';
            @ApiPath('/x') class Api {@Endpoint() @${legacy}() x(v: object): Promise<object> {throw 0;}}
        `);
        const violations = auditSecurityContracts(root, ['packages/api']);
        expect(violations.some((v: SecurityContractViolation) => v.code === 'HTTP_AUTH_MIGRATION' && v.message.includes('WpAuthorization'))).toBe(true);
    });

    it.each([
        ['@WpAuth([])', '{authType:AuthorizationType.ALL_USERS}', 'HTTP_AUTH_METHODS'],
        ['@WpAuth([jwt(),jwt()])', '{authType:AuthorizationType.ALL_USERS}', 'HTTP_AUTH_METHODS'],
        ['@WpAuth([fake()])', '{authType:AuthorizationType.ALL_USERS}', 'HTTP_AUTH_METHODS'],
        ['@WpAuth([jwt()])', '{authType:AuthorizationType.ROLES,roles:[]}', 'HTTP_AUTHORIZATION_POLICY'],
        ['@WpAuth([jwt()])', '{authType:AuthorizationType.CUSTOM}', 'HTTP_AUTHORIZATION_POLICY'],
        ['@WpAuth([jwt()])', '{authType:AuthorizationType.ALL_USERS,inOrg:true}', 'HTTP_AUTHORIZATION_POLICY'],
        ['@WpAuth([jwt()])', '{authType:AuthorizationType.ALL_USERS,appPolicy:{permission:"x"}}', 'HTTP_AUTHORIZATION_POLICY'],
        ['@WpAuth([jwt()])', '{authType:AuthorizationType.ANONYMOUS,reason:"x"}', 'HTTP_AUTHORIZATION_PAIRING'],
        ["@WpAuthPublic('probe')", '{authType:AuthorizationType.ALL_USERS}', 'HTTP_AUTHORIZATION_PAIRING'],
    ])('fails closed on %s with %s', (authentication: string, policy: string, code: string) => {
        write('packages/api/src/BadPolicy.ts', `
            import {ApiPath,Endpoint,WpAuth,WpAuthPublic,WpAuthorization,AuthorizationType,jwt} from '@webpieces/core-util';
            function fake() {return {kind:'jwt'};}
            @ApiPath('/x') class Api {@Endpoint() ${authentication} @WpAuthorization(${policy}) x(v: object): Promise<object> {throw 0;}}
        `);
        expect(codes()).toContain(code);
    });

    it('does not treat negative test fixtures as production API contracts', () => {
        write(
            'packages/api/src/Bad.spec.ts',
            `
            import { ApiPath, Endpoint } from '@webpieces/core-util';
            @ApiPath('/test') class TestApi { @Endpoint(POST, '/x', WRITE, RPC) x(v: object): Promise<object> { throw 0; } }
        `,
        );
        expect(codes()).toEqual([]);
    });

    it('reports class-level, duplicate, missing and orphan declarations', () => {
        write('packages/api/src/Bad.ts', `
            import {ApiPath,Endpoint,WpAuth,WpAuthPublic,WpAuthorization,AuthorizationType,jwt,oidc} from '@webpieces/core-util';
            @WpAuth([jwt()]) @ApiPath('/x') class Api {
                @Endpoint() missing(v: object): Promise<object> {throw 0;}
                @Endpoint() @WpAuth([jwt()]) @WpAuth([oidc()]) @WpAuthorization({authType:AuthorizationType.ALL_USERS}) many(v: object): Promise<object> {throw 0;}
                @Endpoint() @WpAuthPublic('   ') @WpAuthorization({authType:AuthorizationType.ANONYMOUS,reason:'probe'}) public(v: object): Promise<object> {throw 0;}
                @WpAuth([oidc()]) @WpAuthorization({authType:AuthorizationType.SERVICE_ONLY}) orphan(v: object): Promise<object> {throw 0;}
            }
        `);
        expect(codes()).toEqual([
            'HTTP_CLASS_AUTH', 'HTTP_AUTH_COUNT', 'HTTP_AUTHORIZATION_COUNT',
            'HTTP_AUTH_COUNT', 'HTTP_PUBLIC_REASON', 'HTTP_ORPHAN_AUTH', 'HTTP_ORPHAN_AUTHORIZATION',
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
                @WpIpcEndpoint('same') @Endpoint(POST, '/x', WRITE, RPC) @WpAuthJwt({ allRolesAllowed: true }) two(a: object, b: object): Promise<object> { throw 0; }
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
