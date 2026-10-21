import { afterEach, describe, expect, it } from 'vitest';
import { ClientRegistry } from '../ClientRegistry';
import { CallScope } from '../CallScope';
import { CallContext } from '../CallStrategy';
import { TransportDefault } from '../TransportDefault';
import { READ } from '../HttpEndpointOptions';

/** The context's own contract; `execute` re-keys it onto whichever class it is given. */
class SameApi {}
const work = new CallContext('SameApi', 'work', READ, SameApi);

afterEach(() => ClientRegistry.resetForTests());

describe('ClientRegistry identity and configuration', () => {
    it('does not collide when distinct contracts have the same class and method names', async () => {
        const first = class SameApi {
            work(): void {}
        };
        const second = class SameApi {
            work(): void {}
        };
        expect(first.name).toBe(second.name);
        ClientRegistry.setTimeout(10, CallScope.method(first, 'work'));
        const attempt = (ms: number): Promise<number> => Promise.resolve(ms);
        expect(await ClientRegistry.execute(first, work, attempt, new TransportDefault(30_000))).toBe(10);
        expect(await ClientRegistry.execute(second, work, attempt, new TransportDefault(30_000))).toBe(
            30_000,
        );
        ClientRegistry.setStrategy(() => Promise.resolve(99), CallScope.api(first));
        expect(await ClientRegistry.execute(first, work, attempt, new TransportDefault(30_000))).toBe(99);
        expect(await ClientRegistry.execute(second, work, attempt, new TransportDefault(5_000))).toBe(
            5_000,
        );
    });

    it.each([0, -1, NaN, Infinity, 2_147_483_648])('rejects invalid configuration %s', (ms: number) => {
        expect(() => ClientRegistry.setTimeout(ms, CallScope.all())).toThrow(RangeError);
    });
});
