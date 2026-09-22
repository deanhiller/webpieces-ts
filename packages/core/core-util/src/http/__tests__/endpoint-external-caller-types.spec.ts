import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import {
    ApiPath,
    Endpoint,
    WpAuthPublic,
    EXTERNAL,
    POST,
    RPC,
    WRITE,
} from '../decorators';
import { getEndpointCaller } from '../external-caller';

@ApiPath('/types')
abstract class TypeCheckApi {
    @WpAuthPublic('Declared external endpoint fixture')
    @Endpoint(POST, '/ok', WRITE, EXTERNAL, { calledBy: 'twilio' })
    declared(_req: object): Promise<object> {
        throw new Error('subclass');
    }

    @WpAuthPublic('RPC endpoint fixture')
    @Endpoint(POST, '/rpc2', WRITE, RPC, { formPost: true })
    rpcWithOptions(_req: object): Promise<object> {
        throw new Error('subclass');
    }
}

describe('@Endpoint overloads (type-level)', () => {
    it('compiles the declared external endpoint and records its caller', () => {
        expect(getEndpointCaller(TypeCheckApi, 'declared')?.label).toBe('twilio');
    });

    it('accepts an explicit operation on non-external endpoints', () => {
        expect(getEndpointCaller(TypeCheckApi, 'rpcWithOptions')).toBeUndefined();
    });
});
