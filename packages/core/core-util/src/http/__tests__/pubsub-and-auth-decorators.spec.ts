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
    @Endpoint('/send')
    sendEmail(_req: object): Promise<void> {
        throw new Error('subclass');
    }

    @Endpoint('/report')
    @Queue('custom-report-queue')
    fireReport(_req: object): Promise<void> {
        throw new Error('subclass');
    }
}

@Rpc()
@Public()
@ApiPath('/rpc')
abstract class SampleRpcApi {
    @Endpoint('/ping')
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
            @Endpoint('/a') a(_r: object): Promise<object> { throw new Error('x'); }
            @Public() @Endpoint('/b') b(_r: object): Promise<object> { throw new Error('x'); }
        }
        const aMode = getAuthMode(JwtApi, 'a');
        expect(aMode?.kind).toBe('jwt');
        if (aMode?.kind === 'jwt') {
            expect(aMode.requirement.roles).toEqual(['admin']);
        }
        expect(getAuthMode(JwtApi, 'b')?.kind).toBe('public');
    });
});
