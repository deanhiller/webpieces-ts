/**
 * The COMPILE-TIME half of the required external caller.
 *
 * Every `@ts-expect-error` below is a real assertion: tsc FAILS the build if the line it guards
 * stops being an error, so "omitting calledBy is a compile error" cannot silently regress into
 * "omitting calledBy is fine". vitest transpiles without type-checking, so the runtime `it()` here is
 * only the carrier — `tsc -p tsconfig.spec.json --noEmit` is what actually checks these.
 */
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { ApiPath, Endpoint, WpAuthPublic } from '../decorators';
import { getEndpointCaller } from '../external-caller';

@ApiPath('/types')
abstract class TypeCheckApi {
    // ---- external: calledBy is REQUIRED ------------------------------------------------------

    @WpAuthPublic('Type-level invalid external endpoint fixture')
    // @ts-expect-error - 'external' with options but no calledBy: the whole point of this change.
    @Endpoint('/x', 'external', { formPost: true })
    missingCaller(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    @WpAuthPublic('Type-level invalid external endpoint fixture')
    // @ts-expect-error - 'external' with NO options object at all.
    @Endpoint('/y', 'external')
    noOptions(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    @WpAuthPublic('Type-level invalid external endpoint fixture')
    // @ts-expect-error - callerKind must be one of the declared kinds, not free text.
    @Endpoint('/z', 'external', { calledBy: 'twilio', callerKind: 'vendor' })
    badKind(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    @WpAuthPublic('Type-level declared external endpoint fixture')
    @Endpoint('/ok', 'external', { calledBy: 'twilio' })
    declared(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    // ---- non-external endpoints are COMPLETELY unaffected -------------------------------------

    @WpAuthPublic('Type-level RPC endpoint fixture')
    @Endpoint('/rpc', 'rpc')
    rpcNoOptions(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    @WpAuthPublic('Type-level RPC endpoint fixture')
    @Endpoint('/rpc2', 'rpc', { formPost: true })
    rpcWithOptions(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    @WpAuthPublic('Type-level task endpoint fixture')
    @Endpoint('/task', 'cloudtasks')
    queued(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    @WpAuthPublic('Type-level cron endpoint fixture')
    @Endpoint('/nightly', 'cron')
    nightly(_req: object): Promise<object> {
        throw new Error('subclass');
    }
}

describe('@Endpoint overloads (type-level)', () => {
    it('compiles the declared external endpoint and records its caller', () => {
        expect(getEndpointCaller(TypeCheckApi, 'declared')?.label).toBe('twilio');
    });

    it('leaves non-external endpoints with optional options', () => {
        expect(getEndpointCaller(TypeCheckApi, 'rpcWithOptions')).toBeUndefined();
    });
});
