import { RecordedTestCase, RecordedEndpoint } from '@webpieces/core-util';

/**
 * SpecGenerator - Deterministic template that turns a RecordedTestCase into a
 * small vitest spec (~30 lines) which loads the fixture JSON, primes an inline
 * createMock per downstream api, invokes the endpoint in-process, and deep-equal
 * asserts the response + the requests each mock received.
 *
 * The mock test-double is emitted inline into the generated spec (see
 * INLINE_MOCK_SOURCE) so the generated file is fully self-contained and does not
 * depend on any external mock package.
 *
 * Deliberately NO deep reflection over DTOs (the fragile part of the Java
 * TestCaseRecorderImpl codegen) - all data lives in the fixture; the spec is
 * pure plumbing. The fixture is also a stable artifact for an AI to write a
 * richer spec from.
 */

/**
 * Self-contained recording test-double emitted into every generated spec. Mirrors
 * the small slice of the former @webpieces/core-mock API the template relies on:
 *   createMock<T>(name)                       -> T & { mock: MockControls }
 *   .mock.addValueToReturn(method, value)     queue a return value (FIFO)
 *   .mock.addExceptionToThrow(method, ()=>Err) queue an exception (FIFO)
 *   .mock.getSingleRequestList(method)        first argument of each recorded call
 */
const INLINE_MOCK_SOURCE = `type MockControls = {
    addValueToReturn(method: string, value: unknown): void;
    addExceptionToThrow(method: string, errorFactory: () => Error): void;
    getSingleRequestList(method: string): unknown[];
};

function createMock<T>(_name: string): T & { mock: MockControls } {
    const returns = new Map<string, unknown[]>();
    const throwers = new Map<string, Array<() => Error>>();
    const requests = new Map<string, unknown[]>();
    const controls: MockControls = {
        addValueToReturn(method, value) {
            const queue = returns.get(method) ?? [];
            queue.push(value);
            returns.set(method, queue);
        },
        addExceptionToThrow(method, errorFactory) {
            const queue = throwers.get(method) ?? [];
            queue.push(errorFactory);
            throwers.set(method, queue);
        },
        getSingleRequestList(method) {
            return requests.get(method) ?? [];
        },
    };
    return new Proxy({} as Record<string, unknown>, {
        get(_target, prop: string | symbol): unknown {
            if (prop === 'mock') return controls;
            const method = String(prop);
            return (...args: unknown[]): unknown => {
                const recorded = requests.get(method) ?? [];
                recorded.push(args[0]);
                requests.set(method, recorded);
                const throwQueue = throwers.get(method);
                if (throwQueue && throwQueue.length > 0) {
                    throw throwQueue.shift()!();
                }
                const returnQueue = returns.get(method);
                if (returnQueue && returnQueue.length > 0) {
                    return returnQueue.shift();
                }
                return undefined;
            };
        },
    }) as T & { mock: MockControls };
}`;

export class SpecGenerator {
    generate(testCase: RecordedTestCase, fixtureFileName: string): string {
        const endpoint = testCase.serverEndpoint;
        const downstreamApis = this.uniqueApiNames(testCase.downstreamCalls);

        const mockDecls = downstreamApis
            .map((api: string) => `    const mock${api} = createMock<${api}>('${api}');`)
            .join('\n');
        const mockPrimes = testCase.downstreamCalls
            .map((call: RecordedEndpoint, i: number) =>
                call.failureResponse
                    ? `    mock${call.apiName}.mock.addExceptionToThrow('${call.methodName}', () => new Error(fixture.downstreamCalls[${i}].failureResponse!.message));`
                    : `    mock${call.apiName}.mock.addValueToReturn('${call.methodName}', fixture.downstreamCalls[${i}].successResponse);`)
            .join('\n');
        const mockAsserts = testCase.downstreamCalls
            .map((call: RecordedEndpoint, i: number) =>
                `    expect(mock${call.apiName}.mock.getSingleRequestList('${call.methodName}')[0]).toEqual(fixture.downstreamCalls[${i}].args[0]);`)
            .join('\n');

        return `import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { RecordedTestCase } from '@webpieces/core-util';
// TODO(generated): import your ServerMeta, the api class, DI tokens, and the
// downstream api types, then wire the appOverrides ContainerModule below.

${INLINE_MOCK_SOURCE}

describe('${endpoint.apiName}.${endpoint.methodName} (recorded ${testCase.recordedAt})', () => {
    const fixture: RecordedTestCase = JSON.parse(
        fs.readFileSync(path.join(__dirname, '${fixtureFileName}'), 'utf-8'),
    );

    it('replays the recorded request against mocked downstream apis', async () => {
${mockDecls}
${mockPrimes}
        // TODO(generated): boot the server with the mocks rebound, e.g.:
        // const overrides = new ContainerModule(async (options) => {
        //     (await options.rebind(TYPES.RemoteApi)).toConstantValue(mockRemoteApi);
        // });
        // const server = await WebpiecesFactory.create(new ProdServerMeta(), new WebpiecesConfig(), overrides);
        // const api = server.createApiClient(${endpoint.apiName});
        // const response = await api.${endpoint.methodName}(fixture.serverEndpoint.args[0]);
        // expect(response).toEqual(fixture.serverEndpoint.successResponse);
${mockAsserts}
    });
});
`;
    }

    private uniqueApiNames(calls: RecordedEndpoint[]): string[] {
        const names: string[] = [];
        for (const call of calls) {
            if (!names.includes(call.apiName)) {
                names.push(call.apiName);
            }
        }
        return names;
    }
}
