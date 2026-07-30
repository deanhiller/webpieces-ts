import 'reflect-metadata';
import {
    ApiPath,
    Endpoint,
    PubSub,
    Rpc,
    Queue,
    Public,
    AuthJwt,
    AuthOidc,
    AuthSharedSecret,
    getApiKind,
    getEndpointKind,
    getEndpointKinds,
    getQueueName,
    getAuthMode,
    assertApiKind,
    assertPubSubConventions,
    assertEveryEndpointHasAuthMode,
} from '../decorators';

@PubSub()
@AuthOidc()
@ApiPath('/email')
abstract class SampleTaskApi {
    @Endpoint('/send', 'cloudtasks')
    sendEmail(_req: object): Promise<void> {
        throw new Error('subclass');
    }

    @Endpoint('/report', 'cron')
    @Queue('custom-report-queue')
    fireReport(_req: object): Promise<void> {
        throw new Error('subclass');
    }
}

@Rpc()
@Public()
@ApiPath('/rpc')
abstract class SampleRpcApi {
    @Endpoint('/ping', 'rpc')
    @AuthSharedSecret('MY_SECRET_ENV')
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
        expect(getEndpointKinds(SampleTaskApi)).toEqual({ sendEmail: 'cloudtasks', fireReport: 'cron' });
        expect(getEndpointKind(SampleTaskApi, 'sendEmail')).toBe('cloudtasks');
        expect(getEndpointKind(SampleRpcApi, 'ping')).toBe('rpc');
    });

    it('returns undefined for a non-endpoint rather than defaulting to rpc', () => {
        // Defaulting would silently reclassify an undeclared cron/webhook as a normal call.
        expect(getEndpointKind(SampleTaskApi, 'notAnEndpoint')).toBeUndefined();
    });

    it('rejects a @PubSub method declaring a kind no queue can deliver', () => {
        @PubSub()
        @AuthOidc()
        @ApiPath('/bad')
        abstract class BadTaskApi {
            // 'rpc' on a @PubSub contract: nothing calls a queue synchronously.
            @Endpoint('/nope', 'rpc') nope(_r: object): Promise<void> { throw new Error('x'); }
        }
        expect(() => assertPubSubConventions(BadTaskApi)).toThrow(/must be one of: cloudtasks \| cron \| external/);
    });
});

describe('auth modes', () => {
    it('resolves class-level @AuthOidc() to an empty (trust-the-edge) caller list', () => {
        const mode = getAuthMode(SampleTaskApi, 'sendEmail');
        expect(mode?.kind).toBe('oidc');
        if (mode?.kind === 'oidc') {
            expect(mode.callers).toEqual([]);
        }
    });

    it('lets a method override with @AuthSharedSecret', () => {
        const mode = getAuthMode(SampleRpcApi, 'ping');
        expect(mode?.kind).toBe('shared-secret');
        if (mode?.kind === 'shared-secret') {
            expect(mode.secretKey).toBe('MY_SECRET_ENV');
        }
    });

    it('passes assertEveryEndpointHasAuthMode when all endpoints are covered', () => {
        expect(() => assertEveryEndpointHasAuthMode(SampleTaskApi)).not.toThrow();
        expect(() => assertEveryEndpointHasAuthMode(SampleRpcApi)).not.toThrow();
    });

    it('maps @Public and @AuthJwt to the right modes', () => {
        @AuthJwt('admin')
        @ApiPath('/x')
        abstract class JwtApi {
            @Endpoint('/a', 'rpc') a(_r: object): Promise<object> { throw new Error('x'); }
            @Public() @Endpoint('/b', 'rpc') b(_r: object): Promise<object> { throw new Error('x'); }
        }
        const aMode = getAuthMode(JwtApi, 'a');
        expect(aMode?.kind).toBe('jwt');
        if (aMode?.kind === 'jwt') {
            expect(aMode.requirement.roles).toEqual(['admin']);
        }
        expect(getAuthMode(JwtApi, 'b')?.kind).toBe('public');
    });
});
