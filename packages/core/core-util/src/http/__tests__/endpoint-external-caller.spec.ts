/**
 * `@Endpoint(path, 'external', { calledBy })` — the compile-time forcing function that makes a human
 * name the system calling us from outside, plus the metadata it records for the architecture graph.
 *
 * The type-level half (omitting `calledBy` is a COMPILE error, non-external endpoints unaffected)
 * lives in endpoint-external-caller-types.spec.ts, which tsc checks; this file covers the runtime.
 */
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import {
    ApiPath,
    Endpoint,
    Public,
    assertEveryExternalEndpointDeclaresCaller,
    getEndpointKinds,
    getEndpoints,
    METADATA_KEYS,
} from '../decorators';
import { ExternalCaller, getEndpointCaller } from '../external-caller';

@Public()
@ApiPath('/hooks')
abstract class CallerApi {
    @Endpoint('/rpc', 'rpc')
    plain(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    // Vendor webhook: kind defaults to 'saas'.
    @Endpoint('/twilio', 'external', { formPost: true, calledBy: 'twilio' })
    inbound(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    // A SECOND method with the SAME caller — one vendor, several endpoints.
    @Endpoint('/twilio-status', 'external', { calledBy: 'twilio' })
    status(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    // Infrastructure rather than a vendor product.
    @Endpoint('/push', 'external', { calledBy: 'pubsub-push', callerKind: 'system' })
    push(_req: object): Promise<object> {
        throw new Error('subclass');
    }
}

describe('@Endpoint external caller metadata', () => {
    it('leaves the ENDPOINTS path map and the kind map untouched', () => {
        expect(getEndpoints(CallerApi)).toEqual({
            plain: '/rpc',
            inbound: '/twilio',
            status: '/twilio-status',
            push: '/push',
        });
        expect(getEndpointKinds(CallerApi)).toEqual({
            plain: 'rpc',
            inbound: 'external',
            status: 'external',
            push: 'external',
        });
    });

    it('records the caller with the default kind saas', () => {
        expect(getEndpointCaller(CallerApi, 'inbound')).toEqual(new ExternalCaller('saas', 'twilio'));
    });

    it('honours an explicit callerKind', () => {
        expect(getEndpointCaller(CallerApi, 'push')).toEqual(new ExternalCaller('system', 'pubsub-push'));
    });

    it('gives two endpoints of one vendor the SAME identity, so the graph converges on one node', () => {
        const inbound = getEndpointCaller(CallerApi, 'inbound')!;
        const status = getEndpointCaller(CallerApi, 'status')!;
        expect(status.label).toBe(inbound.label);
        expect(status.kind).toBe(inbound.kind);
    });

    it('records NO caller for a non-external endpoint', () => {
        // A caller on an rpc endpoint would be a fact about nothing — the kind is what decides.
        expect(getEndpointCaller(CallerApi, 'plain')).toBeUndefined();
        expect(getEndpointCaller(CallerApi, 'nope')).toBeUndefined();
    });

    it('rides its OWN metadata map, parallel to ENDPOINTS', () => {
        const map = Reflect.getMetadata(METADATA_KEYS.ENDPOINT_CALLER, CallerApi);
        expect(Object.keys(map).sort()).toEqual(['inbound', 'push', 'status']);
    });
});

describe('assertEveryExternalEndpointDeclaresCaller', () => {
    it('passes when every external endpoint named its caller', () => {
        expect(() => assertEveryExternalEndpointDeclaresCaller(CallerApi)).not.toThrow();
    });

    it('throws for an external endpoint that bypassed TS and declared none', () => {
        @Public()
        @ApiPath('/sneaky')
        abstract class SneakyApi {
            // The `as never` is the point: TS refuses this, JS callers and `as any` do not, so the
            // wiring-time assert is the backstop behind the compile error.
            @Endpoint('/hook', 'external', { formPost: true } as never)
            inbound(_req: object): Promise<object> {
                throw new Error('subclass');
            }
        }
        expect(() => assertEveryExternalEndpointDeclaresCaller(SneakyApi)).toThrow(/declares no caller/);
        expect(() => assertEveryExternalEndpointDeclaresCaller(SneakyApi)).toThrow(/calledBy/);
    });

    it('ignores a class with no external endpoints at all', () => {
        @Public()
        @ApiPath('/plain')
        abstract class PlainApi {
            @Endpoint('/go', 'rpc')
            go(_req: object): Promise<object> {
                throw new Error('subclass');
            }
        }
        expect(() => assertEveryExternalEndpointDeclaresCaller(PlainApi)).not.toThrow();
    });
});
