import { createMock } from '../createMock';
import { MockHandler } from '../MockHandler';

interface DemoRequest {
    name?: string;
}

interface DemoResponse {
    value?: string;
}

interface DemoApi {
    fetchValue(request: DemoRequest): Promise<DemoResponse>;
}

describe('MockHandler', () => {
    it('dequeues primed values in order', () => {
        const handler = new MockHandler();
        handler.addValueToReturn('m', 'first');
        handler.addValueToReturn('m', 'second');

        expect(handler.calledMethod('m', [])).toBe('first');
        expect(handler.calledMethod('m', [])).toBe('second');
    });

    it('falls back to the default when the queue is empty', () => {
        const handler = new MockHandler();
        handler.addValueToReturn('m', 'queued');
        handler.setDefaultReturnValue('m', 'default');

        expect(handler.calledMethod('m', [])).toBe('queued');
        expect(handler.calledMethod('m', [])).toBe('default');
        expect(handler.calledMethod('m', [])).toBe('default');
    });

    it('throws the primed exception', () => {
        const handler = new MockHandler();
        handler.addExceptionToThrow('m', () => new Error('primed boom'));

        expect(() => handler.calledMethod('m', [])).toThrow('primed boom');
    });

    it('throws a helpful error when nothing is primed', () => {
        const handler = new MockHandler();

        expect(() => handler.calledMethod('unprimed', [])).toThrow(
            /did not add enough return values to mocked method 'unprimed'/,
        );
    });

    it('computes values at call time via addCalculateRetValue', () => {
        const handler = new MockHandler();
        let counter = 0;
        handler.addCalculateRetValue('m', () => ++counter);
        handler.addCalculateRetValue('m', () => ++counter);

        expect(handler.calledMethod('m', [])).toBe(1);
        expect(handler.calledMethod('m', [])).toBe(2);
    });

    it('getCalledMethodList drains recorded calls (Java parity)', () => {
        const handler = new MockHandler();
        handler.setDefaultReturnValue('m', 'x');
        handler.calledMethod('m', ['a']);
        handler.calledMethod('m', ['b']);

        const calls = handler.getCalledMethodList('m');
        expect(calls).toHaveLength(2);
        expect(calls[0].args).toEqual(['a']);

        // drained - second read is empty
        expect(handler.getCalledMethodList('m')).toHaveLength(0);
    });

    it('clear resets queues, defaults, and recorded calls', () => {
        const handler = new MockHandler();
        handler.addValueToReturn('m', 'queued');
        handler.setDefaultReturnValue('m', 'default');
        handler.calledMethod('m', []);
        handler.clear();

        expect(() => handler.calledMethod('m', [])).toThrow(/did not add enough return values/);
    });
});

describe('createMock', () => {
    it('implements the api: primed value returned as a Promise', async () => {
        const mockApi = createMock<DemoApi>('DemoApi');
        mockApi.mock.addValueToReturn('fetchValue', { value: 'primed' });

        const response = await mockApi.fetchValue({ name: 'q' });
        expect(response.value).toBe('primed');
    });

    it('rejects when primed with an exception', async () => {
        const mockApi = createMock<DemoApi>('DemoApi');
        mockApi.mock.addExceptionToThrow('fetchValue', () => new Error('remote down'));

        await expect(mockApi.fetchValue({})).rejects.toThrow('remote down');
    });

    it('captures request DTOs for assertion via getSingleRequestList', async () => {
        const mockApi = createMock<DemoApi>('DemoApi');
        mockApi.mock.setDefaultReturnValue('fetchValue', { value: 'x' });

        await mockApi.fetchValue({ name: 'first' });
        await mockApi.fetchValue({ name: 'second' });

        const requests = mockApi.mock.getSingleRequestList<DemoRequest>('fetchValue');
        expect(requests.map((r: DemoRequest) => r.name)).toEqual(['first', 'second']);
    });

    it('is Promise-safe: awaiting the mock object itself does not explode', async () => {
        const mockApi = createMock<DemoApi>('DemoApi');
        // Promise.resolve checks .then - must return undefined, not a mocked method
        const resolved = await Promise.resolve(mockApi);
        expect(resolved).toBe(mockApi);
    });
});
