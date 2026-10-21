import {getAuthorization} from '@webpieces/core-util';
import { WpAuthorization, AuthorizationType, WpAuth, oidcSameProject, oidcSvcs, sharedSecret as sharedSecretAuth, jwt as jwtAuth } from '@webpieces/core-util';
import type { AuthMethod, OidcCallers } from '@webpieces/core-util';
import 'reflect-metadata';
import { ApiPath, Endpoint, WpAuthPublic, getEndpointKind, getEndpointKinds, getAuthMeta, MISSING_AUTH_DECORATOR_FIX, assertEveryEndpointHasAuthMode, CLOUDTASKS, CRON, POST, READ, RPC, WRITE } from '../decorators';
import {
    PubSub,
    Rpc,
    Queue,
    getApiKind,
    getQueueName,
    assertApiKind,
    assertPubSubConventions,
} from '../api-kind';

@PubSub()
@ApiPath('/email')
abstract class SampleTaskApi {
    @WpAuth([oidcSameProject()])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    @Endpoint(POST, '/send', WRITE, CLOUDTASKS)
    sendEmail(_req: object): Promise<void> {
        throw new Error('subclass');
    }

    @WpAuth([oidcSameProject()])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    @Endpoint(POST, '/report', WRITE, CRON)
    @Queue('custom-report-queue')
    fireReport(_req: object): Promise<void> {
        throw new Error('subclass');
    }
}

@Rpc()
@ApiPath('/rpc')
abstract class SampleRpcApi {
    @Endpoint(POST, '/ping', READ, RPC)
    @WpAuth([sharedSecretAuth('MY_SECRET_ENV')])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    ping(_req: object): Promise<object> {
        throw new Error('subclass');
    }
}

describe('API kind + queue naming', () => {
    it('marks @PubSub / @Rpc kinds and defaults to rpc', () => {
        expect(getApiKind(SampleTaskApi)).toBe('pubsub');
        expect(getApiKind(SampleRpcApi)).toBe('rpc');
    });

    it('derives the queue name, honoring @Queue overrides', () => {
        expect(getQueueName(SampleTaskApi, 'sendEmail')).toBe('SampleTaskApi-sendEmail');
        expect(getQueueName(SampleTaskApi, 'fireReport')).toBe('custom-report-queue');
    });

    it('asserts kind and PubSub conventions', () => {
        expect(() => assertPubSubConventions(SampleTaskApi)).not.toThrow();
        expect(() => assertApiKind(SampleTaskApi, 'rpc')).toThrow(/is @PubSub/);
        expect(() => assertPubSubConventions(SampleRpcApi)).toThrow();
    });
});

describe('@Endpoint trigger kind', () => {
    it('records the kind per METHOD, so one api can mix triggers', () => {
        expect(getEndpointKinds(SampleTaskApi)).toEqual({
            sendEmail: 'cloudtasks',
            fireReport: 'cron',
        });
        expect(getEndpointKind(SampleTaskApi, 'sendEmail')).toBe('cloudtasks');
        expect(getEndpointKind(SampleRpcApi, 'ping')).toBe('rpc');
    });

    it('returns undefined for a non-endpoint rather than defaulting to rpc', () => {
        // Defaulting would silently reclassify an undeclared cron/webhook as a normal call.
        expect(getEndpointKind(SampleTaskApi, 'notAnEndpoint')).toBeUndefined();
    });

    it('rejects a @PubSub method declaring a kind no queue can deliver', () => {
        @PubSub()
        @ApiPath('/bad')
        abstract class BadTaskApi {
            // 'rpc' on a @PubSub contract: nothing calls a queue synchronously.
            @WpAuth([oidcSameProject()])
            @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
            @Endpoint(POST, '/nope', WRITE, RPC)
            nope(_r: object): Promise<void> {
                throw new Error('x');
            }
        }
        expect(() => assertPubSubConventions(BadTaskApi)).toThrow(
            /must be one of: cloudtasks \| cron \| external/,
        );
    });
});

describe('method authentication and authorization declarations', () => {
    it('rejects class authentication and blank public reasons', () => {
        class Api {}
        const classAuth = WpAuth([jwtAuth()]) as unknown as ClassDecorator;
        expect(() => classAuth(Api)).toThrow(/method-only/);
        expect(() => WpAuthPublic('   ')).toThrow(/reason/);
    });

    it('reads concrete credential descriptors separately from policy', () => {
        expect(getAuthMeta(SampleTaskApi, 'sendEmail')?.methods).toEqual([{kind:'oidc',callerScope:'same-project'}]);
        expect(getAuthMeta(SampleRpcApi, 'ping')?.methods).toEqual([{kind:'shared-secret',secretKey:'MY_SECRET_ENV'}]);
        expect(getAuthorization(SampleTaskApi, 'sendEmail')).toEqual({authType:AuthorizationType.SERVICE_ONLY});
        expect(() => assertEveryEndpointHasAuthMode(SampleTaskApi)).not.toThrow();
    });

    it('rejects missing authorization even when authentication is declared', () => {
        @ApiPath('/missing')
        class Missing {
            @Endpoint(POST, '/a', READ, RPC)
            @WpAuth([jwtAuth()])
            a(_r: object): Promise<object> {throw new Error('subclass');}
        }
        expect(() => assertEveryEndpointHasAuthMode(Missing)).toThrow(/WpAuthorization/);
    });

    it('rejects two authentication declarations', () => {
        expect(() => {
            @ApiPath('/duplicate')
            class Duplicate {
                @Endpoint(POST, '/a', READ, RPC)
                @WpAuth([jwtAuth()])
                @WpAuthPublic('probe')
                @WpAuthorization({authType:AuthorizationType.ANONYMOUS,reason:'probe'})
                a(_r: object): Promise<object> {throw new Error('subclass');}
            }
            return Duplicate;
        }).toThrow(/Conflicting auth decorator/);
    });

    it('teaches the new declarations in missing-auth diagnostics', () => {
        for (const current of ['@WpAuth([', 'jwt()', 'oidcSameProject()', 'oidcSvcs([', 'sharedSecret(', 'vendorAuth(', 'apiKey(', '@WpAuthorization', '@WpLocalOnly()']) {
            expect(MISSING_AUTH_DECORATOR_FIX).toContain(current);
        }
        for (const removed of ['@WpAuthJwt', '@WpAuthOidc', '@WpAuthLocalOnly', '@Authentication', 'oidc(', 'webhook(']) {
            expect(MISSING_AUTH_DECORATOR_FIX).not.toContain(removed);
        }
    });
});

describe('OIDC descriptors: oidcSameProject() and oidcSvcs([...])', () => {
    @ApiPath('/oidc-scopes')
    abstract class OidcScopesApi {
        @WpAuth([oidcSameProject()])
        @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
        @Endpoint(POST, '/project', READ, RPC)
        project(_r: object): Promise<object> {
            throw new Error('subclass');
        }

        @WpAuth([oidcSvcs(['self', 'partner-sa@other-project.iam.gserviceaccount.com'])])
        @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
        @Endpoint(POST, '/listed', READ, RPC)
        listed(_r: object): Promise<object> {
            throw new Error('subclass');
        }
    }

    it('keeps one oidc kind and names the scope in callerScope', () => {
        expect(getAuthMeta(OidcScopesApi, 'project')?.methods).toEqual([{ kind: 'oidc', callerScope: 'same-project' }]);
        expect(getAuthMeta(OidcScopesApi, 'listed')?.methods).toEqual([
            { kind: 'oidc', callerScope: 'services', callers: ['self', 'partner-sa@other-project.iam.gserviceaccount.com'] },
        ]);
    });

    // The type already refuses these; the values below arrive AROUND it, the way runtime data or plain JS would.
    it('rejects an empty or blank oidcSvcs list when the decorator is evaluated, even around the type', () => {
        const none = JSON.parse('[]') as OidcCallers;
        expect(() => WpAuth([oidcSvcs(none)])).toThrow(
            /oidcSvcs\(\[\.\.\.\]\) requires at least one nonblank service account; use oidcSameProject\(\)/,
        );
        expect(() => WpAuth([oidcSvcs(['   '])])).toThrow(/requires at least one nonblank service account/);
    });

    it('pairs one method of each OIDC scope with other credentials on one endpoint', () => {
        @ApiPath('/oidc-pair')
        abstract class OidcPairApi {
            @WpAuth([oidcSameProject(), oidcSvcs(['partner@other-project.iam.gserviceaccount.com']), jwtAuth()])
            @WpAuthorization({ authType: AuthorizationType.USERS_OR_SERVICES })
            @Endpoint(POST, '/pair', READ, RPC)
            pair(_r: object): Promise<object> {
                throw new Error('subclass');
            }
        }
        expect(getAuthMeta(OidcPairApi, 'pair')?.methods).toEqual([
            { kind: 'oidc', callerScope: 'same-project' },
            { kind: 'oidc', callerScope: 'services', callers: ['partner@other-project.iam.gserviceaccount.com'] },
            { kind: 'jwt' },
        ]);
    });

    it('rejects two OIDC methods of one scope on one endpoint', () => {
        expect(() => WpAuth([oidcSameProject(), oidcSameProject()])).toThrow(/duplicate or invalid credential methods/);
        expect(() => WpAuth([oidcSvcs(['svc-a']), oidcSvcs(['svc-b'])])).toThrow(/duplicate or invalid credential methods/);
    });

    it('rejects the removed scope-less oidc shape when the decorator is evaluated', () => {
        const removedShape = JSON.parse('{"kind":"oidc","callers":[]}') as AuthMethod;
        expect(() => WpAuth([removedShape])).toThrow(/Unknown OIDC callerScope; use oidcSameProject\(\) or oidcSvcs/);
    });
});
