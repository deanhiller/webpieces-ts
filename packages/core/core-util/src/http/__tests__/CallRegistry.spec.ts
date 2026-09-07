import { afterEach, describe, expect, it } from 'vitest';
import { CallRegistry } from '../CallRegistry';

afterEach(() => CallRegistry.clear());

describe('CallRegistry identity and configuration', () => {
    it('does not collide when distinct contracts have the same class and method names', async () => {
        const first = class SameApi {};
        const second = class SameApi {};
        expect(first.name).toBe(second.name);
        CallRegistry.setTimeout(10, first, 'work');
        const attempt = (ms: number): Promise<number> => Promise.resolve(ms);
        expect(await CallRegistry.execute(first, 'work', attempt, 30_000)).toBe(10);
        expect(await CallRegistry.execute(second, 'work', attempt, 30_000)).toBe(30_000);
        CallRegistry.setStrategy(() => Promise.resolve(99), first);
        expect(await CallRegistry.execute(first, 'work', attempt, 30_000)).toBe(99);
        expect(await CallRegistry.execute(second, 'work', attempt, 5_000)).toBe(5_000);
    });

    it.each([0, -1, NaN, Infinity, 2_147_483_648])('rejects invalid configuration %s', (ms: number) => {
        expect(() => CallRegistry.setTimeout(ms, 'ALL')).toThrow(RangeError);
    });
});
