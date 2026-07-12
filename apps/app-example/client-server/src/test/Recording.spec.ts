import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { recordable } from '@webpieces/http-server';
import { WebpiecesConfig, ApiFactory, AuthConfig, JwtHook } from '@webpieces/http-routing';
import { TestAuthConfig, TestJwtHook } from './TestAuthConfig';
import { RecordedTestCase, RecordSerializer } from '@webpieces/core-util';
import { createMock } from '@webpieces/core-mock';
import { RequestContext, HttpRequest } from '@webpieces/core-context';
import { SaveApi } from '@webpieces/client-server-api';
import { Server2Api, FetchValueResponse, FetchValueRequest } from '@webpieces/server2-api';
import { setupCompanyRuntime, CompanySetupOptions } from '@webpieces/company-svc-core';
import { ClientServerAppModules } from '../ClientServerAppModules';
import { TYPES } from '../remote/Server2Client';
import { Server2Simulator } from '../remote/Server2Simulator';

/**
 * End-to-end proof of the recording subsystem:
 * - RecordingFilter (priority 1850) records the inbound endpoint
 * - recordable(Server2Simulator) records the in-process downstream call
 * - TestCaseRecorderImpl writes a JSON fixture + generated spec to recordingDir
 */
let router: ApiFactory;
let recordingDir: string;

/**
 * Boot with recording always-on. Prod binds Server2Api to a real HTTP client;
 * for this in-process test we rebind to recordable(simulator) so the downstream
 * call is captured WITHOUT a second server (recordable = port of Java ApiRecorder).
 */
async function bootRecordingServer(): Promise<void> {
    recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-recording-'));

    const config = new WebpiecesConfig();
    config.recordingAlwaysOn = true; // in-process calls have no HTTP headers
    config.recordingDir = recordingDir;

    const appOverrides = new ContainerModule(async (options: ContainerModuleLoadOptions) => {
        const rebindResult = await options.rebind<Server2Api>(TYPES.Server2Api);
        rebindResult.toConstantValue(recordable('Server2Api', new Server2Simulator()));
        (await options.rebind(AuthConfig)).to(TestAuthConfig);
        (await options.rebind(JwtHook)).to(TestJwtHook);
    });
    // ONE call — the SAME AppModules the real server uses; only the recordable override + config differ.
    router = await setupCompanyRuntime(
        ClientServerAppModules.create(),
        new CompanySetupOptions(undefined, appOverrides, config),
    );
}

function stopRecordingServer(): void {
    fs.rmSync(recordingDir, { recursive: true, force: true });
}

describe('Test-case recording', () => {
    beforeAll(bootRecordingServer);
    afterAll(stopRecordingServer);

    it('records the endpoint + downstream call into a fixture and generates a spec', async () => {
        const saveApi = router.createApiClient<SaveApi>(SaveApi);

        await RequestContext.run(async () => {
            RequestContext.setRequest(new HttpRequest('POST', '/', new Map([['authorization', ['Bearer test-token-123']]])));
            const response = await saveApi.save({ query: 'record-me' });
            expect(response.success).toBe(true);
        });

        const files = fs.readdirSync(recordingDir);
        const fixtureFile = files.find((f: string) => f.startsWith('SaveApi.save.') && f.endsWith('.fixture.json'));
        const specFile = files.find((f: string) => f.startsWith('SaveApi.save.') && f.endsWith('.spec.ts'));
        expect(fixtureFile).toBeDefined();
        expect(specFile).toBeDefined();

        const serializer = new RecordSerializer();
        const fixture = serializer.deserialize<RecordedTestCase>(
            fs.readFileSync(path.join(recordingDir, fixtureFile!), 'utf-8'),
        );

        // Server endpoint captured: request DTO + response + masked ctx snapshot
        // (in-process clients register routes under the api prototype name)
        expect(fixture.serverEndpoint.apiName).toBe('SaveApi');
        expect(fixture.serverEndpoint.methodName).toBe('save');
        expect(fixture.serverEndpoint.args[0]).toEqual({ query: 'record-me' });
        const successResponse = fixture.serverEndpoint.successResponse as { success: boolean };
        expect(successResponse.success).toBe(true);
        // The credential is not a ContextKey at all, so it can never reach the ctx snapshot
        expect(JSON.stringify(fixture.serverEndpoint.ctxSnapshot)).not.toContain('test-token-123');

        // Downstream in-process call captured via recordable()
        expect(fixture.downstreamCalls).toHaveLength(1);
        expect(fixture.downstreamCalls[0].apiName).toBe('Server2Api');
        expect(fixture.downstreamCalls[0].methodName).toBe('fetchValue');
        expect(fixture.downstreamCalls[0].args[0]).toEqual({ name: 'record-me' });
        const downstreamResponse = fixture.downstreamCalls[0].successResponse as FetchValueResponse;
        expect(downstreamResponse.value).toContain('record-me');

        // Generated spec primes a mock from the fixture's downstream calls
        const specSource = fs.readFileSync(path.join(recordingDir, specFile!), 'utf-8');
        expect(specSource).toContain("createMock<Server2Api>('Server2Api')");
        expect(specSource).toContain("addValueToReturn('fetchValue'");
    });
});

/**
 * The replay side: createMock<Server2Api> primed exactly the way a recorded
 * fixture (or an AI reading one) would prime it - replacing the hand-rolled
 * MockServer2Api pattern from Integration.spec.ts.
 */
describe('createMock replaces hand-rolled mocks', () => {
    let router: ApiFactory;
    const mockServer2Api = createMock<Server2Api>('Server2Api');

    beforeAll(async () => {
        const appOverrides = new ContainerModule(async (options: ContainerModuleLoadOptions) => {
            const rebindResult = await options.rebind<Server2Api>(TYPES.Server2Api);
            rebindResult.toConstantValue(mockServer2Api);
            (await options.rebind(AuthConfig)).to(TestAuthConfig);
            (await options.rebind(JwtHook)).to(TestJwtHook);
        });
        router = await setupCompanyRuntime(ClientServerAppModules.create(), new CompanySetupOptions(undefined, appOverrides));
    });

    it('primes responses and asserts captured requests through the full filter chain', async () => {
        mockServer2Api.mock.addValueToReturn('fetchValue', { value: 'MOCKED: from createMock' });

        const saveApi = router.createApiClient<SaveApi>(SaveApi);
        await RequestContext.run(async () => {
            RequestContext.setRequest(new HttpRequest('POST', '/', new Map([['authorization', ['Bearer test-token-123']]])));
            const response = await saveApi.save({ query: 'mock-query' });
            expect(response.matches![0].description).toBe('MOCKED: from createMock');
        });

        const requests = mockServer2Api.mock.getSingleRequestList<FetchValueRequest>('fetchValue');
        expect(requests).toHaveLength(1);
        expect(requests[0].name).toBe('mock-query');
    });

    it('throws the helpful not-enough-values error when unprimed', async () => {
        const saveApi = router.createApiClient<SaveApi>(SaveApi);
        await RequestContext.run(async () => {
            RequestContext.setRequest(new HttpRequest('POST', '/', new Map([['authorization', ['Bearer test-token-123']]])));
            await expect(saveApi.save({ query: 'unprimed' })).rejects.toThrow(/did not add enough return values/);
        });
    });
});
