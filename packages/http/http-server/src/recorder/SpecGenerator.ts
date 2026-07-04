import { RecordedTestCase, RecordedEndpoint } from '@webpieces/http-api';

/**
 * SpecGenerator - Deterministic template that turns a RecordedTestCase into a
 * small vitest spec (~30 lines) which loads the fixture JSON, primes a
 * createMock per downstream api, invokes the endpoint in-process, and
 * deep-equal asserts the response + the requests each mock received.
 *
 * Deliberately NO deep reflection over DTOs (the fragile part of the Java
 * TestCaseRecorderImpl codegen) - all data lives in the fixture; the spec is
 * pure plumbing. The fixture is also a stable artifact for an AI to write a
 * richer spec from.
 */
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
import { createMock } from '@webpieces/core-mock';
import { RecordedTestCase } from '@webpieces/http-api';
// TODO(generated): import your ServerMeta, the api class, DI tokens, and the
// downstream api types, then wire the appOverrides ContainerModule below.

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
